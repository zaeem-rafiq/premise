// The soak runner's unit tests (VE6 of docs/spec/04-build-plan.md 5.2). Everything the runner
// touches is faked: the service (HTTP + stream), git, the Artifacts token source, the clock.
// Expected values are worked by hand from the fixtures below and the spec — never from the
// runner's own output (BP1).
//
// The fixtures mint the deterministic ids of SWR4 (`a_<ULID>` from
// `H("swarm|<prefix>|<request_id>|<n>")`) with an independent re-derivation of the formula, so a
// wrong derivation inside run.ts shows up here as unmappable attempts and wrong truth counts.

import { describe, expect, it } from "vitest";
import type { PoolEvent } from "../../src/protocol/events.ts";
import { H } from "../../src/core/sync/h.ts";
import { agentRandom } from "../../src/swarm/prng.ts";
import { dialPattern } from "../../src/swarm/dial.ts";
import { patternById } from "../../src/swarm/pattern.ts";
import { REPLAY_MAX_BYTES } from "../../src/protocol/constants.ts";
import { runDial } from "./run.ts";
import type { SoakDeps, SoakResult, SoakRunInput } from "./run.ts";
import { fakeFloor, type FakeFloor } from "./fake-floor.ts";

// ---- The ids of SWR4, derived from the spec text once more (independent of run.ts) ----

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function specLaunchId(prefix: "a_" | "i_" | "c_", requestId: string, n: number): string {
  const digits: string[] = [];
  let value = BigInt(`0x${H(`swarm|${prefix}|${requestId}|${n}`)}`);
  for (let i = 0; i < 26; i += 1) {
    digits.unshift(B32[Number(value % 32n)] ?? "?");
    value /= 32n;
  }
  return `${prefix}${digits.join("")}`;
}

// ---- Fixture constants ----

const POOL = "soak-fixture";
const RUN_REQUEST = `soak-${POOL}-run`;
const BUILD = "b123abc";
const RECORDED = "2026-01-02T03:04:05.000Z";
const TOKEN = "rt-fake-token-0123";
const OWNER_KEY = "ok-fake-owner-key-456";
const REMOTE = "https://artifacts.example.test/soak-fixture";
const CLONE_DIR = ".tmp-test/soak-test-clone";

const aid = (n: number) => specLaunchId("a_", RUN_REQUEST, n);
const iid = (n: number) => specLaunchId("i_", RUN_REQUEST, n);
const cid = (n: number) => specLaunchId("c_", RUN_REQUEST, n);

const intentOf = (pattern: string) => patternById(pattern)?.intent ?? "?";

// ---- Events ----

type AgentSpec = { n: number; attempt: string; intent: string; change: string; pattern: string };

let eventN = 0;
function ev<T extends Record<string, unknown>>(ts: number, src: PoolEvent["src"], body: T): PoolEvent {
  eventN += 1;
  return { n: eventN, t: ts, ts, pool: POOL, src, ...body } as unknown as PoolEvent;
}

function poolState(
  ts: number,
  o: { epoch: number; head_seq: number; state?: "ready" | "rebuilding" | "paused"; synthetic?: boolean },
): PoolEvent {
  return ev(ts, "trunk", {
    type: "pool.state",
    head_seq: o.head_seq,
    head_commit: o.head_seq > 0 ? `c${o.head_seq}` : "",
    green_seq: o.head_seq,
    landed_seq: o.head_seq,
    landed_commit: o.head_seq > 0 ? `c${o.head_seq}` : "",
    state: o.state ?? "ready",
    reason: null,
    epoch: o.epoch,
    remote: REMOTE,
    plain_remote: null,
    app: "tidepool",
    source: null,
    rebuild: null,
    unwitnessed: [],
    real_agents: 0,
    max_real_agents: 0,
    synthetic: o.synthetic ?? false,
    summary_only: true,
  });
}

function attemptState(ts: number, attempt: string, from: string, to: string, goArounds = 0): PoolEvent {
  return ev(ts, "trunk", {
    type: "attempt.state",
    attempt_id: attempt,
    from,
    to,
    transition: `${from}->${to}`,
    reason: null,
    go_arounds: goArounds,
    pull_backs: 0,
    right_of_way: false,
  });
}

/**
 * One scripted agent's event ladder: intent, open, work, validate, optionally one repair
 * go-around (headsup + resolve + resubmit), accept, land. `seq` is its landing's position.
 */
