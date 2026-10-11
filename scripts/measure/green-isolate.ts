// `node scripts/measure/green-isolate.ts`: 04-build-plan 2.15 item 4 (RR4), run live by the lead.
// It deploys the throwaway Worker `premise-green-probe` (scripts/measure/green-probe/worker.ts),
// which has the Worker Loader binding and nothing else, sets a random per-run key as its only
// secret, and asks it for:
//   1. 50 verifications of the seed commit at `GREEN_CPU_MS`: how many give no verdict, or a
//      verdict later than `SELFTEST_TIMEOUT_MS`, and how long each took;
//   2. one verification of a commit with `MAX_KINDS` creature files (the seed's creatures, copied);
//   3. the seed under lower CPU limits, to show the margin under `GREEN_CPU_MS`.
// It writes `docs/measurements/spikes/<UTC date>-green-isolate.json` and deletes the Worker. It
// uses no model and no Artifacts. Needs `wrangler login` on the Columbia account.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GREEN_CPU_MS, MAX_KINDS, SELFTEST_TIMEOUT_MS } from "../../src/protocol/constants.ts";
import { buildSeeds } from "../seeds/build.ts";

const NAME = "premise-green-probe";
const ORIGIN = `https://${NAME}.rk3469.workers.dev`;
const DIR = resolve(".tmp-test/green-probe");
const RUNS = 50;
const LOWER_CPU = [50, 200, 1_000];

type Run = { ok: boolean; ms: number; checks: Array<{ name: string; ok: boolean; code?: string }> };

function wrangler(args: string[], input?: string): string {
  return execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
}

async function call(key: string, files: Map<string, string>, runs: number, cpuMs: number): Promise<Run[]> {
  for (let i = 0; i < 30; i++) {
    const res = await fetch(ORIGIN, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ files: Object.fromEntries(files), runs, cpuMs }),
    }).catch(() => null);
    if (res && res.status === 200) return ((await res.json()) as { runs: Run[] }).runs;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("the probe Worker never answered 200");
}

/** The seed with its creature files copied until there are `MAX_KINDS` of them. */
function maxKinds(seed: Map<string, string>): Map<string, string> {
  const files = new Map(seed);
  const creatures = [...seed.keys()].filter((p) => /^creatures\/[^/]+\.js$/.test(p)).sort();
  for (let i = 0; creatures.length + i < MAX_KINDS; i += 1) {
    const from = creatures[i % creatures.length]!;
    files.set(`creatures/copy${i}.js`, seed.get(from)!);
  }
  return files;
}

function summary(runs: Run[]) {
  const ms = runs.map((r) => r.ms).sort((a, b) => a - b);
  const at = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] ?? null;
  return {
    runs: runs.length,
    ok: runs.filter((r) => r.ok).length,
    no_verdict: runs.filter((r) => r.checks.some((c) => c.code === "no_verdict")).length,
    late: runs.filter((r) => r.ms > SELFTEST_TIMEOUT_MS).length,
    failed_checks: [...new Set(runs.flatMap((r) => r.checks.map((c) => c.code ?? c.name)))],
    ms_p50: at(0.5),
    ms_p90: at(0.9),
    ms_max: ms.at(-1) ?? null,
  };
}

async function main(): Promise<void> {
  const tree = buildSeeds().get("tidepool");
  if (tree === undefined) throw new Error("buildSeeds: no tidepool seed");
  const seed = new Map(tree);
  mkdirSync(DIR, { recursive: true });
  const config = join(DIR, "wrangler.jsonc");
  writeFileSync(
    config,
    JSON.stringify(
      {
        name: NAME,
        main: resolve("scripts/measure/green-probe/worker.ts"),
        compatibility_date: "2026-10-01",
        workers_dev: true,
        worker_loaders: [{ binding: "LOADER" }],
      },
      null,
      2,
    ),
  );
  const key = randomBytes(24).toString("hex");
  let deployed = false;
  try {
    wrangler(["deploy", "-c", config]);
    deployed = true;
    wrangler(["secret", "put", "PROBE_KEY", "-c", config], key);
    const seedRuns = await call(key, seed, RUNS, GREEN_CPU_MS);
    const kinds = maxKinds(seed);
    const kindsRuns = await call(key, kinds, 1, GREEN_CPU_MS);
    const lower: Record<string, ReturnType<typeof summary>> = {};
    for (const cpuMs of LOWER_CPU) lower[String(cpuMs)] = summary(await call(key, seed, 3, cpuMs));
    const result = {
      measured_at: new Date().toISOString(),
      green_cpu_ms: GREEN_CPU_MS,
      selftest_timeout_ms: SELFTEST_TIMEOUT_MS,
      seed: summary(seedRuns),
      max_kinds: {
        creature_files: [...kinds.keys()].filter((p) => p.startsWith("creatures/")).length,
        ...summary(kindsRuns),
      },
      lower_cpu_ms: lower,
      // 2.15 item 4: at most one missing or late verdict over the 50, and the MAX_KINDS commit gives one.
      item4_pass: summary(seedRuns).no_verdict + summary(seedRuns).late <= 1 && summary(kindsRuns).no_verdict === 0,
    };
    const out = `docs/measurements/spikes/${new Date().toISOString().slice(0, 10)}-green-isolate.json`;
    mkdirSync("docs/measurements/spikes", { recursive: true });
    writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
    console.log(`written: ${out}`);
  } finally {
    if (deployed) wrangler(["delete", NAME, "--force"]);
  }
}

await main();
