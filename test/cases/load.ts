// Loads docs/spec/premise-cases.json, the executable test vectors of the pure core (01-core Appendix A),
// and test/cases/required.json, the list of cases that merged slices must pass (plan 1.4).
//
// The driver that runs a case through the engine is `test/cases/driver.ts` (engine lane, Slice 1).
// This file only reads and checks the outer shape. A builder never edits the cases file (BP1).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../support/source.ts";

export const CASES_FILE = "docs/spec/premise-cases.json";
export const REQUIRED_FILE = "test/cases/required.json";

/** The format this loader reads. */
export const CASES_FORMAT = "premise-cases/2";

/** One vector. Its other members are read by the driver. */
export type Vector = { id: string; [member: string]: unknown };

export type CasesFile = { format: string; cases: Vector[]; hashCases: Vector[]; inboxCases: Vector[] };

/** `required` maps a slice number to the ids of the cases that slice added. A case is named by its number prefix. */
export type RequiredFile = { format: string; hashCases: "all"; inboxCases: "all"; required: Record<string, string[]> };

function readJson(path: string): Record<string, unknown> {
  const data: unknown = JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8"));
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`${path}: expected a JSON object.`);
  }
  return data as Record<string, unknown>;
}

function vectors(path: string, member: string, value: unknown): Vector[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path}: \`${member}\` must be an array.`);
  }
  const seen = new Set<string>();
  for (const entry of value as Array<{ id?: unknown }>) {
    if (typeof entry !== "object" || entry === null || typeof entry.id !== "string" || entry.id === "") {
      throw new Error(`${path}: every entry of \`${member}\` needs an \`id\`.`);
    }
    if (seen.has(entry.id)) {
      throw new Error(`${path}: \`${member}\` holds the id ${entry.id} twice.`);
    }
    seen.add(entry.id);
  }
  return value as Vector[];
}

function format(path: string, data: Record<string, unknown>): string {
  if (data.format !== CASES_FORMAT) {
    throw new Error(`${path}: format is ${JSON.stringify(data.format)}, and this loader reads ${CASES_FORMAT}.`);
  }
  return CASES_FORMAT;
}

export function loadCases(): CasesFile {
  const data = readJson(CASES_FILE);
  return {
    format: format(CASES_FILE, data),
    cases: vectors(CASES_FILE, "cases", data.cases),
    hashCases: vectors(CASES_FILE, "hash_cases", data.hash_cases),
    inboxCases: vectors(CASES_FILE, "inbox_cases", data.inbox_cases),
  };
}

export function loadRequired(): RequiredFile {
  const data = readJson(REQUIRED_FILE);
  if (data.hash_cases !== "all" || data.inbox_cases !== "all") {
    throw new Error(`${REQUIRED_FILE}: \`hash_cases\` and \`inbox_cases\` must be "all".`);
  }
  const required = data.required;
  if (typeof required !== "object" || required === null || Array.isArray(required)) {
    throw new Error(`${REQUIRED_FILE}: \`required\` must be an object.`);
  }
  for (const [slice, ids] of Object.entries(required)) {
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
      throw new Error(`${REQUIRED_FILE}: \`required.${slice}\` must be an array of case ids.`);
    }
  }
  return {
    format: format(REQUIRED_FILE, data),
    hashCases: "all",
    inboxCases: "all",
    required: required as Record<string, string[]>,
  };
}

/** The number prefix that names a case: `C04` for `C04-hero-shared-rule-lands-first` (Appendix A, runner rule 10). */
export function prefixOf(id: string): string {
  return id.split("-")[0] ?? id;
}

/** The line that `CASES=list npm run test:cases` prints (plan 2.1, acceptance item 1). */
export function summary(cases: CasesFile, required: RequiredFile): string {
  const requiredCount = Object.values(required.required).reduce((count, ids) => count + ids.length, 0);
  return (
    `${cases.cases.length} cases, ${cases.hashCases.length} hash cases, ${cases.inboxCases.length} inbox cases, ` +
    `format ${cases.format}, required: ${requiredCount}`
  );
}
