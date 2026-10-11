// The harness of the isolate runtime (02-tidepool 5.4, option B): the generated entry module that
// runs a commit's self-test inside a Dynamic Worker, and the mapping of its verdict to
// `VerifyResult` by the fixed list of GR8. Pure: no binding, no clock. The loading itself is
// `../isolate.ts`.

import { GREEN_LOG_MAX_CHARS } from "../../../../protocol/constants.ts";
import { GREEN_RUNTIME_CHECKS, type SelftestCode, type VerifyResult } from "../../../../protocol/green.ts";

/** The module names the harness adds next to the pool's files. `~` never starts a pool path. */
export const ENTRY_MODULE = "~selftest-entry.js";
export const RANDOM_MODULE = "~selftest-random.js";

/** 02-tidepool 5.1: the self-test's module and the creature files that become `kinds`. */
export const SELFTEST_PATH = "selftest/run.js";
const CREATURE = /^creatures\/([A-Za-z0-9_-]+)\.js$/;

/** The twelve invariants of 02-tidepool 5.2, in their order. */
const INVARIANTS = GREEN_RUNTIME_CHECKS.slice(1);

/** HO2's generator, installed before any pool module is evaluated: the entry imports this module
 * first, and ES modules evaluate in import order. `reseed(n)` restarts it from seed `n`. */
const RANDOM_SOURCE = `function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
Math.random = mulberry32(7);
export function reseed(n) {
  Math.random = mulberry32(n);
}
`;

/** The kinds of a commit: each `creatures/<kind>.js`, by kind name. */
export function creatureKinds(paths: Iterable<string>): Array<{ kind: string; path: string }> {
  const out: Array<{ kind: string; path: string }> = [];
  for (const path of paths) {
    const m = CREATURE.exec(path);
    if (m !== null) out.push({ kind: m[1]!, path });
  }
  return out.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

/** The entry module (5.4): imports `selftest/run.js` and each creature statically, calls
 * `runSelfTest`, and answers the verdict as JSON. A throw inside answers `{ error }`. */
export function entrySource(paths: Iterable<string>): string {
  const kinds = creatureKinds(paths);
  const imports = kinds.map((k, i) => `import * as k${i} from ${JSON.stringify(`./${k.path}`)};`);
  const entries = kinds.map((k, i) => `${JSON.stringify(k.kind)}: k${i}`);
  return `import { reseed } from ${JSON.stringify(`./${RANDOM_MODULE}`)};
import { runSelfTest } from ${JSON.stringify(`./${SELFTEST_PATH}`)};
${imports.join("\n")}
export default {
  async fetch() {
    try {
      const verdict = runSelfTest({ kinds: { ${entries.join(", ")} }, reseed });
      return new Response(JSON.stringify({ verdict }), { headers: { "content-type": "application/json" } });
    } catch (e) {
      const error = e instanceof Error ? e.name + ": " + e.message : "a value was thrown";
      return new Response(JSON.stringify({ error }), { headers: { "content-type": "application/json" } });
    }
  },
};
`;
}

/** The modules of the one Dynamic Worker: the commit's `.js` files, the entry and the generator. */
export function isolateModules(files: ReadonlyMap<string, string>): Record<string, { js: string }> {
  const modules: Record<string, { js: string }> = {};
  for (const [path, content] of files) if (path.endsWith(".js")) modules[path] = { js: content };
  modules[RANDOM_MODULE] = { js: RANDOM_SOURCE };
  modules[ENTRY_MODULE] = { js: entrySource(files.keys()) };
  return modules;
}

type Mapped = Pick<VerifyResult, "ok" | "checks" | "log">;

/** ST4: no usable verdict. The single check `selftest_ran` with its code; the reason goes to `log`. */
export function failClosed(code: SelftestCode, reason: string): Mapped {
  return {
    ok: false,
    checks: [{ name: "selftest_ran", ok: false, code }],
    log: `selftest_ran: ${code}: ${reason}`.slice(0, GREEN_LOG_MAX_CHARS),
  };
}

type Verdict = {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: unknown }>;
  failed?: unknown;
  rest_share?: unknown;
};

/** 02-tidepool 5.3: the verdict's shape, enough to map it; anything else is `bad_verdict`. */
function asVerdict(value: unknown): Verdict | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.v !== 1 || typeof v.ok !== "boolean" || !Array.isArray(v.checks)) return null;
  if (v.checks.length !== INVARIANTS.length) return null;
  for (let i = 0; i < INVARIANTS.length; i += 1) {
    const c = v.checks[i] as Record<string, unknown> | null;
    if (typeof c !== "object" || c === null || c.name !== INVARIANTS[i] || typeof c.ok !== "boolean") return null;
  }
  const checks = v.checks as Verdict["checks"];
  // `ok` is the verdict's own (5.4); a verdict that contradicts its checks is not one of 5.3.
  if (v.ok !== checks.every((c) => c.ok)) return null;
  return v as unknown as Verdict;
}

/** The body the entry module answered, mapped by GR8 (5.4's table): `selftest_ran`, then the twelve
 * checks in order with a code only on a failed one. `detail`, `failed` and `rest_share` go to
 * `log` only (GR7). */
export function mapAnswer(body: string): Mapped {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return failClosed("bad_verdict", "the answer is not JSON");
  }
  const answer = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
  if (typeof answer.error === "string") return failClosed("harness_error", answer.error);
  const verdict = asVerdict(answer.verdict);
  if (verdict === null) return failClosed("bad_verdict", "the verdict is not of the type in 02-tidepool 5.3");

  const checks: VerifyResult["checks"] = [{ name: "selftest_ran", ok: true }];
  const details: Record<string, unknown> = {};
  for (const c of verdict.checks) {
    if (c.ok) checks.push({ name: c.name, ok: true });
    else {
      checks.push({ name: c.name, ok: false, code: `${c.name}:failed` });
      details[c.name] = c.detail ?? null;
    }
  }
  const log = JSON.stringify({ failed: verdict.failed ?? [], rest_share: verdict.rest_share ?? {}, details });
  return { ok: verdict.ok, checks, log: log.slice(0, GREEN_LOG_MAX_CHARS) };
}
