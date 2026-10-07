// node scripts/ops/rules-coverage.ts
//
// Writes docs/measurements/rules.md, the rule-coverage record of VE2 (docs/spec/04-build-plan.md 5.1
// and 5.2): one row per rule id that a case, an acceptance check of section 2, or the VE2 table
// requires, with the cases and the test titles that cover it. Everything except the file and git
// reads at the bottom is a pure function of the files' contents, so the unit tests run on fixtures.
//
// A rule id is letters, digits and at most one lower-case suffix letter (E1, QR1m, TA9a, LP5c,
// SE14b). It is defined where a spec file under docs/spec/ gives it its own definition: a bullet
// that starts with the bold id and a period ("- **AG3.**", "- **SE14b (separate host).**"), or the
// first cell of a table row ("| QR1 | ... |"). A table cell counts only when it holds the bare id
// and nothing else, so "S1, push" in the port table does not define S1 while the bare "S6" row does.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RULE_ID = /^[A-Z]{1,4}\d+[a-z]?$/;
const RULE_ID_WORD = /\b[A-Z]{1,4}\d+[a-z]?\b/g;
const RANGE = /\b([A-Z]{1,4}\d+[a-z]?)\s+to\s+([A-Z]{1,4}\d+[a-z]?)\b/g;
const BULLET_DEF = /^\s*[-*]\s+\*\*([A-Z]{1,4}\d+[a-z]?)(?:\s*\([^()]*\))?\.\*\*/;
// A table row's first cell, when it is the bare id ("| QR1 |" or "| `QR1` |").
const TABLE_ROW = /^\s*\|/;
// An it/test/describe call at a statement position, with optional .each(...), .fails, .only and
// similar modifiers, whose first argument is a string or a template literal. "x.test(" and
// "// it(" do not match: the callee must start a statement or follow one of ; { }.
const TITLE_CALL =
  /(?:^|[\n;{}])\s*(?:it|test|describe)(?:\s*\.\s*\w+(?:<[^<>]*>)?\s*(?:\((?:[^()]|\([^()]*\))*\))?)*\s*\(\s*(["'`])((?:\\.|(?!\1)[^])*)\1/g;

/** Id families that look like rules but name something else. */
export const EXCLUDED_FAMILIES: ReadonlyArray<{ family: string; pattern: RegExp; why: string }> = [
  { family: "C", pattern: /^C\d+[a-z]?$/, why: "case vectors of docs/spec/premise-cases.json" },
  { family: "H", pattern: /^H\d+[a-z]?$/, why: "hash-case vectors of premise-cases.json" },
  { family: "I", pattern: /^I\d+[a-z]?$/, why: "inbox-case vectors of premise-cases.json" },
  { family: "M", pattern: /^M\d+[a-z]?$/, why: "milestones of the schedule" },
  { family: "IP", pattern: /^IP\d+[a-z]?$/, why: "integration points" },
  { family: "GP", pattern: /^GP\d+[a-z]?$/, why: "gaps closed in reconciliation" },
  { family: "PT", pattern: /^PT\d+[a-z]?$/, why: "plan thresholds (pass marks)" },
  { family: "RR", pattern: /^RR\d+[a-z]?$/, why: "risk-register entries" },
  { family: "SC", pattern: /^SC\d+[a-z]?$/, why: "submission-checklist items" },
  { family: "VE", pattern: /^VE\d+[a-z]?$/, why: "verification entries of the plan" },
  {
    family: "FNN…",
    pattern: /^F\d{2,}[a-z]?$/,
    why: "reconciliation findings F01 to F43; the one-digit F0 to F7 are decision-table rules",
  },
];

export function isNonRuleId(id: string): boolean {
  return EXCLUDED_FAMILIES.some(({ pattern }) => pattern.test(id));
}

/** "LP5a to LP5c" expands over the suffix letter; "RS1 to RS5" over the number. */
export function expandRange(from: string, to: string): string[] {
  const a = /^([A-Z]{1,4})(\d+)([a-z]?)$/.exec(from);
  const b = /^([A-Z]{1,4})(\d+)([a-z]?)$/.exec(to);
  if (a === null || b === null) return [from, to];
  const prefix = a[1] ?? "";
  const numberA = Number(a[2]);
  const numberB = Number(b[2]);
  const suffixA = a[3] ?? "";
  const suffixB = b[3] ?? "";
  if (prefix !== (b[1] ?? "") || Number.isNaN(numberA) || Number.isNaN(numberB)) return [from, to];
  if (numberA === numberB && suffixA !== "" && suffixA < suffixB) {
    const ids: string[] = [];
    for (let code = suffixA.charCodeAt(0); code <= suffixB.charCodeAt(0); code += 1) {
      ids.push(`${prefix}${numberA}${String.fromCharCode(code)}`);
    }
    return ids;
  }
  if (suffixA === suffixB && numberA < numberB) {
    const ids: string[] = [];
    for (let n = numberA; n <= numberB; n += 1) ids.push(`${prefix}${n}${suffixA}`);
    return ids;
  }
  return [from, to];
}

/** The id-shaped tokens the text names: whole words plus expanded "X1 to X5" ranges. */
export function idsInText(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(RANGE)) {
    const from = match[1] ?? "";
    const to = match[2] ?? "";
    if (from !== "" && to !== "") ids.push(...expandRange(from, to));
  }
  const rest = text.replace(RANGE, (range) => " ".repeat(range.length));
  for (const match of rest.matchAll(RULE_ID_WORD)) ids.push(match[0]);
  return [...new Set(ids)];
}

/** Every id a spec file defines, mapped to the files that define it. */
export function definedRuleIds(specFiles: Record<string, string>): Map<string, string[]> {
  const defined = new Map<string, string[]>();
  const add = (id: string, path: string): void => {
    if (id === "" || isNonRuleId(id)) return;
    const files = defined.get(id);
    if (files === undefined) defined.set(id, [path]);
    else if (!files.includes(path)) files.push(path);
  };
  for (const path of Object.keys(specFiles).sort()) {
    for (const line of (specFiles[path] ?? "").split("\n")) {
      const bullet = BULLET_DEF.exec(line);
      if (bullet !== null) add(bullet[1] ?? "", path);
      if (!TABLE_ROW.test(line)) continue;
      const cell = (line.split("|")[1] ?? "").replace(/[`*]/g, "").trim();
      if (RULE_ID.test(cell)) add(cell, path);
    }
  }
  return defined;
}

/** The cases that cite each rule id in their `rules`. */
export function caseCoverage(casesJson: string): Map<string, string[]> {
  const data = JSON.parse(casesJson) as { cases?: Array<{ id?: string; rules?: string[] }> };
  const byRule = new Map<string, string[]>();
  for (const entry of data.cases ?? []) {
    if (typeof entry.id !== "string") continue;
    const ids = new Set<string>();
    for (const rule of entry.rules ?? []) for (const id of idsInText(rule)) ids.add(id);
    for (const id of ids) {
      if (isNonRuleId(id)) continue;
      const cases = byRule.get(id);
      if (cases === undefined) byRule.set(id, [entry.id]);
      else if (!cases.includes(entry.id)) cases.push(entry.id);
    }
  }
  return byRule;
}

/**
 * Ids that the acceptance checks of section 2 name. An acceptance check is the numbered list under
 * an "Acceptance" heading of a slice, between "## 2." and "## 3."; fenced command blocks are not
 * checks.
 */
export function acceptanceCheckIds(buildPlan: string): string[] {
  const lines = buildPlan.split("\n");
  const start = lines.findIndex((line) => /^## 2\./.test(line));
  if (start === -1) return [];
  const after = lines.findIndex((line, index) => index > start && /^## 3\./.test(line));
  const stop = after === -1 ? lines.length : after;
  const ids: string[] = [];
  let inAcceptance = false;
  let inFence = false;
  for (const line of lines.slice(start, stop)) {
    if (/^#{2,3} /.test(line)) {
      inAcceptance = false;
      inFence = false;
      continue;
    }
    if (/^Acceptance\b/.test(line)) {
      inAcceptance = true;
      continue;
    }
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inAcceptance && !inFence && /^\d+\.\s/.test(line)) ids.push(...idsInText(line));
  }
  return [...new Set(ids)];
}

/** Ids of the first column of the "Rules that the vectors do not cover" table of 5.2. */
export function ve2TableIds(buildPlan: string): string[] {
  const lines = buildPlan.split("\n");
  const start = lines.findIndex((line) => /^### 5\.2\b/.test(line));
  if (start === -1) return [];
  const after = lines.findIndex((line, index) => index > start && /^### 5\.3\b/.test(line));
  const stop = after === -1 ? lines.length : after;
  const ids: string[] = [];
  let inTable = false;
  for (const line of lines.slice(start, stop)) {
    if (!TABLE_ROW.test(line)) {
      inTable = false;
      continue;
    }
    const firstCell = (line.split("|")[1] ?? "").replace(/[`*]/g, "").trim();
    if (firstCell.includes("Rules that the vectors do not cover")) {
      inTable = true;
      continue;
    }
    if (!inTable || firstCell === "" || /^:?-{2,}:?$/.test(firstCell)) continue;
    ids.push(...idsInText(firstCell));
  }
  return [...new Set(ids)];
}

/** The titles of every it/test/describe call whose first argument is a static string or template. */
export function testTitles(source: string): string[] {
  const titles: string[] = [];
  for (const match of source.matchAll(TITLE_CALL)) {
    const title = match[2];
    if (typeof title === "string") titles.push(title);
  }
  return titles;
}

export interface TestHit {
  file: string;
  title: string;
}

export interface CoverageRow {
  id: string;
  definedIn: string[];
  cases: string[];
  tests: TestHit[];
}

export interface CoverageInput {
  /** Spec markdown files, repository-relative path -> contents. */
  specFiles: Record<string, string>;
  /** Contents of docs/spec/premise-cases.json. */
  casesJson: string;
  /** Contents of docs/spec/04-build-plan.md. */
  buildPlan: string;
  /** Test sources (*.test.ts, *.test.tsx, *.spec.ts), path -> contents. */
  testFiles: Record<string, string>;
}

export interface RuleCoverage {
  rows: CoverageRow[];
  counts: { required: number; coveredByCase: number; coveredOnlyByTests: number; notCovered: number };
  /** Required ids that nothing covers. */
  uncovered: string[];
  /** Ids a required source names that no spec file defines (not part of the required set). */
  namedButUndefined: string[];
}

/** Natural order: family, then number, then suffix letter (A2 before A10, LP5a before LP5c). */
export function compareRuleIds(a: string, b: string): number {
  const key = (id: string): string => {
    const m = /^([A-Z]+)(\d+)([a-z]?)$/.exec(id);
    if (m === null) return id;
    return `${m[1] ?? ""}${String(Number(m[2])).padStart(8, "0")}${m[3] ?? ""}`;
  };
  const ka = key(a);
  const kb = key(b);
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The pure function: file contents in, coverage rows out. */
export function ruleCoverage(input: CoverageInput): RuleCoverage {
  const defined = definedRuleIds(input.specFiles);
  const byCase = caseCoverage(input.casesJson);
  const required = new Set(byCase.keys());
  const named = new Set(byCase.keys());
  for (const id of [...acceptanceCheckIds(input.buildPlan), ...ve2TableIds(input.buildPlan)]) {
    named.add(id);
    if (defined.has(id)) required.add(id);
  }
  const namedButUndefined = [...named].filter((id) => !defined.has(id) && !isNonRuleId(id)).sort(compareRuleIds);

  const hits = new Map<string, TestHit[]>();
  const seen = new Map<string, Set<string>>();
  for (const file of Object.keys(input.testFiles).sort()) {
    for (const title of testTitles(input.testFiles[file] ?? "")) {
      for (const id of idsInText(title)) {
        if (!required.has(id)) continue;
        const key = `${file}${title}`;
        let known = seen.get(id);
        if (known === undefined) {
          known = new Set();
          seen.set(id, known);
        }
        if (known.has(key)) continue;
        known.add(key);
        const list = hits.get(id);
        if (list === undefined) hits.set(id, [{ file, title }]);
        else list.push({ file, title });
      }
    }
  }

  const rows: CoverageRow[] = [...required].sort(compareRuleIds).map((id) => ({
    id,
    definedIn: defined.get(id) ?? [],
    cases: byCase.get(id) ?? [],
    tests: hits.get(id) ?? [],
  }));
  const uncovered = rows.filter((row) => row.cases.length === 0 && row.tests.length === 0);
  return {
    rows,
    counts: {
      required: rows.length,
      coveredByCase: rows.filter((row) => row.cases.length > 0).length,
      coveredOnlyByTests: rows.filter((row) => row.cases.length === 0 && row.tests.length > 0).length,
      notCovered: uncovered.length,
    },
    uncovered: uncovered.map((row) => row.id),
    namedButUndefined,
  };
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

/** The markdown of docs/measurements/rules.md. */
export function renderReport(result: RuleCoverage, commit: string, date: string): string {
  const lines: string[] = [];
  lines.push("# Rule coverage (VE2)");
  lines.push("");
  lines.push(
    "Every rule id that `docs/spec/premise-cases.json` cites in a case's `rules`, that an acceptance " +
      "check of `docs/spec/04-build-plan.md` section 2 names, or that the first column of the VE2 " +
      `table (5.2) names, at commit \`${commit}\` on ${date}. Generated by \`node ` +
      "scripts/ops/rules-coverage.ts`.",
  );
  lines.push("");
  lines.push(`- ids required: ${result.counts.required}`);
  lines.push(`- covered by a case: ${result.counts.coveredByCase}`);
  lines.push(`- covered only by tests: ${result.counts.coveredOnlyByTests}`);
  lines.push(`- not covered: ${result.counts.notCovered}`);
  lines.push("");
  lines.push(
    "Id families that are not rules and are excluded: " +
      EXCLUDED_FAMILIES.map(({ family, why }) => `\`${family}\` (${why})`).join("; ") +
      ". Section numbers (`9.4`, `2.5 module hash`) and other words inside a case's `rules` are " +
      "not ids. Titles are read statically: a template title's `${...}` parts hold no id.",
  );
  lines.push("");
  lines.push("| id | defined in | cases | tests |");
  lines.push("| --- | --- | --- | --- |");
  for (const row of result.rows) {
    const definedIn = row.definedIn.length === 0 ? "—" : row.definedIn.map(cell).join(", ");
    const cases = row.cases.length === 0 ? "—" : row.cases.join(", ");
    const tests =
      row.tests.length === 0 ? "—" : row.tests.map(({ file, title }) => `${cell(file)}: ${cell(title)}`).join("<br>");
    lines.push(`| ${row.id} | ${definedIn} | ${cases} | ${tests} |`);
  }
  lines.push("");
  lines.push("## Required ids with no coverage");
  lines.push("");
  if (result.uncovered.length === 0) lines.push("None.");
  else for (const id of result.uncovered) lines.push(`- \`${id}\``);
  lines.push("");
  lines.push("## Named by a required source but defined nowhere");
  lines.push("");
  if (result.namedButUndefined.length === 0) lines.push("None.");
  else for (const id of result.namedButUndefined) lines.push(`- \`${id}\``);
  lines.push("");
  return lines.join("\n");
}

// --- the command entry: reads the repository and writes the record -------------------------------

const TEST_DIRS = ["src", "test", "scripts"];
const TEST_FILE = /\.(test\.ts|test\.tsx|spec\.ts)$/;

function collectTestFiles(dir: string, root: string, out: Record<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectTestFiles(path, root, out);
    else if (TEST_FILE.test(entry.name)) out[relative(root, path)] = readFileSync(path, "utf8");
  }
}

function main(): number {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const specDir = join(root, "docs", "spec");
  const specFiles: Record<string, string> = {};
  for (const name of readdirSync(specDir).filter((name) => name.endsWith(".md"))) {
    specFiles[`docs/spec/${name}`] = readFileSync(join(specDir, name), "utf8");
  }
  const buildPlan = specFiles["docs/spec/04-build-plan.md"];
  if (buildPlan === undefined) {
    console.error("rules-coverage: docs/spec/04-build-plan.md is missing.");
    return 2;
  }
  const casesJson = readFileSync(join(specDir, "premise-cases.json"), "utf8");
  const testFiles: Record<string, string> = {};
  for (const dir of TEST_DIRS) collectTestFiles(join(root, dir), root, testFiles);

  const result = ruleCoverage({ specFiles, casesJson, buildPlan, testFiles });
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  const date = new Date().toISOString().slice(0, 10);
  const target = join(root, "docs", "measurements", "rules.md");
  const text = renderReport(result, commit, date);
  const before = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (before === text) {
    console.log("rules-coverage: docs/measurements/rules.md is up to date.");
  } else {
    writeFileSync(target, text);
    console.log(
      `rules-coverage: wrote docs/measurements/rules.md ` +
        `(${result.counts.required} required ids, ${result.counts.notCovered} uncovered).`,
    );
  }
  return 0;
}

const invoked = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) process.exitCode = main();
