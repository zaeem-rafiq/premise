/**
 * Experiment registry and runner. Each experiment answers one question about
 * Cloudflare Artifacts as seen from inside a Durable Object; README.md lists them.
 */
import {
  Recorder,
  RunCancelled,
  errText,
  intParam,
  type ExperimentResult,
} from "../recorder";
import {
  disposeQuietly,
  type AiLike,
  type Body,
  type Deps,
  type Experiment,
} from "./common";
import { e1 } from "./e1-create-push";
import { e2 } from "./e2-minted-token";
import { e3 } from "./e3-compare-and-swap";
import { e4 } from "./e4-refs";
import { e5 } from "./e5-fork";
import { e6 } from "./e6-read-by-ref";
import { e7 } from "./e7-soak";
import { e8 } from "./e8-raw-pack";
import { e9 } from "./e9-workers-ai";
import { cleanup } from "./cleanup";

export type { AiLike, Deps, RepoState, StateStore, WarmState } from "./common";

export const EXPERIMENTS: Record<string, Experiment> = {
  "e1-create-push": e1,
  "e2-minted-token": e2,
  "e3-compare-and-swap": e3,
  "e4-refs": e4,
  "e5-fork": e5,
  "e6-read-by-ref": e6,
  "e7-soak": e7,
  "e8-raw-pack": e8,
  "e9-workers-ai": e9,
  cleanup,
};

export const EXPERIMENT_IDS = Object.keys(EXPERIMENTS);

/** After the deadline, how long the runner waits for the cancelled experiment to stop before it answers. */
export const CANCEL_GRACE_MS = 5_000;

// ----------------------------------------------------------- cancellation ----

/**
 * Run a binding call so that it fails at once when the run is cancelled, also while the
 * call is pending. A value that arrives after the cancellation is released, not used.
 */
function abortable<T>(signal: AbortSignal, start: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    start().then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) disposeQuietly(value);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** The Artifacts namespace binding, with every call stopped by the run's cancellation. */
function guardArtifacts(real: Artifacts, signal: AbortSignal): Artifacts {
  return {
    create: (name, opts) => abortable(signal, () => real.create(name, opts)),
    get: (name) => abortable(signal, () => real.get(name)),
    import: (params) => abortable(signal, () => real.import(params)),
    list: (opts) => abortable(signal, () => real.list(opts)),
    delete: (name) => abortable(signal, () => real.delete(name)),
  };
}

function guardAi(real: AiLike, signal: AbortSignal): AiLike {
  return { run: (model, input) => abortable(signal, () => real.run(model, input)) };
}

// ----------------------------------------------------------------- runner ----

export interface RunHandle {
  /** The result: at the end of the experiment, or shortly after its deadline. Never rejects. */
  result: Promise<ExperimentResult>;
  /** Resolves when the experiment code has really stopped running. Never rejects. */
  stopped: Promise<void>;
  /** Time (Date.now()) at which the run was cancelled, or null while it was not. */
  cancelledAt(): number | null;
}

/**
 * Start one experiment.
 *
 * A deadline (body.deadline_ms, default 10 minutes) guards against a run that never
 * ends. When it passes, the run is CANCELLED: pending git requests are aborted, every
 * later request and binding call throws, and the caller gets everything recorded so far.
 */
