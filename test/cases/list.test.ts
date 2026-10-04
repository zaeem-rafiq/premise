// Slice 0: no case runs yet, the file loads (docs/spec/04-build-plan.md section 2 and 2.1, acceptance item 1).
//
// The expected counts are read from the case index of docs/spec/01-core.md, Appendix A, so the specification
// text and the vectors cannot drift apart unseen (BP1).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../support/source.ts";
import { loadCases, loadRequired, prefixOf, summary } from "./load.ts";

/** "Case index (57 cases, 23 hash cases, 5 inbox cases)." */
function countsInSpecification(): { cases: number; hashCases: number; inboxCases: number } {
  const core = readFileSync(join(REPO_ROOT, "docs/spec/01-core.md"), "utf8");
  const sentences = [...core.matchAll(/^Case index \((\d+) cases, (\d+) hash cases, (\d+) inbox cases\)/gm)];
  if (sentences.length !== 1) {
    throw new Error(`docs/spec/01-core.md: expected one "Case index (…)" sentence, found ${sentences.length}.`);
  }
  const [, cases, hashCases, inboxCases] = sentences[0] as RegExpMatchArray;
  return { cases: Number(cases), hashCases: Number(hashCases), inboxCases: Number(inboxCases) };
}

function numbered(letter: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${letter}${String(index + 1).padStart(2, "0")}`);
}

describe("docs/spec/premise-cases.json", () => {
  const cases = loadCases();
  const required = loadRequired();
  const expected = countsInSpecification();

  it("loads, in the format premise-cases/2", () => {
    expect(cases.format).toBe("premise-cases/2");
    expect(required.format).toBe("premise-cases/2");
  });

  it("holds the cases that the case index of 01-core.md counts, numbered from C01 with no gap", () => {
    expect(expected.cases).toBeGreaterThanOrEqual(57);
    expect(cases.cases.map((entry) => prefixOf(entry.id))).toEqual(numbered("C", expected.cases));
  });

  it("holds the hash cases that the case index counts, numbered from H01 with no gap", () => {
    expect(expected.hashCases).toBeGreaterThanOrEqual(23);
    expect(cases.hashCases.map((entry) => entry.id)).toEqual(numbered("H", expected.hashCases));
  });

  it("holds the inbox cases that the case index counts, numbered from I01 with no gap", () => {
    expect(expected.inboxCases).toBeGreaterThanOrEqual(5);
    expect(cases.inboxCases.map((entry) => entry.id)).toEqual(numbered("I", expected.inboxCases));
  });

  it("every required case exists, and each is required by one slice only", () => {
    const known = new Set(cases.cases.map((entry) => prefixOf(entry.id)));
    const listed = Object.values(required.required).flat();
    for (const id of listed) {
      expect(known, id).toContain(id);
    }
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("prints its summary line", () => {
    const requiredCount = Object.values(required.required).flat().length;
    const line = summary(cases, required);
    expect(line).toBe(
      `${expected.cases} cases, ${expected.hashCases} hash cases, ${expected.inboxCases} inbox cases, ` +
        `format premise-cases/2, required: ${requiredCount}`,
    );
    if (process.env.CASES === "list") {
      console.log(line);
    }
  });
});
