// test/cases/right-of-way.test.ts — RW1, RW3 and RW4 at the engine level (01-core 11.2):
// the mark is a millisecond timestamp taken from the injected clock, its `right_of_way` timer
// row is durable (AL1), the timer entry lapses only the grant its row was armed for, and a
// tick sweeps a stale mark itself so a lost timer can never block RW3's skip for ever.
// Expected behavior comes from the specification (BP1): grant at the second sent-back, skip
// while live, nothing skipped after RIGHT_OF_WAY_MS, earlier mark wins between two holders.

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { RIGHT_OF_WAY_MS } from "../../src/protocol/constants.ts";
import type { Sql } from "../../src/protocol/ports.ts";
import type { ToolRequest, ToolResponse } from "../../src/protocol/tools.ts";
import { Trunk } from "../../src/core/trunk/registry.ts";
import { ScriptedTriage } from "../../src/swarm/scripted-triage.ts";

/** `node:sqlite` speaks the `Sql` port (same adapter shape the case driver uses). */
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

const SNAIL =
  'import { ENERGY_MAX } from "../world/energy.js";\n\n' +
  "export function creep() {\n  return { x: 4, y: 190, en: ENERGY_MAX };\n}\n";

function call(trunk: Trunk, attempt: string, n: number, tool: string, args: object, ack?: number): ToolResponse {
  return trunk.tool({
    attempt_id: attempt,
    call_id: `${attempt}:${n}`,
    tool: tool as ToolRequest["tool"],
    args,
    // The driver's rule: `ack` defaults to the attempt's own heads-up count.
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
}

/** The victim: reads the entity, writes a new file that imports it — an edit premise on
 * `ENERGY_MAX` and a write that survives every head change (mirrors vector C24). */
function victim(trunk: Trunk, a: string, file: string, content: string): void {
  trunk.openAttempt(a, { intent: `${a} adds a creature` });
  call(trunk, a, 1, "read", { path: "world/energy.js", entity: "ENERGY_MAX" });
  call(trunk, a, 2, "write", { path: file, content });
}

/** The victim's resubmit after a go-around: every heads-up acknowledged and delivered. */
function resubmit(trunk: Trunk, a: string, n: number): ToolResponse {
  const hns = trunk.pool.attempts.get(a)!.heads.map((h) => h.hn);
  return call(trunk, a, n, "submit", { summary: "creature", acknowledge: hns });
}

function timerDueAt(db: DatabaseSync, kind: string, key: string): number | null {
  const rows = db.prepare("SELECT due_at FROM timers WHERE kind = ? AND key = ?").all(kind, key) as Array<{
    due_at: number;
  }>;
  return rows.length === 0 ? null : Number(rows[0]!.due_at);
}

/** The pool plus the seed batch pushed (PL1: batch 0 is on Artifacts before attempts work —
 * the same `push_ok` the case driver replays after `Trunk.create`). */
function setup(nowRef: { v: number }): { db: DatabaseSync; sql: Sql; trunk: Trunk } {
  const db = new DatabaseSync(":memory:");
  const sql = sqlOver(db);
  const trunk = Trunk.create(sql, FILES, {
    now: () => nowRef.v,
    syncTriage: ScriptedTriage,
    features: { held: true },
  });
  trunk.pushOk();
  return { db, sql, trunk };
}

describe("right of way (RW1-RW5, 11.2)", () => {
  it(
    "grants at the second sent-back as a ms mark plus a durable timer, blocks the next " +
      "candidate while live (RW3), and the timer's entry lapses it so the waiting landing goes",
    () => {
      const nowRef = { v: 1_000 };
      const { db, sql, trunk } = setup(nowRef);

      victim(trunk, "a", "creatures/crab.js", CRAB);
      landCap(trunk, "b-90", 100, 90);
      const r1 = call(trunk, "a", 3, "submit", { summary: "a crab" });
      expect(r1.result).toMatchObject({ status: "validated" });
      trunk.tick();
      expect(trunk.out.skipped["a"]).toBe("not_disjoint");
      trunk.pushOk();
      expect(trunk.state("a")).toBe("going_around");

      landCap(trunk, "b-80", 90, 80);
      expect(resubmit(trunk, "a", 4).result).toMatchObject({ status: "validated" });
      trunk.tick();
      trunk.pushOk();
      expect(trunk.state("a")).toBe("going_around");
      expect(trunk.pool.attempts.get("a")!.go_arounds).toBe(2);

      // RW1: the mark is the grant time in ms and the `right_of_way` row is armed at +120 s.
      const grant = trunk.pool.attempts.get("a")!.right_of_way_at;
      expect(grant).toBe(nowRef.v);
      expect(timerDueAt(db, "right_of_way", "a")).toBe(grant! + RIGHT_OF_WAY_MS);

      // RW3: a later candidate whose landing would send the holder around again is skipped.
      landCap(trunk, "c-70", 80, 70);
      trunk.tick();
      expect(trunk.out.skipped["c-70"]).toBe("right_of_way");
      expect(trunk.out.waiting).toBe(1); // 14.6: changes waiting behind another change

      // A stale timer row (not this grant) changes nothing.
      trunk.expireRightOfWay({ attempt_id: "a", due_at: grant! + RIGHT_OF_WAY_MS + 1 });
      expect(trunk.pool.attempts.get("a")!.right_of_way_at).toBe(grant);

      // RW1: the grant's own timer fires after the lapse — the entry clears mark and row.
      nowRef.v += RIGHT_OF_WAY_MS + 1;
      trunk.expireRightOfWay({ attempt_id: "a", due_at: grant! + RIGHT_OF_WAY_MS });
      expect(trunk.pool.attempts.get("a")!.right_of_way_at).toBeNull();
      expect(timerDueAt(db, "right_of_way", "a")).toBeNull();

      // The lapse runs the tick itself (RW1's "next tick" — the timer entry's own pass), so the
      // waiting candidate lands in the same call. The repair joins `a`'s still-undelivered
      // go-around (T10), which is why `go_arounds` stays 2.
      expect(trunk.out.accepted).toEqual(["c-70"]);
      expect(trunk.pool.attempts.get("a")!.go_arounds).toBe(2);
      db.close();
    },
  );

  it("lapses a mark whose timer row was lost — the tick's own sweep clears it", () => {
    const nowRef = { v: 5_000 };
    const { db, sql, trunk } = setup(nowRef);

    victim(trunk, "a", "creatures/crab.js", CRAB);
    landCap(trunk, "b-90", 100, 90);
    call(trunk, "a", 3, "submit", { summary: "a crab" });
    trunk.tick();
    trunk.pushOk();
    landCap(trunk, "b-80", 90, 80);
    resubmit(trunk, "a", 4);
    trunk.tick();
    trunk.pushOk();
    const grant = trunk.pool.attempts.get("a")!.right_of_way_at;
    expect(grant).not.toBeNull();

    // The row is lost (a deploy, a dropped write): the mark alone cannot hold the skip open
    // past RIGHT_OF_WAY_MS — the tick sweeps before it orders (RW1).
    db.exec("DELETE FROM timers WHERE kind = 'right_of_way'");
    landCap(trunk, "c-70", 80, 70);
    trunk.tick();
    expect(trunk.out.skipped["c-70"]).toBe("right_of_way");
    nowRef.v += RIGHT_OF_WAY_MS + 1;
    trunk.tick();
    expect(trunk.pool.attempts.get("a")!.right_of_way_at).toBeNull();
    expect(trunk.out.accepted).toEqual(["c-70"]);
    db.close();
  });

  it("RW4: between two holders the earlier grant wins, even against an earlier validated_at", () => {
    const nowRef = { v: 9_000 };
    const { db, sql, trunk } = setup(nowRef);

    victim(trunk, "a", "creatures/crab.js", CRAB);
    victim(trunk, "a2", "creatures/snail.js", SNAIL);
    landCap(trunk, "b-90", 100, 90);
    call(trunk, "a", 3, "submit", { summary: "crab" });
    call(trunk, "a2", 3, "submit", { summary: "snail" });
    trunk.tick();
    trunk.pushOk();
    landCap(trunk, "b-80", 90, 80);
    resubmit(trunk, "a", 4);
    resubmit(trunk, "a2", 4);
    trunk.tick();
    trunk.pushOk();

    const markA = trunk.pool.attempts.get("a")!.right_of_way_at;
    const markA2 = trunk.pool.attempts.get("a2")!.right_of_way_at;
    expect(markA).not.toBeNull();
    // Grant order survives a shared millisecond: `a2` was granted after `a` in the same pass.
    expect(markA2).toBe(markA! + 1);

    // `a2` validates first — RW4 still lands `a` first inside the same batch.
    resubmit(trunk, "a2", 5);
    resubmit(trunk, "a", 5);
    nowRef.v += 1;
    trunk.tick();
    expect(trunk.out.landings.map((l) => (l as { attempt?: string }).attempt)).toEqual(["a", "a2"]);
    trunk.pushOk();
    // RW1: landing ended both grants — marks and timer rows are gone.
    expect(trunk.pool.attempts.get("a")!.right_of_way_at).toBeNull();
    expect(trunk.pool.attempts.get("a2")!.right_of_way_at).toBeNull();
    expect(db.prepare("SELECT * FROM timers WHERE kind = 'right_of_way'").all()).toHaveLength(0);
    db.close();
  });

  it(
    "the mark and its timer row survive a reopen of the pool (durable across restart), " +
      "and stopping clears them (RW1)",
    () => {
      const nowRef = { v: 2_000 };
      const { db, sql, trunk } = setup(nowRef);

      victim(trunk, "a", "creatures/crab.js", CRAB);
      landCap(trunk, "b-90", 100, 90);
      call(trunk, "a", 3, "submit", { summary: "a crab" });
      trunk.tick();
      trunk.pushOk();
      landCap(trunk, "b-80", 90, 80);
      resubmit(trunk, "a", 4);
      trunk.tick();
      trunk.pushOk();
      const grant = trunk.pool.attempts.get("a")!.right_of_way_at;
      expect(grant).not.toBeNull();

      // Re-open the engine on the same store — the restart path keeps mark and timer.
      const after = Trunk.open(sql, { now: () => nowRef.v, syncTriage: ScriptedTriage });
      expect(after.pool.attempts.get("a")!.right_of_way_at).toBe(grant);
      expect(timerDueAt(db, "right_of_way", "a")).toBe(grant! + RIGHT_OF_WAY_MS);

      // RW1: stopping ends the grant — mark and timer row both go.
      const stop = after.stop({ attempt_id: "a", reason: "cancelled" });
      expect(stop).toMatchObject({ ok: true });
      expect(after.pool.attempts.get("a")!.right_of_way_at).toBeNull();
      expect(timerDueAt(db, "right_of_way", "a")).toBeNull();
      db.close();
    },
  );
});
