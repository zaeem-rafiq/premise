// The engine variant's unit tests (ME7): a fake service replays event sequences the test writes;
// every expected RunRecord field is worked by hand from those events, never from the
// implementation's own output (BP1).

import { describe, it, expect } from "vitest";
import { ATTEMPT_TIMEOUT_MS } from "../../../src/protocol/constants.ts";
import type { PoolEvent } from "../../../src/protocol/events.ts";
import { loadSeed } from "../models.ts";
import { ADDITIVE_INTENTS, HERO_INTENTS } from "../early/intents.ts";
import { CONFIRM_INTENTS, enginePlan } from "./plan.ts";
import { engineRunOnce, WorkhorseMismatch } from "./run.ts";
import { runMeasurement, poolName } from "./measure.ts";
import { engineMain } from "./main.ts";
import { ev, fakeClock, fakeService } from "./fake.ts";

const WORKHORSE = "@cf/openai/gpt-oss-120b";
const T = 1_000_000; // the epoch ms the hand-built events share
const SEED = loadSeed();

const A01 = ADDITIVE_INTENTS[0]!;
const P1A = HERO_INTENTS[0]!;
const P3A = CONFIRM_INTENTS[0]!;

// -- canned sources -------------------------------------------------------------

const JELLY = `import { step } from "../world/movement.js";\nexport function spawn() { return { y: 0, vx: 0, energy: 100 }; }\nexport function update(j) { step(j); }\nexport function draw(j, pen) { pen.fill("blue"); }\n`;

/** `creatures/crab.js` as the canned write of 02-tidepool 7.3 has it: `crab.energy < 30`. */
const CRAB_BEFORE = `import { ENERGY_MAX } from "../world/energy.js";\nimport { FLOOR_Y, bounce } from "../world/bounds.js";\nimport { step } from "../world/movement.js";\n\nconst SHELL = "orange";\n\nexport function spawn() {\n  return { y: FLOOR_Y - 10, vx: 1, energy: ENERGY_MAX, hiding: false };\n}\n\nexport function update(crab) {\n  crab.hiding = crab.energy < 30;\n  if (crab.hiding) return;\n  step(crab);\n  bounce(crab);\n}\n\nexport function draw(crab, pen) {\n  pen.fill(SHELL);\n}\n`;
/** 7.3's repair: `replace creatures/crab.js`, `crab.energy < 30` -> `crab.energy < 0.3`. */
const CRAB_AFTER = CRAB_BEFORE.replace("crab.energy < 30", "crab.energy < 0.3");

const COMMIT = "a".repeat(40);

// -- event streams built by hand -------------------------------------------------

/** The opening of any pool's stream: `pool.state` of a measurement pool (not summary-only). */
const poolState = (n: number) =>
  ev(n, T, "pool.state", {
    head_seq: 0,
    head_commit: "",
    green_seq: 0,
    landed_seq: 0,
    landed_commit: "",
    state: "ready",
    reason: null,
    epoch: 1,
    remote: "",
    plain_remote: null,
    running: true,
    attempts: 1,
    submitted: 0,
    heads_ups: 0,
    conflicts: 0,
    max_seq: 0,
    notes: 0,
    unwitnessed: [],
    real_agents: 0,
    max_real_agents: 4,
    synthetic: false,
    summary_only: false,
  });

const opened = (n: number, ts: number, attempt: string, intent: string, model = WORKHORSE) =>
  ev(n, ts, "attempt.opened", {
    attempt_id: attempt,
    intent_id: intent,
    change_id: `c-${attempt}`,
    agent: "real",
    model,
    race: false,
  });

const modelStep = (
  n: number,
  ts: number,
  attempt: string,
  step: number,
  cost = 0.001,
  ms = 800,
  error: string | null = null,
) =>
  ev(n, ts, "attempt.step", {
    attempt_id: attempt,
    step,
    tool: null,
    target: null,
    ok: error === null,
    error,
    ms,
    tokens_in: error === null ? 1000 : null,
    tokens_out: error === null ? 200 : null,
    cost_usd: error === null ? cost : null,
  });

