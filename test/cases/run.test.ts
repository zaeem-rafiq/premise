// test/cases/run.test.ts — runs the executable vectors of docs/spec/premise-cases.json against
// the engine (01-core Appendix A, 04-build-plan 2.2 Track 1C). Slice 1 requires C01, C23 and C28;
// every case id the lead lists in `required.json` runs too, so later tracks switch theirs on by
// adding ids, never by editing this file (the file is the lead's).
//
// A test's name carries the vector id and its rule ids, e.g. `C01-disjoint-batch (9.4, LP2)`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../support/source.ts";
import { CASES_FILE, loadCases, loadRequired } from "./load.ts";
import { runCase, sqlOver, type Pools } from "./driver.ts";
import { DatabaseSync } from "node:sqlite";
import { Trunk } from "../../src/core/trunk/registry.ts";

const REQUIRED_IDS = new Set(["C01", "C23", "C28"]);

function idPrefix(id: string): string {
  const i = id.indexOf("-");
  return i < 0 ? id : id.slice(0, i);
}

const cases = loadCases();
const required = loadRequired();
// `loadCases` checks the outer shape and keeps the vectors; the seed pools live at the file's
// top level, which the loader does not re-export — read them straight from the data file (BP1).
const pools = (JSON.parse(readFileSync(join(REPO_ROOT, CASES_FILE), "utf8")) as { pools: Pools }).pools;
const tidepool = pools.tidepool;
if (tidepool === undefined) throw new Error("premise-cases.json: no tidepool pool");
const requiredByLead = new Set(Object.values(required.required).flat());
const toRun = cases.cases.filter(
  (c) => REQUIRED_IDS.has(idPrefix(c.id)) || requiredByLead.has(c.id) || requiredByLead.has(idPrefix(c.id)),
);

describe("premise case vectors through the Trunk engine", () => {
  it("runs every case that required.json lists (Slice 1 requires all of them)", () => {
    expect(toRun.map((c) => idPrefix(c.id)).sort()).toEqual([...requiredByLead].sort());
  });

  for (const vector of toRun) {
    const rules = Array.isArray((vector as { rules?: unknown }).rules)
      ? ` (${(vector.rules as string[]).join(", ")})`
      : "";
    it(`${vector.id}${rules}`, () => {
      expect(runCase(vector, pools)).toEqual([]);
    });
  }

  it("the 3.2 schema carries the Slice-1 columns and meta keys (3.2)", () => {
    const sql = sqlOver(new DatabaseSync(":memory:"));
    Trunk.create(sql, tidepool.files);
    const cols = (table: string): Set<string> =>
      new Set(
        sql
          .exec(`SELECT name FROM pragma_table_info('${table}')`)
          .toArray()
          .map((r) => String(r.name)),
      );
    for (const col of ["race", "truth", "resumes"]) {
      expect(cols("attempts"), `attempts.${col}`).toContain(col);
    }
    expect(cols("heads_ups")).toContain("op_mark");
    const meta = new Set(
      sql
        .exec("SELECT k FROM meta")
        .toArray()
        .map((r) => String(r.k)),
    );
    expect(meta).toContain("summary_only");
    expect(meta).toContain("synthetic");
  });

  it("every submit records the CK9 policy check in `checks` (10.2, 4.9)", () => {
    const sql = sqlOver(new DatabaseSync(":memory:"));
    const trunk = Trunk.create(sql, tidepool.files);
    trunk.openAttempt("T", { intent: "prove CK9 rides on submit" });
    trunk.tool({
      attempt_id: "T",
      call_id: "T:1",
      tool: "write",
      args: { path: "creatures/newt.js", content: "export function spawn() {\n  return { x: 0, y: 0 };\n}\n" },
      ack: 0,
    });
    const resp = trunk.tool({
      attempt_id: "T",
      call_id: "T:2",
      tool: "submit",
      args: { summary: "add a newt" },
      ack: 0,
    });
    expect(resp.ok).toBe(true);
    const checks = (resp.result as { checks?: Array<{ name: string; ok: boolean }> }).checks ?? [];
    expect(checks.map((c) => c.name)).toContain("policy");
    expect(checks.find((c) => c.name === "policy")?.ok).toBe(true);
  });
});
