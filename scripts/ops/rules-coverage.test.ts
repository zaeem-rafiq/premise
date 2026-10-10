// Fixtures for scripts/ops/rules-coverage.ts. Parser fixtures use made-up ZX and QW families.
// Feature-switch fixtures use real ids inside source strings, never in the enclosing test titles.

import { describe, expect, it } from "vitest";
import type { Features } from "../../src/protocol/floor-json.ts";

const ENABLED: Features = {
  held: true,
  race: true,
  undo: true,
  green: "full",
  clef: true,
  attempt_repos: true,
  text_merge: true,
};
import {
  acceptanceCheckIds,
  caseCoverage,
  compareRuleIds,
  definedRuleIds,
  expandRange,
  idsInText,
  isNonRuleId,
  renderReport,
  ruleCoverage,
  testTitles,
  ve2TableIds,
} from "./rules-coverage.ts";

const SPEC = {
  "docs/spec/01-fixture.md": [
    "# fixture",
    "",
    "- **ZX1.** the first rule",
    "- **ZX2a (the labeled one).** a labeled rule",
    "- **C01.** a case id is not a rule",
    "- **M3.** a milestone is not a rule",
    "",
    "| Id | What it does |",
    "| --- | --- |",
    "| ZX9 | a rule in a table |",
    "| `QW4` | a backticked id |",
    "| ZX7, ZX8 | two ids in one cell define neither |",
    "| F05 | a finding, excluded |",
    "| F2 | a decision-table rule |",
  ].join("\n"),
};

describe("definedRuleIds", () => {
  it("reads bullet definitions, with or without a parenthetical label", () => {
    const defined = definedRuleIds(SPEC);
    expect(defined.get("ZX1")).toEqual(["docs/spec/01-fixture.md"]);
    expect(defined.get("ZX2a")).toEqual(["docs/spec/01-fixture.md"]);
  });

  it("reads a bare-id first cell of a table row", () => {
    const defined = definedRuleIds(SPEC);
    expect(defined.get("ZX9")).toEqual(["docs/spec/01-fixture.md"]);
    expect(defined.get("QW4")).toEqual(["docs/spec/01-fixture.md"]);
    expect(defined.has("ZX7")).toBe(false);
    expect(defined.has("ZX8")).toBe(false);
  });

  it("excludes case, milestone and finding ids but keeps one-digit F rules", () => {
    const defined = definedRuleIds(SPEC);
    expect(defined.has("C01")).toBe(false);
    expect(defined.has("M3")).toBe(false);
    expect(defined.has("F05")).toBe(false);
    expect(defined.get("F2")).toEqual(["docs/spec/01-fixture.md"]);
    expect(isNonRuleId("IP0")).toBe(true);
    expect(isNonRuleId("IP0a")).toBe(true);
    expect(isNonRuleId("F43")).toBe(true);
    expect(isNonRuleId("F3")).toBe(false);
  });
});

describe("expandRange", () => {
  it("expands a numeric range", () => {
    expect(expandRange("X1", "X5")).toEqual(["X1", "X2", "X3", "X4", "X5"]);
  });

  it("expands a suffix-letter range", () => {
    expect(expandRange("LP5a", "LP5c")).toEqual(["LP5a", "LP5b", "LP5c"]);
  });

  it("returns the endpoints when the parts do not line up", () => {
    expect(expandRange("A1", "B2")).toEqual(["A1", "B2"]);
    expect(expandRange("X5", "X1")).toEqual(["X5", "X1"]);
  });
});

describe("idsInText", () => {
  it("matches whole words only", () => {
    expect(idsInText("E1, E10, SE14b")).toEqual(["E1", "E10", "SE14b"]);
  });

  it("expands ranges and drops the endpoints' bare words", () => {
    expect(idsInText("rows A3 to A5 hold")).toEqual(["A3", "A4", "A5"]);
  });

  it("ignores section numbers and other words", () => {
    expect(idsInText("9.4 step 3b, 2.5 module hash, context")).toEqual([]);
  });
});

describe("caseCoverage", () => {
  it("maps each rule id of a case's rules to the case, stripping non-id words", () => {
    const json = JSON.stringify({
      cases: [
        { id: "C01", rules: ["9.4", "ZX2", "7.3 ZX3", "C02"] },
        { id: "C04", rules: ["ZX2", "ZX2"] },
      ],
    });
    const byRule = caseCoverage(json);
    expect(byRule.get("ZX2")).toEqual(["C01", "C04"]);
    expect(byRule.get("ZX3")).toEqual(["C01"]);
    expect(byRule.has("C02")).toBe(false);
  });
});

