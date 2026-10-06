// `npm run measure:models`: the seeded-intent measurement of 05-agent section 6. With `--early`
// the early variant — the in-memory pool, the local ledger, Workers AI over REST. Without it (or
// with `--engine`) the engine variant (ME7): real pools on the deployment of `PREMISE_URL`, the
// owner key of `PREMISE_OWNER_KEY` on mutating calls, and the pool streams as the record.
//
// Usage: node scripts/measure/models.ts [--early|--engine] --model <id>
//          [--sets additive,hero,confirm,shared] [--runs n] [--max-usd 3] [--concurrency n]
//          [--out dir] [--seed n] [--build sha] [--dry-run (early only)] [--no-transcripts]
// Writes `docs/measurements/models/<UTC date>-<mode>-<model>.json`; the early variant writes
// `.transcripts.jsonl` beside it, the engine variant `.events.jsonl` (6.8: the stream stands in
// for transcripts the engine cannot read).

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../../src/protocol/redact.ts";
import { MODEL_PLAN, newLedger } from "./early/ledger.ts";
import { callWorkersAI, type RestOutcome } from "./early/workers-ai-rest.ts";
import { runOnce, realClock, type CallModel, type RunResult } from "./early/run.ts";
import { runPlan } from "./early/intents.ts";
import { cannedModel } from "./early/fake-model.ts";
import { referencesEnergyMax } from "./early/score.ts";
import { summarize } from "./early/summarize.ts";
import { engineMain } from "./engine/main.ts";
import { SET_NAMES, type SetName } from "./engine/plan.ts";

const SEED_DIR = "seeds/tidepool";

