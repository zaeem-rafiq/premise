import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Sql } from "../../protocol/ports.ts";
import type { ToolRequest } from "../../protocol/tools.ts";
import { persist, releaseWorkingState, Trunk } from "./registry.ts";
import { metaGet } from "./schema.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const queries: string[] = [];
  const sql: Sql = {
    exec(query, ...values) {
      queries.push(query);
      const rows = db.prepare(query).all(...values) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
    transaction(run) {
      db.exec("BEGIN");
      try {
        const result = run();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const trunk = Trunk.create(
    sql,
    { ".premise/policy.json": '{"v":1,"default":"auto"}', "GUIDE.md": "# Pool\n" },
    { now: () => 1_000 },
  );
  trunk.pushOk();
  let n = 0;
  function call(id: string, tool: ToolRequest["tool"], args: ToolRequest["args"]) {
    const result = trunk.tool({ attempt_id: id, call_id: `call-${++n}`, tool, args, ack: 0 });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return result;
  }
  function land(id: string, content: string) {
    trunk.openAttempt(id, { intent: `Add ${id}` });
    call(id, "write", { path: `creatures/${id}.js`, content });
    expect(call(id, "submit", { summary: `Add ${id}` }).result).toMatchObject({ status: "validated" });
    trunk.tick();
    trunk.pushOk();
    expect(trunk.pool.attempts.get(id)?.state).toBe("landed");
  }
  return { db, sql, trunk, queries, call, land };
}

describe("retained Trunk persistence", () => {
  it("does not read historical landing fields, judgments or metadata when nothing changed", () => {
    const { sql, trunk, queries, land } = fixture();
    land("one", "export const energy = 1;\n");
    land("two", "export const energy = 2;\n");
    const pool = trunk.pool;
    const landed = pool.landings[0]!;
    const acceptedAt = Object.getOwnPropertyDescriptor(landed, "accepted_at")!;
    let landingReads = 0;
    Object.defineProperty(landed, "accepted_at", {
      ...acceptedAt,
      get: () => {
        landingReads += 1;
        return acceptedAt.get!();
      },
    });
    // A clean save must not enumerate these growing collections. They remain readable by
    // key, as the engine needs, and the tests never replace a decision with a mock result.
    Object.defineProperty(pool.meta, Symbol.iterator, {
      value: () => {
        throw new Error("scanned meta");
      },
    });
    Object.defineProperty(pool.savedMeta, "keys", {
      value: () => {
        throw new Error("scanned saved meta");
      },
    });
    Object.defineProperty(pool.judgments, "values", {
      value: () => {
        throw new Error("scanned judgments");
      },
    });
    queries.length = 0;
    sql.transaction(() => persist(pool));
    expect(landingReads).toBe(0);
    expect(queries).toEqual([]);
  });

  it("persists push and undo fields changed directly on an old landing", () => {
    const { sql, trunk, land } = fixture();
    land("one", "export const energy = 1;\n");
    const first = trunk.pool.landings[0]!;
    first.pushed_at = 2_000;
    first.undone_by = 2;
    trunk.tick();
    const reopened = Trunk.open(sql);
    expect(reopened.pool.landings[0]).toMatchObject({ seq: 1, pushed_at: 2_000, undone_by: 2 });
  });

  it("observes landing array replacement, splice and element replacement", () => {
    const { sql, trunk, land } = fixture();
    land("one", "export const energy = 1;\n");
    const first = trunk.pool.landings[0]!;
    trunk.pool.landings = [{ ...first, accepted_at: 2_000 }];
    trunk.tick();
    expect(Trunk.open(sql).pool.landings[0]!.accepted_at).toBe(2_000);
    trunk.pool.landings.splice(0, 0, { ...first, seq: 2, change_id: "change-two", accepted_at: 3_000 });
    trunk.tick();
    expect(Trunk.open(sql).pool.landings.map((l) => [l.seq, l.accepted_at])).toEqual([
      [1, 2_000],
      [2, 3_000],
    ]);
    trunk.pool.landings[1] = { ...first, accepted_at: 4_000 };
    trunk.tick();
    expect(Trunk.open(sql).pool.landings[0]!.accepted_at).toBe(4_000);
  });

  it("observes metadata deletion and whole-map replacement without losing saved values", () => {
    const { sql, trunk } = fixture();
    trunk.pool.meta.set("scale", "one");
    trunk.tick();
    trunk.pool.meta = new Map([...trunk.pool.meta, ["scale", "two"], ["extra", "three"]]);
    trunk.tick();
    expect(metaGet(sql, "scale")).toBe("two");
    expect(metaGet(sql, "extra")).toBe("three");
    const next = new Map(trunk.pool.meta);
    next.delete("scale");
    trunk.pool.meta = next;
    trunk.tick();
    expect(metaGet(sql, "scale")).toBeNull();
    expect(trunk.pool.savedMeta.has("scale")).toBe(false);
    expect(trunk.pool.savedMeta.get("extra")).toBe("three");
  });

  it("persists newly inserted judgments and later dirty flags after a map replacement", () => {
    const { sql, trunk } = fixture();
    const attempt = trunk.openAttempt("one", { intent: "Check a premise" });
    const judgment = trunk.pool.newJudgment(attempt, {
      kind: "file",
      key: "GUIDE.md",
      old_hash: "before",
      new_hash: "after",
      cause: "landing",
      cause_seq: 1,
      rule: "F2",
      klass: "rule",
      result: "holds",
      reason: "unchanged",
    });
    trunk.tick();
    expect(Trunk.open(sql).pool.judgments.get(judgment.judgment_id)!.reason).toBe("unchanged");
    trunk.pool.judgments = new Map(trunk.pool.judgments);
    judgment.reason = "checked again";
    judgment.dirty = true;
    trunk.tick();
    expect(Trunk.open(sql).pool.judgments.get(judgment.judgment_id)!.reason).toBe("checked again");
    trunk.pool.judgments.set(judgment.judgment_id, { ...judgment, reason: "replacement", dirty: true });
    judgment.reason = "detached record";
    judgment.dirty = true;
    trunk.tick();
    expect(Trunk.open(sql).pool.judgments.get(judgment.judgment_id)!.reason).toBe("replacement");
  });

  it("loads first-operation snapshots with one query and preserves revision matching", () => {
    const { sql, trunk, queries } = fixture();
    for (const id of ["one", "two", "three"]) trunk.openAttempt(id, { intent: `Read with ${id}` });
    // PM2 fixtures represent the first heads-up of revision 1. Attempt three has since
    // reopened as revision 2; its previous snapshot must not mark this revision complete.
    for (const id of ["one", "two", "three"]) {
      sql.exec("INSERT INTO ops_first (attempt_id, revision, ops, submitted) VALUES (?, 1, '[]', 0)", id);
    }
    sql.exec("UPDATE attempts SET revision = 2 WHERE attempt_id = 'three'");
    queries.length = 0;
    const reopened = Trunk.open(sql);
    expect(queries.filter((q) => q.includes("FROM ops_first"))).toHaveLength(1);
    expect(reopened.pool.attempts.get("one")!.opsFirstDone).toBe(true);
    expect(reopened.pool.attempts.get("two")!.opsFirstDone).toBe(true);
    expect(reopened.pool.attempts.get("three")!.opsFirstDone).toBe(false);
  });

  it("releases call scratch data and reconstructs historical maps after later landings", () => {
    const { sql, trunk, land } = fixture();
    land("one", "export const energy = 1;\n");
    const first = trunk.pool.landings[0]!;
    const originalBefore = first.before;
    const originalAfter = first.after;
    expect(trunk.pool.objects.size).toBeGreaterThan(0);
    releaseWorkingState(trunk.pool);
    expect(trunk.pool.objects.size).toBe(0);
    expect(trunk.pool.analyses.size).toBe(0);
    land("two", "export const energy = 2;\n");
    releaseWorkingState(trunk.pool);
    expect(first.before).toEqual(originalBefore);
    expect(first.after).toEqual(originalAfter);
    // A historical read must not retain another full tree between calls.
    expect(first.after).not.toBe(first.after);
    const reopened = Trunk.open(sql);
    expect(reopened.pool.landings[0]!.before).toEqual(first.before);
    expect(reopened.pool.landings[0]!.after).toEqual(first.after);
  });

  it("restores persisted premise order only for attempts changed since the last release", () => {
    const { sql, trunk, land, call } = fixture();
    land("one", "export const energy = 1;\n");
    land("two", "export const energy = 2;\n");
    releaseWorkingState(trunk.pool);
    const oldPremises = trunk.pool.attempts.get("one")!.premises;
    trunk.openAttempt("probe", { intent: "Read files in reverse key order" });
    call("probe", "read", { path: "creatures/two.js" });
    call("probe", "read", { path: "GUIDE.md" });
    call("probe", "read", { path: "creatures/one.js", entity: "energy" });
    const attempt = trunk.pool.attempts.get("probe")!;
    releaseWorkingState(trunk.pool);
    expect([...attempt.premises.keys()]).toEqual([
      "entity|creatures/one.js#energy",
      "file|GUIDE.md",
      "file|creatures/two.js",
    ]);
    expect([...attempt.premises]).toEqual([...Trunk.open(sql).pool.attempts.get("probe")!.premises]);
    expect(trunk.pool.attempts.get("one")!.premises).toBe(oldPremises);
  });

  it("restores call-local counters and attempt fields that a reopen derives from stored rows", () => {
    const { sql, trunk, call } = fixture();
    trunk.openAttempt("first", { intent_id: "shared", intent: "Shared intent", requester: "Owner" });
    trunk.openAttempt("second", { intent_id: "shared", intent: "Ignored duplicate text", requester: "Agent" });
    const attempt = trunk.pool.attempts.get("second")!;
    attempt.op_mark = 7;
    // Editing clears the live approval fields, while the existing reconstruction path
    // reads the retained approval metadata. A cached call must use that same path.
    trunk.pool.meta.set("approved:second", JSON.stringify({ at: 1_500, option: "land", risk: null }));
    trunk.pool.now = () => 2_000;
    call("second", "write", { path: "new.txt", content: "new\n" });
    call("second", "submit", { summary: "Add text" });
    expect(trunk.pool.order).toBe(1);
    releaseWorkingState(trunk.pool);
    expect(trunk.pool.order).toBe(0);
    expect(attempt).toMatchObject({
      intentText: "Shared intent",
      requester: "Owner",
      updated_at: 2_000,
      op_mark: null,
      validated_at: 1,
      approved_at: 1_500,
      approved_option: "land",
      policy_risk: null,
    });
    const reopened = Trunk.open(sql).pool.attempts.get("second")!;
    expect(attempt.updated_at).toBe(reopened.updated_at);
    expect(attempt.intentText).toBe(reopened.intentText);
    expect(attempt.requester).toBe(reopened.requester);
    expect(attempt.approved_at).toBe(reopened.approved_at);
    expect(attempt.approved_option).toBe(reopened.approved_option);
  });
});