const toolStep = (
  n: number,
  ts: number,
  attempt: string,
  step: number,
  tool: string,
  target: string | null,
  ok = true,
  error: string | null = null,
) =>
  ev(n, ts, "attempt.step", {
    attempt_id: attempt,
    step,
    tool,
    target,
    ok,
    error,
    ms: 40,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
  });

const opRecorded = (n: number, ts: number, attempt: string, opSeq: number, path: string, op = "write") =>
  ev(n, ts, "op.recorded", {
    attempt_id: attempt,
    op_seq: opSeq,
    op,
    path,
    targets: [],
    altered: [],
    added: [],
    removed: [],
  });

const submitted = (n: number, ts: number, attempt: string, status = "validated") =>
  ev(n, ts, "submit.result", {
    attempt_id: attempt,
    submit_id: `s${n}`,
    status,
    tier: "auto",
    checks: [],
    duplicate: false,
  });

const accepted = (n: number, ts: number, seq: number, attempt: string, paths: string[]) =>
  ev(n, ts, "landing.accepted", {
    seq,
    batch_id: 1,
    kind: "change",
    attempt_id: attempt,
    change_id: `c-${attempt}`,
    intent_id: "i_test",
    request_id: "r",
    paths,
    writes: [],
  });

const landed = (n: number, ts: number, seq: number, note: object | null = null) =>
  ev(n, ts, "landing.landed", {
    seq,
    batch_id: 1,
    commit: COMMIT,
    tree: "b".repeat(40),
    note: "c".repeat(40),
    note_json: note === null ? null : JSON.stringify(note),
    time_to_land_ms: 1000,
  });

const headsUpSent = (n: number, ts: number, attempt: string, hn: number, result: string, rule: string) =>
  ev(n, ts, "headsup.sent", {
    attempt_id: attempt,
    hn,
    result,
    wake: true,
    cause: { type: "submit", seqs: [n - 1] },
    keys: [{ kind: "premise", key: "refs:world/energy.js#ENERGY_MAX", rule }],
    items: null,
    dropped_ops: [],
    go_around: null,
  });

const headsUpResolved = (
  n: number,
  ts: number,
  attempt: string,
  hn: number,
  result: string,
  statement = "energy is a fraction now",
) =>
  ev(n, ts, "headsup.resolved", {
    attempt_id: attempt,
    hn,
    result,
    go_around: null,
    changed: true,
    statement,
  });

const stopped = (n: number, ts: number, attempt: string, reason: string) =>
  ev(n, ts, "attempt.state", {
    attempt_id: attempt,
    from: "running",
    to: "stopped",
    transition: "stop",
    reason,
    go_arounds: 0,
    pull_backs: 0,
    right_of_way: false,
  });

const intentCreated = (n: number, ts: number, intent: string) =>
  ev(n, ts, "intent.created", {
    intent_id: intent,
    text: "add a jellyfish",
    requester: "owner",
    race: false,
    prewritten: false,
  });

const limits = (n: number, ts: number, spend: number, reserved = 0) =>
  ev(n, ts, "limits", {
    spend_usd: spend,
    reserved_usd: reserved,
    cap_usd: 10,
    killed: false,
    refusing: false,
    models: [{ model: WORKHORSE, per_minute: 240, used_last_minute: 1 }],
  });

/** A note whose `ops` carry the creature's write then the repair replace (7.3). */
function crabNote() {
  return {
    v: 1,
    hash_version: "ast1",
    seq: 41,
    kind: "change",
    change_id: "c-a1",
    revision: 1,
    intent: null,
    attempt: null,
    summary: "crab",
    premises: [],
    writes: [],
    ops: [
      { op: "write", path: "creatures/crab.js", content: CRAB_BEFORE },
      {
        op: "replace",
        path: "creatures/crab.js",
        old: "crab.energy < 30",
        new: "crab.energy < 0.3",
        targets: ["creatures/crab.js#update"],
      },
    ],
    go_arounds: [],
    confirms: [],
    judgments: [],
    checks: [],
    policy: { tier: "auto", approved_by: null, approved_at: null, option: null, risk: null },
    pull_backs: 0,
    batch: { id: 1, index: 0, size: 1 },
    timing: { opened_at: "", submitted_at: "", accepted_at: "" },
  };
}

