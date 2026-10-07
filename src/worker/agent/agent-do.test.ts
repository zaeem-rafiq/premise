// The Agent pump against fake Durable Object bindings and SQLite storage.
// No network, real clocks, models or service credentials are involved.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.ts";
import type { ToolRequest, ToolResponse } from "../../protocol/tools.ts";
import type { Script } from "./scripted-driver.ts";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { JournalRow } from "../../core/agent/store.ts";
import type { AttemptState } from "../../protocol/attempt.ts";
import {
  AGENT_WATCHDOG_MS,
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
    // A real answer mirrors Trunk's own attempt state: only a passing submit moves it.
    attempt: { state: request.tool === "submit" ? "validated" : "working", go_arounds: 0, pull_backs: 0 },
  } satisfies ToolResponse);
}

/** The scripted answers `/stop` can give, in send order; anything Trunk answers that does not
 * resolve the stop must leave it pending (TL16). A function hangs the send in flight. */
type StopOutcome = "ok" | "invalid_args" | "attempt_unknown" | "attempt_closed" | number | (() => Promise<Response>);

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

function fixture(
  outcomes: ToolOutcome[] = [],
  stopFailures = 0,
  opts: { stops?: StopOutcome[]; trunkState?: AttemptState; readContinuously?: boolean; usdPerModelCall?: number } = {},
) {
  const db = new DatabaseSync(":memory:");
  // What the fake Trunk's mirror reports: the answers `/stop` gives next, and
  // the attempt state `/sync` mirrors (stopping the attempt flips it).
  const trunk = {
    stops: [...(opts.stops ?? [])],
    state: opts.trunkState ?? ("opened" as AttemptState),
    sync: null as Promise<void> | null,
  };
  databases.push(db);
  const background: Promise<unknown>[] = [];
  const tools: Array<{ at: number; request: ToolRequest }> = [];
  const stops: string[] = [];
  const model = { replies: [] as Array<"list" | "empty" | "error">, calls: 0 };
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
    async getAlarm() {
      return alarmAt;
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
        const answer = trunk.stops.shift();
        if (typeof answer === "function") return answer();
        if (typeof answer === "number") return new Response("busy", { status: answer });
        if (answer === "invalid_args" || answer === "attempt_unknown" || answer === "attempt_closed") {
          return Response.json({ ok: false, error: answer });
        }
        if (stopFailures-- > 0) return new Response("busy", { status: 503 });
        trunk.state = "stopped";
        return Response.json({
          ok: true,
          stop_reason: body.reason,
          attempt: { state: "stopped", go_arounds: 0, pull_backs: 0 },
        });
      }
      if (path === "/sync") {
        await trunk.sync;
        return Response.json({
          head_seq: 0,
          heads_ups: [],
          heads_ups_more: false,
          attempt: { state: trunk.state, go_arounds: 0, pull_backs: 0 },
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
      if (path === "/internal/settle") return Response.json({ ok: true, charged_usd: opts.usdPerModelCall ?? 0 });
      return Response.json({ ok: true });
    }),
    AI: {
      async run() {
        model.calls++;
        const reply = model.replies.shift();
        if (reply === "error") throw new Error("model unavailable");
        return {
          choices: [
            {
              message: {
                content: "",
                tool_calls:
                  reply === "empty"
                    ? []
                    : opts.readContinuously || reply === "list"
                      ? (opts.readContinuously ? [0, 1] : [0]).map((n) => ({
                          id: `model_list_${n}`,
                          function: { name: "list", arguments: '{"path":"creatures/"}' },
                        }))
                      : [{ id: "model_submit", function: { name: "submit", arguments: '{"summary":"test"}' } }],
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
    model,
    tools,
    stops,
    trunk,
    post,
    drain,
    inspect,
    alarmAt: () => alarmAt,
    /** A reset rebuilt the object: the constructor runs on the same durable state. */
    spawn() {
      agent = new Agent(context, env);
    },
    async open(
      real = false,
      started_at = NOW,
      settle = true,
      steps: Script["steps"] = [{ tool: "submit", args: { summary: "test" } }],
    ) {
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
              script: { pattern: "retry-test", truth: [], steps },
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

describe("Agent resume budgets", () => {
  it.each(["empty", "error"] as const)(
    "AG6: a %s reply at the resumed model-call limit cannot send another call",
    async (lastReply) => {
      const f = fixture();
      await f.open(true);
      await f.post("/stop");
      await f.drain();
      expect(f.model.calls).toBe(1);
      f.model.replies = [...Array<"list">(11).fill("list"), lastReply];
      f.trunk.state = "working";
      await f.post("/resume", { resume_n: 1, revision: 2, attempt_id: "a_backoff" });
      await f.drain();
      if (lastReply === "error") {
        const parked = await f.inspect();
        expect(parked.journal?.kind).toBe("model");
        await f.alarm(parked.journal!.deadline_at);
      }
      const stopped = await f.inspect();
      expect(stopped.meta).toMatchObject({
        state: "stopped",
        stop_reason: "budget",
        model_calls: "13",
        model_limit: "13",
      });
      expect(f.model.calls).toBe(13); // One before stopping, then AG6's 12-call allowance.
      expect(stopped.journal).toBeNull();
    },
  );

  it.each([false, true])("AG6/RS2: resume grants fresh allowances from usage, at step limit=%s", async (atLimit) => {
    const f = fixture([], 0, { readContinuously: atLimit, usdPerModelCall: 0.001 });
    await f.open(true);
    if (!atLimit) {
      await f.post("/stop");
      await f.drain();
    }
    const before = await f.inspect();
    expect(before.meta.state).toBe("stopped");
    expect(before.meta.stop_reason).toBe(atLimit ? "budget" : "cancelled");
    expect(before.meta.tool_steps).toBe(atLimit ? "40" : "1");
    expect(before.meta.model_calls).toBe(atLimit ? "20" : "1");
    expect(Number(before.meta.usd_spent)).toBeCloseTo(atLimit ? 0.02 : 0.001, 10);

    // Hold the resume's sync so the snapshot observes acceptance, before any new spend.
    let release!: () => void;
    f.trunk.sync = new Promise<void>((resolve) => (release = resolve));
    f.trunk.state = "working";
    vi.setSystemTime(NOW + 60_000);
    expect(await (await f.post("/resume", { resume_n: 1, revision: 2, attempt_id: "a_backoff" })).json()).toEqual({
      ok: true,
      resume_n: 1,
    });
    const resumed = await f.inspect();
    // AG6: 15 steps, 12 model calls, and 300,000 ms counted from this resume.
    expect(resumed.meta.step_limit).toBe(atLimit ? "55" : "16");
    expect(resumed.meta.model_limit).toBe(atLimit ? "32" : "13");
    expect(resumed.meta.deadline_at).toBe(String(NOW + 60_000 + 300_000));
    expect(resumed.timers).toContainEqual({ kind: "attempt_timeout", key: "main", due_at: NOW + 360_000 });
    for (const key of [
      "tool_steps",
      "model_calls",
      "tokens_in",
      "tokens_out",
      "usd_spent",
      "token_limit",
      "usd_limit",
    ]) {
      expect(resumed.meta[key], key).toBe(before.meta[key]);
    }
    expect(resumed.meta.token_limit).toBe("400000");
    expect(resumed.meta.usd_limit).toBe("1");
    expect(resumed.meta.stop_reason).toBeUndefined();

    // RS2: retrying the accepted resume cannot accumulate another allowance or deadline.
    vi.setSystemTime(NOW + 61_000);
    await f.post("/resume", { resume_n: 1, revision: 2, attempt_id: "a_backoff" });
    expect((await f.inspect()).meta).toEqual(resumed.meta);
    release();
    await f.drain();
    const after = await f.inspect();
    expect(after.meta.state).toBe(atLimit ? "stopped" : "validated");
    expect(after.meta.tool_steps).toBe(atLimit ? "55" : "2");
  });
});

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

describe("Agent liveness (AL3)", () => {
  // The soak's invariant: while the attempt is neither landed nor stopped the
  // Agent holds a timer due within a watchdog interval and the platform alarm
  // is armed no later than it.
  const expectArmed = async (f: ReturnType<typeof fixture>, now: number) => {
    const s = await f.inspect();
    if (s.meta.state === "landed" || s.meta.state === "stopped") return s;
    expect(s.timers.length).toBeGreaterThan(0);
    const due = Math.min(...s.timers.map((t) => t.due_at));
    expect(due).toBeLessThanOrEqual(now + AGENT_WATCHDOG_MS);
    expect(f.alarmAt()).not.toBeNull();
    expect(f.alarmAt() ?? Infinity).toBeLessThanOrEqual(due);
    return s;
  };
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(done()).toBe(true);
  };

  it("TL16: a stop answer that cannot end the attempt keeps the pending stop and its retry", async () => {
    const f = fixture([], 0, { stops: ["invalid_args", "invalid_args"] });
    await f.open();
    await f.post("/stop");
    await f.drain();
    let s = await expectArmed(f, NOW);
    expect(s.meta.pending_stop).toBe("cancelled");
    const retry = s.timers.find((t) => t.kind === "call" && t.key === "stop");
    expect(retry?.due_at).toBe(NOW + HEADS_UP_REPUSH_MS);
    await f.alarm(NOW + HEADS_UP_REPUSH_MS);
    expect(f.stops).toEqual(["cancelled", "cancelled"]);
    s = await expectArmed(f, NOW + HEADS_UP_REPUSH_MS);
    expect(s.meta.pending_stop).toBe("cancelled");
    await f.alarm(NOW + 2 * HEADS_UP_REPUSH_MS);
    expect(f.stops).toEqual(["cancelled", "cancelled", "cancelled"]);
    s = await f.inspect();
    expect(s.meta.state).toBe("stopped");
    expect(s.meta.stop_reason).toBe("cancelled");
  });

  it("AG3: a watchdog that declares stalled stays armed while the stop it started is pending", async () => {
    const f = fixture([], 0, { stops: ["invalid_args"] });
    await f.open(false, NOW, true, [{ tool: "list", args: { path: "creatures/" } }]);
    let s = await f.inspect();
    const w1 = s.timers.find((t) => t.kind === "watchdog")!.due_at;
    await f.alarm(w1);
    s = await f.inspect();
    const w2 = s.timers.find((t) => t.kind === "watchdog")!.due_at;
    await f.alarm(w2);
    s = await expectArmed(f, w2);
    expect(s.meta.pending_stop).toBe("stalled");
    expect(f.stops).toEqual(["stalled"]);
    expect(s.timers.some((t) => t.kind === "watchdog")).toBe(true);
    const retry = s.timers.find((t) => t.kind === "call" && t.key === "stop");
    expect(retry?.due_at).toBeLessThanOrEqual(w2 + HEADS_UP_REPUSH_MS);
  });

  it("a reset rebuild sends the pending stop again even when no call is journaled", async () => {
    let release!: (r: Response) => void;
    const hung = new Promise<Response>((r) => (release = r));
    const f = fixture([], 0, { stops: [() => hung, "ok"] });
    await f.open();
    await f.post("/stop");
    await until(() => f.stops.length === 1);
    f.spawn();
    await until(() => f.stops.length === 2);
    release(
      Response.json({
        ok: true,
        stop_reason: "cancelled",
        attempt: { state: "stopped", go_arounds: 0, pull_backs: 0 },
      }),
    );
    await f.drain();
    expect((await f.inspect()).meta.state).toBe("stopped");
  });

  it("AL2: a throw inside the alarm handler still leaves the alarm armed", async () => {
    const f = fixture();
    await f.open(false, NOW - ATTEMPT_TIMEOUT_MS + 60_000, true, [{ tool: "list", args: { path: "x" } }]);
    // `items`/`dropped_ops` are missing: showing this heads-up throws inside the pump.
    await f.post("/push", {
      attempt_id: "a_backoff",
      heads_ups: [{ hn: 1, attempt_id: "a_backoff", wake: true, result: "info" }],
    });
    await f.drain().catch(() => {});
    const w1 = (await f.inspect()).timers.find((t) => t.kind === "watchdog")!.due_at;
    await expect(f.alarm(w1)).resolves.toBeUndefined();
    const s = await expectArmed(f, w1);
    expect(s.meta.state).not.toBe("stopped");
    const deadline = s.timers.find((t) => t.kind === "attempt_timeout")!.due_at;
    await f.alarm(deadline);
    expect(f.stops).toEqual(["timeout"]);
    expect((await f.inspect()).meta.state).toBe("stopped");
  });

  it("a stop retry armed before a resume sends nothing after it", async () => {
    const f = fixture([], 1);
    await f.open();
    await f.post("/stop");
    await f.drain();
    const sent = f.stops.length;
    const before = await f.inspect();
    const retry = before.timers.find((t) => t.kind === "call" && t.key === "stop")!;
    await f.post("/resume", { resume_n: 1, revision: 2, attempt_id: "a_backoff" });
    await f.drain();
    const s = await f.inspect();
    expect(s.meta.pending_stop ?? null).toBeNull();
    const stale = s.timers.find((t) => t.kind === "call" && t.key === "stop");
    await f.alarm(stale?.due_at ?? retry.due_at);
    expect(f.stops).toHaveLength(sent);
    expect((await f.inspect()).meta.state).not.toBe("stopped");
  });

  it("TL16: recovery does not resend a tool call while a stop is pending", async () => {
    let release!: (r: Response) => void;
    const hung = new Promise<Response>((r) => (release = r));
    const f = fixture([() => hung], 1);
    await f.open(false, NOW, false);
    await until(() => f.tools.length === 1);
    await f.post("/stop");
    await f.post("/internal/recover");
    await new Promise((r) => setTimeout(r, 10));
    expect(f.tools).toHaveLength(1);
    release(
      Response.json({
        call_id: f.tools[0]!.request.call_id,
        ok: true,
        head_seq: 0,
        result: { path: "creatures/", entries: [], truncated: false },
        premises: [],
        heads_ups: [],
        heads_ups_more: false,
        attempt: { state: "working", go_arounds: 0, pull_backs: 0 },
      }),
    );
    await f.drain();
  });
});
