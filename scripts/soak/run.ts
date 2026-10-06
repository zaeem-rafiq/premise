// The Swarm soak runner of VE6 (docs/spec/04-build-plan.md 5.2): one pool per collision-dial
// value, the scripted agents of `SwarmConfig` against it, then the eleven checks. Every effect —
// HTTP, the pool's WebSocket stream, git, the Artifacts read token, the clock — is an injected
// dependency, so the unit tests run the whole runner offline against fakes.
//
// The stream discipline is 01-core 12.2's: the shared reader of `stream.ts` probes the route
// with a plain GET until the pool has an event (FR30), sends the one hello, accepts the
// snapshot frame a stale `after` answers, and reconnects with `after: <last n>` on a drop. The
// Swarm never starts before the first frame — the run's early `running: false` came from
// treating a closed socket as a drained stream. The live stream drives the waits alone (which
// attempts are in flight, whether the run is over; after a reconnect the snapshot's attempt
// states): every number `SoakResult` reports is computed from the complete event list of the
// owner Replay export fetched after the run, never from the lossy live view.
//
// What the runner measures, per the VE6 text:
// - `metrics` is what the reducer computes from the stream (01-core 14). The run's window is the
//   whole stream, first event to last: `computeMetrics` gets `window_ms = last_ts - first_ts`.
//   The three fields the reducer cannot answer for a whole run are computed here the way 14
//   defines them: `time_to_land_ms` from the `landing.landed.time_to_land_ms` of every change
//   landing (14.2), `go_around_rate` and `confirm_rate` from each landing's `landing_facts` at
//   acceptance (14.3 — the state trims `landing_facts` with the landings, so the values are
//   snapshotted at `landing.accepted`), `longest_gap_ms` from the `validated` set and
//   `landing.accepted` times (the `no_stall` definition), `waiting_behind_max` and
//   `push_backlog_max` as the maxima over `metrics` events, `push_ms` from `batch.pushed.ms`.
//   `tick_cpu_ms` stays null: no event carries tick CPU time (14.6).
// - `truth` is what only Artifacts can answer after the run: `repair` judgments of the landed
//   notes against each attempt's truth list (TR8, `02` 10.3) and the SW2 oracle over the head
//   tree. An attempt's truth list is recomputed the way the launcher computed it: the attempt id
//   `a_<ULID>` of `H("swarm|a_|<request_id>|<n>")` names its draw-stream index `n`; the intent
//   text "rescale ENERGY_MAX" names a scheduled rescale launch, everything else was drawn with
//   `dialPattern(d, agentRandom(seed, n))`, and `truthOf` gets the agent's own fresh stream
//   (SW1).
// - `rebuildable` asks Trunk to rebuild from Artifacts (RB1) and compares `head_seq` and the
//   head tree id before and after. `recording_fits` reads the owner export `replay.ndjson` and
//   compares its byte size with `REPLAY_MAX_BYTES`.

import type { PoolEvent } from "../../src/protocol/events.ts";
import type { AttemptState } from "../../src/protocol/attempt.ts";
import type { Note } from "../../src/protocol/note.ts";
import type { SwarmConfig } from "../../src/protocol/swarm.ts";
import type { FloorState } from "../../src/protocol/reducer/state.ts";
import { emptyFloorState } from "../../src/protocol/reducer/state.ts";
import { reduce } from "../../src/protocol/reducer/reduce.ts";
import { computeMetrics } from "../../src/protocol/reducer/metrics.ts";
import { ATTEMPT_TIMEOUT_MS, REPLAY_MAX_BYTES } from "../../src/protocol/constants.ts";
import { H } from "../../src/core/sync/h.ts";
import { agentRandom } from "../../src/swarm/prng.ts";
import { dialPattern } from "../../src/swarm/dial.ts";
import { patternById } from "../../src/swarm/pattern.ts";
import { sw2Escapes } from "../../src/swarm/sw2.ts";
import { openPoolStream, parseReplayNdjson, type StreamSocket } from "./stream.ts";

// ---- The dependencies the command injects (the tests fake them) ----

/** A route answer: the status, the decoded body and the body's byte length. */
export type SoakResponse = { status: number; body: string; bytes: number };

/** The owner routes the soak calls. `path` starts with `/api/`. */
export type SoakHttp = (request: { method: "GET" | "POST"; path: string; body?: unknown }) => Promise<SoakResponse>;