function runOpts(spec: typeof A01, streams: PoolEvent[][], files: Record<string, string> = {}, extra: object = {}) {
  const fake = fakeService({ streams, files });
  return {
    fake,
    run: () =>
      engineRunOnce({
        service: fake.service,
        clock: fakeClock(),
        model: WORKHORSE,
        spec,
        runIndex: 1,
        tryIndex: 1,
        pool: "m-test",
        requestPrefix: "t",
        swarmSeed: 7,
        seedFiles: SEED,
        ...extra,
      }),
  };
}

// -- the tests -------------------------------------------------------------------

describe("engineRunOnce: an additive run that lands (ME7)", () => {
  const events = [
    poolState(1),
    intentCreated(2, T + 0, "i_test"),
    opened(3, T + 100, "a1", "i_test"),
    modelStep(4, T + 900, "a1", 1, 0.001), // model turn: 1000 in / 200 out / $0.001
    toolStep(5, T + 950, "a1", 2, "read", "GUIDE.md"),
    toolStep(6, T + 1000, "a1", 3, "write", "creatures/jellyfish.js"),
    opRecorded(7, T + 1050, "a1", 1, "creatures/jellyfish.js"),
    modelStep(8, T + 1900, "a1", 4, 0.002), // second model turn
    toolStep(9, T + 1950, "a1", 5, "submit", null),
    submitted(10, T + 2000, "a1"),
    accepted(11, T + 2100, 41, "a1", ["creatures/jellyfish.js"]),
    landed(12, T + 2200, 41),
  ];
  it("builds every RunRecord field from the stream", async () => {
    const { run, fake } = runOpts(A01, [events], { "creatures/jellyfish.js": JELLY });
    const result = await run();
    const r = result.record;
    expect(r.intent).toBe("A01");
    expect(r.run).toBe(1);
    expect(r.outcome).toBe("landed");
    expect(r.stop_reason).toBe(null);
    expect(r.seconds).toBeCloseTo((T + 2200 - (T + 0)) / 1000, 6); // ts(landed) - ts(intent.created)
    expect(r.waited_ms).toBe(0);
    expect(r.model_calls).toBe(2); // the two tool:null steps
    expect(r.tool_calls).toBe(3); // read, write, submit
    expect(r.tool_errors).toBe(0);
    expect(r.nudges).toBe(0);
    expect(r.tokens_in).toBe(2000);
    expect(r.tokens_out).toBe(400);
    expect(r.cost_usd).toBeCloseTo(0.003, 9);
    expect(r.first_tool).toBe("read GUIDE.md");
    expect(r.whole_file_reads).toEqual(["GUIDE.md"]); // jellyfish.js was written, not read
    expect(r.files).toEqual({ "creatures/jellyfish.js": JELLY });
    expect(r.hero).toBe(null);
    expect(result.counted).toBe(true);
    expect(result.openedModel).toBe(WORKHORSE);
    // The pool was created from tidepool-auto with summary_only: false (ME7).
    const create = fake.calls.find((c) => c.path === "/api/pools");
    expect(create).toMatchObject({
      method: "POST",
      body: { pool: "m-test", seed: "tidepool-auto", summary_only: false },
    });
    // The file was read through the public app-server route at the landed commit.
    const fileGet = fake.calls.find((c) => c.method === "GET" && c.path.includes("/v/"));
    expect(fileGet?.path).toBe(`/pool/m-test/v/c-${COMMIT}/creatures/jellyfish.js`);
  });
});

