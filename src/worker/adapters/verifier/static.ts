// The `static` runtime of the green line (01-core 11.5 GR5, GR5a; S4 option D): no pool code runs.
// It judges a commit's files with the same analysis Trunk uses for premises (6.2) and the same
// policy file reader (10.1), and counts only the findings the green commit does not have. The
// check names and codes are GR8's; every path, entity key and name goes into `log` only (GR7).

import { GREEN_LOG_MAX_CHARS } from "../../../protocol/constants.ts";
import { GREEN_STATIC_CHECKS, greenCheckCode, type VerifyResult } from "../../../protocol/green.ts";
import type { Verifier } from "../../../protocol/ports.ts";
import { IMPORT_LANGUAGES, languageOfPath, TIDEPOOL_LANGUAGES, type LanguageSet } from "../../../core/keys/paths.ts";
import { analyse } from "../../../core/refs/refs.ts";
import { parsePolicy, policyOf } from "../../../core/policy/policy.ts";

const POLICY_PATH = ".premise/policy.json";

type StaticCheck = (typeof GREEN_STATIC_CHECKS)[number];

/** One commit's findings per static check, each a line of text for the log. */
export type StaticFindings = Record<StaticCheck, Set<string>>;

export type StaticInput = {
  /** The commit's files (path -> content), as Trunk recorded them for its landing. */
  files: ReadonlyMap<string, string>;
  /** The green commit's files: its findings are not counted (GR5a). */
  greenFiles: ReadonlyMap<string, string>;
  /** An imported pool (IR7): the imported language set, and no globals check (CK6 skips it too). */
  imported: boolean;
};

/** The findings of GR5a's three checks on one commit. */
export function staticFindings(files: ReadonlyMap<string, string>, imported: boolean): StaticFindings {
  const languages: LanguageSet = imported ? IMPORT_LANGUAGES : TIDEPOOL_LANGUAGES;
  const analysis = analyse(files, languages);
  const parse = new Set<string>();
  for (const path of files.keys()) {
    // 2.1: a file in a module language that does not parse is left out of `modules` by analyse.
    if (languageOfPath(path, languages) !== null && !analysis.modules.has(path)) parse.add(path);
  }
  const imports = new Set<string>();
  for (const u of analysis.unresolved) imports.add(`${u.from} imports ${u.to}, which does not resolve`);
  for (const b of analysis.banned) imports.add(`${b.from} imports ${b.specifier}, which is not relative`);

  const policy = new Set<string>();
  const text = files.get(POLICY_PATH);
  if (text === undefined) policy.add(`${POLICY_PATH} is missing`);
  else if (parsePolicy(text) === null) policy.add(`${POLICY_PATH} is not a valid policy file`);
  if (!imported) {
    // PO3/PO4: a missing or invalid file closes the pool, and its globals are DEFAULT_GLOBALS.
    const allowed = new Set(policyOf(text).globals);
    for (const [key, names] of analysis.globals) {
      for (const name of names) if (!allowed.has(name)) policy.add(`${key} uses the global ${name}`);
    }
  }
  return { parse, imports_resolve: imports, policy_invariants: policy };
}

/** GR5a and GR8: the three checks in order, each failing only on findings the green commit lacks. */
export function staticResult(input: StaticInput): Pick<VerifyResult, "ok" | "checks" | "log"> {
  const at = staticFindings(input.files, input.imported);
  const green = staticFindings(input.greenFiles, input.imported);
  const checks: VerifyResult["checks"] = [];
  const lines: string[] = [];
  for (const name of GREEN_STATIC_CHECKS) {
    const fresh = [...at[name]].filter((finding) => !green[name].has(finding)).sort();
    if (fresh.length === 0) {
      checks.push({ name, ok: true });
      continue;
    }
    checks.push({ name, ok: false, code: greenCheckCode(name) });
    for (const finding of fresh) lines.push(`${name}: ${finding}`);
  }
  return { ok: checks.every((c) => c.ok), checks, log: lines.join("\n").slice(0, GREEN_LOG_MAX_CHARS) };
}

/** The `Verifier` of the static runtime over one start answer's files. `now` is the clock that
 * gives `duration_ms`. */
export function staticVerifier(
  input: StaticInput & { seq: number; commit: string },
  now: () => number = Date.now,
): Verifier {
  return {
    async verify(request) {
      if (request.seq !== input.seq || request.commit !== input.commit) {
        throw new Error("the static verifier holds the files of another commit");
      }
      const started = now();
      const result = staticResult(input);
      return { seq: input.seq, commit: input.commit, runtime: "static", duration_ms: now() - started, ...result };
    },
  };
}
