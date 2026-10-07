// test/workerd/agent/liveness.test.ts — the soak's defect end to end in
// workerd: while the attempt is neither `landed` nor `stopped` the Agent
// holds at least one timer due within a watchdog interval and the platform
// alarm is armed no later than it (AG3, AL1). The paths exercised:
//
//   TL16  every answer `/stop` can give — the repeat ends only on the three
//         answers that resolve the attempt (ok, attempt_unknown, attempt_closed)
//   AL2   a throw inside the alarm handler leaves the alarm armed
//   AG4   the deadline ends a pending stop's attempt with `timeout`
//   the soak's wedge: refused stops must not drain every timer
//
// The fake Trunk drives the failure the soak saw: the connection is cut while
// the Agent waits on `/tool` (the platform's reset error is a transport throw
// on this side). `/stop` answers are scripted in send order.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AttemptState } from "../../../src/protocol/attempt.ts";
import type { HeadsUp } from "../../../src/protocol/headsup.ts";
import type { ToolRequest, ToolResponse } from "../../../src/protocol/tools.ts";
import { AGENT_WATCHDOG_MS, ATTEMPT_TIMEOUT_MS, TOOL_RETRIES } from "../../../src/protocol/constants.ts";
import { startWorker, type LocalWorker } from "../../support/workerd.ts";

type RecordedRequest = { path: string; body: Record<string, unknown> };

/** A scripted `/stop` answer: a named error body, an HTTP status, or ok. */
type StopAnswer = "ok" | "invalid_args" | "attempt_unknown" | "attempt_closed" | number;

type Inspection = {
  alarm: number | null;
  meta: Record<string, string>;
  journal: { call_id: string; kind: string; tries: number; request: { waiting?: boolean } } | null;
  timers: { kind: string; key: string; due_at: number }[];
  transcript: { step: number; role: string; tool: string | null; call_id: string | null; content: string }[];
};

class FakeTrunk {
  #server: Server | null = null;
  url = "";
  requests: RecordedRequest[] = [];
  /** The next N sends to `/tool` die on the wire — the soak's reset. */
  toolFailures = 0;
  /** The `/stop` answers, in send order; the queue drained, `stopDefault` answers. */
  stopAnswers: StopAnswer[] = [];
  stopDefault: StopAnswer = "ok";
  /** What `/sync` mirrors back. */
  state: AttemptState = "working";