/** A git invocation: `git <args...>` answered `{code, stdout, stderr}`. */
export type SoakGit = (
  args: readonly string[],
  opts?: { cwd?: string; env?: Record<string, string> },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** The Artifacts read-token source (SE5c): a `npx wrangler artifacts repos issue-token` call. */
export type SoakTokenSource = (repo: string) => Promise<string>;

/** Wait-phase knobs; the defaults bound a real run, the tests shrink them. */
export type SoakTunables = {
  /** How often the stream's state is re-read while waiting. */
  pollMs: number;
  /** Post-stop drain: how long without a new event before the run is called settled. */
  drainQuietMs: number;
  /** The wall-clock bound of one wait phase, and the reader's give-up bound when the pool's
   * stream produces no frame for that long (the FR30 probe of an eventless pool included). */
  wallBudgetMs: number;
  /** The wall-clock bound of the rebuild wait (RB1 replays every landing). */
  rebuildBudgetMs: number;
  /** The reader's wait between plain-GET probes while the route answers 404. */
  probeMs: number;
  /** The reader's wait after a socket close before the next probe. */
  reconnectMs: number;
};

const DEFAULT_TUNABLES: SoakTunables = {
  pollMs: 500,
  drainQuietMs: 5_000,
  wallBudgetMs: 2 * ATTEMPT_TIMEOUT_MS,
  rebuildBudgetMs: ATTEMPT_TIMEOUT_MS,
  probeMs: 250,
  reconnectMs: 1_000,
};

export type SoakDeps = {
  http: SoakHttp;
  /** FR30's plain-GET probe of `/api/pools/{pool}/stream`: answers the HTTP status (0 when the
   * request itself failed). */
  probe: (pool: string) => Promise<number>;
  /** Opens the pool's stream WebSocket (`GET /api/pools/{pool}/stream`, upgraded). */
  socket: (pool: string) => StreamSocket;
  git: SoakGit;
  issueToken: SoakTokenSource;
  clock: { now(): number };
  sleep(ms: number): Promise<void>;
  tunables?: Partial<SoakTunables>;
};

export type SoakRunInput = {
  /** The pool to create (`summary_only: true`, seed `tidepool-swarm`). */
  pool: string;
  /** The full `SwarmConfig` of the run; `collision_dial` is this file's dial value. */
  config: SwarmConfig;
  /** The short commit id of the build, for `SoakResult.build` and `request_id`s. */
  build: string;
  /** The directory the pool repository is cloned into (created by the caller, emptied by it). */
  cloneDir: string;
  /** `SoakResult.recorded_at`. */
  recordedAt: () => string;
};

// ---- The SoakResult of VE6 ----

export type SoakCheck = { name: string; ok: boolean; detail?: string };

export type SoakResult = {
  v: 2;
  build: string;
  recorded_at: string;
  pool: string;
  config: SwarmConfig;
  agents: { launched: number; landed: number; stopped: Record<string, number>; in_flight_at_end: number };
  landings: {
    count: number;
    commits_on_main: number;
    notes: number;
    batches: number;
    pushes: number;
    push_retries: number;
  };
  metrics: {
    landings_per_second: number;
    time_to_land_ms: { p50: number | null; p99: number | null };
    go_around_rate: number;
    confirm_rate: number;
    false_abort_rate: number | null;
    escape_rate: number | null;
    waiting_behind_max: number;
    push_backlog_max: number;
    longest_gap_ms: number;
    tick_cpu_ms: { p50: number | null; p99: number | null };
    push_ms: { p50: number | null; p99: number | null };
  };
  truth: {
    repairs: number;
    repairs_outside_truth: number;
    false_abort_rate: number | null;
    escapes: number;
  };
  stream: { events: number; bytes: number };
  checks: SoakCheck[];
};

/** A route or environment answer the soak cannot measure from. */
export class SoakError extends Error {}

// ---- `launchId` of src/worker/swarm/launch.ts (SWR4), re-derived here: that file cannot be
// imported — its `Env` type import pulls the worker's Cloudflare types into every program that
// compiles this script. The derivation is the spec's: `a_<ULID>` is the 128 bits of
// `H("swarm|<prefix>|<request_id>|<n>")` Crockford-base32-encoded. The tests re-derive it from
// the same text once more, independently, so a drift shows as a failed fixture.

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The deterministic `a_<ULID>` (or `i_`, `c_`) of agent `n` of one launch request. */
function swarmLaunchId(prefix: "a_" | "i_" | "c_", requestId: string, n: number): string {
  let value = BigInt(`0x${H(`swarm|${prefix}|${requestId}|${n}`)}`);
  let id = "";
  for (let i = 0; i < 26; i += 1) {
    id = (B32[Number(value & 0x1fn)] ?? "") + id;
    value >>= 5n;
  }
  return `${prefix}${id}`;
}

// ---- What one drained stream accumulates ----

type HeadsUpSeen = { attempt_id: string; hn: number; seqs: number[] };

type Collected = {
  state: FloorState;
  events: number;
  firstTs: number | null;
  lastTs: number;
  opened: string[];
  attemptState: Map<string, AttemptState>;
  stoppedReason: Map<string, string | null>;
  intents: Map<string, string>;
  attemptIntentId: Map<string, string>;
  lastOpenTs: number | null;
  sentHeadsUps: HeadsUpSeen[];
  acceptFacts: Map<number, { submit_ts: number | null; repair: number; confirm: number }>;
  accepted: Map<number, { ts: number; kind: string; attempt_id: string | null; batch_id: number }>;
  landedCount: number;
  landedChanges: Array<{ seq: number; ts: number; time_to_land_ms: number | null; tree: string }>;
  pushes: number;
  pushRetries: number;
  pushMs: number[];
  metricSamples: Array<{
    waiting_behind: number;
    push_backlog: number;
    tick: { p50: number | null; p99: number | null };
  }>;
  runningFalseSeen: boolean;
  poolPaused: PoolEvent[];
  validated: Set<string>;
  validatedSince: number | null;
  lastAcceptedTs: number | null;
  longestGapMs: number;
};

function newCollected(): Collected {
  return {
    state: emptyFloorState(),
    events: 0,
    firstTs: null,
    lastTs: 0,
    opened: [],
    attemptState: new Map(),
    stoppedReason: new Map(),
    intents: new Map(),
    attemptIntentId: new Map(),
    lastOpenTs: null,
    sentHeadsUps: [],
    acceptFacts: new Map(),
    accepted: new Map(),
    landedCount: 0,
    landedChanges: [],
    pushes: 0,
    pushRetries: 0,
    pushMs: [],
    metricSamples: [],
    runningFalseSeen: false,
    poolPaused: [],
    validated: new Set(),
    validatedSince: null,
    lastAcceptedTs: null,
    longestGapMs: 0,
  };
}

/**
 * Applies one event: the reducer first (it is the product's own reading, EM5/EV5), then the
 * soak's own bookkeeping for what the run needs and the state does not keep whole.
 */
function observe(col: Collected, event: PoolEvent): void {
  // `no_stall`: the interval from the newest of {last landing.accepted, the ts the `validated`
  // set last became nonempty} to this event — while the set is nonempty.
  if (col.validated.size > 0 && col.validatedSince !== null) {
    const anchor = Math.max(col.lastAcceptedTs ?? col.validatedSince, col.validatedSince);
    col.longestGapMs = Math.max(col.longestGapMs, event.ts - anchor);
  }

  reduce(col.state, event);
  col.events += 1;
  if (col.firstTs === null) col.firstTs = event.ts;
  col.lastTs = Math.max(col.lastTs, event.ts);

  switch (event.type) {
    case "pool.state":
      if (event.state === "paused") col.poolPaused.push(event);
      break;
    case "pool.paused":
      col.poolPaused.push(event);
      break;
    case "intent.created":
      col.intents.set(event.intent_id, event.text);
      break;
    case "attempt.opened":
      col.opened.push(event.attempt_id);
      col.attemptState.set(event.attempt_id, "opened");
      col.attemptIntentId.set(event.attempt_id, event.intent_id);
      col.lastOpenTs = event.ts;
      break;
    case "attempt.reopened":
      col.attemptState.set(event.attempt_id, "working");
      col.validated.delete(event.attempt_id);
      break;
    case "attempt.state": {
      col.attemptState.set(event.attempt_id, event.to);
      if (event.to === "stopped") col.stoppedReason.set(event.attempt_id, event.reason);
      if (event.to === "validated") {
        if (col.validated.size === 0) col.validatedSince = event.ts;
        col.validated.add(event.attempt_id);
      } else if (event.from === "validated" || col.validated.has(event.attempt_id)) {
        col.validated.delete(event.attempt_id);
        if (col.validated.size === 0) col.validatedSince = null;
      }
      break;
    }
    case "headsup.sent":
      col.sentHeadsUps.push({
        attempt_id: event.attempt_id,
        hn: event.hn,
        seqs: event.cause.seqs,
      });
      break;
    case "landing.accepted": {
      col.accepted.set(event.seq, {
        ts: event.ts,
        kind: event.kind,
        attempt_id: event.attempt_id,
        batch_id: event.batch_id,
      });
      col.lastAcceptedTs = event.ts;
      // 14.3's per-landing facts, frozen at acceptance; the state trims them with the landing.
      const facts = col.state.landing_facts[event.seq];
      if (facts !== undefined) col.acceptFacts.set(event.seq, { ...facts });
      break;
    }
    case "landing.landed": {
      col.landedCount += 1;
      const kind = col.accepted.get(event.seq)?.kind ?? "change";
      if (kind === "change") {
        col.landedChanges.push({
          seq: event.seq,
          ts: event.ts,
          time_to_land_ms: event.time_to_land_ms,
          tree: event.tree,
        });
      }
      break;
    }
    case "batch.pushed":
      col.pushes += 1;
      col.pushMs.push(event.ms);
      break;
    case "push.retry":
      col.pushRetries += 1;
      break;
    case "metrics":
      col.metricSamples.push({
        waiting_behind: event.waiting_behind,
        push_backlog: event.push_backlog,
        tick: event.tick_cpu_ms,
      });
      break;
    case "swarm.state":
      if (!event.running) col.runningFalseSeen = true;
      break;
    default:
      break;
  }
}

/** The trailing stall: `validated` nonempty at stream end counts until the last event. */
function finishGap(col: Collected): void {
  if (col.validated.size > 0 && col.validatedSince !== null) {
    const anchor = Math.max(col.lastAcceptedTs ?? col.validatedSince, col.validatedSince);
    col.longestGapMs = Math.max(col.longestGapMs, col.lastTs - anchor);
  }
}

// ---- Percentiles as the reducer computes them (metrics.ts) ----

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)] ?? null;
}