describe("engineRunOnce: a run that stops with budget", () => {
  it("outcome not_completed, stop_reason budget, no seconds", async () => {
    const events = [
      poolState(1),
      intentCreated(2, T, "i_test"),
      opened(3, T + 100, "a1", "i_test"),
      modelStep(4, T + 900, "a1", 1, 0.9),
      stopped(5, T + 5000, "a1", "budget"),
    ];
    const { run } = runOpts(A01, [events]);
    const r = (await run()).record;
    expect(r.outcome).toBe("not_completed");
    expect(r.stop_reason).toBe("budget");
    expect(r.seconds).toBe(null);
    expect(r.model_calls).toBe(1);
    expect(r.cost_usd).toBeCloseTo(0.9, 9);
    expect(r.files).toEqual({});
  });
});

describe("engineRunOnce: the hero flow (ME7)", () => {
  /** A counted P1a run: rescale held, released at the crab's first op; the repair heads-up
   * (n=9) precedes the creature's `landing.accepted` (n=13). */
  const countedEvents = (): PoolEvent[] => [
    poolState(1),
    ev(2, T + 50, "attempt.opened", {
      attempt_id: "syn-1",
      intent_id: "i_rescale",
      change_id: "c-syn",
      agent: "synthetic",
      model: null,
      race: false,
    }),
    intentCreated(3, T + 200, "i_test"),
    opened(4, T + 300, "a1", "i_test"),
    toolStep(5, T + 400, "a1", 1, "write", "creatures/crab.js"),
    opRecorded(6, T + 450, "a1", 1, "creatures/crab.js"),
    submitted(7, T + 600, "a1"), // the first passing submit (the `before` file is on it)
    toolStep(8, T + 700, "a1", 4, "replace", "creatures/crab.js"),
    headsUpSent(9, T + 800, "a1", 5, "repair", "E2"),
    opRecorded(10, T + 900, "a1", 2, "creatures/crab.js", "replace"),
    headsUpResolved(11, T + 950, "a1", 5, "repair"),
    submitted(12, T + 1000, "a1"), // the repair's passing submit, carrying the statement
    accepted(13, T + 1200, 41, "a1", ["creatures/crab.js"]),
    landed(14, T + 1300, 41, crabNote()),
  ];
  /** The same run, but the heads-up reaches the creature only after its change was accepted. */
  const landsFirstEvents = (): PoolEvent[] => [
    poolState(1),
    ev(2, T + 50, "attempt.opened", {
      attempt_id: "syn-1",
      intent_id: "i_rescale",
      change_id: "c-syn",
      agent: "synthetic",
      model: null,
      race: false,
    }),
    intentCreated(3, T + 200, "i_test"),
    opened(4, T + 300, "a1", "i_test"),
    toolStep(5, T + 400, "a1", 1, "write", "creatures/crab.js"),
    opRecorded(6, T + 450, "a1", 1, "creatures/crab.js"),
    submitted(7, T + 600, "a1"),
    accepted(8, T + 700, 41, "a1", ["creatures/crab.js"]),
    headsUpSent(9, T + 750, "a1", 5, "repair", "E2"), // n=9 > accepted's n=8: does not count
    landed(10, T + 800, 41, crabNote()),
  ];

  it("counted: headsup.sent of repair before landing.accepted; class repaired (6.5, ME8)", async () => {
    const { run, fake } = runOpts(P1A, [countedEvents()], { "creatures/crab.js": CRAB_AFTER });
    const result = await run();
    const r = result.record;
    // the rescale swarm was started, held, then released at the crab's op.recorded
    const swarms = fake.calls.filter((c) => c.path === "/api/swarm");
    expect(swarms[0]?.body).toMatchObject({
      running: true,
      patterns: ["rescale-energy"],
      hold_before_submit: ["rescale-energy"],
      agents: 0,
      launch_per_second: 0,
    });
    expect(swarms[1]?.body).toMatchObject({ running: true, release: ["rescale-energy"] });
    expect(r.outcome).toBe("landed");
    expect(result.counted).toBe(true);
    expect(r.hero).not.toBe(null);
    expect(r.hero?.class).toBe("repaired");
    expect(r.hero?.judged_by).toBe("rule");
    expect(r.hero?.before).toBe(CRAB_BEFORE); // replayed from the note's ops (write, pre-heads-up)
    expect(r.hero?.statement).toBe("energy is a fraction now");
    expect(r.hero?.repair_ms).toBe(T + 1000 - (T + 800)); // headsup.sent -> the repair's submit
    expect(r.files["creatures/crab.js"]).toBe(CRAB_AFTER);
  });

  it("not_counted: the creature's landing.accepted precedes the heads-up (ME7)", async () => {
    const { run } = runOpts(P1A, [landsFirstEvents()], { "creatures/crab.js": CRAB_AFTER });
    const result = await run();
    expect(result.record.outcome).toBe("not_counted");
    expect(result.counted).toBe(false);
  });
});