function agentLadder(
  a: AgentSpec,
  seq: number | null,
  o: {
    base: number;
    timeToLand?: number;
    goAround?: { causeSeqs: number[] };
    acceptDelay?: number;
    /** Extra ms this landing's push takes (its batch.pushed comes that much later). */
    pushDelay?: number;
    stopAfterWorking?: boolean;
  },
): PoolEvent[] {
  const b = o.base;
  const out: PoolEvent[] = [
    ev(b, "trunk", {
      type: "intent.created",
      intent_id: a.intent,
      text: intentOf(a.pattern),
      requester: "swarm",
      race: false,
      prewritten: false,
    }),
    ev(b + 10, "trunk", {
      type: "attempt.opened",
      attempt_id: a.attempt,
      intent_id: a.intent,
      change_id: a.change,
      agent: "synthetic",
      model: null,
      race: false,
    }),
    attemptState(b + 20, a.attempt, "opened", "working"),
  ];
  if (o.stopAfterWorking) return out;
  out.push(
    ev(b + 100, "trunk", {
      type: "submit.result",
      attempt_id: a.attempt,
      submit_id: `s_${a.n}_a`,
      status: "validated",
      tier: "auto",
      checks: [],
      duplicate: false,
    }),
    attemptState(b + 110, a.attempt, "working", "validated"),
  );
  if (o.goAround !== undefined) {
    out.push(
      ev(b + 150, "trunk", {
        type: "headsup.sent",
        attempt_id: a.attempt,
        hn: 1,
        result: "repair",
        wake: true,
        cause: { type: "landing", seqs: o.goAround.causeSeqs, changes: [] },
        keys: [{ kind: "entity", key: "world/movement.js#step", rule: "E2" }],
        items: null,
        dropped_ops: [],
        go_around: 1,
      }),
      attemptState(b + 160, a.attempt, "validated", "going_around", 1),
      ev(b + 200, "trunk", {
        type: "headsup.resolved",
        attempt_id: a.attempt,
        hn: 1,
        result: "repair",
        go_around: 1,
        changed: true,
        statement: "still valid",
      }),
      attemptState(b + 210, a.attempt, "going_around", "submitted", 1),
      ev(b + 300, "trunk", {
        type: "submit.result",
        attempt_id: a.attempt,
        submit_id: `s_${a.n}_b`,
        status: "validated",
        tier: "auto",
        checks: [],
        duplicate: false,
      }),
      attemptState(b + 310, a.attempt, "submitted", "validated", 1),
    );
  }
  if (seq !== null) {
    const d = o.acceptDelay ?? 0;
    const landed = o.timeToLand ?? 400;
    out.push(
      ev(b + 500 + d, "trunk", {
        type: "landing.accepted",
        seq,
        batch_id: seq,
        kind: "change",
        attempt_id: a.attempt,
        change_id: a.change,
        intent_id: a.intent,
        request_id: null,
        paths: [`creatures/c${seq}.js`],
        writes: [],
      }),
      attemptState(b + 510 + d, a.attempt, "validated", "accepted", o.goAround === undefined ? 0 : 1),
      attemptState(b + 520 + d, a.attempt, "accepted", "landed", o.goAround === undefined ? 0 : 1),
      // LP1: the batch's push completes before the next accept; 50 ms after this one.
      ev(b + 550 + d + (o.pushDelay ?? 0), "trunk", {
        type: "batch.pushed",
        batch_id: seq,
        first_seq: seq,
        last_seq: seq,
        main: `c${seq}`,
        notes: `note${seq}`,
        tries: 0,
        ms: 50 + (o.pushDelay ?? 0),
      }),
      ev(b + 700 + d, "trunk", {
        type: "landing.landed",
        seq,
        batch_id: seq,
        commit: `c${seq}`,
        tree: `t${seq}`,
        note: `n${seq}`,
        note_json: null,
        time_to_land_ms: landed,
      }),
    );
  }
  return out;
}

/** A `metrics` broadcast; only waiting_behind, push_backlog and tick feed the result. */
function metricsEv(
  ts: number,
  o: { waiting_behind: number; push_backlog: number; tick: { p50: number | null; p99: number | null } },
): PoolEvent {
  return ev(ts, "trunk", {
    type: "metrics",
    window_ms: 60_000,
    landings_per_second: 0,
    time_to_land_ms: { p50: null, p99: null },
    time_held_ms: { p50: null, p99: null },
    go_around_rate: null,
    false_abort_rate: null,
    escape_rate: null,
    waiting_behind: o.waiting_behind,
    push_backlog: o.push_backlog,
    tick_cpu_ms: o.tick,
  });
}

// ---- The notes and tree of Artifacts ----

type Judgment = {
  kind: string;
  key: string;
  old: string;
  new: string;
  cause_seq: number | null;
  rule: string;
  class: "rule" | "triage";
  result: "holds" | "confirm" | "repair";
  reason: string;
};

const repair = (kind: string, key: string, rule: string, causeSeq: number | null): Judgment => ({
  kind,
  key,
  old: "o",
  new: "n",
  cause_seq: causeSeq,
  rule,
  class: "rule",
  result: "repair",
  reason: "r",
});

function noteJson(spec: AgentSpec, seq: number, judgments: Judgment[]): string {
  return JSON.stringify({
    v: 1,
    hash_version: "ast1",
    seq,
    kind: "change",
    change_id: spec.change,
    revision: 0,
    intent: { id: spec.intent, text: intentOf(spec.pattern), requester: "swarm", created_at: "t" },
    attempt: {
      id: spec.attempt,
      agent: "synthetic",
      model: null,
      repo: null,
      opened_seq: 0,
      steps: 5,
      model_calls: 0,
      tokens_in: 0,
      tokens_out: 0,
    },
    summary: "s",
    premises: [],
    writes: [],
    ops: [],
    go_arounds: [],
    confirms: [],
    judgments,
    checks: [],
    policy: { tier: "auto", approved_by: null, approved_at: null, option: null, risk: null },
    pull_backs: 0,
  });
}

// The head tree that passes SW2: ENERGY_MAX=100, one T-energy creature at 30 (0.3), one
// T-relative creature (symbolic, always 0.3).
const GOOD_FILES: Record<string, string> = {
  "world/energy.js": "export const ENERGY_MAX = 100;",
  "creatures/ok-energy.js":
    'import { ENERGY_MAX } from "../world/energy.js";\n' +
    "export function update(creature) {\n  if (creature.energy < 30) return;\n  step(creature);\n}",
  "creatures/ok-relative.js":
    'import { ENERGY_MAX } from "../world/energy.js";\n' +
    "export function update(creature) {\n  if (creature.energy < ENERGY_MAX * 0.3) return;\n  step(creature);\n}",
};

// A T-energy creature at 50 of 100: 0.5, not 0.3 — one escape.
const ESCAPE_FILES: Record<string, string> = {
  ...GOOD_FILES,
  "creatures/bad-energy.js":
    'import { ENERGY_MAX } from "../world/energy.js";\n' +
    "export function update(creature) {\n  if (creature.energy < 50) return;\n  step(creature);\n}",
};

// ---- A whole run, assembled ----

