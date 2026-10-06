// One run of the engine variant (ME7): a fresh pool from `tidepool-auto` with
// `summary_only: false`, the scripted `rescale-energy` held before its submit for `hero` and
// `confirm`, the owner's intent posted, then the pool's stream watched until the attempt lands,
// stops, or `ATTEMPT_TIMEOUT_MS` plus one minute passes. Everything the run needs — HTTP, the
// stream, the clock — is injected, so the unit tests drive a fake service.

import { ATTEMPT_TIMEOUT_MS } from "../../../src/protocol/constants.ts";
import type { PoolEvent } from "../../../src/protocol/events.ts";
import type { IntentSpec } from "../early/intents.ts";
import type { RunRecord } from "../early/run.ts";
import { observe } from "./observe.ts";
import { scoreRun, type ConfirmWindow } from "./score.ts";
import type { EngineService } from "./service.ts";
import type { Clock } from "../early/run.ts";

/** The attempt timed out under the measurement's own deadline, not the deployment's. */
const RUN_BUDGET_MS = ATTEMPT_TIMEOUT_MS + 60_000;

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
  /** The pool's events as seen (the whole stream — the rescale's events included). */
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

  const stream = service.openStream(pool);
  const events: PoolEvent[] = [];

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
  let ourAttempt: string | null = null;
  let openedModel: string | null = null;
  let acceptedSeq: number | null = null;
  let releaseTries = 0;
  let released = false;
  let ended: "landed" | "stopped" | "paused" | "deadline" = "deadline";
  const deadline = clock.now() + RUN_BUDGET_MS;

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

  for (;;) {
    const event = await stream.next(deadline);
    if (event === null) break; // the deadline passed
    events.push(event);
    if (event.type === "limits") {
      opts.onLimits?.({ spend_usd: event.spend_usd, reserved_usd: event.reserved_usd });
    }
    if (event.type === "attempt.opened" && event.agent === "real" && event.intent_id === intentId) {
      if (ourAttempt === null) {
        ourAttempt = event.attempt_id;
        openedModel = event.model;
        opts.onOpenedModel?.(event.model);
        if (event.model !== opts.model) {
          // ME7's check: the deployment's workhorse is not the model under test. Stop the attempt
          // best-effort so it does not keep spending, then refuse the measurement.
          await service
            .postJson(`/api/pools/${encodeURIComponent(pool)}/attempts/${encodeURIComponent(event.attempt_id)}/stop`, {
              request_id: rid("stop"),
            })
            .catch(() => {});
          stream.close();
          throw new WorkhorseMismatch(event.model, opts.model);
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
      break;
    }
    if (event.type === "attempt.state" && event.attempt_id === ourAttempt && event.to === "stopped") {
      ended = "stopped";
      break;
    }
    if (event.type === "pool.paused") {
      ended = "paused";
      break;
    }
  }
  stream.close();

  const obs = observe(events, intentId);

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
    openedModel,
    rateLimited: scored.rateLimited,
  };
}