describe("engineRunOnce: the confirm flow (P3a, rule E2m)", () => {
  it("counted; the confirm window measures headsup.sent -> headsup.resolved (6.6)", async () => {
    const events = [
      poolState(1),
      intentCreated(2, T, "i_test"),
      opened(3, T + 100, "a1", "i_test"),
      toolStep(4, T + 200, "a1", 1, "write", "creatures/fish.js"),
      opRecorded(5, T + 250, "a1", 1, "creatures/fish.js"),
      modelStep(6, T + 900, "a1", 2, 0.001),
      headsUpSent(7, T + 1000, "a1", 3, "confirm", "E2m"),
      modelStep(8, T + 1500, "a1", 4, 0.004), // the confirm turn: inside the window
      toolStep(9, T + 1600, "a1", 5, "read", "world/energy.js"),
      headsUpResolved(10, T + 2000, "a1", 3, "confirm", "I keep ENERGY_MAX as the cap."),
      submitted(11, T + 2100, "a1"),
      accepted(12, T + 2200, 41, "a1", ["creatures/fish.js"]),
      landed(13, T + 2300, 41, { ops: [{ op: "write", path: "creatures/fish.js", blob: "x".repeat(40) }] }),
    ];
    const { run } = runOpts(P3A, [events], { "creatures/fish.js": SEED.get("creatures/fish.js") ?? "" });
    const result = await run();
    expect(result.counted).toBe(true);
    expect(result.record.outcome).toBe("landed");
    const w = result.confirm;
    expect(w).not.toBe(null);
    expect(w?.ms).toBe(1000); // resolved.ts - sent.ts
    expect(w?.model_calls).toBe(1); // the step at ts=T+1500, inside the window
    expect(w?.tokens_in).toBe(1000);
    expect(w?.tokens_out).toBe(200);
    expect(w?.cost_usd).toBeCloseTo(0.004, 9);
  });
});

