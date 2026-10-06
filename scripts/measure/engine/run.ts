// One run of the engine variant (ME7): a fresh pool from `tidepool-auto` with
// `summary_only: false`, the scripted `rescale-energy` held before its submit for `hero` and
// `confirm`, the owner's intent posted, then the pool's stream watched until the attempt lands,
// stops, or `ATTEMPT_TIMEOUT_MS` plus one minute passes. Everything the run needs — HTTP, the
// stream, the clock — is injected, so the unit tests drive a fake service.
//
// The stream discipline is 01-core 12.2's, through the shared reader of `../../soak/stream.ts`:
// the route is probed (FR30's plain GET) until it answers 426, the socket sends its one hello,
// a stale `after` answers a snapshot (its attempt states keep driving the waits), and a dropped
// socket is re-probed and re-helloed with `after: <last n>`. The scripted agent and the intent
// never start before the first frame. The live stream drives the waiting alone — every number
// `RunRecord` reports is computed from the complete event list of the owner Replay export
// (12.3) fetched after the run ends, never from the lossy live view.

import { ATTEMPT_TIMEOUT_MS } from "../../../src/protocol/constants.ts";
import type { PoolEvent } from "../../../src/protocol/events.ts";
import type { IntentSpec } from "../early/intents.ts";
import type { RunRecord } from "../early/run.ts";
import { observe } from "./observe.ts";
import { scoreRun, type ConfirmWindow } from "./score.ts";
import type { EngineService } from "./service.ts";
import { openPoolStream, parseReplayNdjson } from "../../soak/stream.ts";
import type { Clock } from "../early/run.ts";

/** The attempt timed out under the measurement's own deadline, not the deployment's. */
const RUN_BUDGET_MS = ATTEMPT_TIMEOUT_MS + 60_000;
/** The reader's FR30 probe interval while the route answers 404. */
const STREAM_PROBE_MS = 250;
/** The reader's wait after a socket close before the next probe. */
const STREAM_RECONNECT_MS = 1_000;
/** How many sockets in a row may close without one frame before the run ends `stream_lost`
 * (the old reader's MAX_RECONNECTS + the first connect). */
const STREAM_GIVE_UP_DROPS = 6;

/** A setup call to the service failed before or outside the attempt (pool, swarm, intent). */
export class RunSetupError extends Error {
  code: string;
  constructor(code: string) {
    super(`run setup failed: ${code}`);
    this.code = code;
  }
}

/** The first real `attempt.opened` named a model other than `--model`: the deployment's workhorse
 * is not the model under test (ME7's check). */
export class WorkhorseMismatch extends Error {
  openedModel: string | null;
  constructor(openedModel: string | null, expected: string) {
    super(`the deployment's workhorse is ${openedModel ?? "unknown"}, not --model ${expected}`);
    this.openedModel = openedModel;
  }
}

export type EngineRunResult = {
  record: RunRecord;
  /** The pool's complete event list — the owner Replay export's (the rescale's events
   * included), not the lossy live view. */
  events: PoolEvent[];
  counted: boolean;
  confirm: ConfirmWindow | null;
  openedModel: string | null;
  rateLimited: number;
};

export type EngineRunOpts = {
  service: EngineService;
  clock: Clock;
  model: string; // `--model`: the model under test and the expected workhorse
  spec: IntentSpec;
  runIndex: number; // the run slot of the intent (1-based)
  tryIndex: number; // which attempt of the slot this is (1-based; `not_counted` repeats)
  pool: string; // the fresh pool's name
  requestPrefix: string; // unique prefix for this attempt's request ids
  swarmSeed: number;
  seedFiles: ReadonlyMap<string, string>; // the seed's files (for `before` reconstruction)
  onLimits?: (limits: { spend_usd: number; reserved_usd: number }) => void;
  /** The first real `attempt.opened` of the run reports the model the deployment opened. */
  onOpenedModel?: (model: string | null) => void;
};

const errorCode = (body: unknown): string => {
  if (typeof body === "object" && body !== null) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return "unknown";
};

const isOk = (status: number, body: unknown): boolean =>
  status >= 200 && status < 300 && (typeof body !== "object" || body === null || !("error" in body));

/** The path that releases the held rescale (ME7): under `creatures/` for hero,
 * `creatures/fish.js` for confirm. */
function releasePath(spec: IntentSpec, path: string): boolean {
  if (spec.set === "hero") return path.startsWith("creatures/");
  if (spec.set === "confirm") return path === "creatures/fish.js";
  return false;
}