const PLAN = [
  "## 2. Vertical slices",
  "",
  "### 2.1 Slice A",
  "1. ZX7 in the slice body is not an acceptance check.",
  "",
  "Acceptance (the lead, at IP1):",
  "",
  "```",
  "npm run check",
  "```",
  "",
  "1. The ZX1 rule holds (ZX2).",
  "2. ZX3 to ZX4 pass.",
  "",
  "### 2.2 Slice B",
  "Acceptance: `npm test`.",
  "",
  "1. ZX9 passes.",
  "",
  "## 3. Parallelism map",
  "1. ZX5 is outside section 2.",
  "",
  "### 5.2 Details",
  "| Rules that the vectors do not cover | Test | Built in |",
  "| --- | --- | --- |",
  "| The `stop` call (QW1, QW2a) | 2.3 item 8 | Slice 2 |",
  "| A range (QW5 to QW6) | 2.4 item 1 | Slice 3 |",
  "| VX88 missing | 2.5 | Slice 4 |",
  "",
  "### 5.3 Security review (VE7)",
].join("\n");

describe("acceptanceCheckIds", () => {
  it("collects only the numbered items under Acceptance lines of section 2", () => {
    expect(acceptanceCheckIds(PLAN)).toEqual(["ZX1", "ZX2", "ZX3", "ZX4", "ZX9"]);
  });
});

describe("ve2TableIds", () => {
  it("reads the first column of the VE2 table, ranges expanded", () => {
    expect(ve2TableIds(PLAN)).toEqual(["QW1", "QW2a", "QW5", "QW6", "VX88"]);
  });
});

const TEST_SOURCE = [
  'it("ZX1 works", () => {});',
  "test('ZX2 ok', () => {});",
  "describe(`ZX3 suite`, () => {});",
  'it.each([[1], [2]])("ZX4 case %i", () => {});',
  'it.fails("ZX5 known failure", () => {});',
  'test.describe("ZX6 playwright", () => {});',
  'obj.test("ZX7 is a member call, not a title");',
  '// it("ZX8 commented out")',
  'const s = "it(\\"ZX9 inside a string\\")";',
].join("\n");

describe("testTitles", () => {
  it("reads it, test and describe titles, strings and templates, with modifiers", () => {
    expect(testTitles(TEST_SOURCE)).toEqual([
      "ZX1 works",
      "ZX2 ok",
      "ZX3 suite",
      "ZX4 case %i",
      "ZX5 known failure",
      "ZX6 playwright",
    ]);
  });
});

describe("ruleCoverage", () => {
  const integrationPlan = [
    "## 2. Vertical slices",
    "### 2.1 Slice A",
    "Acceptance:",
    "1. ZX2 holds.",
    "## 3. Parallelism map",
    "### 5.2 Details",
    "| Rules that the vectors do not cover | Test | Built in |",
    "| --- | --- | --- |",
    "| ZX3 and VX88 | 2.1 item 1 | Slice A |",
    "### 5.3 Security review (VE7)",
  ].join("\n");
  const input = {
    features: ENABLED,
    specFiles: {
      "docs/spec/01-fixture.md": [
        "- **ZX1.** case-covered",
        "- **ZX2.** test-covered",
        "- **ZX3.** covered by neither",
        "- **ZX4.** defined but cited by nothing, so not required",
      ].join("\n"),
    },
    casesJson: JSON.stringify({ cases: [{ id: "C01", rules: ["ZX1"] }] }),
    buildPlan: integrationPlan,
    testFiles: { "src/x/z.test.ts": 'it("ZX2 still works", () => {});' },
  };

  it("requires the union of case rules, acceptance checks and the VE2 column", () => {
    const result = ruleCoverage(input);
    expect(result.counts).toEqual({
      required: 3,
      coveredByCase: 1,
      coveredOnlyByTests: 1,
      featureOff: 0,
      notCovered: 1,
    });
    const row = result.rows.find((row) => row.id === "ZX1");
    expect(row?.definedIn).toEqual(["docs/spec/01-fixture.md"]);
    expect(row?.cases).toEqual(["C01"]);
    const testRow = result.rows.find((row) => row.id === "ZX2");
    expect(testRow?.tests).toEqual([{ file: "src/x/z.test.ts", title: "ZX2 still works" }]);
    expect(result.uncovered).toEqual(["ZX3"]);
    expect(result.namedButUndefined).toEqual(["VX88"]);
  });

  it("renders the report with commit, counts, rows and the uncovered list", () => {
    const report = renderReport(ruleCoverage(input), "abc1234", "2026-10-09");
    expect(report).toContain("# Rule coverage (VE2)");
    expect(report).toContain("`abc1234`");
    expect(report).toContain("2026-10-09");
    expect(report).toContain("- ids required: 3");
    expect(report).toContain("| ZX1 | docs/spec/01-fixture.md | C01 | — |");
    expect(report).toContain("| ZX3 | docs/spec/01-fixture.md | — | — |");
    expect(report).toContain("- `ZX3`");
  });
});