describe("runMeasurement", () => {
  const landingScript = (attempt: string, cost: number): PoolEvent[] => [
    poolState(1),
    intentCreated(2, T, "i_test"),
    opened(3, T + 100, attempt, "i_test"),
    modelStep(4, T + 900, attempt, 1, cost),
    submitted(5, T + 1000, attempt),
    accepted(6, T + 1100, 41, attempt, ["creatures/jellyfish.js"]),
    landed(7, T + 1200, 41),
  ];

  it("a not_counted hero run is repeated, at most three times per intent (ME7)", async () => {
    // The creature lands before any repair heads-up, every time: 1 run + 3 repeats = 4 tries.
    const script = [
      poolState(1),
      intentCreated(2, T, "i_test"),
      opened(3, T + 100, "a1", "i_test"),
      opRecorded(4, T + 200, "a1", 1, "creatures/crab.js"),
      submitted(5, T + 300, "a1"),
      accepted(6, T + 400, 41, "a1", ["creatures/crab.js"]), // accepted at n=6
      headsUpSent(7, T + 450, "a1", 5, "repair", "E2"), // heads-up at n=7: after the accept
      landed(8, T + 500, 41, crabNote()),
    ];
    const fake = fakeService({ streams: [script, script, script, script, script] });
    const measured = await runMeasurement({
      service: fake.service,
      clock: fakeClock(),
      model: WORKHORSE,
      plan: [{ intent: P1A, run: 1 }],
      concurrency: 1,
      maxUsd: 10,
      swarmSeed: 7,
      requestPrefix: "t",
      seedFiles: SEED,
    });
    // Every try is a real run of real spend: all four records are kept, each `not_counted`.
    expect(measured.results).toHaveLength(4);
    expect(measured.results.every((r) => r.record.outcome === "not_counted")).toBe(true);
    const pools = fake.calls.filter((c) => c.path === "/api/pools");
    expect(pools).toHaveLength(4); // the original plus three repeats
  });

  it("the spend limit stops new runs (ME4): no pool is created once the cap can't hold a run", async () => {
    const expensive = [
      poolState(1),
      intentCreated(2, T, "i_test"),
      opened(3, T + 100, "a1", "i_test"),
      modelStep(4, T + 900, "a1", 1, 0.9), // $0.9 of one model turn
      limits(5, T + 950, 10.8), // the gate reports the spend
      submitted(6, T + 1000, "a1"),
      accepted(7, T + 1100, 41, "a1", ["creatures/jellyfish.js"]),
      landed(8, T + 1200, 41),
    ];
    const fake = fakeService({ streams: [expensive] });
    const measured = await runMeasurement({
      service: fake.service,
      clock: fakeClock(),
      model: WORKHORSE,
      plan: [
        { intent: A01, run: 1 },
        { intent: ADDITIVE_INTENTS[1]!, run: 1 },
      ],
      concurrency: 1,
      maxUsd: 1.5, // run 1 spends $0.9; the next run's worst case (a finished max of $0.9) passes it
      swarmSeed: 7,
      requestPrefix: "t",
      seedFiles: SEED,
    });
    expect(measured.results).toHaveLength(1);
    expect(measured.incomplete).toBe(true);
    expect(measured.spendUsd).toBeCloseTo(0.9, 9);
    expect(fake.calls.filter((c) => c.path === "/api/pools")).toHaveLength(1);
  });

  it("refuses a deployment whose workhorse is not --model (the first attempt.opened)", async () => {
    const wrongModel = [
      poolState(1),
      intentCreated(2, T, "i_test"),
      opened(3, T + 100, "a1", "i_test", "@cf/moonshotai/kimi-k2.7-code"),
    ];
    const fake = fakeService({ streams: [wrongModel] });
    await expect(
      runMeasurement({
        service: fake.service,
        clock: fakeClock(),
        model: WORKHORSE,
        plan: [{ intent: A01, run: 1 }],
        concurrency: 1,
        maxUsd: 10,
        swarmSeed: 7,
        requestPrefix: "t",
        seedFiles: SEED,
      }),
    ).rejects.toBeInstanceOf(WorkhorseMismatch);
    // the attempt was asked to stop before the script gave up on the deployment
    expect(fake.calls.some((c) => c.path.endsWith("/stop"))).toBe(true);
  });

  it("runs slots in plan order under concurrency 1 and records every event", async () => {
    const fake = fakeService({ streams: [landingScript("a1", 0.001), landingScript("a2", 0.002)] });
    const measured = await runMeasurement({
      service: fake.service,
      clock: fakeClock(),
      model: WORKHORSE,
      plan: [
        { intent: A01, run: 1 },
        { intent: ADDITIVE_INTENTS[1]!, run: 1 },
      ],
      concurrency: 1,
      maxUsd: 10,
      swarmSeed: 7,
      requestPrefix: "t",
      seedFiles: SEED,
    });
    expect(measured.results.map((r) => r.record.intent)).toEqual(["A01", "A02"]);
    expect(measured.incomplete).toBe(false);
    expect(measured.events.length).toBe(landingScript("x", 0).length * 2);
    expect(measured.events[0]).toMatchObject({ intent: "A01", run: 1, try: 1 });
    expect(measured.spendUsd).toBeCloseTo(0.003, 9);
  });
});