type RunPlan = {
  seed: number;
  dial: number;
  agents: number;
  /** Adds a rescale-energy open on draw index `agents`. */
  rescale: boolean;
  /** Agent indices (into the roster) that take one repair go-around before landing. */
  goAroundOn: number[];
  /** Agent index -> extra ms before its landing.accepted (the no_stall gap). */
  acceptDelay: Record<number, number>;
  /** Agent index -> extra ms its landing's push takes (LP1: the next accept waits for it). */
  pushDelay: Record<number, number>;
  /** Agent indices whose ladder stops after `working` (in flight at end). */
  stopAfterWorking: number[];
  /** Agent indices whose post-`working` events are held out of `pre` — `lateEvents(base)` mints
   * them fresh so a `push` during a wait delivers them live (a late finisher). */
  lateFinish: number[];
  /** Extra events appended just before the tail (batch.pushed, metrics, swarm stop). */
  extraTail: (landed: { spec: AgentSpec; seq: number }[]) => PoolEvent[];
  /** Extra events appended after the swarm stop (still before rebuild). */
  extraLate: () => PoolEvent[];
  /** judgments for each landed attempt's note, by agent index. */
  judgmentsOf: (spec: AgentSpec, seq: number) => Judgment[];
  /** Notes whose oid is missing from `git notes list` (the seqs to drop). */
  dropNotes: number[];
  files: Record<string, string>;
  fsckCode: number;
  /** head_seq on the post-rebuild pool.state (default: the landed count). */
  rebuildHeadSeq: number | null;
  replayBytes: number;
  waitingBehind: number;
  pushBacklog: number;
  tick: { p50: number | null; p99: number | null };
};

const DEFAULT_PLAN: RunPlan = {
  seed: 7,
  dial: 0.25,
  agents: 3,
  rescale: true,
  goAroundOn: [1],
  acceptDelay: {},
  pushDelay: {},
  stopAfterWorking: [],
  lateFinish: [],
  extraTail: () => [],
  extraLate: () => [],
  judgmentsOf: (spec, _seq) =>
    spec.pattern === "rescale-energy" ? [repair("entity", "world/energy.js#ENERGY_MAX", "E2", null)] : [],
  dropNotes: [],
  files: GOOD_FILES,
  fsckCode: 0,
  rebuildHeadSeq: null,
  replayBytes: 1234,
  waitingBehind: 1,
  pushBacklog: 2,
  tick: { p50: 12, p99: 40 },
};

type BuiltRun = {
  pre: PoolEvent[];
  /** Minted lazily: the fake Floor pushes it on `/rebuild`, and fresh `n` at that moment
   * is what keeps it deliverable after any mid-run `lateEvents` push. */
  post: () => PoolEvent[];
  landed: { spec: AgentSpec; seq: number }[];
  commits: string[];
  notesList: string;
  noteBodies: Map<string, string>;
  lastPreTs: number;
  /** The completion events of `lateFinish` agents, minted at call time so their `n` tops the
   * whole fixture and a live `push` delivers them. */
  lateEvents: (base: number) => PoolEvent[];
};

function buildRun(over: Partial<RunPlan> = {}): BuiltRun {
  const plan: RunPlan = { ...DEFAULT_PLAN, ...over };
  eventN = 0;
  const specs: AgentSpec[] = [];
  for (let n = 0; n < plan.agents; n += 1) {
    specs.push({
      n,
      attempt: aid(n),
      intent: iid(n),
      change: cid(n),
      pattern: dialPattern(plan.dial, agentRandom(plan.seed, n)),
    });
  }
  if (plan.rescale) {
    const n = plan.agents;
    specs.push({ n, attempt: aid(n), intent: iid(n), change: cid(n), pattern: "rescale-energy" });
  }

  const pre: PoolEvent[] = [
    poolState(0, { epoch: 0, head_seq: 0 }),
    ev(0, "trunk", { type: "pool.files", files: [] }),
    ev(100, "swarm", {
      type: "swarm.state",
      synthetic: true,
      running: true,
      agents: plan.agents,
      collision_dial: plan.dial,
      pools: [POOL],
    }),
  ];

  const landed: { spec: AgentSpec; seq: number }[] = [];
  const lateSpecs: { spec: AgentSpec; seq: number }[] = [];
  let seq = 0;
  const emit = (spec: AgentSpec, index: number, agentSeq: number | null, stopAfterWorking: boolean): void => {
    const goAround =
      plan.goAroundOn.includes(index) && agentSeq !== null && agentSeq > 1
        ? { causeSeqs: [agentSeq - 1] }
        : plan.goAroundOn.includes(index)
          ? { causeSeqs: [1] }
          : undefined;
    pre.push(
      ...agentLadder(spec, agentSeq, {
        base: 1000 * (index + 1),
        goAround,
        acceptDelay: plan.acceptDelay[index],
        pushDelay: plan.pushDelay[index],
        stopAfterWorking,
        timeToLand: [400, 900, 500, 400][index] ?? 400,
      }),
    );
  };
  specs.forEach((spec, index) => {
    // A late finisher's ladder is emitted below: it lands after every other landing, so its
    // seq tops theirs — the seq a real late finisher would be assigned.
    if (plan.lateFinish.includes(index)) return;
    const stops = plan.stopAfterWorking.includes(index);
    if (!stops) seq += 1;
    const agentSeq = stops ? null : seq;
    if (agentSeq !== null) landed.push({ spec, seq: agentSeq });
    emit(spec, index, agentSeq, stops);
  });
  for (const index of plan.lateFinish) {
    const spec = specs[index];
    if (spec === undefined) continue;
    seq += 1;
    landed.push({ spec, seq });
    lateSpecs.push({ spec, seq });
    emit(spec, index, seq, true);
  }
  // The held-out completion ladders: minted on demand so their event `n` is fresh — past every
  // `n` the fixture minted — which is what lets a live `push` carry them to the reader.
  const lateEvents = (base: number): PoolEvent[] =>
    lateSpecs.flatMap(({ spec, seq }) => agentLadder(spec, seq, { base }).slice(3));
  // A stream is in arrival order: a delayed push or accept lands among the later agents' events
  // (the sort is stable, so ladders that do not overlap keep their order).
  pre.sort((x, y) => x.ts - y.ts);
  pre.push(...plan.extraTail(landed));

  let tail = Math.max(...pre.map((e) => e.ts)) + 100;
  const lastSeq = landed.length === 0 ? 0 : (landed[landed.length - 1] as { seq: number }).seq;
  pre.push(metricsEv(tail, { waiting_behind: plan.waitingBehind, push_backlog: plan.pushBacklog, tick: plan.tick }));
  tail += 100;
  pre.push(
    ev(tail, "swarm", {
      type: "swarm.state",
      synthetic: true,
      running: false,
      agents: plan.agents,
      collision_dial: plan.dial,
      pools: [POOL],
    }),
  );
  pre.push(...plan.extraLate());
  const lastPreTs = Math.max(...pre.map((e) => e.ts));

  const post = (): PoolEvent[] => [
    poolState(lastPreTs + 400, {
      epoch: 1,
      head_seq: plan.rebuildHeadSeq ?? lastSeq,
      synthetic: true,
    }),
  ];

  // The Artifacts view: one seed commit plus one commit per landing, in order.
  const commits = ["seed0", ...landed.map((l) => `c${l.seq}`)];
  const noteLines = landed
    .filter((l) => !plan.dropNotes.includes(l.seq))
    .map((l) => `n${l.seq} c${l.seq}`)
    .join("\n");
  const noteBodies = new Map<string, string>();
  for (const l of landed) {
    noteBodies.set(`n${l.seq}`, noteJson(l.spec, l.seq, plan.judgmentsOf(l.spec, l.seq)));
  }
  return { pre, post, landed, commits, notesList: noteLines, noteBodies, lastPreTs, lateEvents };
}

