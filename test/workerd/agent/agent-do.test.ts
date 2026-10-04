// test/workerd/agent/agent-do.test.ts — the Agent Durable Object in local
// workerd, against a local fake Trunk that follows src/protocol/tools.ts.
//
// Proved here:
//   AG1  the journal row exists before a tool call and is gone after it
//   TA2  a repeated call_id returns the stored response
//   SW4  a scripted agent runs the add-plain script through the same tools
//   TA9  an owner stop ends the attempt with the reason cancelled
//   HU6a an out-of-order push is answered by a sync before it is shown
//   3.6.6 a call answered attempt_unknown is followed by register
//
// The fake records every request, executes each new call_id once, keeps the
// response it stored, and returns that stored response to a repeat without
// executing again — TA2 from the Trunk side, seen by the Agent.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AttemptState } from "../../../src/protocol/attempt.ts";
import type { HeadsUp } from "../../../src/protocol/headsup.ts";
import type { ToolRequest, ToolResponse } from "../../../src/protocol/tools.ts";
import { startWorker, type LocalWorker } from "../../support/workerd.ts";

type RecordedRequest = { path: string; body: Record<string, unknown> };

function attemptBlock(state: AttemptState = "working") {
  return { state, go_arounds: 0, pull_backs: 0 };
}

function toolResponse(req: ToolRequest, result: object, state: AttemptState = "working"): ToolResponse {
  return {
    call_id: req.call_id,
    ok: true,
    head_seq: 0,
    result,
    premises: [],
    heads_ups: [],
    heads_ups_more: false,
    attempt: attemptBlock(state),
  };
}

