// docs/spec/04-build-plan.md 1.3, mechanism 4: no SQL text under src/core/trunk/ contains LIKE or GLOB (SQ1).

import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../support/source.ts";
import { findingsIn, findingsUnder, format } from "./sql-rules.ts";

/** The LIKE and GLOB words found in an engine file with this source text. */
function words(text: string): string[] {
  return findingsIn("src/core/trunk/premises.ts", text).map((finding) => finding.word);
}

describe("no patterns built from input: the repository", () => {
  it("no SQL text under src/core/trunk/ contains LIKE or GLOB", () => {
    expect(format(findingsUnder(REPO_ROOT))).toBe("");
  });
});

describe("no patterns built from input: what is found", () => {
  it("LIKE in a string", () => {
    expect(words(`sql.exec("SELECT path FROM files WHERE path LIKE ?", prefix);`)).toEqual(["LIKE"]);
  });

  it("GLOB in a string", () => {
    expect(words(`sql.exec("SELECT path FROM files WHERE path GLOB ?", pattern);`)).toEqual(["GLOB"]);
  });

  it("either word in any letter case", () => {
    expect(words(`sql.exec("select path from files where path like ?", prefix);`)).toEqual(["LIKE"]);
    expect(words(`sql.exec("select path from files where path Glob ?", pattern);`)).toEqual(["GLOB"]);
  });

  it("either word in the text of a template literal", () => {
    expect(words("sql.exec(`SELECT path FROM ${table} WHERE path LIKE ?`, prefix);")).toEqual(["LIKE"]);
    expect(words("const query = `SELECT path FROM files\n  WHERE path GLOB ?`;")).toEqual(["GLOB"]);
  });

  it("a query that is split over several strings", () => {
    expect(words(`const query = "SELECT path FROM files WHERE path " + "LIKE ?";`)).toEqual(["LIKE"]);
  });
});

describe("no patterns built from input: what is not a finding", () => {
  it("a query that compares by value", () => {
    expect(words(`sql.exec("SELECT path FROM files WHERE path = ? OR dir = ?", path, dir);`)).toEqual([]);
  });

  it("the words in a comment or as part of a name", () => {
    expect(words(`// Never LIKE, never GLOB (SQ1).\nexport const likely = "globals";`)).toEqual([]);
  });
});
