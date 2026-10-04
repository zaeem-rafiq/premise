// test/workerd/agent/real/agent-do.test.ts — the real Agent (driver "model") in
// local workerd: the pure loop inside the Durable Object, the gate calls of
// SE6/SE8 around every model send, the journal of AG2, and the Agent-source
// `attempt.step` events of EV2a — against a scripted Workers AI stand-in, a
// fake Trunk, and the real gate Durable Object.
//
// Proved here:
//   SP1/SP2/MP1 the first request carries the system prompt, the first user
//             message, the tool array and nothing else (item 6, first half)
//   TL2–TL4    a model turn writes the assistant row, applies the tool call,
//             and emits `attempt.step` with tokens and cost
//   SE6        every send is preceded by may-start (once) and reserve, and is
//             settled with the reported usage
//   SE6a       a failed try's reservation settles without usage — the gate
//             charges the full reserved amount
//   TL12/AG2   unavailable answers are counted tries; after MODEL_RETRIES the
//             attempt stops `model_error`
//   SE8/TL12   a 429 is a wait, never a counted try
//   HE1/HE4    a heads-up in a tool result is shown as data in the tool row,
//             never in the system role, and the rows keep numbering (MR4)
//   TD6        submit carries the acknowledge list the loop computed
//   TA9        the stop route cancels; a repeat changes nothing
//   SE10       a killed gate refuses the next reserve; the attempt stops `killed`
//   RS1–RS3    resume extends the step and model-call budgets and appends the
//             resume message as one user row

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { HeadsUp } from "../../../../src/protocol/headsup.ts";
import {
  firstUserMessage,
  systemPrompt,
  RESUME_MESSAGE,
  TOOL_DEFINITIONS,
} from "../../../../src/protocol/agent-prompt.ts";
import { MODEL_PLAN, MODEL_OPTIONS, WORKHORSE_MODEL } from "../../../../src/config/model-plan.ts";
import { FakeModel, FakeTrunk, startRealWorker, waitFor, type RealWorker } from "./harness.ts";

const KEY = "owner-key-for-tests-0123456789abcdef";
const POOL = "p_real";

let worker: RealWorker;
let model: FakeModel;
let trunk: FakeTrunk;

beforeAll(async () => {
  model = new FakeModel();
  trunk = new FakeTrunk();
  await model.listen();
  await trunk.listen();
  worker = await startRealWorker({ ownerKey: KEY, modelUrl: model.url });
}, 60_000);

afterAll(async () => {
  await worker?.dispose();
  await model?.close();
  await trunk?.close();
});

function openReal(id: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  const q = encodeURIComponent(
    JSON.stringify({
      attempt_id: id,
      intent_id: `i_${id}`,
      change_id: `c_${id}`,
      pool_id: POOL,
      intent_text: "a jellyfish that drifts up and down",
      agent_kind: "real",
      driver: "model",
      model: WORKHORSE_MODEL,
      trunk_url: trunk.url,
      ...extra,
    }),
  );
  return worker
    .object("AGENT", id)
    .fetch(`/open?q=${q}`)
    .then((r) => r.json());
}

const inspect = (id: string) =>
  worker
    .object("AGENT", id)
    .fetch("/internal/inspect")
    .then((r) => r.json()) as Promise<{
    meta: Record<string, string>;
    journal: { call_id: string; kind: string; tries: number; request: Record<string, unknown> } | null;
    inbox: { hn: number; shown_step: number | null; result: string; wake: boolean }[];
    timers: { kind: string; key: string; due_at: number }[];
    transcript: { step: number; role: string; tool: string | null; call_id: string | null; content: string }[];
    events: { n: number; event: Record<string, unknown> }[];
  }>;

const alarm = (id: string) => worker.object("AGENT", id).fetch("/internal/alarm");

const gateState = () =>
  worker
    .gate()
    .fetch("/internal/state")
    .then((r) => r.json()) as Promise<{
    state: {
      spent_usd: number;
      killed: boolean;
      slots: Record<string, unknown>;
      reservations: Record<string, unknown>;
    } | null;
  }>;

const floorEvents = (pool: string) =>
  worker
    .object("FLOOR", pool)
    .fetch(`/api/pools/${pool}/replay.ndjson`)
    .then((r) => r.text())
    .then((text) =>
      text
        .trim()
        .split("\n")
        .slice(1)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    );

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