// ---- The fakes ----

type GitCall = { args: string[]; cwd: string | undefined; env: Record<string, string> | undefined };
/** `frames` is how many stream frames the fake Floor had sent when the call was answered — the
 * stream gate's tests read it to prove what came first. */
type HttpCall = { method: string; path: string; body: unknown; frames: number; ms: number };

type Fake = {
  deps: SoakDeps;
  floor: FakeFloor;
  gitCalls: GitCall[];
  httpCalls: HttpCall[];
  tokenCalls: string[];
};

type FakeHooks = {
  /** FR30 probes that answer 404 before the route exists. */
  probeMisses?: number;
  /** Runs inside the `POST /api/swarm` `running: true` answer — where a mid-run drop is staged. */
  onSwarmStart?: (floor: FakeFloor) => void;
  /** Runs inside every `deps.sleep` — where a wait's poll ticks — so a test can push a late
   * finisher while the runner is waiting on it. */
  onSleep?: (floor: FakeFloor, count: number, ms: number) => void;
  /** Server errors `POST /api/pools` answers before it answers 200. */
  createErrors?: number;
};

function makeFake(run: BuiltRun, over: Partial<RunPlan> = {}, hooks: FakeHooks = {}): Fake {
  const gitCalls: GitCall[] = [];
  const httpCalls: HttpCall[] = [];
  const tokenCalls: string[] = [];
  let nowMs = 0;
  let sleepCount = 0;

  const floor = fakeFloor(run.pre, { probeMisses: hooks.probeMisses });

  const gitOk = (stdout: string) => ({ code: 0, stdout, stderr: "" });
  const git: SoakDeps["git"] = async (args, opts) => {
    gitCalls.push({ args: [...args], cwd: opts?.cwd, env: opts?.env === undefined ? undefined : { ...opts.env } });
    const [cmd] = args;
    if (cmd === "clone") return gitOk("");
    if (cmd === "fetch") return gitOk("");
    if (cmd === "rev-list") return gitOk(`${run.commits.join("\n")}\n`);
    if (cmd === "notes") return gitOk(run.notesList === "" ? "" : `${run.notesList}\n`);
    if (cmd === "cat-file") return gitOk(run.noteBodies.get(String(args[2])) ?? "{}");
    if (cmd === "ls-tree") {
      const files = over.files ?? DEFAULT_PLAN.files;
      return gitOk(`${Object.keys(files).join("\n")}\n`);
    }
    if (cmd === "show") {
      const files = over.files ?? DEFAULT_PLAN.files;
      const path = String(args[1]).replace(/^HEAD:/, "");
      return gitOk(files[path] ?? "");
    }
    if (cmd === "fsck") return { code: over.fsckCode ?? 0, stdout: "", stderr: "" };
    if (cmd === "rev-parse") {
      const commit = String(args[1]).replace(/\^\{tree\}$/, "");
      if (commit === "seed0") return gitOk("seedtree\n");
      const match = /^c(\d+)$/.exec(commit);
      return match === null ? gitOk("?\n") : gitOk(`t${match[1]}\n`);
    }
    return { code: 2, stdout: "", stderr: `fake git: ${args.join(" ")}` };
  };

  const http: SoakDeps["http"] = async ({ method, path, body }) => {
    httpCalls.push({ method, path, body, frames: floor.framesSent, ms: nowMs });
    if (method === "POST" && path === "/api/pools") {
      if ((hooks.createErrors ?? 0) > 0) {
        hooks.createErrors = (hooks.createErrors ?? 0) - 1;
        return { status: 500, body: "<!DOCTYPE html>", bytes: 15 };
      }
      return { status: 200, body: "{}", bytes: 2 };
    }
    if (method === "POST" && path === "/api/swarm") {
      if ((body as { running?: unknown }).running === true) hooks.onSwarmStart?.(floor);
      return { status: 200, body: "{}", bytes: 2 };
    }
    if (method === "GET" && path.endsWith("/replay.ndjson")) {
      // The owner export the runner parses: every event the Floor holds (12.3). `bytes` stays
      // plan-driven so `recording_fits` can be pushed over the limit.
      const text = floor.exportNdjson(POOL);
      return { status: 200, body: text, bytes: over.replayBytes ?? DEFAULT_PLAN.replayBytes };
    }
    if (method === "POST" && path.endsWith("/rebuild")) {
      floor.push(...run.post());
      return { status: 200, body: "{}", bytes: 2 };
    }
    return { status: 404, body: "", bytes: 0 };
  };

  return {
    deps: {
      http,
      probe: (pool) => floor.probe(pool),
      socket: (pool) => floor.socket(pool),
      git,
      issueToken: async (repo) => {
        tokenCalls.push(repo);
        return TOKEN;
      },
      clock: { now: () => nowMs },
      sleep: async (ms) => {
        nowMs += ms;
        sleepCount += 1;
        hooks.onSleep?.(floor, sleepCount, nowMs);
      },
      tunables: {
        pollMs: 50,
        drainQuietMs: 100,
        wallBudgetMs: 400,
        rebuildBudgetMs: 400,
        probeMs: 5,
        reconnectMs: 5,
      },
    },
    floor,
    gitCalls,
    httpCalls,
    tokenCalls,
  };
}

