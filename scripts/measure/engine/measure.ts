// The engine invocation's scheduler (ME4, ME7): run slots in plan order, at most `concurrency`
// in flight, the per-intent `not_counted` repeats (at most three per intent), the spend gate from
// the streams' `limits` events, and the workhorse check of the first run's `attempt.opened`.

import { MAX_ATTEMPT_USD } from "../../../src/protocol/constants.ts";
import type { PoolEvent } from "../../../src/protocol/events.ts";
import type { IntentSpec, RunSpec } from "../early/intents.ts";
import type { RunRecord } from "../early/run.ts";
import type { Clock } from "../early/run.ts";
import type { ConfirmWindow } from "./score.ts";
import { engineRunOnce, WorkhorseMismatch, RunSetupError } from "./run.ts";
import type { EngineService } from "./service.ts";

export { WorkhorseMismatch };

/** One event of one attempt of one run, as recorded into `<name>.events.jsonl`. */
export type EventLine = { intent: string; run: number; try: number; event: PoolEvent };

export type MeasureResult = {
  results: Array<{ record: RunRecord; rate_limited: number }>;
  events: EventLine[];
  /** `headsup.sent` -> `headsup.resolved` windows of the counted `confirm` runs. */
  confirmWindows: ConfirmWindow[];
  /** `--max-usd` stopped the plan before its last slot. */
  incomplete: boolean;
  /** The gate counter's delta over the invocation, or the sum of the runs' `cost_usd`. */
  spendUsd: number;
  /** The model the first real `attempt.opened` named (the deployment's workhorse). */
  openedModel: string | null;
};

/** Pool names: `[a-z0-9][a-z0-9-]{0,62}` (the route's check). The name carries the model's short
 * name, the intent id, the run slot, the try and a time stamp — ME2's fresh pool per attempt. */
export function poolName(model: string, intentId: string, run: number, tryIndex: number, at: number): string {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const short = clean(model.slice(model.lastIndexOf("/") + 1));
  const name = `m-${short}-${clean(intentId)}-${run}t${tryIndex}-${at.toString(36)}`;
  return name.length > 63 ? name.slice(0, 63).replace(/-+$/g, "") : name;
}

const MAX_REPEATS_PER_INTENT = 3; // ME7: a `not_counted` run is repeated, at most three times per intent
const MAX_CONCURRENT = 4; // ME4