class FakeTrunk {
  #server: Server | null = null;
  url = "";
  requests: RecordedRequest[] = [];
  served: RecordedRequest[] = [];
  executed: string[] = [];
  headsUps: HeadsUp[] = [];
  #stored = new Map<string, ToolResponse>();
  #inflight = new Map<string, Promise<ToolResponse>>();
  // The latest call number per attempt: a call_id belongs to its attempt,
  // never to a global sequence (TA2's "older call_id" is per attempt).
  #maxN = new Map<string, number>();
  // Attempts a rebuilt Trunk no longer knows: their calls answer
  // attempt_unknown until register restores them (3.6 step 6).
  forgotten = new Set<string>();
  #gates: {
    match: (body: Record<string, unknown>) => boolean;
    seen: (b: Record<string, unknown>) => void;
    release: Promise<void>;
  }[] = [];

  /** EV6: answered on `GET /internal/state` — the Agent learns the flag from
   * Trunk's own answer, the way it does against the real object. */
  summaryOnly = false;

  async listen(): Promise<void> {
    this.#server = createServer((req, res) => {
      if (req.method === "GET") {
        if (req.url === "/internal/state") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              pool: "test",
              meta: { summary_only: this.summaryOnly ? "1" : "0" },
              events_out: [],
              timers: [],
              outbox: null,
              served: {},
            }),
          );
        } else {
          res.writeHead(404).end();
        }
        return;
      }
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        void this.#handle(req.url ?? "", JSON.parse(body) as Record<string, unknown>).then((r) => {
          res.writeHead(r.status, { "content-type": "application/json" });
          res.end(JSON.stringify(r.json));
        });
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.#server?.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    this.#gates.forEach((g) => void g.release);
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  // Defer the next matching call's answer until release() — the deterministic
  // window in which the journal row is observable.
  hold(match: (body: Record<string, unknown>) => boolean): { seen: Promise<RecordedRequest>; release: () => void } {
    let releaseFn!: () => void;
    let seenFn!: (b: Record<string, unknown>) => void;
    const release = new Promise<void>((r) => (releaseFn = r));
    const seen = new Promise<RecordedRequest>((r) => (seenFn = (b) => r({ path: "/tool", body: b })));
    this.#gates.push({ match, seen: seenFn, release });
    return { seen, release: releaseFn };
  }

  async #handle(path: string, body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
    const entry = { path, body };
    this.requests.push(entry);
    if (path === "/tool") {
      const req = body as unknown as ToolRequest;
      if (this.forgotten.has(req.attempt_id)) {
        this.served.push(entry);
        return {
          status: 200,
          json: {
            call_id: req.call_id,
            ok: false,
            head_seq: 0,
            error: { code: "attempt_unknown", message: "attempt not known" },
            premises: [],
            heads_ups: [],
            heads_ups_more: false,
            attempt: attemptBlock(),
          },
        };
      }
      // TA2: a repeat of an in-flight or stored call_id returns the stored
      // response; nothing else changes.
      const pending = this.#inflight.get(req.call_id);
      if (pending !== undefined) {
        const stored = await pending;
        this.served.push(entry);
        return { status: 200, json: stored };
      }
      const stored = this.#stored.get(req.call_id);
      if (stored !== undefined) {
        this.served.push(entry);
        return { status: 200, json: stored };
      }
      // TA2: an older call_id that was never stored is invalid_args.
      const n = Number(req.call_id.split(":").at(-1));
      const maxN = this.#maxN.get(req.attempt_id) ?? 0;
      if (Number.isInteger(n) && n <= maxN) {
        const json = {
          call_id: req.call_id,
          ok: false,
          head_seq: 0,
          error: { code: "invalid_args", message: "call_id is not the latest" },
          premises: [],
          heads_ups: [],
          heads_ups_more: false,
          attempt: attemptBlock(),
        };
        this.served.push(entry);
        return { status: 200, json };
      }
      const promise = this.#execute(req);
      this.#inflight.set(req.call_id, promise);
      const json = await promise;
      this.#inflight.delete(req.call_id);
      this.served.push(entry);
      return { status: 200, json };
    }
    if (path === "/sync") {
      const heads_ups = this.headsUps;
      this.headsUps = [];
      return { status: 200, json: { heads_ups, heads_ups_more: false, head_seq: 0, attempt: attemptBlock() } };
    }
    if (path === "/stop") {
      return { status: 200, json: { ok: true, stop_reason: body.reason, attempt: attemptBlock("stopped") } };
    }
    if (path === "/register") {
      if (!this.forgotten.has(body.attempt_id as string)) {
        return { status: 200, json: { ok: false, error: "invalid_args" } };
      }
      this.forgotten.delete(body.attempt_id as string);
      return { status: 200, json: { ok: true, heads_ups: [], attempt: attemptBlock() } };
    }
    return { status: 404, json: { error: { code: "not_found" } } };
  }

  async #execute(req: ToolRequest): Promise<ToolResponse> {
    this.executed.push(req.call_id);
    const gate = this.#gates.findIndex((g) => g.match(req as unknown as Record<string, unknown>));
    if (gate >= 0) {
      const [g] = this.#gates.splice(gate, 1);
      g?.seen(req as unknown as Record<string, unknown>);
      await g?.release;
    }
    const state = req.tool === "submit" ? "validated" : "working";
    const args = req.args as { path?: string; content?: string };
    let result: object;
    switch (req.tool) {
      case "list":
        result = { path: args.path, entries: [{ name: "fish.js", type: "file", bytes: 100 }], truncated: false };
        break;
      case "read":
        result = { path: args.path, oid: "0".repeat(40), content: "// fake", edited_by_you: false };
        break;
      case "write":
        result = {
          path: args.path,
          op_seq: 1,
          created: true,
          bytes: String(args.content ?? "").length,
          added: [],
          altered: [],
          removed: [],
          relied_on_by: {},
        };
        break;
      case "submit":
        result = { status: "validated", submit_id: "s_fake", tier: "auto", checks: [] };
        break;
      default:
        result = {};
    }
    const resp = toolResponse(req, result, state);
    this.#stored.set(req.call_id, resp);
    const n = Number(req.call_id.split(":").at(-1));
    this.#maxN.set(req.attempt_id, Math.max(this.#maxN.get(req.attempt_id) ?? 0, Number.isNaN(n) ? 0 : n));
    return resp;
  }
}