  async listen(): Promise<void> {
    this.#server = createServer((req, res) => {
      if (req.method === "GET") {
        if (req.url === "/internal/state") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              pool: "test",
              meta: { summary_only: "0" },
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
        if (req.url === "/tool" && this.toolFailures > 0) {
          this.toolFailures -= 1;
          this.requests.push({ path: "/tool", body: JSON.parse(body) as Record<string, unknown> });
          req.socket.destroy();
          return;
        }
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
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  stops(attempt_id: string): string[] {
    return this.requests
      .filter((r) => r.path === "/stop" && r.body.attempt_id === attempt_id)
      .map((r) => String(r.body.reason));
  }

  async #handle(path: string, body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
    this.requests.push({ path, body });
    const attempt = (state: AttemptState = this.state) => ({ state, go_arounds: 0, pull_backs: 0 });
    if (path === "/tool") {
      const req = body as unknown as ToolRequest;
      const json: ToolResponse = {
        call_id: req.call_id,
        ok: true,
        head_seq: 0,
        result: req.tool === "submit" ? { status: "validated", submit_id: "s_x", tier: "auto", checks: [] } : {},
        premises: [],
        heads_ups: [],
        heads_ups_more: false,
        attempt: attempt(req.tool === "submit" ? "validated" : "working"),
      };
      return { status: 200, json };
    }
    if (path === "/sync") {
      return { status: 200, json: { heads_ups: [], heads_ups_more: false, head_seq: 0, attempt: attempt() } };
    }
    if (path === "/stop") {
      const answer = this.stopAnswers.shift() ?? this.stopDefault;
      if (typeof answer === "number") return { status: answer, json: { error: { code: "unavailable" } } };
      if (answer !== "ok") return { status: 200, json: { ok: false, error: answer } };
      this.state = "stopped";
      return { status: 200, json: { ok: true, stop_reason: body.reason, attempt: attempt("stopped") } };
    }
    if (path === "/register") {
      return { status: 200, json: { ok: false, error: "invalid_args" } };
    }
    return { status: 404, json: { error: { code: "not_found" } } };
  }
}

const LIST = { pattern: "t", truth: [], steps: [{ tool: "list", args: { path: "creatures/" } }] };

describe("an unfinished Agent always has an alarm that fires", () => {
  let worker: LocalWorker;
  let fake: FakeTrunk;

  beforeAll(async () => {
    fake = new FakeTrunk();
    await fake.listen();
    worker = await startWorker();
  }, 60_000);

  beforeEach(() => {
    fake.state = "working";
    fake.stopAnswers = [];
    fake.stopDefault = "ok";
    fake.toolFailures = 0;
    fake.requests = [];
  });

  afterAll(async () => {
    await worker.dispose();
    await fake.close();
  });

  function openAttempt(id: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    const q = encodeURIComponent(
      JSON.stringify({
        ...extra,
        attempt_id: id,
        intent_id: "i_t",
        change_id: "c_t",
        pool_id: "p_t",
        intent_text: "test",
        agent_kind: "synthetic",
        model: null,
        revision: 1,
        trunk_url: fake.url,
        script: LIST,
      }),
    );
    return worker.fetchDurableObject("AGENT", id, `/open?q=${q}`).then((r) => r.json());
  }

  const inspect = (id: string) =>
    worker.fetchDurableObject("AGENT", id, "/internal/inspect").then((r) => r.json()) as Promise<Inspection>;

  const alarm = (id: string, now: number) => worker.fetchDurableObject("AGENT", id, `/internal/alarm?now=${now}`);

  async function waitFor(check: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
    const end = Date.now() + ms;
    for (;;) {
      if (await check()) return;
      if (Date.now() > end) throw new Error("waitFor timed out");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** The invariant: an unfinished attempt has a timer due within the watchdog
   * interval and the platform alarm is armed no later than it. `now` is the
   * last driven clock reading (the alarm path's `?now=` or real time). */
  async function expectArmed(id: string, now: number): Promise<Inspection> {
    const s = await inspect(id);
    if (s.meta.state === "landed" || s.meta.state === "stopped") return s;
    expect(s.timers.length).toBeGreaterThan(0);
    const due = Math.min(...s.timers.map((t) => t.due_at));
    expect(due).toBeLessThanOrEqual(now + AGENT_WATCHDOG_MS);
    expect(s.alarm).not.toBeNull();
    expect(s.alarm ?? Infinity).toBeLessThanOrEqual(due);
    return s;
  }

  /** Sends that die on the wire: 1 + TOOL_RETRIES takes the call to
   * `pending_stop: "tool_timeout"`; the first `/stop` send rides the same run. */
  async function driveToPendingStop(id: string, extra: Record<string, unknown> = {}): Promise<Inspection> {
    fake.toolFailures = 1 + TOOL_RETRIES;
    await openAttempt(id, extra);
    // The drive ends when a pending stop stands, when the first answer already
    // ended the attempt (terminal), or when a non-resolving answer cleared the
    // pending flag without a journal — the wedge's own shape.
    const settled = (s: Inspection) =>
      s.meta.pending_stop !== undefined ||
      s.meta.state === "landed" ||
      s.meta.state === "stopped" ||
      (s.journal === null && fake.stops(id).length > 0);
    for (let i = 0; i < 20; i++) {
      let s = await inspect(id);
      if (settled(s)) return s;
      await waitFor(async () => {
        s = await inspect(id);
        return settled(s) || s.journal?.request.waiting === true;
      });
      s = await inspect(id);
      if (settled(s)) return s;
      const t = s.timers.find((x) => x.kind === "call" && x.key !== "stop");
      if (t !== undefined) await alarm(id, t.due_at);
    }
    throw new Error("pending_stop never set");
  }

  /** Fire the armed stop retry once, if the `call/stop` row exists. */
  async function driveStopRetry(id: string): Promise<void> {
    const s = await inspect(id);
    const t = s.timers.find((x) => x.kind === "call" && x.key === "stop");
    if (t !== undefined) await alarm(id, t.due_at);
  }

  it("TL16: a thrown stop send is retried by the call timer and lands", async () => {
    const id = "a_l16_throw";
    fake.stopAnswers = [503];
    await driveToPendingStop(id);
    await waitFor(() => fake.stops(id).length >= 1);
    const s = await expectArmed(id, Date.now());
    expect(s.meta.pending_stop).toBe("tool_timeout");
    await driveStopRetry(id);
    await waitFor(async () => (await inspect(id)).meta.state === "stopped");
    expect(fake.stops(id)).toEqual(["tool_timeout", "tool_timeout"]);
    expect((await inspect(id)).meta.stop_reason).toBe("tool_timeout");
  });

  it("TL16: ok ends the attempt and the repeat", async () => {
    const id = "a_l16_ok";
    await driveToPendingStop(id);
    await waitFor(async () => (await inspect(id)).meta.state === "stopped");
    expect((await inspect(id)).meta.stop_reason).toBe("tool_timeout");
    expect(fake.stops(id)).toEqual(["tool_timeout"]);
    // AG8: the next alarm retires the attempt's timers for good.
    await alarm(id, Date.now() + AGENT_WATCHDOG_MS + 1_000);
    const s = await inspect(id);
    expect(s.timers).toEqual([]);
    expect(s.alarm).toBeNull();
  });

  it("TL16: attempt_unknown stops the attempt with the pending reason", async () => {
    const id = "a_l16_unknown";
    fake.stopAnswers = ["attempt_unknown"];
    await driveToPendingStop(id);
    await waitFor(async () => (await inspect(id)).meta.state === "stopped");
    expect((await inspect(id)).meta.stop_reason).toBe("tool_timeout");
    expect(fake.stops(id)).toEqual(["tool_timeout"]);
  });

  it("TL16: attempt_closed syncs the attempt's real state instead", async () => {
    const id = "a_l16_closed";
    fake.state = "landed";
    fake.stopAnswers = ["attempt_closed"];
    await driveToPendingStop(id);
    await waitFor(async () => (await inspect(id)).meta.state === "landed");
    const s = await inspect(id);
    expect(s.meta.pending_stop ?? null).toBeNull();
    expect(fake.stops(id)).toEqual(["tool_timeout"]);
  });

  it("TL16: invalid_args cannot end the attempt — the stop repeats until an answer that can", async () => {
    const id = "a_l16_invalid";
    fake.stopAnswers = ["invalid_args", "invalid_args"];
    await driveToPendingStop(id);
    await waitFor(() => fake.stops(id).length >= 1);
    let s = await expectArmed(id, Date.now());
    expect(s.meta.pending_stop).toBe("tool_timeout");
    const retry = s.timers.find((t) => t.kind === "call" && t.key === "stop");
    expect(retry).toBeDefined();
    await alarm(id, retry!.due_at);
    await waitFor(() => fake.stops(id).length >= 2);
    s = await expectArmed(id, Date.now());
    expect(s.meta.pending_stop).toBe("tool_timeout");
    expect(s.meta.state).not.toBe("stopped");
    await driveStopRetry(id);
    await waitFor(() => fake.stops(id).length >= 3);
    await waitFor(async () => (await inspect(id)).meta.state === "stopped");
    expect(fake.stops(id)).toEqual(["tool_timeout", "tool_timeout", "tool_timeout"]);
  });

  it.each([500, 503])("TL16: an HTTP %s is a thrown send — the stop repeats and lands", async (status) => {
    const id = `a_l16_${status}`;
    fake.stopAnswers = [status];
    await driveToPendingStop(id);
    await waitFor(() => fake.stops(id).length >= 1);
    const s = await expectArmed(id, Date.now());
    expect(s.meta.pending_stop).toBe("tool_timeout");
    await driveStopRetry(id);
    await waitFor(() => fake.stops(id).length >= 2);
    await waitFor(async () => (await inspect(id)).meta.state === "stopped");
    expect((await inspect(id)).meta.stop_reason).toBe("tool_timeout");
  });

  it("the soak's wedge: refused stops cannot drain the timers to nothing", async () => {
    const id = "a_wedge";
    fake.stopDefault = "invalid_args"; // Trunk answers but refuses to end it
    {
      await driveToPendingStop(id);
      let s = await expectArmed(id, Date.now());
      expect(s.meta.pending_stop).toBe("tool_timeout");
      expect(s.timers.some((t) => t.kind === "call" && t.key === "stop")).toBe(true);

      // AG3's stall path: while the stop is pending the watchdog is exempt and
      // keeps its own row armed — a stalled attempt is not a dead one.
      for (let i = 0; i < 3; i++) {
        s = await inspect(id);
        const w = s.timers.find((t) => t.kind === "watchdog");
        if (w === undefined) break;
        await alarm(id, w.due_at);
        s = await expectArmed(id, w.due_at);
      }
      expect(s.meta.pending_stop ?? null).not.toBeNull();

      // AG4: the deadline passes while the stop is still refused.
      s = await inspect(id);
      const deadline = Number(s.meta.deadline_at);
      await alarm(id, deadline);
      s = await inspect(id);
      expect(s.meta.state).not.toBe("stopped");
      expect(s.meta.pending_stop).toBe("timeout");
      expect(s.timers.length).toBeGreaterThan(0);
      expect(s.alarm).not.toBeNull();

      // The next sent stop lands: the attempt closes with the deadline's reason.
      fake.stopDefault = "ok";
      await driveStopRetry(id);
      await waitFor(async () => (await inspect(id)).meta.state === "stopped");
      s = await inspect(id);
      expect(s.meta.stop_reason).toBe("timeout");
      expect(fake.stops(id)).toContain("timeout");
    }
  });

  it("AL2: a throw inside the alarm handler leaves the alarm armed", async () => {
    const id = "a_throw";
    await openAttempt(id);
    await waitFor(async () => (await inspect(id)).transcript.length === 1);
    // A heads-up the scripted renderer cannot read (`items`/`dropped_ops`
    // missing): showing it throws inside the pump the alarm calls.
    const q = encodeURIComponent(
      JSON.stringify({
        attempt_id: id,
        heads_ups: [{ hn: 1, attempt_id: id, wake: true, result: "info" } as unknown as HeadsUp],
      }),
    );
    await worker.fetchDurableObject("AGENT", id, `/push?q=${q}`);
    const w = (await inspect(id)).timers.find((t) => t.kind === "watchdog")!.due_at;
    const res = await alarm(id, w).catch(() => ({ status: 0 }) as { status: number });
    expect(res.status).toBe(200);
    const s = await expectArmed(id, w);
    expect(s.meta.state).not.toBe("stopped");
    // The deadline still ends the attempt: the poisoned heads-up cannot block
    // the stop path.
    await alarm(id, Number(s.meta.deadline_at));
    await waitFor(async () => (await inspect(id)).meta.state === "stopped");
    expect((await inspect(id)).meta.stop_reason).toBe("timeout");
    expect(fake.stops(id)).toEqual(["timeout"]);
  });

  it("AG4: the deadline rewrites a pending stop's reason and the retry still lands", async () => {
    const id = "a_deadline";
    fake.stopDefault = 503; // Trunk keeps throwing on /stop until the test lets it through
    {
      await openAttempt(id, { started_at: Date.now() - ATTEMPT_TIMEOUT_MS + 60_000 });
      await waitFor(async () => (await inspect(id)).transcript.length === 1);
      await worker.fetchDurableObject("AGENT", id, "/stop");
      await waitFor(() => fake.stops(id).length >= 1);
      let s = await expectArmed(id, Date.now());
      expect(s.meta.pending_stop).toBe("cancelled");
      const deadline = Number(s.meta.deadline_at);
      await alarm(id, deadline);
      s = await expectArmed(id, deadline);
      expect(s.meta.pending_stop).toBe("timeout");
      fake.stopDefault = "ok";
      await driveStopRetry(id);
      await waitFor(async () => (await inspect(id)).meta.state === "stopped");
      s = await inspect(id);
      expect(s.meta.stop_reason).toBe("timeout");
      expect(fake.stops(id)).toContain("timeout");
    }
  });
});
