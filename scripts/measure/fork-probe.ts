// `node scripts/measure/fork-probe.ts`: the fork probe of 04-build-plan 2.5 item 7, run live by the
// lead. It deploys the throwaway Worker `premise-fork-probe` (scripts/measure/fork-probe/worker.ts)
// bound to the `test` namespaces, sets a random per-run key as its only secret, calls it once,
// writes `docs/measurements/integration/<UTC date>-fork-probe.json`, and deletes the Worker. The
// probe makes three repositories and deletes them. It uses no model, so it spends nothing on
// Workers AI. Needs `wrangler login` on the Columbia account.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const NAME = "premise-fork-probe";
const ORIGIN = `https://${NAME}.rk3469.workers.dev`;
const DIR = resolve(".tmp-test/fork-probe");

function wrangler(args: string[], input?: string): string {
  return execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
}

async function callProbe(key: string): Promise<unknown> {
  for (let i = 0; i < 30; i++) {
    const res = await fetch(ORIGIN, { method: "POST", headers: { authorization: `Bearer ${key}` } }).catch(() => null);
    if (res && res.status === 200) return res.json();
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("the probe Worker never answered 200");
}

async function main(): Promise<void> {
  mkdirSync(DIR, { recursive: true });
  const config = join(DIR, "wrangler.jsonc");
  writeFileSync(
    config,
    JSON.stringify(
      {
        name: NAME,
        main: resolve("scripts/measure/fork-probe/worker.ts"),
        compatibility_date: "2026-10-01",
        workers_dev: true,
        artifacts: [
          { binding: "POOLS", namespace: "premise-test-pools" },
          { binding: "ATTEMPTS", namespace: "premise-test-attempts" },
        ],
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
    const result = await callProbe(key);
    const out = `docs/measurements/integration/${new Date().toISOString().slice(0, 10)}-fork-probe.json`;
    writeFileSync(out, JSON.stringify({ measured_at: new Date().toISOString(), result }, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
    console.log(`written: ${out}`);
  } finally {
    if (deployed) wrangler(["delete", NAME, "--force"]);
  }
}

await main();