const ADD_PLAIN = {
  pattern: "add-plain",
  truth: ["entity:world/movement.js#bounce", "entity:world/movement.js#step", "entity:world/movement.js#wander"],
  steps: [
    { tool: "list", args: { path: "creatures/" } },
    { tool: "read", args: { path: "GUIDE.md" } },
    { tool: "read", args: { path: "world/movement.js", entity: "bounce" } },
    { tool: "read", args: { path: "world/movement.js", entity: "step" } },
    { tool: "read", args: { path: "world/movement.js", entity: "wander" } },
    { tool: "write", args: { path: "creatures/ray.js", content: "export function spawn() { return {}; }" } },
    { tool: "submit", args: { summary: "add a creature" } },
  ],
};

function headsUp(hn: number, result: HeadsUp["result"], wake = true): HeadsUp {
  return {
    hn,
    attempt_id: "a_x",
    result,
    wake,
    cause: { type: "landing", seqs: [1], changes: [{ seq: 1, change_id: "c_o", intent_text: "other" }] },
    items: [],
    dropped_ops: [],
    go_around: null,
    head_seq: 1,
    created_at: 1,
  };
}

describe("the Agent Durable Object in workerd", () => {
  let worker: LocalWorker;
  let fake: FakeTrunk;

  beforeAll(async () => {
    fake = new FakeTrunk();
    await fake.listen();
    worker = await startWorker();
  }, 60_000);

  afterAll(async () => {
    await worker.dispose();
    await fake.close();
  });

  function openAttempt(id: string, script: object): Promise<unknown> {
    const q = encodeURIComponent(
      JSON.stringify({
        attempt_id: id,
        intent_id: "i_t",
        change_id: "c_t",
        pool_id: "p_t",
        intent_text: "test",
        agent_kind: "synthetic",
        model: null,
        revision: 1,
        trunk_url: fake.url,
        script,
      }),
    );
    return worker.fetchDurableObject("AGENT", id, `/open?q=${q}`).then((r) => r.json());
  }

  const inspect = (id: string) =>
    worker.fetchDurableObject("AGENT", id, "/internal/inspect").then((r) => r.json()) as Promise<{
      meta: Record<string, string>;
      journal: { call_id: string; kind: string; tries: number } | null;
      inbox: { hn: number; shown_step: number | null; result: string; wake: boolean }[];
      timers: { kind: string; key: string; due_at: number }[];
      transcript: { step: number; role: string; tool: string | null; call_id: string | null; content: string }[];
    }>;

  async function waitFor(check: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
    const end = Date.now() + ms;
    for (;;) {
      if (await check()) return;
      if (Date.now() > end) throw new Error("waitFor timed out");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("AG1: the journal row exists before a tool call and is gone after it", async () => {
    const gate = fake.hold((b) => b.call_id === "a_ag1:1");
    await openAttempt("a_ag1", { pattern: "t", truth: [], steps: [{ tool: "list", args: { path: "creatures/" } }] });
    await gate.seen;

    // The call is out: the journal row must exist (AG1, first half).
    let s = await inspect("a_ag1");
    expect(s.journal).not.toBeNull();
    expect(s.journal?.call_id).toBe("a_ag1:1");
    expect(s.journal?.kind).toBe("tool");
    expect(s.transcript).toHaveLength(0);

    // After the answer the row and its call timer are gone, and the
    // transcript has the tool row (AG1, second half).
    gate.release();
    await waitFor(async () => (await inspect("a_ag1")).journal === null);
    s = await inspect("a_ag1");
    expect(s.journal).toBeNull();
    expect(s.transcript.map((r) => [r.step, r.tool])).toEqual([[1, "list"]]);
    expect(s.timers.find((t) => t.kind === "call")).toBeUndefined();
  });

  it("TA2: a repeated call_id returns the stored response", async () => {
    const gate = fake.hold((b) => b.call_id === "a_ta2:1");
    await openAttempt("a_ta2", { pattern: "t", truth: [], steps: [{ tool: "list", args: { path: "creatures/" } }] });
    await gate.seen;

    // The journal row is present, so the call is sent again with the same
    // call_id — the path a restart takes (AG4).
    const recover = await worker.fetchDurableObject("AGENT", "a_ta2", "/internal/recover");
    expect(await recover.json()).toMatchObject({ ok: true });
    await waitFor(() => fake.requests.filter((r) => r.body.call_id === "a_ta2:1").length >= 2);
    gate.release();
    await waitFor(async () => (await inspect("a_ta2")).journal === null);

    // Trunk executed the call once; both sends got the one stored response.
    const sends = fake.requests.filter((r) => r.body.call_id === "a_ta2:1");
    const answers = fake.served.filter((r) => r.body.call_id === "a_ta2:1");
    expect(sends).toHaveLength(2);
    expect(answers).toHaveLength(2);
    expect(fake.executed.filter((id) => id === "a_ta2:1")).toHaveLength(1);
    const s = await inspect("a_ta2");
    expect(s.journal).toBeNull();
    expect(s.transcript.filter((r) => r.call_id === "a_ta2:1")).toHaveLength(1);
  });

  it("SW4: the scripted agent runs the add-plain script through the seven tools", async () => {
    await openAttempt("a_add", ADD_PLAIN);
    await waitFor(async () => (await inspect("a_add")).meta.state === "validated");
    const calls = fake.requests.filter((r) => r.path === "/tool" && r.body.attempt_id === "a_add");
    expect(calls.map((r) => r.body.tool)).toEqual(["list", "read", "read", "read", "read", "write", "submit"]);
    expect(calls.map((r) => r.body.call_id)).toEqual([
      "a_add:1",
      "a_add:2",
      "a_add:3",
      "a_add:4",
      "a_add:5",
      "a_add:6",
      "a_add:7",
    ]);
    expect(calls.every((r) => r.body.ack === 0)).toBe(true);
    const s = await inspect("a_add");
    expect(s.journal).toBeNull();
    expect(s.transcript.map((r) => r.step)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(s.meta.state).toBe("validated");
    expect(s.meta.shown_hn).toBe("0");
  });

  it("TA9: the owner stop ends the attempt with the reason cancelled", async () => {
    await openAttempt("a_stop", { pattern: "t", truth: [], steps: [{ tool: "list", args: { path: "creatures/" } }] });
    await waitFor(async () => (await inspect("a_stop")).transcript.length === 1);
    const res = await worker.fetchDurableObject("AGENT", "a_stop", "/api/pools/p_t/attempts/a_stop/stop");
    expect(await res.json()).toMatchObject({ ok: true });
    await waitFor(async () => (await inspect("a_stop")).meta.state === "stopped");
    const stops = fake.requests.filter((r) => r.path === "/stop" && r.body.attempt_id === "a_stop");
    expect(stops.map((r) => r.body.reason)).toEqual(["cancelled"]);
    const s = await inspect("a_stop");
    expect(s.meta.stop_reason).toBe("cancelled");
  });

  it("AG8: a stopped attempt keeps no timer and never calls Trunk again", async () => {
    await openAttempt("a_quiet", { pattern: "t", truth: [], steps: [{ tool: "list", args: { path: "creatures/" } }] });
    await waitFor(async () => (await inspect("a_quiet")).transcript.length === 1);
    await worker.fetchDurableObject("AGENT", "a_quiet", "/api/pools/p_t/attempts/a_quiet/stop");
    await waitFor(async () => (await inspect("a_quiet")).meta.state === "stopped");
    // The attempt is closed: its next run retires the watchdog, time-out, sync and call timers.
    await worker.fetchDurableObject("AGENT", "a_quiet", "/internal/alarm");
    const s = await inspect("a_quiet");
    expect(s.timers.filter((timer) => timer.kind !== "events" && timer.kind !== "release")).toEqual([]);
    // And later alarm runs send Trunk nothing: a finished Agent is quiet.
    const sent = () => fake.requests.filter((r) => r.body.attempt_id === "a_quiet").length;
    const before = sent();
    await worker.fetchDurableObject("AGENT", "a_quiet", "/internal/alarm");
    await worker.fetchDurableObject("AGENT", "a_quiet", "/internal/alarm");
    expect(sent()).toBe(before);
  });

  it("HU6a: an out-of-order push is answered by a sync before anything is shown", async () => {
    await openAttempt("a_gap", { pattern: "t", truth: [], steps: [{ tool: "list", args: { path: "creatures/" } }] });
    await waitFor(async () => (await inspect("a_gap")).transcript.length === 1);

    // hn 2 arrives first: nothing may be shown; the Agent syncs for hn 1.
    const push = await worker.fetchDurableObject(
      "AGENT",
      "a_gap",
      `/push?q=${encodeURIComponent(
        JSON.stringify({ attempt_id: "a_gap", heads_ups: [{ ...headsUp(2, "repair"), attempt_id: "a_gap" }] }),
      )}`,
    );
    expect(await push.json()).toMatchObject({ ok: true });
    await waitFor(() => fake.requests.some((r) => r.path === "/sync" && r.body.attempt_id === "a_gap"));
    const beforeSync = await inspect("a_gap");
    expect(beforeSync.inbox.map((i) => i.hn)).toEqual([2]);
    expect(beforeSync.meta.shown_hn).toBe("0");

    // The sync delivers hn 1; now the run 1, 2 is shown in one user row.
    fake.headsUps = [{ ...headsUp(1, "confirm"), attempt_id: "a_gap" }];
    await waitFor(async () => (await inspect("a_gap")).meta.shown_hn === "2");
    const s = await inspect("a_gap");
    const userRows = s.transcript.filter((r) => r.role === "user");
    expect(userRows).toHaveLength(1);
    const shown = (JSON.parse(userRows[0]?.content ?? "{}") as { heads_ups: { hn: number }[] }).heads_ups;
    expect(shown.map((h) => h.hn)).toEqual([1, 2]);
    expect(s.inbox.every((i) => i.shown_step === 2)).toBe(true);
  });

  it("3.6 step 6: a call answered attempt_unknown is followed by register", async () => {
    // The rebuilt Trunk forgot the attempt before it opened: every call
    // answers attempt_unknown until the Agent registers its mirror.
    fake.forgotten.add("a_reg");
    await openAttempt("a_reg", {
      pattern: "t",
      truth: ["entity:world/energy.js#ENERGY_MAX"],
      steps: [
        { tool: "list", args: { path: "creatures/" } },
        { tool: "read", args: { path: "world/energy.js" } },
      ],
    });
    await waitFor(() => fake.requests.some((r) => r.path === "/register" && r.body.attempt_id === "a_reg"));

    // The register carries the mirror of 3.6 step 6: intent, revision,
    // operations and read premises — and the truth list (TR8).
    const reg = fake.requests.find((r) => r.path === "/register" && r.body.attempt_id === "a_reg");
    expect(reg?.body).toMatchObject({
      intent_id: "i_t",
      change_id: "c_t",
      revision: 1,
      agent_kind: "synthetic",
      truth: ["entity:world/energy.js#ENERGY_MAX"],
    });
    expect(Array.isArray(reg?.body.ops)).toBe(true);
    expect(Array.isArray(reg?.body.read_premises)).toBe(true);

    // Registered, the attempt runs the rest of its script: the transcript
    // shows the refused list call, then the read that now succeeds.
    await waitFor(async () => (await inspect("a_reg")).transcript.length === 2);
    const s = await inspect("a_reg");
    expect(s.meta.register_needed).toBe("0");
    expect(s.transcript.map((r) => r.tool)).toEqual(["list", "read"]);
    expect(fake.requests.filter((r) => r.path === "/register" && r.body.attempt_id === "a_reg")).toHaveLength(1);
  });
});
