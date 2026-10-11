// The harness of the isolate runtime (02-tidepool 5.4, option B): the generated entry module that
// runs a commit's self-test inside a Dynamic Worker, and the mapping of its verdict to
// `VerifyResult` by the fixed list of GR8. Pure: no binding, no clock. The loading itself is
// `../isolate.ts`.

import { GREEN_LOG_MAX_CHARS } from "../../../../protocol/constants.ts";
import {
  GREEN_RUNTIME_CHECKS,
  SELFTEST_CODES,
  type SelftestCode,
  type VerifyResult,
} from "../../../../protocol/green.ts";

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

/** One run's mapped result plus its findings: `name|kind` for each failure of the verdict's
 * `failed` list (kind "" for a check of the whole pool), or `selftest_ran|<code>` when no verdict
 * was had. The findings are compared with the green commit's (GR3d) and never leave the harness. */
export type Run = Mapped & {
  findings: Set<string>;
  /** The isolate gave no answer at all: the time-out, or a load or call that threw (`../isolate.ts`).
   * The pre-landing self-test of a submit fails open on such a run (01-core CK6c). */
  unanswered?: true;
};

/** ST4: no usable verdict. The single check `selftest_ran` with its code; the reason goes to `log`. */
export function failClosed(code: SelftestCode, reason: string): Run {
  return {
    findings: new Set([`selftest_ran|${code}`]),
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
export function mapAnswer(body: string): Run {
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
  const findings = new Set<string>();
  for (const f of Array.isArray(verdict.failed) ? verdict.failed : []) {
    const item = (typeof f === "object" && f !== null ? f : {}) as { name?: unknown; kind?: unknown };
    if (typeof item.name === "string") findings.add(`${item.name}|${typeof item.kind === "string" ? item.kind : ""}`);
  }
  // A verdict whose `failed` list names nothing still counts each failed check once.
  for (const c of verdict.checks) {
    if (!c.ok && ![...findings].some((f) => f.startsWith(`${c.name}|`))) findings.add(`${c.name}|`);
  }
  return { ok: verdict.ok, checks, log: log.slice(0, GREEN_LOG_MAX_CHARS), findings };
}

/** GR3d: the head's run judged against the green commit's run. A finding counts only when the
 * green commit does not have it (the same rule as GR5a's for the static checks), so a landing is
 * never blamed for a fault its base already had — after a switch from the static runtime, or after
 * a red that was not taken back. */
export function againstGreen(head: Run, green: Run): Mapped {
  const fresh = [...head.findings].filter((f) => !green.findings.has(f));
  const shared = [...head.findings].filter((f) => green.findings.has(f)).sort();
  const note = shared.length === 0 ? "" : `\nalso at the green commit, not counted: ${shared.join(", ")}`;
  if (fresh.length === 0) {
    const checks: VerifyResult["checks"] =
      head.findings.has("selftest_ran|harness_error") ||
      head.findings.has("selftest_ran|no_verdict") ||
      head.findings.has("selftest_ran|bad_verdict")
        ? [{ name: "selftest_ran", ok: true }]
        : head.checks.map((c) => ({ name: c.name, ok: true }));
    return { ok: true, checks, log: `${head.log}${note}`.slice(0, GREEN_LOG_MAX_CHARS) };
  }
  if (fresh.some((f) => f.startsWith("selftest_ran|"))) return { ok: false, checks: head.checks, log: head.log };
  const failing = new Set(fresh.map((f) => f.slice(0, f.indexOf("|"))));
  const checks: VerifyResult["checks"] = head.checks.map((c) =>
    c.name === "selftest_ran" || !failing.has(c.name)
      ? { name: c.name, ok: true }
      : { name: c.name, ok: false, code: `${c.name}:failed` },
  );
  return { ok: false, checks, log: `${head.log}${note}`.slice(0, GREEN_LOG_MAX_CHARS) };
}

/** One failure of a submit's pre-landing self-test (01-core CK6c): a name and code of GR8, and the
 * creature kind when the candidate tree has `creatures/<kind>.js` (the agent's own file name). */
export type FreshFailure = { name: string; code: string; kind?: string };

/** CK6c with GR3d: the failures of a submit's candidate run that head's run does not have, in a
 * fixed order. Only names and codes of GR8 leave the harness (GR7): a name the fixed list does not
 * know is dropped, and a kind is kept only when it names a creature file of the candidate tree.
 * Null when either run gave no answer: the submit then proceeds (fail open). */
export function freshFailures(candidate: Run, head: Run, paths: Iterable<string>): FreshFailure[] | null {
  if (candidate.unanswered === true || head.unanswered === true) return null;
  const kinds = new Set(creatureKinds(paths).map((k) => k.kind));
  const out: FreshFailure[] = [];
  for (const finding of [...candidate.findings].sort()) {
    if (head.findings.has(finding)) continue;
    const bar = finding.indexOf("|");
    const name = finding.slice(0, bar);
    const rest = finding.slice(bar + 1);
    if (name === "selftest_ran") {
      if ((SELFTEST_CODES as readonly string[]).includes(rest)) out.push({ name, code: rest });
      continue;
    }
    if (!(INVARIANTS as readonly string[]).includes(name)) continue;
    out.push({ name, code: `${name}:failed`, ...(kinds.has(rest) ? { kind: rest } : {}) });
  }
  return out;
}
