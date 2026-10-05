// A synchronous evaluator for the module forms the seed and the canned files use — named
// `import { x } from "..."` and `export const`/`export function` only (checked: no
// destructuring, no `export default`, no `export let`, no cycles). It exists so the tree a
// scenario produces through the engine, not the seed on disk, can be run in Node through the
// seed's own `selftest/run.js`: that run is the Appendix A method for the rows whose answer
// is a verdict ("each produced tree was run in Node with the self-test of section 5").
//
// The evaluator shares nothing with the engine; it is a test tool of this directory only.

const IMPORT_LINE = /^import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];?\s*$/gm;
const EXPORT_WORD = /^export\s+(?=(?:const|function)\b)/gm;
const DECL_NAME = /^(?:const|function)\s+([A-Za-z_$][\w$]*)/gm;

/** Resolve `spec` against the directory of `from` (POSIX, files keyed by `a/b/c.js`). */
function resolve(from: string, spec: string): string {
  const out = from.split("/").slice(0, -1);
  for (const part of spec.split("/")) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return out.join("/");
}

/** Evaluate the module at `path` inside `files`; its `import`s come from the same tree. */
export function moduleOf(files: ReadonlyMap<string, string>, path: string): Record<string, unknown> {
  const cache = new Map<string, Record<string, unknown>>();
  const load = (p: string): Record<string, unknown> => {
    const hit = cache.get(p);
    if (hit !== undefined) return hit;
    const text = files.get(p);
    if (text === undefined) throw new Error(`module not in the tree: ${p}`);
    const out: Record<string, unknown> = {};
    cache.set(p, out); // before the body runs, so a named cycle could see a partial record
    const imports: Array<{ local: string; exported: string; spec: string }> = [];
    let body = text.replace(IMPORT_LINE, (_m, names: string, spec: string) => {
      for (const entry of names.split(",")) {
        const [imported, local] = entry.trim().split(/\s+as\s+/);
        imports.push({ local: (local ?? imported).trim(), exported: imported.trim(), spec });
      }
      return "";
    });
    body = body.replace(EXPORT_WORD, "");
    const declared: string[] = [];
    for (const m of body.matchAll(DECL_NAME)) declared.push(m[1]!);
    const names = [...new Set(declared)];
    const assigns = names.map((n) => `out[${JSON.stringify(n)}] = ${n};`).join("\n");
    const fn = new Function("out", ...imports.map((i) => i.local), `${body}\n${assigns}`) as (
      out: Record<string, unknown>,
      ...args: unknown[]
    ) => void;
    const args = imports.map((i) => load(resolve(p, i.spec))[i.exported]);
    fn(out, ...args);
    return out;
  };
  return load(path);
}

/** Every `creatures/*.js` of the tree as a `{kind: module}` map (2.5: base name is the kind). */
export function kindsOf(files: ReadonlyMap<string, string>): Record<string, Record<string, unknown>> {
  const kinds: Record<string, Record<string, unknown>> = {};
  for (const path of files.keys()) {
    if (path.startsWith("creatures/") && path.endsWith(".js")) {
      kinds[path.slice("creatures/".length, -".js".length)] = moduleOf(files, path);
    }
  }
  return kinds;
}

export type Verdict = {
  ok: boolean;
  ticks: number;
  kinds: string[];
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  failed: Array<{ name: string; kind: string | null }>;
  rest_share: Record<string, number>;
  creatures: number;
  state_hash: string;
};

/** The `selftest/run.js` of `files` run over the creature kinds of `files` itself. */
export function verdictOf(files: ReadonlyMap<string, string>, reseed: (n: number) => void, ticks?: number): Verdict {
  const run = moduleOf(files, "selftest/run.js") as { runSelfTest: (o: unknown) => Verdict };
  return run.runSelfTest({ kinds: kindsOf(files), reseed, ticks });
}

type Creature = { kind: string; x: number; hiding?: boolean };
type Pool = { world: { creatures: Creature[] }; kinds: Record<string, unknown> };

export type CrabStats = { hidden_share: number; mean_speed: number; crab_ticks: number };

/** Tick `ticks` of the produced tree's own `main.js` pool — the same run `runOnce` performs
 * (`reseed`, then `createPool`, then `tick` per tick) — and measure the crab's per-tick
 * `hiding` share and horizontal speed (|Δx| per tick): the two crab bounds of A4/A5/A18,
 * which the verdict's rest share does not cover. */
export function crabStatsOf(files: ReadonlyMap<string, string>, reseed: (n: number) => void, ticks: number): CrabStats {
  const main = moduleOf(files, "main.js") as {
    createPool: (kinds: Record<string, unknown>) => Pool;
    tick: (pool: Pool) => void;
  };
  const run = moduleOf(files, "selftest/run.js") as { SELFTEST_SEED: number };
  reseed(run.SELFTEST_SEED);
  const pool = main.createPool(kindsOf(files));
  const world = pool.world;
  let hidden = 0;
  let speedSum = 0;
  let crabTicks = 0;
  for (let t = 0; t < ticks; t += 1) {
    const before = new Map(world.creatures.map((c) => [c, c.x]));
    main.tick(pool);
    for (const c of world.creatures) {
      if (c.kind !== "crab") continue;
      const prev = before.get(c);
      if (prev === undefined) continue; // spawned this tick
      crabTicks += 1;
      if (c.hiding === true) hidden += 1;
      speedSum += Math.abs(c.x - prev);
    }
  }
  return {
    hidden_share: crabTicks === 0 ? 0 : hidden / crabTicks,
    mean_speed: crabTicks === 0 ? 0 : speedSum / crabTicks,
    crab_ticks: crabTicks,
  };
}