function percentiles(values: number[]): { p50: number | null; p99: number | null } {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: percentile(sorted, 50), p99: percentile(sorted, 99) };
}

/** Shortens a list for a check detail: the first few entries, then a count. */
function preview(items: readonly string[], atMost = 5): string {
  if (items.length <= atMost) return items.join(",");
  return `${items.slice(0, atMost).join(",")}…+${items.length - atMost}`;
}

// ---- The run ----

/**
 * One dial value end to end: create the pool, run the Swarm, wait until every launched agent
 * has ended (or `ATTEMPT_TIMEOUT_MS` after the last launch), stop the Swarm, then read Artifacts
 * and the owner routes for the checks. Throws `SoakError` when the run itself cannot be measured.
 */
export async function runDial(input: SoakRunInput, deps: SoakDeps): Promise<SoakResult> {
  const tunables: SoakTunables = { ...DEFAULT_TUNABLES, ...deps.tunables };
  const { config, pool } = input;
  const requestId = (op: string) => `soak-${pool}-${op}`;

  const post = async (path: string, body: unknown): Promise<SoakResponse> => {
    const response = await deps.http({ method: "POST", path, body });
    return response;
  };

  // PL1: one summary-only pool per dial value.
  const created = await post("/api/pools", {
    pool,
    seed: "tidepool-swarm",
    summary_only: true,
    request_id: requestId("create"),
  });
  if (created.status < 200 || created.status >= 300) {
    throw new SoakError(`POST /api/pools answered ${created.status}: ${created.body.slice(0, 200)}`);
  }

  const stream = openPoolStream(
    pool,
    { probe: deps.probe, socket: deps.socket, now: deps.clock.now, sleep: deps.sleep },
    {
      deadlineMs: tunables.wallBudgetMs,
      probeMs: tunables.probeMs,
      reconnectMs: tunables.reconnectMs,
    },
  );

  // Nothing starts before the stream is up: the Swarm waits for the first frame, so a socket
  // racing the pool's first event (FR30's 404) cannot end the run's waits as "the stream
  // closed" — the deployed `test` run that sent `running: false` a second in was exactly that.
  if (!(await stream.ready())) {
    stream.close();
    throw new SoakError("the pool's stream produced no frame before its deadline");
  }

  // ---- The live view the waits read (snapshot states after a reconnect included) ----

  const liveAttempts = () => Object.values(stream.state()?.attempts ?? {});
  const inFlight = (): number =>
    liveAttempts().filter((attempt) => attempt.state !== "landed" && attempt.state !== "stopped").length;
  const lastOpenTs = (): number | null => {
    const ts = liveAttempts().map((attempt) => attempt.opened_ts);
    return ts.length === 0 ? null : Math.max(...ts);
  };
  const liveStreamTs = (): number => stream.state()?.ts ?? 0;
  const runningFalseSeen = (): boolean => {
    const swarm = stream.state()?.swarm;
    return swarm !== null && swarm !== undefined && !swarm.running;
  };
  let lastSeenN = stream.lastN();
  let lastEventWall = deps.clock.now();

  /**
   * Polls the live stream state until `until()` — or until the stream's own `ts` passes
   * `streamDeadlineTs` (the VE6 deadline: `ATTEMPT_TIMEOUT_MS` after the last launch), or
   * `wallBudgetMs` of wall time, or the stream gives up (`dead()`; a mid-run drop alone only
   * reconnects, it does not end the wait).
   */
  const waitFor = async (
    until: () => boolean,
    streamDeadlineTs: () => number | null,
    wallBudgetMs: number,
  ): Promise<void> => {
    const start = deps.clock.now();
    for (;;) {
      if (stream.lastN() !== lastSeenN) {
        lastSeenN = stream.lastN();
        lastEventWall = deps.clock.now();
      }
      if (until()) return;
      const deadline = streamDeadlineTs();
      if (deadline !== null && liveStreamTs() > deadline) return;
      if (deps.clock.now() - start > wallBudgetMs) return;
      if (stream.dead()) return;
      await deps.sleep(tunables.pollMs);
    }
  };

  // SWR1: the whole SwarmConfig, as `/floor.json` describes it and VE6 sets it.
  const started = await post("/api/swarm", {
    pool,
    running: true,
    request_id: requestId("run"),
    ...config,
  });
  if (started.status < 200 || started.status >= 300) {
    stream.close();
    throw new SoakError(`POST /api/swarm answered ${started.status}: ${started.body.slice(0, 200)}`);
  }

  // The run's wait: every launched agent ended (its quota launched), or the attempt timeout
  // passed after the last launch, measured on the stream's own `ts`.
  await waitFor(
    () => liveAttempts().length >= config.agents && inFlight() === 0,
    () => (lastOpenTs() === null ? null : (lastOpenTs() as number) + ATTEMPT_TIMEOUT_MS),
    tunables.wallBudgetMs,
  );

  // `running: false`: the run's agents in flight finish; launching stops.
  await post("/api/swarm", { pool, running: false, request_id: requestId("stop") });

  // The settle: stragglers the stop did not prevent (a launch step already running) end, the
  // outbox drains its pending push, and the launcher's `running: false` emission is seen — or
  // the stream has been quiet for `drainQuietMs`.
  await waitFor(
    () =>
      inFlight() === 0 &&
      (stream.state()?.push ?? null) === null &&
      (runningFalseSeen() || deps.clock.now() - lastEventWall >= tunables.drainQuietMs),
    () => (lastOpenTs() === null ? null : (lastOpenTs() as number) + 2 * ATTEMPT_TIMEOUT_MS),
    tunables.wallBudgetMs,
  );

  // ---- The run's events: the complete owner export, not the lossy live view ----

  // 12.3/RP1: `replay.ndjson` carries every event of the pool in `n` order. Everything
  // `SoakResult` reports — `agents` through `stream` — is computed from this list alone;
  // the live stream above only drove the waits. The download is the `recording_fits` one.
  const replay = await deps.http({ method: "GET", path: `/api/pools/${pool}/replay.ndjson` });
  const streamBytes = replay.bytes;
  if (replay.status < 200 || replay.status >= 300) {
    stream.close();
    throw new SoakError(`GET replay.ndjson answered ${replay.status}: ${replay.body.slice(0, 200)}`);
  }
  const col = newCollected();
  let exportEvents: PoolEvent[];
  try {
    exportEvents = parseReplayNdjson(replay.body).events;
  } catch {
    stream.close();
    throw new SoakError("replay.ndjson did not parse");
  }
  for (const event of exportEvents) observe(col, event);
  finishGap(col);

  // The run's own window ends here: post-rebuild `pool.state` events must not stretch it (14.1).
  const runEndTs = col.lastTs;
  const eventsAtExport = exportEvents.length;

  // ---- What Artifacts answers after the run ----

  const remote = col.state.pool.remote;
  let cloneOk = remote !== null;
  let commits: string[] = [];
  const notesByPosition = new Map<number, Note>();
  let notesSeen = 0;
  const headFiles = new Map<string, string>();
  let fsckRan = false;
  let fsckOk = false;
  let fsckDetail = "no clone: pool.state carried no remote";
  let tokenDetail = "";

  if (remote !== null) {
    // SE5c: a short-lived read token through git's own process environment only (BP7).
    let token = "";
    try {
      token = await deps.issueToken(pool);
    } catch (cause) {
      cloneOk = false;
      fsckDetail = `read token: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    if (token !== "") {
      const authEnv = {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
        GIT_TERMINAL_PROMPT: "0",
      };
      tokenDetail = "token issued";
      const clone = await deps.git(["clone", "--", remote, input.cloneDir], { env: authEnv });
      if (clone.code !== 0) {
        cloneOk = false;
        fsckDetail = `git clone exited ${clone.code}`;
      }
    } else if (cloneOk) {
      cloneOk = false;
      if (fsckDetail === "no clone: pool.state carried no remote") fsckDetail = "read token came back empty";
    }
  }

  if (cloneOk) {
    const list = await deps.git(["rev-list", "--first-parent", "--reverse", "HEAD"], { cwd: input.cloneDir });
    if (list.code !== 0) {
      cloneOk = false;
      fsckDetail = `git rev-list exited ${list.code}`;
    } else {
      commits = list.stdout.split("\n").filter((line) => line !== "");
      // The notes of refs/notes/premise: `notes list` gives `<note> <commit>` pairs.
      const noteLines = await deps.git(["notes", "--ref=premise", "list"], { cwd: input.cloneDir });
      if (noteLines.code === 0) {
        const positionByCommit = new Map<string, number>(commits.map((commit, index) => [commit, index]));
        for (const line of noteLines.stdout.split("\n").filter((entry) => entry !== "")) {
          const [noteOid, commitOid] = line.split(" ");
          const position = commitOid === undefined ? undefined : positionByCommit.get(commitOid);
          if (noteOid === undefined || position === undefined) continue;
          notesSeen += 1;
          const blob = await deps.git(["cat-file", "-p", noteOid], { cwd: input.cloneDir });
          if (blob.code !== 0) continue;
          try {
            notesByPosition.set(position, JSON.parse(blob.stdout) as Note);
          } catch {
            /* a note that is not JSON fails the seq check below through its position */
          }
        }
      }
      // The head tree's files, for SW2.
      const treeList = await deps.git(["ls-tree", "-r", "--name-only", "HEAD"], { cwd: input.cloneDir });
      if (treeList.code === 0) {
        for (const path of treeList.stdout.split("\n").filter((entry) => entry !== "")) {
          const shown = await deps.git(["show", `HEAD:${path}`], { cwd: input.cloneDir });
          if (shown.code === 0) headFiles.set(path, shown.stdout);
        }
      }
      const fsck = await deps.git(["fsck", "--strict"], { cwd: input.cloneDir });
      fsckRan = true;
      fsckOk = fsck.code === 0;
      fsckDetail = fsckOk ? "git fsck --strict passed" : `git fsck --strict exited ${fsck.code}`;
    }
  }

  // ---- RB1: rebuild from Artifacts, then compare head_seq and the head tree ----

  const epochBefore = col.state.pool.epoch;
  const headSeqBefore = col.state.pool.head_seq;
  const headTreeBefore = await headTreeOf(deps.git, input.cloneDir, commits, headSeqBefore);
  let rebuilt = false;
  let rebuildDetail = "";
  const rebuildAnswer = await post(`/api/pools/${pool}/rebuild`, { request_id: requestId("rebuild") });
  if (rebuildAnswer.status < 200 || rebuildAnswer.status >= 300) {
    rebuildDetail = `POST rebuild answered ${rebuildAnswer.status}`;
  } else {
    // The rebuild's `pool.state` events arrive after the export was fetched: they come through
    // the live stream, the only place they still can.
    await waitFor(
      () => {
        const after = stream.state()?.pool;
        return (
          (after !== undefined && after.epoch > epochBefore && after.state === "ready") || after?.state === "paused"
        );
      },
      () => null,
      tunables.rebuildBudgetMs,
    );
    const after = stream.state()?.pool;
    rebuilt = after !== undefined && after.epoch > epochBefore && after.state === "ready";
    if (!rebuilt) {
      rebuildDetail =
        after?.state === "paused"
          ? `pool paused during rebuild (${after.reason ?? "no reason"})`
          : `no rebuilt pool.state within ${tunables.rebuildBudgetMs} ms`;
    }
  }
  const headSeqAfter = stream.state()?.pool.head_seq ?? headSeqBefore;
  const headTreeAfter = rebuilt ? await headTreeOf(deps.git, input.cloneDir, commits, headSeqAfter) : null;

  stream.close();

  // ---- attempt id -> draw-stream index n, the launcher's own derivation ----

  const runRequest = requestId("run");
  const seqOfAttempt = new Map<string, number>();
  for (let n = 0; n < col.opened.length; n += 1) {
    seqOfAttempt.set(swarmLaunchId("a_", runRequest, n), n);
  }

  /** The intent text an attempt was opened with, from `attempt.opened` + `intent.created`. */
  const intentOfAttempt = (attemptId: string): string | null => {
    const intentId = col.attemptIntentId.get(attemptId);
    return intentId === undefined ? null : (col.intents.get(intentId) ?? null);
  };

  /** The pattern an attempt plays (02 10.3): the rescale intent names the scheduled launch. */
  const patternIdOf = (attemptId: string): string | null => {
    const n = seqOfAttempt.get(attemptId);
    if (n === undefined) return null;
    if (intentOfAttempt(attemptId) === rescaleIntent()) return "rescale-energy";
    return dialPattern(config.collision_dial, agentRandom(config.seed, n));
  };

  /** The truth list the launcher sent for the attempt (TR8), or null when the id is unmappable. */
  const truthOfAttempt = (attemptId: string, intentText: string | null): readonly string[] | null => {
    if (intentText === rescaleIntent()) {
      return patternById("rescale-energy")?.truth ?? null;
    }
    const id = patternIdOf(attemptId);
    if (id === null) return null;
    const pattern = patternById(id);
    if (pattern === undefined) return null;
    const n = seqOfAttempt.get(attemptId);
    if (n === undefined) return null;
    return pattern.truthOf === undefined ? pattern.truth : pattern.truthOf(agentRandom(config.seed, n));
  };

  // ---- agents ----

  const landed = col.opened.filter((id) => col.attemptState.get(id) === "landed").length;
  const stopped: Record<string, number> = {};
  const stoppedWithoutReason: string[] = [];
  for (const id of col.opened) {
    if (col.attemptState.get(id) !== "stopped") continue;
    const reason = col.stoppedReason.get(id) ?? null;
    if (reason === null) stoppedWithoutReason.push(id);
    const key = reason ?? "unknown";
    stopped[key] = (stopped[key] ?? 0) + 1;
  }
  const inFlightIds = col.opened.filter((id) => {
    const state = col.attemptState.get(id);
    return state !== "landed" && state !== "stopped";
  });

  // ---- metrics (the run's whole window, 14.x) ----

  const firstTs = col.firstTs ?? runEndTs;
  const windowMs = Math.max(1, runEndTs - firstTs);
  const runMetrics = computeMetrics(col.state, runEndTs, windowMs);
  const withGoAround = col.landedChanges.filter(
    (landing) => (col.acceptFacts.get(landing.seq)?.repair ?? 0) > 0,
  ).length;
  const withConfirm = col.landedChanges.filter(
    (landing) => (col.acceptFacts.get(landing.seq)?.confirm ?? 0) > 0,
  ).length;
  const goAroundRate = col.landedChanges.length === 0 ? 0 : withGoAround / col.landedChanges.length;
  const confirmRate = col.landedChanges.length === 0 ? 0 : withConfirm / col.landedChanges.length;
  const waitingMax = Math.max(
    0,
    ...col.metricSamples.map((sample) => sample.waiting_behind),
    runMetrics.waiting_behind,
  );
  const backlogMax = Math.max(0, ...col.metricSamples.map((sample) => sample.push_backlog), runMetrics.push_backlog);
  const tickP50 = col.metricSamples.map((sample) => sample.tick.p50).filter((v): v is number => v !== null);
  const tickP99 = col.metricSamples.map((sample) => sample.tick.p99).filter((v): v is number => v !== null);

  // ---- truth (Artifacts) ----

  // The pattern a landing was made by, for the QR1 clause of the truth-label rate (02 10.4:
  // a `refs:…#ENERGY_MAX` repair is a true dependency only when the breaking landing is
  // `add-energy`).
  const patternOfLanding = (seq: number): string | null => {
    const attemptId = col.accepted.get(seq)?.attempt_id;
    return attemptId === null || attemptId === undefined ? null : patternIdOf(attemptId);
  };

  /**
   * One note judgment's place against the truth labels of `02` 10.3/10.4: outside when the key
   * is not in the attempt's truth list — and, for a QR1 repair on `refs:…#ENERGY_MAX` (which IS
   * in a rescale's list), outside when the landing that caused it was not `add-energy`.
   */
  const outsideTruth = (judgment: Note["judgments"][number], truthSet: Set<string>): boolean => {
    if (!truthSet.has(`${judgment.kind}:${judgment.key}`)) return true;
    if (
      judgment.kind === "query" &&
      judgment.rule === "QR1" &&
      judgment.key.startsWith("refs:") &&
      judgment.key.endsWith("#ENERGY_MAX")
    ) {
      const cause = judgment.cause_seq === null ? null : patternOfLanding(judgment.cause_seq);
      return cause !== "add-energy";
    }
    return false;
  };

  let repairs = 0;
  let repairsOutside = 0;
  let unmappableNotes = 0;
  for (const note of notesByPosition.values()) {
    if (note.kind !== "change" || note.attempt === null) continue;
    const intentText = intentOfAttempt(note.attempt.id) ?? note.intent?.text ?? null;
    const truth = truthOfAttempt(note.attempt.id, intentText);
    if (truth === null) unmappableNotes += 1;
    const truthSet = new Set(truth ?? []);
    for (const judgment of note.judgments) {
      if (judgment.result !== "repair") continue;
      repairs += 1;
      if (truth === null || outsideTruth(judgment, truthSet)) repairsOutside += 1;
    }
  }
  const escapePaths = sw2Escapes(headFiles);

  // ---- landings ----

  const batches = new Set<number>();
  for (const landing of col.accepted.values()) batches.add(landing.batch_id);
  const commitsOnMain = cloneOk ? Math.max(0, commits.length - 1) : 0;

  // ---- the eleven checks of VE6, in the table's order ----

  const checks: SoakCheck[] = [];

  {
    const ok = inFlightIds.length === 0 && stoppedWithoutReason.length === 0;
    checks.push({
      name: "all_ended",
      ok,
      detail:
        `in_flight_at_end=${inFlightIds.length}${inFlightIds.length > 0 ? ` (${preview(inFlightIds)})` : ""};` +
        ` stopped_without_reason=${stoppedWithoutReason.length}`,
    });
  }
  {
    const seqMismatch = [...notesByPosition.entries()].filter(([position, note]) => note.seq !== position);
    const ok =
      cloneOk && commitsOnMain === col.landedCount && notesSeen === col.landedCount && seqMismatch.length === 0;
    checks.push({
      name: "one_commit_per_landing",
      ok,
      detail:
        `commits_on_main=${commitsOnMain} landings=${col.landedCount} notes=${notesSeen}` +
        (seqMismatch.length > 0 ? `; seq!=position at ${preview(seqMismatch.map(([p]) => String(p)))}` : "") +
        (!cloneOk ? "; no clone" : ""),
    });
  }
  checks.push({
    name: "oracle",
    ok: escapePaths.length === 0,
    detail:
      escapePaths.length === 0
        ? `escapes=0 over ${headFiles.size} files at head`
        : `escapes=${escapePaths.length}: ${preview(escapePaths)}`,
  });
  checks.push({
    name: "no_go_around_at_zero",
    ok: config.collision_dial !== 0 || goAroundRate === 0,
    detail: `dial=${config.collision_dial} go_around_rate=${goAroundRate}`,
  });
  {
    // `cosmetic` landings sweep no one: a heads-up caused by one may reach only `cosmetic` agents.
    const violations: string[] = [];
    for (const headsUp of col.sentHeadsUps) {
      const cosmeticCause = headsUp.seqs.some((seq) => {
        const attemptId = col.accepted.get(seq)?.attempt_id;
        return attemptId !== null && attemptId !== undefined && patternIdOf(attemptId) === "cosmetic";
      });
      if (!cosmeticCause) continue;
      const receiver = patternIdOf(headsUp.attempt_id);
      if (receiver !== "cosmetic") {
        violations.push(`hn${headsUp.hn}@${headsUp.attempt_id.slice(-8)}->${receiver ?? "unmapped"}`);
      }
    }
    checks.push({
      name: "cosmetic_is_silent",
      ok: violations.length === 0,
      detail:
        violations.length === 0
          ? "no cosmetic-caused heads-up reached another pattern"
          : `${violations.length} violations: ${preview(violations)}`,
    });
  }
  checks.push({
    name: "never_paused",
    ok: col.poolPaused.length === 0,
    detail:
      col.poolPaused.length === 0
        ? "no pool.paused"
        : `paused: ${preview(col.poolPaused.map((event) => (event.type === "pool.paused" ? event.reason : "state")))}`,
  });
  checks.push({
    name: "no_stall",
    ok: col.longestGapMs <= 10_000,
    detail: `longest_gap_ms=${col.longestGapMs} (limit 10000)`,
  });
  checks.push({
    name: "fsck",
    ok: fsckRan && fsckOk,
    detail: fsckDetail + (tokenDetail !== "" ? `; ${tokenDetail}` : ""),
  });
  {
    const sameHead = headSeqBefore === headSeqAfter && headTreeBefore !== null && headTreeBefore === headTreeAfter;
    checks.push({
      name: "rebuildable",
      ok: rebuilt && sameHead,
      detail:
        `head_seq ${headSeqBefore}->${headSeqAfter}` +
        `; head tree ${headTreeBefore ?? "?"}->${headTreeAfter ?? "?"}` +
        (rebuildDetail !== "" ? `; ${rebuildDetail}` : ""),
    });
  }
  {
    const truthRate = repairs === 0 ? null : repairsOutside / repairs;
    checks.push({
      name: "false_abort_reported",
      ok: runMetrics.false_abort_rate !== null && truthRate !== null,
      detail:
        `metrics.false_abort_rate=${runMetrics.false_abort_rate ?? "null"};` +
        ` truth.false_abort_rate=${truthRate ?? "null"} (repairs=${repairs}, outside=${repairsOutside}` +
        `${unmappableNotes > 0 ? `, unmappable attempts=${unmappableNotes}` : ""})`,
    });
  }
  checks.push({
    name: "recording_fits",
    ok: streamBytes <= REPLAY_MAX_BYTES,
    detail: `replay.ndjson ${streamBytes} bytes of ${REPLAY_MAX_BYTES}`,
  });

  // ---- SoakResult ----

  const truthRate = repairs === 0 ? null : repairsOutside / repairs;
  return {
    v: 2,
    build: input.build,
    recorded_at: input.recordedAt(),
    pool,
    config,
    agents: {
      launched: col.opened.length,
      landed,
      stopped,
      in_flight_at_end: inFlightIds.length,
    },
    landings: {
      count: col.landedCount,
      commits_on_main: commitsOnMain,
      notes: notesSeen,
      batches: batches.size,
      pushes: col.pushes,
      push_retries: col.pushRetries,
    },
    metrics: {
      landings_per_second: runMetrics.landings_per_second,
      time_to_land_ms: percentiles(
        col.landedChanges.map((landing) => landing.time_to_land_ms).filter((v): v is number => v !== null),
      ),
      go_around_rate: goAroundRate,
      confirm_rate: confirmRate,
      false_abort_rate: runMetrics.false_abort_rate,
      escape_rate: runMetrics.escape_rate,
      waiting_behind_max: waitingMax,
      push_backlog_max: backlogMax,
      longest_gap_ms: col.longestGapMs,
      tick_cpu_ms: {
        p50: tickP50.length === 0 ? null : Math.max(...tickP50),
        p99: tickP99.length === 0 ? null : Math.max(...tickP99),
      },
      push_ms: percentiles(col.pushMs),
    },
    truth: {
      repairs,
      repairs_outside_truth: repairsOutside,
      false_abort_rate: truthRate,
      escapes: escapePaths.length,
    },
    stream: { events: eventsAtExport, bytes: streamBytes },
    checks,
  };
}

/** The tree id of the landing at first-parent `position` (`head_seq`), or null when unknown. */
async function headTreeOf(
  git: SoakGit,
  cwd: string,
  commits: readonly string[],
  position: number,
): Promise<string | null> {
  const commit = commits[position];
  if (commit === undefined) return null;
  const answer = await git(["rev-parse", `${commit}^{tree}`], { cwd });
  if (answer.code !== 0) return null;
  return answer.stdout.trim();
}

/** The intent text of the `rescale-energy` pattern — the one intent no dial draw produces. */
function rescaleIntent(): string {
  return patternById("rescale-energy")?.intent ?? "rescale ENERGY_MAX";
}
