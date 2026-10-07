// The Agent pump against fake Durable Object bindings and SQLite storage.
// No network, real clocks, models or service credentials are involved.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.ts";
import type { ToolRequest, ToolResponse } from "../../protocol/tools.ts";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { JournalRow } from "../../core/agent/store.ts";
import {
  ATTEMPT_TIMEOUT_MS,
  HEADS_UP_REPUSH_MS,
  TOOL_RETRIES,
  TOOL_TIMEOUT_MS,
  WAIT_BACKOFF_BASE_MS,
} from "../../protocol/constants.ts";
import { WORKHORSE_MODEL } from "../../config/model-plan.ts";
import { Agent } from "./agent-do.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class<T> {
    readonly ctx: DurableObjectState;
    readonly env: T;
    constructor(ctx: DurableObjectState, env: T) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const NOW = 1_000_000;
const databases: DatabaseSync[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type ToolOutcome = "overloaded" | "503" | "transport" | "pool_not_ready" | "timeout" | (() => Promise<Response>);
type Inspection = {
  meta: Record<string, string>;
  journal: (JournalRow & { request: { request: ToolRequest; waiting?: boolean; waits?: number } }) | null;
  timers: Array<{ kind: string; key: string; due_at: number }>;
  transcript: Array<{ role: string; tool: string | null; call_id: string | null }>;
};

function successfulTool(request: ToolRequest): Response {
  return Response.json({
    call_id: request.call_id,
    ok: true,
    head_seq: 0,
    result: { status: "validated", submit_id: "s_test", tier: "auto", checks: [] },
    premises: [],
    heads_ups: [],
    heads_ups_more: false,
    attempt: { state: "validated", go_arounds: 0, pull_backs: 0 },
  } satisfies ToolResponse);
}

function transientTool(request: ToolRequest, code: "pool_not_ready" | "timeout"): Response {
  return Response.json({
    call_id: request.call_id,
    ok: false,
    head_seq: 0,
    error: { code, message: code },
    premises: [],
    heads_ups: [],
    heads_ups_more: false,
    attempt: { state: "opened", go_arounds: 0, pull_backs: 0 },
  } satisfies ToolResponse);
}

function fixture(outcomes: ToolOutcome[] = [], stopFailures = 0) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const background: Promise<unknown>[] = [];
  const tools: Array<{ at: number; request: ToolRequest }> = [];
  const stops: string[] = [];
  let alarmAt: number | null = null;
  let transaction = 0;
  const storage = {
    sql: {
      exec(query: string, ...bindings: Array<string | number | null | ArrayBuffer>) {
        const rows = db.prepare(query).all(...bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)));
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(run: () => T): T {
      const name = `agent_test_${++transaction}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const result = run();
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw error;
      }
    },
    async setAlarm(at: number) {
      alarmAt = at;
    },
    async deleteAlarm() {
      alarmAt = null;
    },
  };
  const context = {
    storage,
    waitUntil(task: Promise<unknown>) {
      background.push(task);
    },
  } as unknown as DurableObjectState;
  const namespace = (fetch: (url: string, init?: RequestInit) => Promise<Response>) => ({
    idFromName: (name: string) => name,
    get: () => ({ fetch }),
  });
  let reservation = 0;
  const env = {
    TRUNK: namespace(async (url, init) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (path === "/internal/state") return Response.json({ meta: { summary_only: "0" } });
      if (path === "/tool") {
        const request = body as unknown as ToolRequest;
        tools.push({ at: Date.now(), request });
        const outcome = outcomes.shift();
        if (typeof outcome === "function") return outcome();
        if (outcome === "overloaded") throw new Error("Durable Object is overloaded. Requests queued for too long.");
        if (outcome === "transport") throw new TypeError("connection reset");
        if (outcome === "503") return new Response("busy", { status: 503 });
        if (outcome === "pool_not_ready" || outcome === "timeout") {
          return transientTool(request, outcome);
        }
        return successfulTool(request);
      }
      if (path === "/stop") {
        stops.push(String(body.reason));
        if (stopFailures-- > 0) return new Response("busy", { status: 503 });
        return Response.json({
          ok: true,
          stop_reason: body.reason,
          attempt: { state: "stopped", go_arounds: 0, pull_backs: 0 },
        });
      }
      if (path === "/sync") {
        return Response.json({
          head_seq: 0,
          heads_ups: [],
          heads_ups_more: false,
          attempt: { state: "opened", go_arounds: 0, pull_backs: 0 },
        });
      }
      throw new Error(`unexpected Trunk path ${path}`);
    }),
    FLOOR: namespace(async () => Response.json({ appended: 1, last_n: 1 })),
    GATE: namespace(async (url) => {
      const path = new URL(url).pathname;
      if (path === "/internal/reserve") {
        return Response.json({ ok: true, reservation_id: `r_${++reservation}`, expires_at: Date.now() + 60_000 });
      }
      if (path === "/internal/settle") return Response.json({ ok: true, charged_usd: 0 });
      return Response.json({ ok: true });
    }),
    AI: {
      async run() {
        return {
          choices: [
            {
              message: {
                content: "",
                tool_calls: [{ id: "model_submit", function: { name: "submit", arguments: '{"summary":"test"}' } }],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        };
      },
    },
  } as unknown as Env;
  let agent = new Agent(context, env);
  const drain = async () => {
    while (background.length > 0) await Promise.all(background.splice(0));
  };
  const post = (path: string, body: unknown = {}) =>
    agent.fetch(
      new Request(`https://agent.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const inspect = async () =>
    (await (await agent.fetch(new Request("https://agent.test/internal/inspect"))).json()) as Inspection;
  return {
    tools,
    stops,
    post,
    drain,
    inspect,
    alarmAt: () => alarmAt,
    async open(real = false, started_at = NOW, settle = true) {
      const answer = await post("/open", {
        attempt_id: "a_backoff",
        intent_id: "i_test",
        change_id: "c_test",
        pool_id: "p_test",
        intent_text: "test retry",
        agent_kind: real ? "real" : "synthetic",
        ...(real
          ? { driver: "model", model: WORKHORSE_MODEL, imported: { guide_path: "", source: "fixture", branch: "main" } }
          : {
              script: { pattern: "retry-test", truth: [], steps: [{ tool: "submit", args: { summary: "test" } }] },
            }),
        started_at,
      });
      expect(answer.status).toBe(200);
      if (settle) await drain();
    },
    async alarm(at: number) {
      vi.setSystemTime(at);
      await agent.alarm();
      await drain();
    },
    async restart() {
      agent = new Agent(context, env);
      await drain();
    },
  };
}

function headsUp(): HeadsUp {
  return {
    hn: 1,
    attempt_id: "a_backoff",
    result: "info",
    wake: true,
    cause: { type: "landing", seqs: [1], changes: [{ seq: 1, change_id: "c_other", intent_text: "other" }] },
    items: [],
    dropped_ops: [],
    go_around: null,
    head_seq: 1,
    created_at: NOW,
  };
}

describe("Agent tool backoff", () => {
  it.each(["overloaded", "503", "transport"] as const)(
    "parks %s durably; early alarm, heads-up, recovery and restart cannot resend",
    async (failure) => {
      const f = fixture([failure]);
      await f.open();
      const first = await f.inspect();
      expect(f.tools).toHaveLength(1);
      expect(first.journal).toMatchObject({ tries: 1, deadline_at: NOW + 1_500, request: { waiting: true } });
      expect(first.transcript).toHaveLength(0);
      expect(f.alarmAt()).toBe(NOW + 1_500);

      await f.alarm(NOW + 1_499);
      await f.post("/push", { attempt_id: "a_backoff", heads_ups: [headsUp()] });
      await f.drain();
      await f.post("/internal/recover");
      await f.drain();
      await f.restart();
      expect(f.tools).toHaveLength(1);
      expect((await f.inspect()).journal).toEqual(first.journal);

      await f.alarm(NOW + 1_500);
      const last = await f.inspect();
      expect(f.tools).toHaveLength(2);
      expect(f.tools[1]!.request).toEqual(f.tools[0]!.request);
      expect(last.journal).toBeNull();
      expect(last.transcript.filter((row) => row.role === "tool")).toHaveLength(1);
      expect(last.meta.state).toBe("validated");
      expect(f.stops).toEqual([]);
    },
  );

  it.each([false, true])("keeps exponential retry counts and tool_timeout for real=%s", async (real) => {
    const f = fixture(["503", "overloaded", "transport"]);
    await f.open(real);
    const first = (await f.inspect()).journal!;
    expect(first.tries).toBe(1);
    expect(first.deadline_at).toBe(NOW + 1_500);
    await f.alarm(first.deadline_at);
    const second = (await f.inspect()).journal!;
    expect(f.tools).toHaveLength(2);
    expect(second.tries).toBe(2);
    expect(second.deadline_at).toBe(first.deadline_at + 3_000);
    expect((await f.inspect()).transcript.filter((row) => row.role === "tool")).toHaveLength(0);
    await f.alarm(second.deadline_at - 1);
    expect(f.tools).toHaveLength(2);
    await f.alarm(second.deadline_at);
    expect(f.tools).toHaveLength(1 + TOOL_RETRIES);
    expect(new Set(f.tools.map((call) => call.request.call_id)).size).toBe(1);
    expect(f.stops).toEqual(["tool_timeout"]);
    const last = await f.inspect();
    expect(last.meta.stop_reason).toBe("tool_timeout");
    expect(last.journal).toBeNull();
    expect(last.transcript.filter((row) => row.role === "tool")).toHaveLength(real ? 0 : 1);
  });

  it("jitters concurrent Agents' waits within the nonzero exponential bounds", async () => {
    vi.mocked(Math.random).mockReturnValueOnce(0).mockReturnValueOnce(0.999);
    const first = fixture(["503"]);
    const second = fixture(["503"]);
    await first.open();
    await second.open();
    expect((await first.inspect()).journal!.deadline_at - NOW).toBe(WAIT_BACKOFF_BASE_MS / 2);
    expect((await second.inspect()).journal!.deadline_at - NOW).toBe(WAIT_BACKOFF_BASE_MS - 1);
    expect(first.tools).toHaveLength(1);
    expect(second.tools).toHaveLength(1);
  });

  it("a retry gets the full tool timeout; a late rejection cannot consume the next parked retry", async () => {
    let reject!: (error: Error) => void;
    let seen!: () => void;
    const sending = new Promise<void>((resolve) => {
      seen = resolve;
    });
    const pending = new Promise<Response>((_resolve, rejectCall) => {
      reject = rejectCall;
    });
    const f = fixture([
      "503",
      () => {
        seen();
        return pending;
      },
    ]);
    await f.open();
    const first = (await f.inspect()).journal!;
    const alarm = f.alarm(first.deadline_at);
    await sending;
    const active = (await f.inspect()).journal!;
    expect(active.tries).toBe(1);
    expect(active.request.waiting).toBe(false);
    expect(active.deadline_at).toBe(first.deadline_at + TOOL_TIMEOUT_MS);

    await f.post("/push", { attempt_id: "a_backoff", heads_ups: [headsUp()] });
    await f.drain();
    await f.post("/internal/recover");
    await f.drain();
    expect(f.tools).toHaveLength(2);
    expect((await f.inspect()).journal).toEqual(active);

    // This alarm parks the still-in-flight second send. The rejected promise
    // is its late answer, so it must not consume another retry or shorten it.
    await f.alarm(active.deadline_at);
    const parked = (await f.inspect()).journal!;
    expect(parked.tries).toBe(2);
    expect(parked.request.waiting).toBe(true);
    reject(new Error("late transport failure"));
    await alarm;
    expect((await f.inspect()).journal).toEqual(parked);
    expect(f.tools).toHaveLength(2);
    await f.alarm(parked.deadline_at);
    expect(f.tools).toHaveLength(3);
    expect((await f.inspect()).meta.state).toBe("validated");
    expect(f.stops).toEqual([]);
  });

  it("a late pool_not_ready answer cannot replace the real Agent's newer retry wait", async () => {
    let resolve!: (response: Response) => void;
    let seen!: () => void;
    const sending = new Promise<void>((ready) => {
      seen = ready;
    });
    const pending = new Promise<Response>((answer) => {
      resolve = answer;
    });
    const f = fixture([
      "503",
      () => {
        seen();
        return pending;
      },
    ]);
    await f.open(true);
    const first = (await f.inspect()).journal!;
    const alarm = f.alarm(first.deadline_at);
    await sending;
    const active = (await f.inspect()).journal!;
    await f.alarm(active.deadline_at);
    const parked = (await f.inspect()).journal!;
    expect(parked.tries).toBe(2);
    expect(parked.request.waiting).toBe(true);
    resolve(transientTool(f.tools[1]!.request, "pool_not_ready"));
    await alarm;
    expect((await f.inspect()).journal).toEqual(parked);
    expect(f.tools).toHaveLength(2);
    await f.alarm(parked.deadline_at);
    expect(f.tools).toHaveLength(3);
    expect((await f.inspect()).meta.state).toBe("validated");
    expect(f.stops).toEqual([]);
  });

  it("MR5/TL12: real pool_not_ready parks without tries or tool rows, then resumes the same call", async () => {
    const f = fixture(["pool_not_ready", "pool_not_ready"]);
    await f.open(true);
    const first = (await f.inspect()).journal!;
    expect(f.tools).toHaveLength(1);
    expect(first).toMatchObject({ tries: 0, deadline_at: NOW + 2_000, request: { waits: 1, waiting: true } });
    await f.post("/internal/recover");
    await f.drain();
    await f.restart();
    await f.alarm(first.deadline_at - 1);
    expect(f.tools).toHaveLength(1);
    expect((await f.inspect()).transcript.filter((row) => row.role === "tool")).toHaveLength(0);

    await f.alarm(first.deadline_at);
    const second = (await f.inspect()).journal!;
    expect(second).toMatchObject({ tries: 0, deadline_at: NOW + 6_000, request: { waits: 2, waiting: true } });
    await f.alarm(second.deadline_at);
    expect(f.tools).toHaveLength(3);
    expect(new Set(f.tools.map((call) => call.request.call_id)).size).toBe(1);
    const last = await f.inspect();
    expect(last.journal).toBeNull();
    expect(last.transcript.filter((row) => row.role === "tool")).toHaveLength(1);
    expect(last.meta.tool_steps).toBe("1");
    expect(last.meta.state).toBe("validated");
  });

  it("MR5/TL12: a real timeout response uses the counted wait and writes no failed tool row", async () => {
    const f = fixture(["timeout"]);
    await f.open(true);
    const first = (await f.inspect()).journal!;
    expect(first).toMatchObject({ tries: 1, request: { waiting: true } });
    expect((await f.inspect()).transcript.filter((row) => row.role === "tool")).toHaveLength(0);
    await f.alarm(first.deadline_at);
    expect(f.tools).toHaveLength(2);
    expect((await f.inspect()).transcript.filter((row) => row.role === "tool")).toHaveLength(1);
    expect(f.stops).toEqual([]);
  });

  it.each([false, true])("the attempt time limit still stops a parked call with timeout for real=%s", async (real) => {
    const f = fixture(["503"]);
    await f.open(real, NOW - ATTEMPT_TIMEOUT_MS + 500);
    expect((await f.inspect()).journal!.deadline_at).toBeGreaterThan(NOW + 500);
    await f.alarm(NOW + 500);
    expect(f.tools).toHaveLength(1);
    expect(f.stops).toEqual(["timeout"]);
    expect((await f.inspect()).meta.stop_reason).toBe("timeout");
    expect((await f.inspect()).journal).toBeNull();
  });

  it.each([false, true])("a late alarm stops before resending when both deadlines passed for real=%s", async (real) => {
    const f = fixture(["503"]);
    await f.open(real, NOW - ATTEMPT_TIMEOUT_MS + 2_000);
    expect((await f.inspect()).journal!.deadline_at).toBeLessThan(NOW + 2_000);
    await f.alarm(NOW + 2_001);
    expect(f.tools).toHaveLength(1);
    expect(f.stops).toEqual(["timeout"]);
    expect((await f.inspect()).meta.stop_reason).toBe("timeout");
    expect((await f.inspect()).journal).toBeNull();
  });

  it("owner cancellation stops a parked call immediately with cancelled", async () => {
    const f = fixture(["overloaded"]);
    await f.open();
    await f.post("/stop");
    await f.drain();
    expect(f.tools).toHaveLength(1);
    expect(f.stops).toEqual(["cancelled"]);
    expect((await f.inspect()).journal).toBeNull();
  });

  it("an overdue recovery persists timeout when stop fails and respects the stop retry timer", async () => {
    const f = fixture(["overloaded"], 1);
    await f.open(false, NOW - ATTEMPT_TIMEOUT_MS + 2_000);
    vi.setSystemTime(NOW + 2_001);
    await f.post("/internal/recover");
    await f.drain();
    const waiting = await f.inspect();
    expect(f.tools).toHaveLength(1);
    expect(f.stops).toEqual(["timeout"]);
    expect(waiting.meta.pending_stop).toBe("timeout");
    const retry = waiting.timers.find((timer) => timer.kind === "call" && timer.key === "stop")!;
    expect(retry.due_at).toBe(NOW + 2_001 + HEADS_UP_REPUSH_MS);
    await f.post("/internal/recover");
    await f.drain();
    expect(f.stops).toEqual(["timeout"]);
    await f.alarm(retry.due_at);
    expect(f.stops).toEqual(["timeout", "timeout"]);
    expect((await f.inspect()).meta.stop_reason).toBe("timeout");
    expect((await f.inspect()).journal).toBeNull();
  });
});