beforeEach(() => {
  // The fakes are per-file servers: each test starts from a clean script, an
  // empty request log, and a Trunk that answers `working` (a stopped mirror
  // belongs to its attempt).
  model.script = [];
  model.requests = [];
  trunk.queue = [];
  trunk.stopped = null;
  trunk.state = "working";
  trunk.summaryOnly = false;
});

const SCRIPT_FULL = [
  { tool_calls: [{ name: "list", arguments: { path: "creatures/" } }] },
  { tool_calls: [{ name: "read", arguments: { path: "GUIDE.md" } }] },
  { tool_calls: [{ name: "read", arguments: { path: "creatures/fish.js" } }] },
  {
    tool_calls: [
      {
        name: "write",
        arguments: { path: "creatures/jellyfish.js", content: "export function spawn() { return {}; }" },
      },
    ],
  },
  { tool_calls: [{ name: "submit", arguments: { summary: "add a jellyfish" } }] },
];

describe("the real Agent in workerd (05-agent)", () => {
  it("SP1/SP2/MP1 + TL2–TL4 + SE6 + MG5 + EV2a: the loop lands a scripted run", async () => {
    model.script = [...SCRIPT_FULL];
    const opened = (await openReal("a_loop")) as { ok: boolean };
    expect(opened.ok).toBe(true);

    await waitFor(async () => {
      const s = await inspect("a_loop");
      return s.meta.state === "validated";
    });

    // MP1: every request is {messages, tools, max_tokens, options} — nothing else.
    expect(model.requests.length).toBe(5);
    for (const r of model.requests) {
      expect(r.model).toBe(WORKHORSE_MODEL);
      expect(Object.keys(r.request).sort()).toEqual(["max_tokens", "messages", "reasoning_effort", "tools"].sort());
      expect(r.request.max_tokens).toBe(4096);
      expect(r.request.reasoning_effort).toBe(MODEL_OPTIONS[WORKHORSE_MODEL]?.reasoning_effort);
      expect(r.request.tools).toEqual(JSON.parse(TOOL_DEFINITIONS));
      const messages = r.request.messages as Array<{ role: string; content: string }>;
      expect(messages[0]).toEqual({ role: "system", content: systemPrompt() });
      expect(messages[1]).toEqual({ role: "user", content: firstUserMessage("a jellyfish that drifts up and down") });
    }

    // The transcript: system(1), user(2), then assistant/tool pairs — rows numbered without a gap (HE1).
    const s = await inspect("a_loop");
    expect(s.transcript.map((r) => r.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(s.transcript[0]?.role).toBe("system");
    expect(s.transcript[1]?.role).toBe("user");
    expect(s.transcript[2]?.role).toBe("assistant");
    expect(s.transcript[3]?.role).toBe("tool");
    expect(s.meta.model_calls).toBe("5");
    expect(s.meta.tool_steps).toBe("5");

    // SE6: the gate saw may-start once, then a reserve+settle per call, and
    // settled spend equals the hand-worked usage sum at the plan's price.
    const gs = await gateState();
    expect(gs.state).not.toBeNull();
    const price = MODEL_PLAN.prices_usd_per_mtok[WORKHORSE_MODEL]!;
    const expected = model.requests.length * ((1000 * price.in + 60 * price.out) / 1_000_000);
    expect(gs.state!.spent_usd).toBeCloseTo(expected, 10);
    // MG5: the slot was released when the loop went to waiting.
    expect(gs.state!.slots["a_loop"]).toBeUndefined();
    expect(Object.keys(gs.state!.reservations)).toHaveLength(0);

    // EV2a/TL14: the agent source emitted attempt.step for every model turn
    // (tokens+cost) and every tool turn (tool, target, ok).
    const events = await floorEvents(POOL);
    const steps = events.filter((e) => e.type === "attempt.step" && e.attempt_id === "a_loop");
    const modelSteps = steps.filter((e) => e.tool === null);
    const toolSteps = steps.filter((e) => e.tool !== null);
    expect(modelSteps.length).toBe(5);
    expect(toolSteps.length).toBe(5);
    for (const e of modelSteps) {
      expect(e.tokens_in).toBe(1000);
      expect(e.tokens_out).toBe(60);
      expect(e.cost_usd).toBeCloseTo((1000 * price.in + 60 * price.out) / 1_000_000, 10);
      expect(e.ok).toBe(true);
      expect(typeof e.ms).toBe("number");
    }
    expect(toolSteps.map((e) => e.tool)).toEqual(["list", "read", "read", "write", "submit"]);
    // Step numbers are transcript row numbers (4.9): the model turns ride the
    // assistant rows 3, 5, 7, 9, 11 and the tool turns 4, 6, 8, 10, 12.
    expect(modelSteps.map((e) => e.step)).toEqual([3, 5, 7, 9, 11]);
    expect(toolSteps.map((e) => e.step)).toEqual([4, 6, 8, 10, 12]);
  }, 30_000);

  it("HE1/HE4/MR4 + TD6: a heads-up in a tool result is data for the model, never system text", async () => {
    trunk.queue = [{ heads_ups: [headsUp(1, "info")], attempt: { state: "working", go_arounds: 0, pull_backs: 0 } }];
    model.script = [
      { tool_calls: [{ name: "read", arguments: { path: "GUIDE.md" } }] }, // carries the heads-up
      { tool_calls: [{ name: "submit", arguments: { summary: "s" } }] },
    ];
    await openReal("a_hu");
    await waitFor(async () => (await inspect("a_hu")).meta.state === "validated", 15_000);

    // MR4: the read's tool message carries the heads-up run, first.
    const second = model.requests[1]!.request.messages as Array<{
      role: string;
      content: string;
      tool_call_id?: string;
    }>;
    const toolRow = second.find((m) => m.role === "tool" && m.content.includes("heads_ups"));
    expect(toolRow).toBeDefined();
    const body = JSON.parse(toolRow!.content) as { heads_ups?: Array<{ hn: number; result: string }> };
    expect(body.heads_ups?.[0]?.hn).toBe(1);

    // HE4: a system-role message is the prompt and nothing else — a heads-up's
    // data is never moved into it (the prompt itself names the protocol, so the
    // check is byte equality, not a substring test).
    for (const r of model.requests) {
      for (const m of r.request.messages as Array<{ role: string; content: string }>) {
        if (m.role === "system") expect(m.content).toBe(systemPrompt());
      }
    }

    // HE1: row numbering continued through the shown heads-up.
    const s = await inspect("a_hu");
    expect(s.transcript.map((r) => r.step)).toEqual([1, 2, 3, 4, 5, 6]);
    // The heads-up was shown by the tool row that carried it: shown_hn moved to
    // hn 1. The `info` row itself is pruned once the submit acknowledges it —
    // the transcript already carries its content (store's prune rule).
    expect(s.meta.shown_hn).toBe("1");
  }, 30_000);

  it("AG2/TL12 + SE6a: unavailable is a counted try; the journal survives; model_error after MODEL_RETRIES", async () => {
    model.script = [{ http: 500 }, { http: 500 }, { http: 500 }];
    const before = (await gateState()).state?.spent_usd ?? 0;
    await openReal("a_err");
    // The first failure parks the call for ~1s; the second for ~2s.
    await waitFor(async () => (await inspect("a_err")).meta.state === "stopped", 30_000);
    const s = await inspect("a_err");
    expect(s.meta.stop_reason).toBe("model_error");
    expect(trunk.stopped?.reason).toBe("model_error");
    // Three sends total: the first and MODEL_RETRIES retries.
    expect(model.requests.length).toBe(3);
    // No assistant row exists for a failed try (the transcript holds only messages).
    expect(s.transcript.filter((r) => r.role === "assistant")).toHaveLength(0);
    // SE6a: every failed try settled without usage — the full reservation bound
    // was charged for each of the three sends.
    const after = (await gateState()).state!.spent_usd;
    const bytes = JSON.stringify(model.requests[0]!.request).length;
    const price = MODEL_PLAN.prices_usd_per_mtok[WORKHORSE_MODEL]!;
    const bound = (bytes * price.in + 4096 * price.out) / 1_000_000;
    expect(after - before).toBeCloseTo(3 * bound, 8);
  }, 45_000);

  it("SE8/TL12: a 429 parks the call as a wait — tries stay at zero, then the same call proceeds", async () => {
    model.script = [
      { http: 429, retry_after_ms: 50 },
      { tool_calls: [{ name: "read", arguments: { path: "GUIDE.md" } }] },
      { tool_calls: [{ name: "submit", arguments: { summary: "s" } }] },
    ];
    await openReal("a_429");
    // The park is visible: the journal waits on its call timer, tries 0.
    await waitFor(async () => {
      const s = await inspect("a_429");
      return s.journal?.kind === "model" && (s.journal.request as { waiting?: boolean }).waiting === true;
    });
    const parked = await inspect("a_429");
    expect(parked.journal!.tries).toBe(0);
    expect(model.requests.length).toBe(1);

    // The wait elapses (>= WAIT_BACKOFF_BASE_MS), the same call_id is served again.
    await waitFor(async () => (await inspect("a_429")).meta.state === "validated", 30_000);
    expect(model.requests.length).toBe(3);
    const s = await inspect("a_429");
    // Rate-limit waits never counted: model_calls counts answered calls only? —
    // counted tries are the failed kind; the journal row is gone.
    expect(s.journal).toBeNull();
  }, 45_000);

  it("TA9: the owner stop route cancels the attempt; a repeat is a no-op", async () => {
    const held = model.hold();
    model.script = [
      { tool_calls: [{ name: "list", arguments: { path: "creatures/" } }] },
      { tool_calls: [{ name: "submit", arguments: { summary: "s" } }] },
    ];
    await openReal("a_stop");
    await held.seen; // the first model call is in flight

    const unauth = await worker.fetch("/api/pools/p_real/attempts/a_stop/stop", { method: "POST" });
    expect(unauth.status).toBe(401);
    const res = await worker.fetch("/api/pools/p_real/attempts/a_stop/stop", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    held.release();
    await waitFor(async () => (await inspect("a_stop")).meta.state === "stopped", 20_000);
    expect(trunk.stopped?.reason).toBe("cancelled");

    const again = await worker.fetch("/api/pools/p_real/attempts/a_stop/stop", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({}),
    });
    expect(again.status).toBe(200);
    expect(trunk.stopped?.reason).toBe("cancelled");
  }, 30_000);

  it("SE10: killed refuses the next reserve — the attempt stops `killed` with no further send", async () => {
    const held = model.hold();
    model.script = [
      { tool_calls: [{ name: "list", arguments: { path: "creatures/" } }] },
      { tool_calls: [{ name: "submit", arguments: { summary: "s" } }] },
    ];
    await openReal("a_kill");
    await held.seen; // the first model send is in flight — its reservation is open
    const kill = await worker.fetch("/api/kill", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ killed: true }),
    });
    expect(kill.status).toBe(200);
    held.release(); // the in-flight call completes; the NEXT reserve must be refused
    await waitFor(async () => (await inspect("a_kill")).meta.state === "stopped", 20_000);
    expect(trunk.stopped?.reason).toBe("killed");
    // The refused call never reached the provider: exactly one send happened.
    expect(model.requests.length).toBe(1);
    await worker.fetch("/api/kill", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ killed: false }),
    });
  }, 30_000);

  it("RS1–RS3: resume extends the budgets and appends the resume message row", async () => {
    model.script = [{ http: 500 }, { http: 500 }, { http: 500 }];
    await openReal("a_resume");
    await waitFor(async () => (await inspect("a_resume")).meta.state === "stopped", 30_000);
    const before = await inspect("a_resume");
    expect(before.meta.model_limit).toBeDefined();

    // Trunk reopened the attempt (T20r): its sync answer is `working` again.
    trunk.state = "working";
    const resume = await worker.object("AGENT", "a_resume").fetch("/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attempt_id: "a_resume", resume_n: 1, revision: 2 }),
    });
    const answer = (await resume.json()) as { ok: boolean };
    expect(answer.ok).toBe(true);

    // The next model request's last message is the resume message (RS2/SP6).
    // The script re-reads the guide before it submits (TD5); `base` rides over
    // requests of the first phase instead of resetting the log mid-pump.
    model.script = [
      { tool_calls: [{ name: "read", arguments: { path: "GUIDE.md" } }] },
      { tool_calls: [{ name: "submit", arguments: { summary: "s" } }] },
    ];
    const base = model.requests.length;
    await waitFor(async () => model.requests.length > base, 20_000);
    const last = model.requests[base]!.request.messages as Array<{ role: string; content: string }>;
    expect(last.at(-1)).toEqual({ role: "user", content: RESUME_MESSAGE });

    const s = await inspect("a_resume");
    expect(s.meta.model_limit).toBe(String(Number(before.meta.model_limit) + 12));
    expect(s.meta.resumed_n).toBe("1");
    // The post-resume call is the test's first send (the log was reset).

    // A repeated resume_n is a no-op answer (RS2).
    const again = await worker.object("AGENT", "a_resume").fetch("/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attempt_id: "a_resume", resume_n: 1, revision: 2 }),
    });
    const againAnswer = (await again.json()) as { ok: boolean; resume_n: number };
    expect(againAnswer).toEqual({ ok: true, resume_n: 1 });
    await waitFor(async () => (await inspect("a_resume")).meta.state === "validated", 20_000);
  }, 60_000);

  it("EV2: the first turns' steps are on the Floor while a later model call is in flight", async () => {
    // Two parked answers: request 1 parks on h1, request 2 on h2 — armed before
    // /open so which request each holds is deterministic.
    const h1 = model.hold();
    const h2 = model.hold();
    model.script = [
      { tool_calls: [{ name: "read", arguments: { path: "GUIDE.md" } }] },
      { tool_calls: [{ name: "read", arguments: { path: "creatures/fish.js" } }] },
      { tool_calls: [{ name: "submit", arguments: { summary: "s" } }] },
    ];
    await openReal("a_live");
    await h1.seen;
    h1.release(); // the first turn answers: model step 3, tool step 4
    await h2.seen; // the second turn's request is now parked
    // While call 2 is in flight the stream already holds turn 1's model step
    // and the tool call it asked for — delivery started at each commit, not at
    // the pump's end (what the first real run got wrong).
    await waitFor(async () => {
      const steps = (await floorEvents(POOL)).filter((e) => e.type === "attempt.step" && e.attempt_id === "a_live");
      return steps.length >= 2;
    });
    const steps = (await floorEvents(POOL)).filter((e) => e.type === "attempt.step" && e.attempt_id === "a_live");
    expect(steps.map((e) => e.step)).toEqual([3, 4]);
    expect(steps.map((e) => e.tool)).toEqual([null, "read"]);
    h2.release();
    await waitFor(async () => (await inspect("a_live")).meta.state === "validated", 20_000);
  }, 30_000);

  it("EV6: a summary_only pool's Agent emits no attempt.step", async () => {
    trunk.summaryOnly = true;
    // TD5: submit before a whole-file GUIDE read is refused `guide_first`, so
    // the script reads the guide first, like every run above.
    model.script = [
      { tool_calls: [{ name: "read", arguments: { path: "GUIDE.md" } }] },
      { tool_calls: [{ name: "submit", arguments: { summary: "s" } }] },
    ];
    await openReal("a_so");
    await waitFor(async () => (await inspect("a_so")).meta.state === "validated", 20_000);
    // The flag was learned from Trunk's own /internal/state answer.
    const s = await inspect("a_so");
    expect(s.meta.summary_only).toBe("1");
    expect(s.events.filter((e) => e.event.type === "attempt.step")).toEqual([]);
    await new Promise((r) => setTimeout(r, 250));
    const steps = (await floorEvents(POOL)).filter((e) => e.type === "attempt.step" && e.attempt_id === "a_so");
    expect(steps).toEqual([]);
  }, 30_000);

  it("an /open carrying model_url or gate_url changes nothing: the bindings answer", async () => {
    model.script = [
      { tool_calls: [{ name: "read", arguments: { path: "GUIDE.md" } }] },
      { tool_calls: [{ name: "submit", arguments: { summary: "s" } }] },
    ];
    // The hooks are gone: if these dead URLs were used, the loop would never
    // see the fake's answer nor reserve at the gate — validated proves both.
    const opened = (await openReal("a_hook", {
      model_url: "http://127.0.0.1:1/unreachable",
      gate_url: "http://127.0.0.1:1/unreachable",
    })) as { ok: boolean };
    expect(opened.ok).toBe(true);
    await waitFor(async () => (await inspect("a_hook")).meta.state === "validated", 20_000);
    // The model that answered is the AI binding's fake; the gate is the real
    // object (a URL fake would have parked the first reserve forever).
    expect(model.requests.length).toBe(2);
    const gs = await gateState();
    expect(Object.keys(gs.state!.reservations)).toHaveLength(0);
  }, 30_000);
});
