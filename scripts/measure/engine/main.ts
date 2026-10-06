// The engine invocation (ME7): `npm run measure:models -- --model <id>` — the deployment of
// `PREMISE_URL` is driven through its owner routes (`PREMISE_OWNER_KEY`, never written), the pools
// and intents are real, and the measurement file lands at
// `docs/measurements/models/<UTC date>-engine-<model short name>.json` with the redacted event
// recording beside it as `<same name>.events.jsonl` (6.8: the engine variant cannot read the
// Agent's transcript — the stream events stand in for it; ME6 never executes model code).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../../../src/protocol/redact.ts";
import { MODEL_OPTIONS, MODEL_PLAN } from "../../../src/config/model-plan.ts";
import { referencesEnergyMax } from "../early/score.ts";
import { percentile, summarize } from "../early/summarize.ts";
import { loadSeed } from "../models.ts";
import type { Clock } from "../early/run.ts";
import { realClock } from "../early/run.ts";
import { SET_NAMES, enginePlan, type SetName } from "./plan.ts";
import { runMeasurement, type MeasureResult } from "./measure.ts";
import { httpService, type EngineService } from "./service.ts";
import { WorkhorseMismatch } from "./run.ts";

export type EngineDeps = {
  service?: EngineService;
  clock?: Clock;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void; // stderr in the real invocation
};

export type EngineArgs = {
  model: string | null;
  sets: SetName[];
  runs: number;
  maxUsd: number;
  concurrency: number | null;
  out: string;
  build: string;
  swarmSeed: number;
};

/** Deployment metadata that can name the workhorse before the first run: `/floor.json` carries no
 * such field in this slice, so the check usually lands on the first `attempt.opened`. */
function floorWorkhorse(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  for (const key of ["workhorse", "workhorse_model", "model"]) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

export async function engineMain(args: EngineArgs, deps: EngineDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const clock = deps.clock ?? realClock;
  const secrets: string[] = [];
  const log = deps.log ?? ((line: string) => console.error(redact(line, secrets)));
  if (args.model === null) {
    log(`--model is required; the plan names ${Object.keys(MODEL_PLAN.per_minute).join(", ")}`);
    return 2;
  }
  const perMinute = MODEL_PLAN.per_minute[args.model];
  if (perMinute === undefined) {
    log(`model ${args.model} is not in the model plan (MG2)`);
    return 2;
  }
  const origin = env.PREMISE_URL ?? "";
  const ownerKey = env.PREMISE_OWNER_KEY ?? "";
  if (origin === "" || ownerKey === "") {
    log("PREMISE_URL and PREMISE_OWNER_KEY are required for the engine variant");
    return 2;
  }
  secrets.push(ownerKey);

  const service = deps.service ?? httpService({ origin, ownerKey });

  // The workhorse check, first chance: `/floor.json` names it only on a build that adds the field.
  const floor = await service.getJson("/floor.json").catch(() => ({ status: 0, body: null }));
  const named = floorWorkhorse(floor.body);
  if (named !== null && named !== args.model) {
    log(`the deployment's workhorse is ${named}, not --model ${args.model} — nothing was measured`);
    return 2;
  }

  const plan = enginePlan(args.sets, args.runs);
  if (plan.length === 0) {
    log(`empty plan: --sets must name at least one of ${SET_NAMES.join(", ")}`);
    return 2;
  }
  // ME4: at most four runs at a time, one at a time for a model under 60 requests a minute.
  const concurrency = Math.min(args.concurrency ?? MAX_CONCURRENT_SAFE, perMinute < 60 ? 1 : MAX_CONCURRENT_SAFE);

  const seedFiles = loadSeed();
  let measured: MeasureResult;
  try {
    measured = await runMeasurement({
      service,
      clock,
      model: args.model,
      plan,
      concurrency,
      maxUsd: args.maxUsd,
      swarmSeed: args.swarmSeed,
      requestPrefix: `m-${Date.now().toString(36)}`,
      seedFiles,
      onProgress: (record) => {
        log(
          `  ${record.intent} run ${record.run}: ${record.outcome}` +
            `${record.stop_reason !== null ? ` (${record.stop_reason})` : ""}` +
            `${record.seconds !== null ? ` ${record.seconds.toFixed(1)}s` : ""}`,
        );
      },
    });
  } catch (error) {
    if (error instanceof WorkhorseMismatch) {
      log(
        `the deployment's workhorse is ${error.openedModel ?? "unknown"}, not --model ${args.model} — nothing was measured`,
      );
      return 2;
    }
    throw error;
  }

  const intents = [...new Map(plan.map((p) => [p.intent.id, p.intent])).values()];
  const writesById = new Map(intents.map((i) => [i.id, i.writes]));
  const energyRefs = new Map<string, boolean>();
  for (const { record } of measured.results) {
    const path = writesById.get(record.intent);
    if (path === undefined) continue;
    const source = record.files[path];
    if (source !== undefined) {
      energyRefs.set(`${record.intent}:${record.run}`, referencesEnergyMax(path, source));
    }
  }

  const windows = measured.confirmWindows;
  const confirm =
    args.sets.includes("confirm") && windows.length > 0
      ? {
          runs: windows.length,
          model_calls: {
            p50: percentile(
              windows.map((w) => w.model_calls),
              0.5,
            ),
            max: Math.max(...windows.map((w) => w.model_calls)),
          },
          tokens: windows.reduce((s, w) => s + w.tokens_in + w.tokens_out, 0),
          cost_usd: windows.reduce((s, w) => s + w.cost_usd, 0),
          ms: {
            p50: percentile(
              windows.map((w) => w.ms),
              0.5,
            ),
            p90: percentile(
              windows.map((w) => w.ms),
              0.9,
            ),
          },
        }
      : args.sets.includes("confirm")
        ? { runs: 0, model_calls: { p50: 0, max: 0 }, tokens: 0, cost_usd: 0, ms: { p50: 0, p90: 0 } }
        : null;

  const measurement = summarize({
    model: args.model,
    build: args.build,
    recordedAt: new Date().toISOString(),
    intents,
    results: measured.results.map((r) => ({ record: r.record, rate_limited: r.rate_limited, incomplete: false })),
    options: MODEL_OPTIONS[args.model] ?? {},
    spendUsd: measured.spendUsd,
    incomplete: measured.incomplete,
    energyRefs,
    mode: "engine",
    transport: "binding",
    confirm,
  });

  mkdirSync(args.out, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const short = args.model.slice(args.model.lastIndexOf("/") + 1);
  const base = join(args.out, `${date}-engine-${short}`);
  writeFileSync(`${base}.json`, JSON.stringify(measurement, null, 2) + "\n");
  log(`wrote ${base}.json`);
  // The stream events stand in for transcripts (6.8): one line per event, after redact().
  const lines = measured.events.map((line) => redact(JSON.stringify(line), secrets));
  writeFileSync(`${base}.events.jsonl`, lines.join("\n") + (lines.length === 0 ? "" : "\n"));
  log(`wrote ${base}.events.jsonl`);
  if (measured.incomplete) log(`incomplete: --max-usd ${args.maxUsd} stopped the plan early`);
  return 0;
}

const MAX_CONCURRENT_SAFE = 4;
