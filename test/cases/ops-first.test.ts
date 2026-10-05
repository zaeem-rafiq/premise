// test/cases/ops-first.test.ts — PM2 (01-core 11.7): `ops_first` is written once per attempt
// and revision, at the moment its first heads-up of result `confirm` or `repair` is created,
// with the operations it held at that moment — before that heads-up's OP6 drops — and with
// `submitted = 1` only when the attempt had passed a submit (reached `submitted`, `validated`
// or `held`) before that moment. An attempt never given such a heads-up holds no row, and a
// second heads-up never rewrites the row.

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Sql } from "../../src/protocol/ports.ts";
import type { ToolRequest, ToolResponse } from "../../src/protocol/tools.ts";
import { Trunk } from "../../src/core/trunk/registry.ts";
import { ScriptedTriage } from "../../src/swarm/scripted-triage.ts";

/** `node:sqlite` speaks the `Sql` port (same adapter shape as the case driver's). */
function sqlOver(db: DatabaseSync): Sql {
  return {
    exec: (query, ...bindings) => {
      const rows = db.prepare(query).all(...bindings) as Array<Record<string, unknown>>;
      return { toArray: () => rows };
    },
    transaction: (run) => {
      db.exec("BEGIN");
      try {
        const r = run();
        db.exec("COMMIT");
        return r;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

const FILES = {
  ".premise/policy.json":
    '{\n  "v": 1,\n  "default": "held",\n  "tiers": [\n' +
    '    { "paths": ["creatures/**", "world/**"], "tier": "auto" }\n  ]\n}\n',
  "world/energy.js":
    "// Energy is counted in points, from 0 to ENERGY_MAX.\n" +
    "export const ENERGY_MAX = 100;\n" +
    "\n" +
    "// Remove energy from a creature. `amount` is in points per tick.\n" +
    "export function drain(creature, amount) {\n" +
    "  creature.energy = Math.max(0, creature.energy - amount);\n" +
    "}\n",
  "GUIDE.md": "# The pool\n",
};

const CRAB =
  'import { ENERGY_MAX } from "../world/energy.js";\n\n' +
  "export function spawn() {\n  return { x: 20, y: 180, en: ENERGY_MAX };\n}\n";

const CRAB_SLOW =
  'import { ENERGY_MAX } from "../world/energy.js";\n\n' +
  "export function spawn() {\n  return { x: 20, y: 60, en: ENERGY_MAX };\n}\n";

/** A file that references `drain` without the entity ever being read — B1's blind spot. */
const NEWT =
  'import { drain } from "../world/energy.js";\n\n' +
  "export function creep() {\n  const c = { energy: 10 };\n  drain(c, 1);\n  return c;\n}\n";

function call(trunk: Trunk, attempt: string, n: number, tool: string, args: object, ack?: number): ToolResponse {
  return trunk.tool({
    attempt_id: attempt,
    call_id: `${attempt}:${n}`,
    tool: tool as ToolRequest["tool"],
    args,
    ack: ack ?? trunk.pool.attempts.get(attempt)?.heads.length ?? 0,
  });
}

/** One breaker landing: `ENERGY_MAX = {before}` -> `{target}`, then the confirm. */
function landCap(trunk: Trunk, id: string, before: number, target: number): void {
  trunk.openAttempt(id, { intent: `lower the energy cap to ${target}` });
  call(trunk, id, 1, "read", { path: "world/energy.js", entity: "ENERGY_MAX" });
  call(trunk, id, 2, "replace", {
    path: "world/energy.js",
    old: `ENERGY_MAX = ${before}`,
    new: `ENERGY_MAX = ${target}`,
  });
  const r = call(trunk, id, 3, "submit", { summary: `cap ${target}` });
  expect(r.ok).toBe(true);
  expect(r.result).toMatchObject({ status: "validated" });
  trunk.tick();
  trunk.pushOk();
}

/** The victim: reads the entity, writes a new file that imports it (edit premise on
 * `ENERGY_MAX` plus a derived reference — the landing sends it `repair`). */
function victim(trunk: Trunk, a: string, content: string): void {
  trunk.openAttempt(a, { intent: `${a} adds a creature` });
  call(trunk, a, 1, "read", { path: "world/energy.js", entity: "ENERGY_MAX" });
  call(trunk, a, 2, "write", { path: `creatures/${a}.js`, content });
}

function setup(): { db: DatabaseSync; trunk: Trunk } {
  const db = new DatabaseSync(":memory:");
  const trunk = Trunk.create(sqlOver(db), FILES, {
    now: (() => {
      let t = 0;
      return () => ++t;
    })(),
    syncTriage: ScriptedTriage,
    features: { held: true },
  });
  trunk.pushOk();
  return { db, trunk };
}

type OpsFirstRow = { revision: number; ops: Array<Record<string, unknown>>; submitted: number };

function opsFirst(db: DatabaseSync, attempt: string): OpsFirstRow[] {
  return (
    db
      .prepare("SELECT revision, ops, submitted FROM ops_first WHERE attempt_id = ? ORDER BY revision")
      .all(attempt) as Array<{ revision: number; ops: string; submitted: number }>
  ).map((r) => ({
    revision: Number(r.revision),
    ops: JSON.parse(r.ops) as Array<Record<string, unknown>>,
    submitted: Number(r.submitted),
  }));
}

describe("ops_first (PM2, 11.7)", () => {
  it("a repair heads-up before any submit writes the row with submitted = 0, pre-drop ops", () => {
    const { db, trunk } = setup();
    victim(trunk, "a_v", CRAB);
    landCap(trunk, "a_b", 100, 50);
    const rows = opsFirst(db, "a_v");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revision).toBe(1);
    expect(rows[0]!.submitted).toBe(0);
    // The write is the whole operation set as held at heads-up creation (11.7 PM2).
    expect(rows[0]!.ops).toHaveLength(1);
    expect(rows[0]!.ops[0]).toMatchObject({ op_seq: 1, op: "write", path: "creatures/a_v.js", content: CRAB });
    const heads = trunk.pool.attempts.get("a_v")!.heads;
    expect(heads[0]?.result).toBe("repair");
  });

  it("a repair heads-up after a submit writes the row with submitted = 1", () => {
    const { db, trunk } = setup();
    // The held path (`extra/` is outside the auto tiers) parks the submit in `held` — the
    // attempt passed a submit, so PM2's flag is 1 when the landing sends it `repair`.
    trunk.openAttempt("a_v", { intent: "a_v adds an extra" });
    call(trunk, "a_v", 1, "read", { path: "world/energy.js", entity: "ENERGY_MAX" });
    call(trunk, "a_v", 2, "write", { path: "extra/a_v.js", content: CRAB });
    const r = call(trunk, "a_v", 3, "submit", { summary: "extra" });
    expect(r.result).toMatchObject({ status: "held" });
    landCap(trunk, "a_b", 100, 50);
    const rows = opsFirst(db, "a_v");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.submitted).toBe(1);
    expect(rows[0]!.ops[0]).toMatchObject({ op_seq: 1, path: "extra/a_v.js" });
  });

  it("a confirm heads-up (B1 blind spot) writes the row with submitted = 0", () => {
    const { db, trunk } = setup();
    trunk.openAttempt("a_c", { intent: "add a newt" });
    call(trunk, "a_c", 1, "write", { path: "creatures/a_c.js", content: NEWT });
    const r = call(trunk, "a_c", 2, "submit", { summary: "newt" });
    expect(r.result).toMatchObject({ status: "needs_confirm" });
    const rows = opsFirst(db, "a_c");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revision).toBe(1);
    expect(rows[0]!.submitted).toBe(0);
    expect(rows[0]!.ops[0]).toMatchObject({ op_seq: 1, op: "write", path: "creatures/a_c.js", content: NEWT });
    expect(trunk.pool.attempts.get("a_c")!.heads[0]?.result).toBe("confirm");
  });

  it("an attempt never given a confirm or repair heads-up has no row", () => {
    const { db, trunk } = setup();
    trunk.openAttempt("a_j", { intent: "add a jellyfish" });
    call(trunk, "a_j", 1, "write", { path: "creatures/a_j.js", content: "export const JELLY = true;\n" });
    const r = call(trunk, "a_j", 2, "submit", { summary: "jelly" });
    expect(r.result).toMatchObject({ status: "validated" });
    trunk.tick();
    trunk.pushOk();
    expect(opsFirst(db, "a_j")).toHaveLength(0);
  });

  it("a second heads-up never rewrites the row of the first (PM2: written once)", () => {
    const { db, trunk } = setup();
    victim(trunk, "a_v", CRAB);
    landCap(trunk, "a_b", 100, 50);
    // The go-around adds an operation after the row was written.
    call(trunk, "a_v", 2, "write", { path: "creatures/a_v.js", content: CRAB_SLOW });
    landCap(trunk, "a_b2", 50, 20);
    const rows = opsFirst(db, "a_v");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.submitted).toBe(0);
    expect(rows[0]!.ops).toHaveLength(1);
    expect(rows[0]!.ops[0]).toMatchObject({ op_seq: 1, content: CRAB });
  });

  it("the row holds the operations as they stood before the heads-up's OP6 drop", () => {
    const { db, trunk } = setup();
    // The victim's write uses a name the breaker takes: the landing drops it (F1 + OP5) and the
    // heads-up is `repair`; the snapshot still holds the dropped write, undropped.
    trunk.openAttempt("a_v", { intent: "add a drifter" });
    call(trunk, "a_v", 1, "list", { path: "creatures/" });
    call(trunk, "a_v", 2, "write", { path: "creatures/d1.js", content: "export const D = 1;\n" });
    trunk.openAttempt("a_b", { intent: "add the same name" });
    call(trunk, "a_b", 1, "list", { path: "creatures/" });
    call(trunk, "a_b", 2, "write", { path: "creatures/d1.js", content: "export const D = 9;\n" });
    const r = call(trunk, "a_b", 3, "submit", { summary: "d1" });
    expect(r.result).toMatchObject({ status: "validated" });
    trunk.tick();
    trunk.pushOk();
    const rows = opsFirst(db, "a_v");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ops).toHaveLength(1);
    expect(rows[0]!.ops[0]).toMatchObject({ op_seq: 1, op: "write", path: "creatures/d1.js", dropped: false });
    // In the attempt's working set the same op carries `dropped` (OP6); the snapshot does not.
    expect(trunk.pool.attempts.get("a_v")!.ops.find((o) => o.op_seq === 1)?.dropped).toBe(true);
  });
});
