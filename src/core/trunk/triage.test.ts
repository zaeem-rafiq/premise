// TR10 (01-core 7.3): the Clef question store. A real attempt reads a whole shared file; another
// change alters one of its entities and lands; the reader's `file` premise is row F4 (triage).
// The question must survive a reopened engine, be re-rowed by V7 on the next operation, time out
// by TR6 and be asked again once after a restart. Expected rows and reasons are the 7.2/7.3 text.

import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Sql } from "../../protocol/ports.ts";
import type { ToolRequest } from "../../protocol/tools.ts";
import { CLEF_TIMEOUT_MS } from "../../protocol/constants.ts";
import { Trunk } from "./registry.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

const SHARED_BEFORE = "export const LIMIT = 100;\nexport const RATE = 2;\n";
const SHARED_AFTER = "export const LIMIT = 1;\nexport const RATE = 2;\n";
const seed = {
  ".premise/policy.json": JSON.stringify({ v: 1, default: "auto", tiers: [] }),
  "shared.js": SHARED_BEFORE,
  "main.js": "export const run = 1;\n",
};

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sql: Sql = {
    exec(query, ...values) {
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
  let now = 1_000;
  let n = 0;
  const opts = { now: () => now };
  let trunk = Trunk.create(sql, seed, opts);
  trunk.pushOk();
  function call(attempt_id: string, tool: ToolRequest["tool"], args: ToolRequest["args"], ack = 0) {
    const response = trunk.tool({ attempt_id, call_id: `call-${++n}`, tool, args, ack });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    return response;
  }
  /** R reads all of shared.js and writes a file that uses none of it; S changes LIMIT and lands. */
  function pendingF4() {
    trunk.openAttempt("R", { intent: "add a reader", agent_kind: "real" });
    call("R", "read", { path: "shared.js" });
    call("R", "write", { path: "reader.js", content: "export const reader = 7;\n" });
    trunk.openAttempt("S", { intent: "lower the limit", agent_kind: "real" });
    call("S", "read", { path: "shared.js", entity: "LIMIT" });
    call("S", "replace", { path: "shared.js", old: "LIMIT = 100", new: "LIMIT = 1" });
    expect(call("S", "submit", { summary: "Lower LIMIT to 1" }).result).toMatchObject({ status: "validated" });
    trunk.tick();
    trunk.pushOk();
  }
  const judgments = () =>
    sql
      .exec(
        "SELECT * FROM judgments WHERE attempt_id = 'R' AND kind = 'file' AND key = 'shared.js' ORDER BY judgment_id",
      )
      .toArray();
  const asks = () => sql.exec("SELECT * FROM triage_asks").toArray();
  const timer = () => sql.exec("SELECT due_at FROM timers WHERE kind = 'triage'").toArray()[0]?.due_at ?? null;
  return {
    sql,
    call,
    pendingF4,
    judgments,
    asks,
    timer,
    get trunk() {
      return trunk;
    },
    reopen() {
      trunk = Trunk.open(sql, opts);
    },
    setNow(value: number) {
      now = value;
    },
  };
}

describe("TR10: the Clef question store", () => {
  it("TR1/TR10: the pending F4 question is stored in the accept transaction with its timer", () => {
    const f = fixture();
    f.pendingF4();
    const [j] = f.judgments();
    expect(j).toMatchObject({ rule: "F4", class: "triage", result: null, reason: "read_not_referenced" });
    const [row] = f.asks();
    expect(row).toMatchObject({
      attempt_id: "R",
      kind: "file",
      key: "shared.js",
      decider_id: "R",
      dispatched_at: null,
    });
    expect(row?.asked_op_seq).toBe(j?.asked_op_seq);
    expect(f.timer()).toBe(1_000 + CLEF_TIMEOUT_MS);
  });

  it("TR10 dispatch: one request carries the S6 question with read_then, is_now and D, once", () => {
    const f = fixture();
    f.pendingF4();
    const { requests } = f.trunk.triageDispatch();
    expect(requests).toHaveLength(1);
    const [req] = requests;
    expect(req?.attempt_id).toBe("R");
    expect(req?.input.intent).toBe("add a reader");
    expect(req?.input.patch).toEqual([{ key: "reader.js#reader", source: "export const reader = 7;\n" }]);
    expect(req?.input.premises["file:shared.js"]).toMatchObject({
      kind: "file",
      key: "shared.js",
      rule: "F4",
      read_then: SHARED_BEFORE,
      is_now: SHARED_AFTER,
      changed: ["shared.js#LIMIT"],
      changed_by_intent: "lower the limit",
    });
    expect(req?.asked["file:shared.js"]?.asked_op_seq).toBe(f.judgments()[0]?.asked_op_seq);
    // Sent: the deadline arms the timer, and a second dispatch has nothing to send.
    expect(f.asks()[0]).toMatchObject({ dispatched_at: 1_000, deadline_at: 1_000 + CLEF_TIMEOUT_MS });
    expect(f.trunk.triageDispatch().requests).toEqual([]);
  });

  it("TR3: an answer at or above T_REPAIR closes the judgment `repair` with its probability and model", () => {
    const f = fixture();
    f.pendingF4();
    const [req] = f.trunk.triageDispatch().requests;
    const asked = req!.asked["file:shared.js"]!;
    f.trunk.triage({
      attempt: "R",
      kind: "file",
      key: "shared.js",
      p: 0.93,
      asked_at_op: asked.asked_op_seq,
      model: "clef",
      ms: 412,
    });
    expect(f.judgments()[0]).toMatchObject({
      result: "repair",
      reason: "triage_depends",
      clef_model: "clef",
      clef_p: 0.93,
      clef_ms: 412,
      clef_error: null,
    });
    expect(f.trunk.pool.attempts.get("R")?.state).toBe("going_around");
    expect(f.asks()).toEqual([]);
    expect(f.timer()).toBeNull();
  });

  it("V7 after a reopen: the next operation re-rows the stored item (F3), and the late answer is `stale` (TR4)", () => {
    const f = fixture();
    f.pendingF4();
    const [req] = f.trunk.triageDispatch().requests;
    const old = req!.asked["file:shared.js"]!.asked_op_seq;
    // A fresh engine over the same store: the classification's maps are gone from memory.
    f.reopen();
    // R now references the changed entity: D ∩ NewRefs is not empty, so row F3 decides (7.2).
    f.call(
      "R",
      "write",
      { path: "reader.js", content: 'import { LIMIT } from "./shared.js";\nexport const reader = LIMIT;\n' },
      1,
    );
    const [j] = f.judgments();
    expect(j).toMatchObject({ rule: "F3", class: "rule", result: "repair", reason: "referenced_entity_changed" });
    expect(f.asks()).toEqual([]);
    f.reopen();
    f.trunk.triage({ attempt: "R", kind: "file", key: "shared.js", p: 0.05, asked_at_op: old, model: "clef" });
    expect(f.judgments()[0]).toMatchObject({ result: "repair", rule: "F3", clef_error: "stale" });
  });

  it("V7: an operation that keeps the question triage asks it again; the older answer is `stale`", () => {
    const f = fixture();
    f.pendingF4();
    const old = f.trunk.triageDispatch().requests[0]!.asked["file:shared.js"]!.asked_op_seq;
    f.reopen();
    f.call("R", "write", { path: "reader.js", content: "export const reader = 8;\n" }, 1);
    const [row] = f.asks();
    expect(row?.dispatched_at).toBeNull();
    expect(Number(row?.asked_op_seq)).toBeGreaterThan(old);
    f.trunk.triage({ attempt: "R", kind: "file", key: "shared.js", p: 0.95, asked_at_op: old });
    expect(f.judgments()[0]).toMatchObject({ result: null, clef_error: "stale" });
    const [again] = f.trunk.triageDispatch().requests;
    expect(again?.input.patch).toEqual([{ key: "reader.js#reader", source: "export const reader = 8;\n" }]);
    f.trunk.triage({
      attempt: "R",
      kind: "file",
      key: "shared.js",
      p: 0.05,
      asked_at_op: again!.asked["file:shared.js"]!.asked_op_seq,
    });
    expect(f.judgments()[0]).toMatchObject({ result: "holds", reason: "reaffirmed", clef_p: 0.05 });
  });

  it("TR6: a question past its deadline is unavailable: confirm, triage_unavailable, error timeout", () => {
    const f = fixture();
    f.pendingF4();
    f.trunk.triageDispatch();
    f.setNow(1_000 + CLEF_TIMEOUT_MS - 1);
    f.trunk.triageDeadline();
    expect(f.judgments()[0]?.result).toBeNull();
    f.setNow(1_000 + CLEF_TIMEOUT_MS);
    f.trunk.triageDeadline();
    expect(f.judgments()[0]).toMatchObject({ result: "confirm", reason: "triage_unavailable", clef_error: "timeout" });
    expect(f.trunk.pool.attempts.get("R")?.premises.get("file|shared.js")?.status).toBe("pending_confirm");
  });

  it("TR6 on start-up: a question sent by an earlier instance is asked again once, then unavailable", () => {
    const f = fixture();
    f.pendingF4();
    f.trunk.triageDispatch();
    f.reopen();
    f.trunk.triageRestart();
    expect(f.asks()[0]).toMatchObject({ tries: 1, dispatched_at: null });
    expect(f.judgments()[0]).toMatchObject({ result: null, tries: 1 });
    expect(f.trunk.triageDispatch().requests).toHaveLength(1);
    f.reopen();
    f.trunk.triageRestart();
    expect(f.judgments()[0]).toMatchObject({ result: "confirm", reason: "triage_unavailable", clef_error: "timeout" });
  });

  it("TR2: an attempt with a pending question is not placed in a batch until the answer", () => {
    const f = fixture();
    f.pendingF4();
    f.call("R", "submit", { summary: "Add a reader" }, 1);
    expect(f.trunk.pool.attempts.get("R")?.state).toBe("submitted");
    f.trunk.tick();
    expect(f.trunk.pool.landings.map((l) => l.attempt_id)).toEqual(["S"]);
    const [req] = f.trunk.triageDispatch().requests;
    f.trunk.triage({
      attempt: "R",
      kind: "file",
      key: "shared.js",
      p: 0.01,
      asked_at_op: req!.asked["file:shared.js"]!.asked_op_seq,
    });
    expect(f.trunk.pool.attempts.get("R")?.state).toBe("validated");
  });
});