/** The 21 seed files as `path -> text` (ME2: an unchanged copy per run). */
export function loadSeed(dir = SEED_DIR): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (sub: string) => {
    for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
      const rel = sub === "" ? entry.name : `${sub}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile() && !entry.name.startsWith(".")) {
        files.set(rel, readFileSync(join(dir, rel), "utf8"));
      }
    }
  };
  walk("");
  return files;
}

type Args = {
  early: boolean;
  engine: boolean;
  model: string | null;
  maxUsd: number;
  runs: number;
  sets: SetName[] | null;
  concurrency: number | null;
  out: string;
  seed: number;
  dryRun: boolean;
  build: string;
  transcripts: boolean;
};

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    early: false,
    engine: false,
    model: null,
    maxUsd: 3,
    runs: 1,
    sets: null,
    concurrency: null,
    out: "docs/measurements/models",
    seed: 7,
    dryRun: false,
    build: "",
    transcripts: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--early":
        args.early = true;
        break;
      case "--engine":
        args.engine = true;
        break;
      case "--model":
        args.model = argv[++i] ?? null;
        break;
      case "--max-usd":
        args.maxUsd = Number(argv[++i] ?? "3");
        break;
      case "--runs":
        args.runs = Math.max(1, Number(argv[++i] ?? "1"));
        break;
      case "--sets": {
        const names = String(argv[++i] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
        for (const name of names) {
          if (!SET_NAMES.includes(name as SetName)) throw new Error(`unknown set ${name}`);
        }
        args.sets = names as SetName[];
        break;
      }
      case "--concurrency":
        args.concurrency = Math.max(1, Number(argv[++i] ?? "4"));
        break;
      case "--seed":
        args.seed = Number(argv[++i] ?? "7");
        break;
      case "--out":
        args.out = argv[++i] ?? args.out;
        break;
      case "--dry-run":
      case "--fake":
        args.dryRun = true;
        break;
      case "--build":
        args.build = argv[++i] ?? "";
        break;
      case "--no-transcripts":
        args.transcripts = false;
        break;
      default:
        throw new Error(`unknown argument ${a}`);
    }
  }
  return args;
}

function gitBuild(fallback: string): string {
  if (fallback !== "") return fallback;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.early) {
    if (args.dryRun) {
      console.error("--dry-run is the early variant's fake; the engine variant talks to PREMISE_URL");
      return 2;
    }
    return engineMain({
      model: args.model,
      sets: args.sets ?? [...SET_NAMES],
      runs: args.runs,
      maxUsd: args.maxUsd,
      concurrency: args.concurrency,
      out: args.out,
      build: gitBuild(args.build),
      swarmSeed: args.seed,
    });
  }
  if (args.model === null) {
    console.error(`--model is required; the plan names ${Object.keys(MODEL_PLAN).join(", ")}`);
    return 2;
  }
  const planEntry = MODEL_PLAN[args.model];
  if (planEntry === undefined) {
    console.error(`model ${args.model} is not in the MG2 starting plan`);
    return 2;
  }

  const secrets: string[] = [];
  let callModel: CallModel | null = null;
  if (!args.dryRun) {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
    const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
    if (accountId === "" || token === "") {
      console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required (or use --dry-run)");
      return 2;
    }
    secrets.push(token, accountId);
    callModel = (request) =>
      callWorkersAI({ accountId, token, model: args.model as string, body: request }) as Promise<RestOutcome>;
  }

  const seed = loadSeed();
  const seedPaths = new Set(seed.keys());
  const ledger = newLedger({ maxUsd: args.maxUsd });
  const plan = runPlan(args.runs);
  const results: RunResult[] = [];
  let incomplete = false;

  // ME4: at most four runs at a time, one at a time for a model under 60 requests a minute.
  const concurrency = planEntry.per_minute < 60 ? 1 : 4;
  const queue = [...plan];
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const spec = queue.shift();
      if (spec === undefined) return;
      if (incomplete) return;
      // ME4: start no run that could pass --max-usd.
      if (ledger.spentUsd() + ledger.outstandingUsd() >= args.maxUsd) {
        incomplete = true;
        return;
      }
      const model = args.dryRun ? cannedModel(spec.intent) : (callModel as CallModel);
      const result = await runOnce({
        attemptId: `m_${spec.intent.id}_${spec.run}`,
        intent: spec.intent,
        runIndex: spec.run,
        seed,
        seedPaths,
        modelId: args.model as string,
        modelOptions: planEntry.options,
        modelPrice: planEntry.price,
        ledger,
        callModel: model,
        clock: realClock,
      });
      results.push(result);
      if (result.incomplete) incomplete = true;
      console.error(
        `  ${spec.intent.id} run ${spec.run}: ${result.record.outcome}` +
          `${result.record.stop_reason !== null ? ` (${result.record.stop_reason})` : ""}`,
      );
    }
  });
  await Promise.all(workers);

  const energyRefs = new Map<string, boolean>();
  for (const r of results) {
    const path =
      r.record.intent === "P1a"
        ? "creatures/crab.js"
        : r.record.intent === "P1b"
          ? "creatures/shrimp.js"
          : [...Object.keys(r.record.files)].find((p) => p.startsWith("creatures/"));
    if (path === undefined) continue;
    const source = r.pool.fileAt(path);
    if (source !== null) {
      energyRefs.set(`${r.record.intent}:${r.record.run}`, referencesEnergyMax(path, source));
    }
  }

  const intents = [...new Map(plan.map((p) => [p.intent.id, p.intent])).values()];
  const measurement = summarize({
    model: args.model,
    build: gitBuild(args.build),
    recordedAt: new Date().toISOString(),
    intents,
    results,
    options: planEntry.options,
    spendUsd: ledger.spentUsd(),
    incomplete,
    energyRefs,
  });

  mkdirSync(args.out, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const short = args.model.slice(args.model.lastIndexOf("/") + 1);
  const base = join(args.out, `${date}-early-${short}`);
  writeFileSync(`${base}.json`, JSON.stringify(measurement, null, 2) + "\n");
  console.error(`wrote ${base}.json`);
  if (args.transcripts) {
    const lines: string[] = [];
    for (const r of results) {
      for (const row of r.rows) {
        lines.push(redact(JSON.stringify({ intent: r.record.intent, run: r.record.run, row }), secrets));
      }
    }
    writeFileSync(`${base}.transcripts.jsonl`, lines.join("\n") + "\n");
    console.error(`wrote ${base}.transcripts.jsonl`);
  }
  return 0;
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith("models.ts");
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(
        redact(String(error), [process.env.CLOUDFLARE_API_TOKEN ?? "", process.env.CLOUDFLARE_ACCOUNT_ID ?? ""]),
      );
      process.exit(1);
    });
}
