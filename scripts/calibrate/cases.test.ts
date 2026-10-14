// The labelled set of calibrate:clef (04-build-plan 2.16 item 2; 01-core S6, 7.3). Expected values
// come from the plan's text (at least 48 cases, the triage vectors plus at least 40 more, QR4 cases,
// cases from real runs) and from docs/spec/premise-cases.json, never from a model's answer.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CASES_FILE, LABELS, ROOT, TRIAGE_ROWS, loadCases, type Sources } from "./cases.ts";

/** The triage vectors that clef.md's stage 1 names (acceptance item 1). */
const TRIAGE_VECTORS = ["C06", "C07", "C12", "C31", "C38", "C42", "C52", "C55"];

type Vector = {
  id: string;
  attempts: Record<string, { intent: string }>;
  steps: Array<{ do?: string; expect?: { judgments?: Array<Record<string, unknown>> } }>;
};
const VECTORS = (
  JSON.parse(readFileSync(join(ROOT, "docs", "spec", "premise-cases.json"), "utf8")) as { cases: Vector[] }
).cases;

const cases = loadCases();

describe("calibrate:clef labelled set (2.16 item 2, S6)", () => {
  it("2.16: loads at least 48 cases, each labelled dependent or independent", () => {
    expect(cases.length).toBeGreaterThanOrEqual(48);
    for (const c of cases) expect(LABELS).toContain(c.label);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it("2.16: the triage vectors plus at least 40 more cases", () => {
    const fromVectors = new Set(cases.filter((c) => c.source.kind === "vector").map((c) => c.source.ref.slice(0, 3)));
    expect([...fromVectors].sort()).toEqual(TRIAGE_VECTORS);
    expect(cases.filter((c) => c.source.kind !== "vector").length).toBeGreaterThanOrEqual(40);
  });

  it("2.16: it includes QR4 cases and cases taken from real agent runs", () => {
    expect(cases.filter((c) => c.row === "QR4").length).toBeGreaterThanOrEqual(3);
    expect(cases.filter((c) => c.source.kind === "real").length).toBeGreaterThanOrEqual(10);
    expect(cases.filter((c) => c.source.kind === "real" && c.row === "QR4").length).toBeGreaterThanOrEqual(1);
  });

  it("RR7: both classes are present, so both of its accuracy conditions can be read", () => {
    expect(cases.filter((c) => c.label === "dependent").length).toBeGreaterThanOrEqual(10);
    expect(cases.filter((c) => c.label === "independent").length).toBeGreaterThanOrEqual(10);
  });

  it("7.3: every case is one question of a triage row, in the request shape of S6", () => {
    for (const c of cases) {
      expect(TRIAGE_ROWS).toContain(c.row);
      expect(Object.keys(c.input.premises)).toEqual([c.qid]);
      const premise = c.input.premises[c.qid]!;
      expect(premise.rule).toBe(c.row);
      expect(c.qid).toBe(`${premise.kind}:${premise.key}`);
      expect(c.input.patch.length).toBeGreaterThan(0);
      expect(c.input.truth).toBeNull();
      if (c.row === "QR4") expect(premise.key.startsWith("refs:")).toBe(true);
    }
  });

  it("vectors: each vector case asks a triage judgment that its vector records, with the vector's intent", () => {
    for (const c of cases.filter((x) => x.source.kind === "vector")) {
      const vector = VECTORS.find((v) => v.id === c.source.ref);
      expect(vector, c.id).toBeDefined();
      const attempt = c.source.attempt!;
      const premise = c.input.premises[c.qid]!;
      const triage = vector!.steps.flatMap((s) => s.expect?.judgments ?? []).filter((j) => j.class === "triage");
      expect(
        triage.some(
          (j) => j.attempt === attempt && j.key === premise.key && j.kind === premise.kind && j.rule === c.row,
        ),
        c.id,
      ).toBe(true);
      // QR4 asks with the landed change's intent (7.3); every other row with the attempt's own.
      if (c.row !== "QR4") expect(c.input.intent).toBe(vector!.attempts[attempt]!.intent);
    }
  });

  it("C42: the patch holds the added and altered entities only (S6 `patch`)", () => {
    const c42 = cases.find((c) => c.source.ref.startsWith("C42"))!;
    expect(c42.input.patch).toEqual([
      {
        key: "creatures/fish.js#spawn",
        source: "export function spawn() {\n  return { x: 45, y: 60, vx: 1, vy: 0, energy: ENERGY_MAX };\n}",
      },
    ]);
  });
});

describe("calibrate:clef case loader", () => {
  const sources: Sources = {
    seed: (path) => (path === "world/a.js" ? "export const A = 1;\n" : undefined),
    vector: () => undefined,
    run: () => undefined,
  };
  const one = (overrides: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), "clef-cases-"));
    const file = join(dir, "cases.json");
    const base = {
      id: "x",
      source: { kind: "spec", ref: "test" },
      row: "E3",
      zone: "triage",
      intent: "make A two",
      patch: [{ path: "world/b.js", after: "export const B = 2;\n" }],
      premise: {
        kind: "entity",
        key: "world/a.js#A",
        read_then: { from: "seed", path: "world/a.js", entity: "A" },
        is_now: { from: "seed", path: "world/a.js", entity: "A", replace: [["A = 1", "A = 2"]] },
        changed_by_intent: "make A two",
      },
      label: "independent",
      why: "B does not use A in any way at all.",
      ...overrides,
    };
    writeFileSync(file, JSON.stringify({ v: 1, cases: [base] }));
    return () => loadCases(file, sources);
  };

  it("resolves references and replace edits into the 7.3 premise", () => {
    const [c] = one({})();
    expect(c!.input.premises["entity:world/a.js#A"]).toMatchObject({
      // EN7: an entity's source is the text of its regions, so the module's last newline stays with it.
      read_then: "export const A = 1;\n",
      is_now: "export const A = 2;\n",
      rule: "E3",
      changed: [],
    });
  });

  it("refuses a label that is not dependent or independent", () => {
    expect(one({ label: "maybe" })).toThrow(/label must be one of dependent, independent/);
  });

  it("refuses a row that is not a triage row", () => {
    expect(one({ row: "E2" })).toThrow(/not a triage row/);
  });

  it("refuses a reference that does not resolve and a replace that does not match", () => {
    expect(
      one({
        premise: {
          kind: "entity",
          key: "k",
          read_then: { from: "seed", path: "nope.js" },
          is_now: null,
          changed_by_intent: null,
        },
      }),
    ).toThrow(/no text for seed nope.js/);
    expect(
      one({
        premise: {
          kind: "entity",
          key: "k",
          read_then: "x",
          is_now: { from: "seed", path: "world/a.js", replace: [["A = 9", "A = 2"]] },
          changed_by_intent: null,
        },
      }),
    ).toThrow(/replace/);
  });

  it("the repository's set file is the one loadCases reads by default", () => {
    expect(CASES_FILE.endsWith(join("scripts", "calibrate", "clef-cases.json"))).toBe(true);
  });
});