const input: SoakRunInput = {
  pool: POOL,
  config: {
    seed: 7,
    agents: 3,
    launch_per_second: 50,
    collision_dial: 0.25,
    think_ms: [0, 0],
    rescale_every_s: 60,
  },
  build: BUILD,
  cloneDir: CLONE_DIR,
  recordedAt: () => RECORDED,
};

const CHECK_NAMES = [
  "all_ended",
  "one_commit_per_landing",
  "oracle",
  "no_go_around_at_zero",
  "cosmetic_is_silent",
  "never_paused",
  "no_stall",
  "fsck",
  "rebuildable",
  "false_abort_reported",
  "recording_fits",
];

const failed = (result: SoakResult) => result.checks.filter((check) => !check.ok).map((check) => check.name);

describe("the soak runner of VE6", () => {
  it("passes every check on a small run, with each field worked by hand", async () => {
    const run = buildRun();
    const fake = makeFake(run);
    const result = await runDial(input, fake.deps);

    expect(result.v).toBe(2);
    expect(result.build).toBe(BUILD);
    expect(result.recorded_at).toBe(RECORDED);
    expect(result.pool).toBe(POOL);
    expect(result.config).toEqual(input.config);

    // 3 drawn agents (reader, add-plain, add-plain at seed 7 / dial 0.25) plus one rescale.
    expect(result.agents).toEqual({ launched: 4, landed: 4, stopped: {}, in_flight_at_end: 0 });
    expect(result.landings).toEqual({ count: 4, commits_on_main: 4, notes: 4, batches: 4, pushes: 4, push_retries: 0 });

    // Window: first event ts 0 to run end (the swarm stop at 4900: the last ladder event at 4700,
    // then the metrics tick at 4800); 4 change landings.
    expect(result.metrics.landings_per_second).toBeCloseTo(4 / 4.9, 10);
    // time_to_land_ms of the four landings: 400, 900, 500, 400 -> sorted 400,400,500,900.
    expect(result.metrics.time_to_land_ms).toEqual({ p50: 400, p99: 900 });
    // Agent 1 took a repair heads-up before acceptance: 1 of 4 change landings.
    expect(result.metrics.go_around_rate).toBe(0.25);
    expect(result.metrics.confirm_rate).toBe(0);
    // Its one go-around resolved changed:true and then ended -> 0 of 1 ended.
    expect(result.metrics.false_abort_rate).toBe(0);
    // No green-line event ever arrives.
    expect(result.metrics.escape_rate).toBeNull();
    expect(result.metrics.waiting_behind_max).toBe(1);
    expect(result.metrics.push_backlog_max).toBe(2);
    // Validated streaks, accept at +500 of each base: 1110-1500, 2110-2160, 2310-2500,
    // 3110-3500, 4110-4500 -> longest 390.
    expect(result.metrics.longest_gap_ms).toBe(390);
    expect(result.metrics.tick_cpu_ms).toEqual({ p50: 12, p99: 40 });
    expect(result.metrics.push_ms).toEqual({ p50: 50, p99: 50 });

    // The rescale note carries one repair on ENERGY_MAX, inside its truth list.
    expect(result.truth).toEqual({ repairs: 1, repairs_outside_truth: 0, false_abort_rate: 0, escapes: 0 });
    expect(result.stream).toEqual({ events: 51, bytes: 1234 });

    expect(result.checks.map((check) => check.name)).toEqual(CHECK_NAMES);
    for (const check of result.checks) {
      expect(check.ok, `${check.name}: ${check.detail ?? ""}`).toBe(true);
    }

    // The owner routes the runner itself took.
    const posts = fake.httpCalls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(4);
    expect(posts[0]).toMatchObject({
      path: "/api/pools",
      body: { pool: POOL, seed: "tidepool-swarm", summary_only: true },
    });
    expect(posts[1]).toMatchObject({
      path: "/api/swarm",
      body: { pool: POOL, running: true, ...input.config },
    });
    expect(fake.tokenCalls).toEqual([POOL]);
  });

  it("no_stall fails on a gap of 10100 ms while an attempt is validated", async () => {
    // The last agent's accept lands 9710 ms late: 4110 -> 14210 with no accept between.
    const run = buildRun({ acceptDelay: { 3: 9710 } });
    const result = await runDial(input, makeFake(run).deps);
    expect(result.metrics.longest_gap_ms).toBe(10100);
    expect(failed(result)).toEqual(["no_stall"]);
  });

  it("no_stall: an attempt that waits while a batch's push is in flight is not a stall (LP1)", async () => {
    // Agent 2's landing (accepted at 3500) takes 12 s to push; agent 3, validated at 4310, can
    // only be accepted after it (its accept at 15710 = 4500 + 11210 delay), 160 ms after the push
    // at 15550. The tick accepts nothing while a push is pending (LP1), so that time is push_ms,
    // not a stall: the clock runs only from the push to the accept.
    const run = buildRun({ pushDelay: { 2: 12_000 }, acceptDelay: { 3: 11_210 } });
    const result = await runDial(input, makeFake(run).deps);
    expect(result.metrics.longest_gap_ms).toBeLessThan(10_000);
    expect(failed(result)).toEqual([]);
    // The push time is published as measured: 50 + 12000 ms for agent 2's batch.
    expect(result.metrics.push_ms.p99).toBe(12_050);
  });

  it("never_paused fails on one pool.paused", async () => {
    const run = buildRun({
      extraTail: () => [ev(4600, "trunk", { type: "pool.paused", reason: "owner", detail: "owner" })],
    });
    const result = await runDial(input, makeFake(run).deps);
    expect(failed(result)).toEqual(["never_paused"]);
  });

  it("a repair outside the truth list is counted and published as measured", async () => {
    // The rescale note repairs `entity:world/time.js#seconds` — not in its truth list — next to
    // the in-truth ENERGY_MAX repair: repairs=2, outside=1, rate 0.5. No check gates on the
    // value (VE6: a value above the target is published as measured).
    const run = buildRun({
      judgmentsOf: (spec) =>
        spec.pattern === "rescale-energy"
          ? [
              repair("entity", "world/energy.js#ENERGY_MAX", "E2", null),
              repair("entity", "world/time.js#seconds", "E2", 1),
            ]
          : [],
    });
    const result = await runDial(input, makeFake(run).deps);
    expect(result.truth).toEqual({ repairs: 2, repairs_outside_truth: 1, false_abort_rate: 0.5, escapes: 0 });
    expect(failed(result)).toEqual([]);
  });

  it("a QR1 repair on refs:#ENERGY_MAX caused by a non-add-energy landing counts outside truth", async () => {
    // The key IS in the rescale's truth list, but 02 10.4 counts it outside when the breaking
    // landing was not add-energy — cause seq 1 is the reader's landing at this seed/dial.
    const run = buildRun({
      judgmentsOf: (spec) =>
        spec.pattern === "rescale-energy" ? [repair("query", "refs:world/energy.js#ENERGY_MAX", "QR1", 1)] : [],
    });
    const result = await runDial(input, makeFake(run).deps);
    expect(result.truth).toEqual({ repairs: 1, repairs_outside_truth: 1, false_abort_rate: 1, escapes: 0 });
  });

  it("a QR1 repair caused by an add-energy landing is a true dependency", async () => {
    // seed 7 / dial 1: draw 1 is add-energy, so the QR1 repair it caused is inside truth while
    // the one caused by draw 0 (same-file) is outside.
    const dialOne: SoakRunInput = { ...input, config: { ...input.config, agents: 4, collision_dial: 1 } };
    const run = buildRun({
      dial: 1,
      agents: 4,
      rescale: true,
      goAroundOn: [],
      judgmentsOf: (spec, seq) => {
        if (spec.pattern !== "rescale-energy") return [];
        // seqs 2 and 1 are landings of draws 1 (add-energy) and 0 (same-file).
        return [
          repair("query", "refs:world/energy.js#ENERGY_MAX", "QR1", 2),
          repair("query", "refs:world/energy.js#ENERGY_MAX", "QR1", 1),
          repair("entity", "world/energy.js#ENERGY_MAX", "E2", null),
        ];
      },
    });
    const result = await runDial(dialOne, makeFake(run).deps);
    expect(result.truth).toEqual({ repairs: 3, repairs_outside_truth: 1, false_abort_rate: 1 / 3, escapes: 0 });
  });

  it("oracle fails on one SW2 escape", async () => {
    const run = buildRun({ files: ESCAPE_FILES });
    const result = await runDial(input, makeFake(run, { files: ESCAPE_FILES }).deps);
    expect(result.truth.escapes).toBe(1);
    expect(failed(result)).toEqual(["oracle"]);
  });

  it("no_go_around_at_zero fails on a go-around at dial 0", async () => {
    const dialZero: SoakRunInput = { ...input, config: { ...input.config, collision_dial: 0 } };
    const run = buildRun({ dial: 0 });
    const result = await runDial(dialZero, makeFake(run).deps);
    expect(result.metrics.go_around_rate).toBe(0.25);
    expect(failed(result)).toEqual(["no_go_around_at_zero"]);
  });

  it("cosmetic_is_silent fails when a cosmetic landing heads up another pattern", async () => {
    // seed 7 / dial 1, draw 9 is `cosmetic` (worked out with the 10.4 draws): a heads-up its
    // landing causes reaching draw 0 (same-file) is the forbidden reach.
    const dialOne: SoakRunInput = { ...input, config: { ...input.config, agents: 10, collision_dial: 1 } };
    expect(dialPattern(1, agentRandom(7, 9))).toBe("cosmetic");
    const run = buildRun({
      dial: 1,
      agents: 10,
      rescale: true,
      goAroundOn: [1],
      extraTail: (landed) => {
        const cosmetic = landed.find((l) => l.spec.pattern === "cosmetic");
        const receiver = landed[0];
        if (cosmetic === undefined || receiver === undefined) return [];
        return [
          ev(4600, "trunk", {
            type: "headsup.sent",
            attempt_id: receiver.spec.attempt,
            hn: 2,
            result: "info",
            wake: false,
            cause: { type: "landing", seqs: [cosmetic.seq], changes: [] },
            keys: [{ kind: "listing", key: "creatures/", rule: "L1" }],
            items: null,
            dropped_ops: [],
            go_around: null,
          }),
        ];
      },
      judgmentsOf: (spec) =>
        spec.pattern === "add-energy" ? [repair("entity", "world/energy.js#ENERGY_MAX", "E2", 2)] : [],
    });
    const result = await runDial(dialOne, makeFake(run).deps);
    expect(failed(result)).toEqual(["cosmetic_is_silent"]);
  });

  it("fsck fails when git fsck --strict exits nonzero", async () => {
    const run = buildRun({ fsckCode: 1 });
    const result = await runDial(input, makeFake(run, { fsckCode: 1 }).deps);
    expect(failed(result)).toEqual(["fsck"]);
  });

  it("rebuildable fails when the rebuild lands another head", async () => {
    const run = buildRun({ rebuildHeadSeq: 9 });
    const result = await runDial(input, makeFake(run).deps);
    expect(failed(result)).toEqual(["rebuildable"]);
  });

  it("recording_fits fails when the export is larger than REPLAY_MAX_BYTES", async () => {
    const run = buildRun({ replayBytes: REPLAY_MAX_BYTES + 1 });
    const result = await runDial(input, makeFake(run, { replayBytes: REPLAY_MAX_BYTES + 1 }).deps);
    expect(result.stream.bytes).toBe(REPLAY_MAX_BYTES + 1);
    expect(failed(result)).toEqual(["recording_fits"]);
  });

  it("all_ended fails while an agent is still in flight at the deadline", async () => {
    // Agent index 2 never proceeds past `working`; the late metrics event carries the stream's
    // ts past ATTEMPT_TIMEOUT_MS after the last open, ending the wait the spec sets.
    const run = buildRun({
      stopAfterWorking: [2],
      extraLate: () => [
        ev(610_000, "trunk", {
          type: "metrics",
          window_ms: 60_000,
          landings_per_second: 0,
          time_to_land_ms: { p50: null, p99: null },
          time_held_ms: { p50: null, p99: null },
          go_around_rate: null,
          false_abort_rate: null,
          escape_rate: null,
          waiting_behind: 0,
          push_backlog: 0,
          tick_cpu_ms: { p50: null, p99: null },
        }),
      ],
      goAroundOn: [1],
      judgmentsOf: (spec) =>
        spec.pattern === "rescale-energy" ? [repair("entity", "world/energy.js#ENERGY_MAX", "E2", null)] : [],
    });
    const fake = makeFake(run);
    const result = await runDial(input, fake.deps);
    expect(result.agents.in_flight_at_end).toBe(1);
    // The in-flight agent also gates `rebuildable`: the POST /rebuild never fires and the check
    // fails saying why — rebuilding a running pool pauses it (RB3) and freezes the run.
    expect(fake.httpCalls.some((call) => call.path.endsWith("/rebuild"))).toBe(false);
    const rebuildable = result.checks.find((check) => check.name === "rebuildable");
    expect(rebuildable?.detail).toContain("1 attempt(s) still in flight");
    expect(failed(result)).toEqual(["all_ended", "rebuildable"]);
  });

  it("waits out the launch-scaled wall budget, then stops the run, before its checks", async () => {
    // agents / launch_per_second = 4 s of launch phase; no stream deadline is ever in sight
    // (no late events carry the ts past it), so only the wall bound can end the run's wait.
    // The old fixed bound — min(wallBudgetMs, ...) = 400 ms — would stop the run at ~400 ms.
    const run = buildRun({ agents: 4, stopAfterWorking: [3] });
    const fake = makeFake(run);
    const result = await runDial({ ...input, config: { ...input.config, agents: 4, launch_per_second: 1 } }, fake.deps);
    const stop = fake.httpCalls.find(
      (call) => call.path === "/api/swarm" && (call.body as { running?: unknown }).running === false,
    );
    expect(stop).toBeDefined();
    expect(stop?.ms).toBeGreaterThanOrEqual(4000);
    // The stop does not make the still-working agent end: the drain gives up after the tail,
    // the export still shows it in flight, and nothing is rebuilt over it.
    expect(result.agents.in_flight_at_end).toBe(1);
    expect(fake.httpCalls.some((call) => call.path.endsWith("/rebuild"))).toBe(false);
    expect(failed(result)).toEqual(["all_ended", "rebuildable"]);
  });

  it("drains a late finisher after the stop POST and rebuilds once it is landed", async () => {
    // Agent 2's completion events are held out of the fixture; the `onSleep` hook pushes them
    // during the settle wait — 150 ms of fake wall time after the stop POST — so the runner is
    // observed waiting on an in-flight agent that then lands.
    const run = buildRun({ lateFinish: [2] });
    let pushed = false;
    let calls: HttpCall[] = [];
    const fake = makeFake(
      run,
      {},
      {
        onSleep: (floor, _count, ms) => {
          const stopMs = calls.find(
            (call) => call.path === "/api/swarm" && (call.body as { running?: unknown }).running === false,
          )?.ms;
          if (stopMs === undefined || pushed || ms < stopMs + 150) return;
          pushed = true;
          floor.push(...run.lateEvents(run.lastPreTs + 200));
        },
      },
    );
    calls = fake.httpCalls;
    const result = await runDial(input, fake.deps);
    expect(pushed).toBe(true);
    expect(result.agents.in_flight_at_end).toBe(0);
    expect(fake.httpCalls.some((call) => call.path.endsWith("/rebuild"))).toBe(true);
    expect(failed(result)).toEqual([]);
  });

  it("one_commit_per_landing fails when a landing's note is missing", async () => {
    // A second note carries a repair too, so dropping the rescale's note still leaves a truth
    // rate to report (that check stays green; only the count fails).
    const run = buildRun({
      dropNotes: [4],
      judgmentsOf: (spec) => {
        if (spec.pattern === "rescale-energy") return [repair("entity", "world/energy.js#ENERGY_MAX", "E2", null)];
        if (spec.pattern === "add-plain") return [repair("entity", "world/movement.js#step", "E2", 1)];
        return [];
      },
    });
    const result = await runDial(input, makeFake(run).deps);
    expect(result.landings).toMatchObject({ count: 4, commits_on_main: 4, notes: 3 });
    expect(failed(result)).toEqual(["one_commit_per_landing"]);
  });

  it("false_abort_reported: nothing to rate (no go-around, no repair) is reported as such and passes", async () => {
    // VE6 amended: at dial 0, no_go_around_at_zero demands this run, whose two rates are 0/0.
    const run = buildRun({ goAroundOn: [], judgmentsOf: () => [] });
    const result = await runDial(input, makeFake(run).deps);
    expect(result.metrics.false_abort_rate).toBeNull();
    expect(result.truth.false_abort_rate).toBeNull();
    expect(failed(result)).toEqual([]);
    expect(result.checks.find((check) => check.name === "false_abort_reported")?.detail).toContain("nothing to rate");
  });

  it("false_abort_reported fails when a go-around is rated but the notes carry no repair", async () => {
    // Agent 1 goes around and resolves (the metrics side has a rate), but no note judges a repair:
    // the truth side is missing while there was something to rate.
    const run = buildRun({ judgmentsOf: () => [] });
    const result = await runDial(input, makeFake(run).deps);
    expect(result.metrics.false_abort_rate).not.toBeNull();
    expect(result.truth.false_abort_rate).toBeNull();
    expect(failed(result)).toEqual(["false_abort_reported"]);
  });

  it("never writes the owner key or the read token into output, files or calls", async () => {
    const run = buildRun();
    const fake = makeFake(run);
    const result = await runDial(input, fake.deps);

    const haystack = [JSON.stringify(result), ...fake.httpCalls.map((call) => JSON.stringify(call))].join("\n");
    expect(haystack).not.toContain(TOKEN);
    expect(haystack).not.toContain(OWNER_KEY);

    // The token travels one way: the process environment of the clone and of the notes fetch that
    // follows it (`git clone` fetches no refs/notes), as http.extraHeader.
    const authCalls = fake.gitCalls.filter((call) => call.args[0] === "clone" || call.args[0] === "fetch");
    expect(authCalls.map((call) => call.args[0])).toEqual(["clone", "fetch"]);
    expect(authCalls[1]?.args).toEqual(["fetch", "origin", "refs/notes/*:refs/notes/*"]);
    for (const call of authCalls) {
      expect(call.env?.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
      expect(call.env?.GIT_CONFIG_VALUE_0).toBe(`Authorization: Bearer ${TOKEN}`);
    }

    for (const call of fake.gitCalls) {
      const argsText = call.args.join(" ");
      expect(argsText).not.toContain(TOKEN);
      expect(argsText).not.toContain(OWNER_KEY);
      if (!authCalls.includes(call) && call.env !== undefined) {
        expect(JSON.stringify(call.env)).not.toContain(TOKEN);
        expect(JSON.stringify(call.env)).not.toContain(OWNER_KEY);
      }
    }
    for (const call of fake.httpCalls) {
      expect(JSON.stringify(call)).not.toContain(TOKEN);
      expect(JSON.stringify(call)).not.toContain(OWNER_KEY);
    }
    // The token is asked once, for the pool's repo — and nothing else is asked.
    expect(fake.tokenCalls).toEqual([POOL]);
  });
});

describe("the stream gate and the export", () => {
  it("a server error on the pool's creation is tried again with the same request_id", async () => {
    // The deployment answered 500 once after the pool was already made (2026-10-05): the run
    // creates again with the same request_id, which names the same pool (9.8), and goes on.
    const run = buildRun();
    const fake = makeFake(run, {}, { createErrors: 2 });
    const result = await runDial(input, fake.deps);
    const creates = fake.httpCalls.filter((call) => call.method === "POST" && call.path === "/api/pools");
    expect(creates).toHaveLength(3);
    expect(new Set(creates.map((call) => JSON.stringify(call.body))).size).toBe(1);
    for (const check of result.checks) {
      expect(check.ok, `${check.name}: ${check.detail ?? ""}`).toBe(true);
    }
  });

  it("three server errors in a row end the dial with the last answer", async () => {
    const run = buildRun();
    const fake = makeFake(run, {}, { createErrors: 3 });
    await expect(runDial(input, fake.deps)).rejects.toThrow("POST /api/pools answered 500");
  });

  it("probes through FR30's 404s and starts the Swarm only after the stream's first frame", async () => {
    // The route answers 404 twice (the pool's first event has not reached the Floor) and 200
    // on the third probe; the Swarm's POST must land after the first frame was delivered.
    const run = buildRun();
    const fake = makeFake(run, {}, { probeMisses: 2 });
    const result = await runDial(input, fake.deps);

    expect(fake.floor.probes).toBe(3);
    const swarmStart = fake.httpCalls.find((call) => call.path === "/api/swarm");
    expect(swarmStart?.frames).toBeGreaterThanOrEqual(1);
    for (const check of result.checks) {
      expect(check.ok, `${check.name}: ${check.detail ?? ""}`).toBe(true);
    }
    expect(result.stream.events).toBe(51); // four per-landing pushes (LP1) in place of one
  });

  it("never posts /api/swarm — running true or false — while the stream has not produced a frame", async () => {
    // The pool's stream never exists within the deadline: the dial fails and the only HTTP the
    // runner did was creating the pool. `running: false` while still connecting is the exact
    // defect this guards (the deployed soak stopped a second after starting).
    const run = buildRun();
    const fake = makeFake(run, {}, { probeMisses: 10_000 });
    await expect(runDial(input, fake.deps)).rejects.toThrow(/stream produced no frame/);
    expect(fake.httpCalls.map((call) => call.path)).toEqual(["/api/pools"]);
  });

  it("scores a mid-run drop from the export — a landing.landed that lived only in the gap counts", async () => {
    // Agent 0's ladder is on the floor up front. When the Swarm starts, agent 1's ladder is
    // pushed live, the socket drops, and agents 2, 3 and the run's tail land in the gap: they
    // reach the run only through the reconnect's snapshot (for the waits) and the owner export
    // (for every reported number).
    const run = buildRun();
    const split = run.pre.findIndex((event) => event.type === "intent.created" && event.intent_id === iid(1));
    expect(split).toBe(13); // agent 0's ladder: 13 events with its batch.pushed
    const tail = run.pre.slice(split);
    const fake = makeFake(
      { ...run, pre: run.pre.slice(0, split) },
      {},
      {
        onSwarmStart: (floor) => {
          floor.push(...tail.slice(0, 16)); // agent 1's ladder (n 14..29): delivered live on socket 0
          floor.dropAll();
          floor.push(...tail.slice(16)); // n 30..51: pushed while no socket is open — the gap
        },
      },
    );
    const result = await runDial(input, fake.deps);

    // Two sockets were opened; the reconnect's first frame is the snapshot that covers the gap.
    expect(fake.floor.sockets).toHaveLength(2);
    const second = fake.floor.sockets[1];
    expect(second?.frames[0]).toHaveProperty("snapshot");

    // The gap's events (n 30..51 — landings 2, 3 and the rescale's `landing.landed` among them)
    // were never carried on an events frame.
    const deliveredNs = new Set<number>();
    for (const ws of fake.floor.sockets) {
      for (const frame of ws.frames) {
        if (!("events" in frame)) continue;
        for (const event of frame.events) deliveredNs.add(event.n);
      }
    }
    expect(deliveredNs.has(30)).toBe(false);
    expect(deliveredNs.has(51)).toBe(false);

    // Every reported number is the export's: identical to the undropped run's hand-worked values.
    expect(result.agents).toEqual({ launched: 4, landed: 4, stopped: {}, in_flight_at_end: 0 });
    expect(result.landings).toEqual({ count: 4, commits_on_main: 4, notes: 4, batches: 4, pushes: 4, push_retries: 0 });
    expect(result.stream).toEqual({ events: 51, bytes: 1234 });
    for (const check of result.checks) {
      expect(check.ok, `${check.name}: ${check.detail ?? ""}`).toBe(true);
    }
  });
});