describe("compareRuleIds", () => {
  it("orders by family, number, suffix", () => {
    expect(["T10", "A2", "T9c", "T9", "A10"].sort(compareRuleIds)).toEqual(["A2", "A10", "T9", "T9c", "T10"]);
  });
});

describe("rules of disabled features", () => {
  const ids = ["AG5", "GR1", "GR2", "GR4", "GR5", "GR6", "GR7", "GR8", "S3a", "S3b", "S6", "TR2", "TR7"];
  const input = {
    features: { ...ENABLED, green: "none", clef: false, attempt_repos: false } satisfies Features,
    specFiles: {
      "docs/spec/01-core.md": [
        ...ids.map((id) => `- **${id}.** fixture definition`),
        'With `features.green = "none"` no verification runs and the Floor shows no green line.',
        "With `features.attempt_repos = false` nothing is provisioned.",
      ].join("\n"),
      "docs/spec/04-build-plan.md":
        "Slice 15 adapters (`features.clef` is false: the build runs with the three Clef switches `off`; the eight cases still pass).",
    },
    casesJson: '{"cases":[]}',
    buildPlan: `## 2. Vertical slices\n### 2.1 Fixture\nAcceptance:\n1. ${ids.join(" ")}\n## 3. Parallelism`,
    testFiles: {},
  };

  it("separates exclusively disabled rules, retaining mixed obligations as uncovered", () => {
    const result = ruleCoverage(input);
    expect(result.featureOff.map(({ id }) => id)).toEqual([
      "AG5",
      "GR1",
      "GR2",
      "GR4",
      "GR6",
      "GR7",
      "GR8",
      "S3a",
      "S3b",
      "TR7",
    ]);
    expect(result.uncovered).toEqual(["GR5", "S6", "TR2"]);
    expect(result.counts).toEqual({
      required: 13,
      coveredByCase: 0,
      coveredOnlyByTests: 0,
      featureOff: 10,
      notCovered: 3,
    });
    const report = renderReport(result, "fixture", "2026-10-07");
    expect(report).toContain("## Rules of features switched off in this build");
    expect(report).toContain(
      '| GR1 | `green: "none"` | docs/spec/01-core.md: With `features.green = "none"` no verification runs and the Floor shows no green line. |',
    );
    expect(report).toContain("| AG5 | `attempt_repos: false` |");
    expect(report).toContain("| TR7 | `clef: false` | docs/spec/04-build-plan.md: Slice 15 adapters");
    expect(report.split("## Required ids with no coverage")[1]).not.toContain("`GR1`");
  });

  it.each(["static", "full"] as const)("requires green verification rules when green is %s", (green) => {
    const result = ruleCoverage({ ...input, features: { ...ENABLED, green } });
    expect(result.featureOff).toEqual([]);
    expect(result.uncovered).toEqual(ids.toSorted(compareRuleIds));
    expect(result.counts.notCovered).toBe(13);
  });

  it("reactivates only the feature whose switch changes", () => {
    const result = ruleCoverage({ ...input, features: { ...input.features, attempt_repos: true } });
    expect(result.uncovered).toEqual(["AG5", "GR5", "S3a", "S3b", "S6", "TR2"]);
    expect(result.featureOff.map(({ switch: value }) => value)).not.toContain("attempt_repos: false");
  });

  it("counts a disabled rule once even when a test and a case name it", () => {
    const result = ruleCoverage({
      ...input,
      casesJson: '{"cases":[{"id":"C01","rules":["AG5"]}]}',
      testFiles: { "test/a.test.ts": 'it("AG5 fixture", () => {});' },
    });
    expect(result.counts).toEqual({
      required: 13,
      coveredByCase: 0,
      coveredOnlyByTests: 0,
      featureOff: 10,
      notCovered: 3,
    });
    expect(result.rows.find(({ id }) => id === "AG5")?.cases).toEqual(["C01"]);
  });

  it("refuses a stale exemption when its spec evidence disappears", () => {
    expect(() =>
      ruleCoverage({ ...input, specFiles: { ...input.specFiles, "docs/spec/04-build-plan.md": "" } }),
    ).toThrow("missing feature evidence");
  });
});
