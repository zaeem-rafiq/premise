// Scratch node harness: loads a pool directory the way the host would and runs its self-test.
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export async function loadPool(dir) {
  const base = pathToFileURL(resolve(dir) + "/").href;
  const kinds = {};
  for (const name of readdirSync(resolve(dir, "creatures")).sort()) {
    const m = /^([a-z][a-z0-9-]*)\.js$/.exec(name);
    if (!m) continue;
    kinds[m[1]] = await import(base + "creatures/" + name);
  }
  const run = await import(base + "selftest/run.js");
  const main = await import(base + "main.js");
  const reseed = (n) => { Math.random = mulberry32(n); };
  return { kinds, run, main, reseed };
}
if (process.argv[1].endsWith("harness.mjs")) {
  const { kinds, run, reseed } = await loadPool(process.argv[2]);
  const t0 = performance.now();
  const verdict = run.runSelfTest({ kinds, reseed });
  verdict.duration_ms = Math.round(performance.now() - t0);
  console.log(JSON.stringify(verdict, null, 1));
}