export function startExperiment(id: string, deps: Deps, body: Body): RunHandle {
  const controller = new AbortController();
  const rec = new Recorder(id, controller.signal);
  rec.data.env = deps.meta;
  const experiment = EXPERIMENTS[id];
  if (!experiment) {
    return {
      result: Promise.resolve(rec.finish(false, `unknown experiment "${id}"; known: ${EXPERIMENT_IDS.join(", ")}`)),
      stopped: Promise.resolve(),
      cancelledAt: () => null,
    };
  }
  const deadlineMs = intParam(body.deadline_ms, 600_000, 1_000, 3_600_000);
  const started = Date.now();
  let cancelledAt: number | null = null;
  const guarded: Deps = { ...deps, artifacts: guardArtifacts(deps.artifacts, controller.signal), ai: guardAi(deps.ai, controller.signal) };

  type Settled = { threw: false; ok: boolean } | { threw: true; error: unknown };
  const run: Promise<Settled> = (async () => experiment(guarded, body, rec))().then(
    (ok): Settled => ({ threw: false, ok }),
    (error: unknown): Settled => ({ threw: true, error }),
  );
  const stopped = run.then(() => undefined);

  const result = (async (): Promise<ExperimentResult> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = (ms: number) =>
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms);
      });
    const first = await Promise.race([run, wait(deadlineMs)]);
    clearTimeout(timer);
    if (first !== "timeout") {
      rec.timing("total_ms", Date.now() - started);
      if (!first.threw) return rec.finish(first.ok);
      const text = errText(first.error);
      rec.note(`experiment stopped by an exception: ${text}`);
      return rec.finish(false, text);
    }
    // Deadline: cancel the run, then give it a moment to stop.
    cancelledAt = Date.now();
    controller.abort(new RunCancelled(`deadline of ${deadlineMs} ms reached`));
    const afterGrace = await Promise.race([stopped, wait(CANCEL_GRACE_MS)]);
    clearTimeout(timer);
    rec.timing("total_ms", Date.now() - started);
    const message =
      `deadline of ${deadlineMs} ms reached; this result holds what was recorded up to that point. ` +
      (afterGrace === "timeout"
        ? `The experiment was cancelled but had not stopped ${CANCEL_GRACE_MS} ms later (a binding call is still pending). It can start no new request; the Durable Object refuses other experiments until it stops.`
        : `The experiment was cancelled and stopped ${Date.now() - cancelledAt} ms later; it makes no further requests.`);
    rec.note(message);
    return rec.finish(false, message);
  })();

  return { result, stopped, cancelledAt: () => cancelledAt };
}

/** Run one experiment and wait for its result. Never throws: failures are reported in the result. */
export async function runExperiment(id: string, deps: Deps, body: Body): Promise<ExperimentResult> {
  return startExperiment(id, deps, body).result;
}

/**
 * Runs one experiment at a time (single flight).
 *
 * A request that arrives while an experiment is still running is refused. Two runs can
 * therefore not interleave on shared state (the stored e1 repo, the warm e7 repo), and
 * cleanup cannot delete repos under a running experiment. The lock is held until the
 * experiment code has really stopped, which can be later than its response.
 */
export class ExperimentRunner {
  private active: { id: string; startedAt: number; handle: RunHandle } | null = null;

  /**
   * @param stuckReleaseMs A cancelled run that has still not stopped after this long is
   *   given up on and the lock is released. Such a run is blocked in one pending binding
   *   call and can start no new request.
   */
  constructor(private readonly stuckReleaseMs = 60_000) {}

  async run(id: string, deps: Deps, body: Body): Promise<ExperimentResult> {
    const notes: string[] = [];
    if (this.active) {
      const cancelledAt = this.active.handle.cancelledAt();
      const runningMs = Date.now() - this.active.startedAt;
      if (cancelledAt === null || Date.now() - cancelledAt < this.stuckReleaseMs) {
        const rec = new Recorder(id);
        rec.data.env = deps.meta;
        const message =
          `busy: experiment "${this.active.id}" has been running on this Durable Object for ${runningMs} ms` +
          (cancelledAt === null ? "" : ` (cancelled ${Date.now() - cancelledAt} ms ago, not stopped yet)`) +
          "; one experiment runs at a time. Nothing was run. Send the request again when that experiment has finished.";
        rec.note(message);
        return rec.finish(false, message);
      }
      notes.push(`experiment "${this.active.id}" was cancelled ${Date.now() - cancelledAt} ms ago and has not stopped (one binding call is still pending); it was given up on so that this run could start`);
      this.active = null;
    }
    const handle = startExperiment(id, deps, body);
    const mine = { id, startedAt: Date.now(), handle };
    this.active = mine;
    void handle.stopped.then(() => {
      if (this.active === mine) this.active = null;
    });
    const result = await handle.result;
    if (notes.length > 0) result.observations.unshift(...notes);
    return result;
  }
}