export async function runMeasurement(opts: {
  service: EngineService;
  clock: Clock;
  model: string;
  plan: RunSpec[];
  concurrency: number; // caller-resolved: <= MAX_CONCURRENT, 1 under per_minute 60
  maxUsd: number;
  swarmSeed: number;
  requestPrefix: string;
  seedFiles: ReadonlyMap<string, string>;
  onProgress?: (record: RunRecord) => void;
}): Promise<MeasureResult> {
  const { service, clock, plan } = opts;
  const concurrency = Math.max(1, Math.min(MAX_CONCURRENT, opts.concurrency));

  const results: Array<{ record: RunRecord; rate_limited: number }> = [];
  const events: EventLine[] = [];
  const confirmWindows: ConfirmWindow[] = [];
  const repeatsLeft = new Map<string, number>();
  const spend = {
    baseline: null as number | null, // first `limits.spend_usd` seen
    latest: null as number | null, // latest `limits.spend_usd`
    reserved: 0,
    finished: [] as number[], // cost_usd of every finished attempt (retries included)
    inFlight: 0,
  };
  let incomplete = false;
  let mismatch: WorkhorseMismatch | null = null;
  let openedModel: string | null = null;

  // The workhorse latch: workers beyond the first wait for the first real `attempt.opened` of the
  // first run before they take a slot, so a wrong-model deployment is refused before the second
  // run starts (it resolves `null` when that run ends without one — every run still checks its own).
  let latchResolve: (model: string | null) => void = () => {};
  const latch = new Promise<string | null>((resolve) => (latchResolve = resolve));
  let latchDone = false;
  const modelSeen = (model: string | null): void => {
    if (latchDone) return;
    latchDone = true;
    openedModel = model;
    latchResolve(model);
  };

  const finishedSum = () => spend.finished.reduce((a, b) => a + b, 0);
  const worstCase = () => (spend.finished.length === 0 ? MAX_ATTEMPT_USD : Math.max(...spend.finished));
  /** ME4: what a new run could still spend against — the gate's delta plus open reservations plus
   * the in-flight runs' worst case; the runs' own costs are the floor when no `limits` came yet. */
  const couldSpend = (): number => {
    const gate =
      spend.latest === null ? 0 : Math.max(0, spend.latest - (spend.baseline ?? spend.latest)) + spend.reserved;
    return Math.max(gate, finishedSum()) + spend.inFlight * worstCase();
  };
  const headroomOk = (): boolean => couldSpend() + worstCase() <= opts.maxUsd;

  const onLimits = (l: { spend_usd: number; reserved_usd: number }): void => {
    if (spend.baseline === null) spend.baseline = l.spend_usd;
    spend.latest = l.spend_usd;
    spend.reserved = l.reserved_usd;
  };

  const queue = [...plan];
  const worker = async (waitFirst: boolean): Promise<void> => {
    if (waitFirst) await latch;
    for (;;) {
      if (mismatch !== null || incomplete) return;
      const spec = queue.shift();
      if (spec === undefined) return;
      if (!headroomOk()) {
        incomplete = true;
        return;
      }
      let tryIndex = 1;
      for (;;) {
        try {
          spend.inFlight++;
          const result = await engineRunOnce({
            service,
            clock,
            model: opts.model,
            spec: spec.intent,
            runIndex: spec.run,
            tryIndex,
            pool: poolName(opts.model, spec.intent.id, spec.run, tryIndex, clock.now()),
            requestPrefix: `${opts.requestPrefix}-${spec.intent.id.toLowerCase()}${spec.run}t${tryIndex}`,
            swarmSeed: opts.swarmSeed,
            seedFiles: opts.seedFiles,
            onLimits,
            onOpenedModel: modelSeen,
          });
          modelSeen(result.openedModel); // frees waiting workers if this run opened first (or none)
          spend.inFlight--;
          spend.finished.push(result.record.cost_usd);
          for (const event of result.events) {
            events.push({ intent: spec.intent.id, run: spec.run, try: tryIndex, event });
          }
          if (result.confirm !== null) confirmWindows.push(result.confirm);
          const repeats = repeatsLeft.get(spec.intent.id) ?? MAX_REPEATS_PER_INTENT;
          if (result.record.outcome === "not_counted" && repeats > 0) {
            repeatsLeft.set(spec.intent.id, repeats - 1);
            tryIndex++;
            continue;
          }
          results.push({ record: result.record, rate_limited: result.rateLimited });
          opts.onProgress?.(result.record);
          break;
        } catch (error) {
          spend.inFlight--;
          if (error instanceof WorkhorseMismatch) {
            mismatch = error;
            modelSeen(error.openedModel);
            return;
          }
          if (error instanceof RunSetupError) {
            modelSeen(null);
            results.push({
              record: {
                intent: spec.intent.id,
                run: spec.run,
                outcome: "not_completed",
                stop_reason: `error:${error.code}`,
                seconds: null,
                waited_ms: 0,
                model_calls: 0,
                tool_calls: 0,
                tool_errors: 0,
                nudges: 0,
                tokens_in: 0,
                tokens_out: 0,
                cost_usd: 0,
                first_tool: null,
                whole_file_reads: [],
                files: {},
                hero: null,
              },
              rate_limited: 0,
            });
            break;
          }
          throw error;
        }
      }
    }
  };

  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker(i !== 0));
  await Promise.all(workers);
  if (mismatch !== null) throw mismatch;

  results.sort((a, b) => {
    const ia = plan.findIndex((p) => p.intent.id === a.record.intent && p.run === a.record.run);
    const ib = plan.findIndex((p) => p.intent.id === b.record.intent && p.run === b.record.run);
    return ia - ib;
  });

  const spendUsd =
    spend.latest !== null && spend.baseline !== null
      ? Math.max(spend.latest - spend.baseline, finishedSum())
      : finishedSum();
  return { results, events, confirmWindows, incomplete, spendUsd, openedModel };
}

export type { IntentSpec };