export async function engineRunOnce(opts: EngineRunOpts): Promise<EngineRunResult> {
  const { service, clock, spec } = opts;
  const pool = opts.pool;
  const rid = (what: string) => `${opts.requestPrefix}-${what}`;

  // PL1: a fresh pool from `tidepool-auto`, never `summary_only` (EV6: the stream must carry the
  // detailed events — `attempt.step`, `headsup.items`, `landing.landed.note_json`).
  const created = await service.postJson("/api/pools", {
    pool,
    seed: "tidepool-auto",
    summary_only: false,
    request_id: rid("pool"),
  });
  if (!isOk(created.status, created.body)) {
    throw new RunSetupError(`pool_create:${errorCode(created.body)}_${created.status}`);
  }

  const stream = openPoolStream(
    pool,
    {
      probe: (name) => service.probe(name),
      socket: (name) => service.socket(name),
      now: clock.now,
      sleep: clock.sleep,
    },
    {
      deadlineMs: RUN_BUDGET_MS,
      probeMs: STREAM_PROBE_MS,
      reconnectMs: STREAM_RECONNECT_MS,
      giveUpDrops: STREAM_GIVE_UP_DROPS,
    },
  );

  // Nothing scripted starts before the stream is up: the first frame — usually the snapshot a
  // fresh pool answers `after: 0` with — is the gate the rescale swarm and the intent wait on.
  if (!(await stream.ready())) {
    stream.close();
    throw new RunSetupError("stream_not_ready");
  }

  // ME7: for `hero` and `confirm` the canned `rescale-energy` opens first, held before submit.
  const needsRescale = spec.set === "hero" || spec.set === "confirm";
  if (needsRescale) {
    const swarm = await service.postJson("/api/swarm", {
      pool,
      running: true,
      patterns: ["rescale-energy"],
      hold_before_submit: ["rescale-energy"],
      seed: opts.swarmSeed,
      agents: 0,
      launch_per_second: 0,
      collision_dial: 0,
      think_ms: [50, 400],
      rescale_every_s: 0,
      request_id: rid("swarm"),
    });
    if (!isOk(swarm.status, swarm.body)) {
      stream.close();
      throw new RunSetupError(`swarm:${errorCode(swarm.body)}_${swarm.status}`);
    }
  }

  const intentResponse = await service.postJson(`/api/pools/${encodeURIComponent(pool)}/intents`, {
    text: spec.text,
    race: false,
    prewritten: false,
    request_id: rid("intent"),
  });
  if (!isOk(intentResponse.status, intentResponse.body)) {
    stream.close();
    throw new RunSetupError(`intent:${errorCode(intentResponse.body)}_${intentResponse.status}`);
  }
  const intentId =
    typeof intentResponse.body === "object" && intentResponse.body !== null
      ? String((intentResponse.body as { intent_id?: unknown }).intent_id ?? "")
      : "";
  if (intentId === "") {
    stream.close();
    throw new RunSetupError("intent:no_id");
  }

  // -- the watch loop -----------------------------------------------------------
  // The live stream decides only the waiting: which attempt is ours, when the rescale may
  // release, when the run is over. After a reconnect the snapshot's attempt states carry the
  // events the gap folded away — `events()` alone cannot see them (12.2).
  let ourAttempt: string | null = null;
  let openedModel: string | null = null;
  let acceptedSeq: number | null = null;
  let releaseTries = 0;
  let released = false;
  let ended: "landed" | "stopped" | "paused" | "deadline" | "stream_lost" = "deadline";
  const deadline = clock.now() + RUN_BUDGET_MS;
  let cursor = 0;

  const sendRelease = async (): Promise<void> => {
    releaseTries++;
    const answer = await service.postJson("/api/swarm", {
      pool,
      running: true,
      release: ["rescale-energy"],
      request_id: rid(`release${releaseTries}`),
    });
    const body = answer.body as { released?: unknown };
    released = isOk(answer.status, answer.body) && Array.isArray(body.released) && body.released.length > 0;
  };

  const mismatch = async (attemptId: string, model: string | null): Promise<never> => {
    // ME7's check: the deployment's workhorse is not the model under test. Stop the attempt
    // best-effort so it does not keep spending, then refuse the measurement.
    await service
      .postJson(`/api/pools/${encodeURIComponent(pool)}/attempts/${encodeURIComponent(attemptId)}/stop`, {
        request_id: rid("stop"),
      })
      .catch(() => {});
    stream.close();
    throw new WorkhorseMismatch(model, opts.model);
  };

  /** Reads the newest stream state (the snapshot's, reduced by every event since): the attempt
   * list a gap folded into, and the terminal states the waits end on. True: the run is over. */
  const reconcile = async (): Promise<boolean> => {
    const st = stream.state();
    if (st === null) return false;
    if (ourAttempt === null) {
      const ours = Object.values(st.attempts).find(
        (attempt) => attempt.intent_id === intentId && attempt.agent === "real",
      );
      if (ours !== undefined) {
        ourAttempt = ours.id;
        openedModel = ours.model;
        opts.onOpenedModel?.(ours.model);
        if (ours.model !== opts.model) await mismatch(ours.id, ours.model);
      }
    }
    if (ourAttempt !== null) {
      const att = st.attempts[ourAttempt];
      if (att?.state === "landed") {
        ended = "landed";
        return true;
      }
      if (att?.state === "stopped") {
        ended = "stopped";
        return true;
      }
    }
    if (st.pool.state === "paused") {
      ended = "paused";
      return true;
    }
    return false;
  };

  for (;;) {
    const list = stream.events();
    for (; cursor < list.length; cursor++) {
      const event = list[cursor] as PoolEvent;
      if (event.type === "limits") {
        opts.onLimits?.({ spend_usd: event.spend_usd, reserved_usd: event.reserved_usd });
      }
      if (event.type === "attempt.opened" && event.agent === "real" && event.intent_id === intentId) {
        if (ourAttempt === null) {
          ourAttempt = event.attempt_id;
          openedModel = event.model;
          opts.onOpenedModel?.(event.model);
          if (event.model !== opts.model) {
            await mismatch(event.attempt_id, event.model);
          }
        }
      }
      if (
        needsRescale &&
        !released &&
        releaseTries < 3 &&
        event.type === "op.recorded" &&
        event.attempt_id === ourAttempt &&
        releasePath(spec, event.path)
      ) {
        await sendRelease(); // an empty `released` means the hold was not registered yet; retry on the next op
      }
      if (event.type === "landing.accepted" && event.attempt_id === ourAttempt && acceptedSeq === null) {
        acceptedSeq = event.seq;
      }
      if (event.type === "landing.landed" && acceptedSeq !== null && event.seq === acceptedSeq) {
        ended = "landed";
      }
      if (event.type === "attempt.state" && event.attempt_id === ourAttempt && event.to === "stopped") {
        ended = "stopped";
      }
      if (event.type === "pool.paused") {
        ended = "paused";
      }
    }
    if (ended !== "deadline" || (await reconcile())) break;
    const more = await stream.wait(deadline);
    if (!more) {
      if (ended === "deadline" && stream.dead()) ended = "stream_lost"; // the socket gave up before the deadline
      break; // else: the deadline passed
    }
  }
  stream.close();

  // ---- The run's events: the complete owner export, not the lossy live view ----

  const replay = await service.getAuthed(`/api/pools/${encodeURIComponent(pool)}/replay.ndjson`);
  if (replay.status !== 200) {
    throw new RunSetupError(`replay:${replay.status}`);
  }
  let events: PoolEvent[];
  try {
    events = parseReplayNdjson(replay.text).events;
  } catch {
    throw new RunSetupError("replay:unparseable");
  }

  const obs = observe(events, intentId);
  if (obs.attemptId !== null && obs.openedModel !== opts.model) {
    // The `attempt.opened` never reached the live stream (a socket's gap folded it into a
    // snapshot): the export still answers the workhorse check.
    await mismatch(obs.attemptId, obs.openedModel);
  }

  // `files`: the text of every path the run wrote, read at the landed commit (02-tidepool 4.2;
  // the public app-server route carries no credentials).
  const files: Record<string, string> = {};
  if (obs.landed !== null && obs.accepted !== null) {
    for (const path of obs.accepted.paths) {
      const res = await service.getText(`/pool/${encodeURIComponent(pool)}/v/c-${obs.landed.commit}/${path}`);
      if (res.status === 200) files[path] = res.text;
    }
  }

  const scored = scoreRun({ obs, spec, runIndex: opts.runIndex, files, seedFiles: opts.seedFiles, ended });
  return {
    record: scored.record,
    events,
    counted: scored.counted,
    confirm: scored.confirm,
    openedModel: obs.openedModel ?? openedModel,
    rateLimited: scored.rateLimited,
  };
}