describe("engineMain", () => {
  const script = [
    poolState(1),
    intentCreated(2, T, "i_test"),
    opened(3, T + 100, "a1", "i_test"),
    modelStep(4, T + 900, "a1", 1, 0.001),
    submitted(5, T + 1000, "a1"),
    accepted(6, T + 1100, 41, "a1", ["creatures/jellyfish.js"]),
    landed(7, T + 1200, 41),
  ];

  it("refuses --model that the deployment's /floor.json does not name as workhorse", async () => {
    const fake = fakeService({
      streams: [script],
      getJson: () => ({ status: 200, body: { workhorse: "@cf/moonshotai/kimi-k2.7-code" } }),
    });
    const logs: string[] = [];
    const code = await engineMain(
      {
        model: WORKHORSE,
        sets: ["additive"],
        runs: 1,
        maxUsd: 10,
        concurrency: 1,
        out: ".tmp-test/measure-out",
        build: "test",
        swarmSeed: 7,
      },
      {
        service: fake.service,
        clock: fakeClock(),
        env: { PREMISE_URL: "https://x", PREMISE_OWNER_KEY: "OWNER_SECRET" },
        log: (l) => logs.push(l),
      },
    );
    expect(code).toBe(2);
    expect(logs.join("\n")).toContain("kimi-k2.7-code");
    expect(fake.calls.some((c) => c.path === "/api/pools")).toBe(false);
  });

  it("writes <date>-engine-<model>.json and .events.jsonl; the owner key never appears", async () => {
    const SECRET = "OWNER_SECRET_x7";
    // the secret leaks into an event's text, as a hostile model could arrange — redact() must strip it
    const leaky = [
      poolState(1),
      ev(2, T, "intent.created", {
        intent_id: "i_test",
        text: `token ${SECRET}`,
        requester: "owner",
        race: false,
        prewritten: false,
      }),
      opened(3, T + 100, "a1", "i_test"),
      modelStep(4, T + 900, "a1", 1, 0.001),
      submitted(5, T + 1000, "a1"),
      accepted(6, T + 1100, 41, "a1", ["creatures/jellyfish.js"]),
      landed(7, T + 1200, 41),
    ];
    const fake = fakeService({
      streams: Array.from({ length: 12 }, () => leaky),
      getJson: () => ({ status: 200, body: {} }),
    });
    const logs: string[] = [];
    const out = ".tmp-test/measure-engine-test";
    const code = await engineMain(
      { model: WORKHORSE, sets: ["additive"], runs: 1, maxUsd: 10, concurrency: 1, out, build: "test", swarmSeed: 7 },
      {
        service: fake.service,
        clock: fakeClock(),
        env: { PREMISE_URL: "https://x", PREMISE_OWNER_KEY: SECRET },
        log: (l) => logs.push(l),
      },
    );
    expect(code).toBe(0);
    const { readFileSync, readdirSync } = await import("node:fs");
    const names = readdirSync(out);
    const json = names.find((n) => n.endsWith(".json") && n.includes("-engine-"));
    const jsonl = names.find((n) => n.endsWith(".events.jsonl"));
    expect(json).toBeDefined();
    expect(jsonl).toBe(`${json?.replace(".json", "")}.events.jsonl`);
    const measurement = JSON.parse(readFileSync(`${out}/${json}`, "utf8")) as {
      mode: string;
      runs: unknown[];
      request: { transport: string };
    };
    expect(measurement.mode).toBe("engine");
    expect(measurement.request.transport).toBe("binding");
    expect(measurement.runs).toHaveLength(12); // the additive set: A01 to A12, one run each
    const allText = readFileSync(`${out}/${json}`, "utf8") + readFileSync(`${out}/${jsonl}`, "utf8") + logs.join("\n");
    expect(allText).not.toContain(SECRET);
    expect(allText).toContain("[redacted]");
  });
});
