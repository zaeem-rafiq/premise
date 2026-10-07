// 8.2 / EV4: a batch item names the first landing that changed its key.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolRequest } from "../../src/protocol/tools.ts";
import type { Note } from "../../src/protocol/note.ts";
import { Trunk } from "../../src/core/trunk/registry.ts";
import { keyHash } from "../../src/core/trunk/sets.ts";
import { sqlOver } from "./driver.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

const ENERGY = "world/energy.js#ENERGY_MAX";
const CREATURE =
  'import { ENERGY_MAX } from "../world/energy.js";\n' + "export function spawn() { return { energy: ENERGY_MAX }; }\n";

function fixture(maxBatch = 3, extraFiles: Record<string, string> = {}) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sql = sqlOver(db);
  const trunk = Trunk.create(
    sql,
    {
      ".premise/policy.json": '{"v":1,"default":"auto"}',
      "world/energy.js": "export const ENERGY_MAX = 100;\n",
      ...extraFiles,
    },
    { now: () => 1_000, constants: { MAX_BATCH: maxBatch } },
  );
  trunk.pushOk();
  let n = 0;
  function call(attempt_id: string, tool: ToolRequest["tool"], args: ToolRequest["args"]) {
    const response = trunk.tool({
      attempt_id,
      call_id: `call-${++n}`,
      tool,
      args,
      ack: trunk.pool.attempts.get(attempt_id)!.heads.length,
    });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    return response;
  }
  function submit(id: string) {
    expect(call(id, "submit", { summary: id }).result).toMatchObject({ status: "validated" });
  }
  function unrelated(id: string) {
    trunk.openAttempt(id, { intent: "Add an independent creature" });
    call(id, "write", { path: `creatures/${id}.js`, content: "export const energy = 5;\n" });
    submit(id);
  }
  return { trunk, sql, call, submit, unrelated };
}

describe("batch cause_seq", () => {
  it.each([
    { kind: "entity" as const, key: ENERGY, rule: "E2" },
    { kind: "query" as const, key: `refs:${ENERGY}`, rule: "QR1" },
  ])("names landing 3 for $rule when landings 1 and 2 leave the key unchanged", ({ kind, key, rule }) => {
    const { trunk, sql, call, submit, unrelated } = fixture();
    trunk.openAttempt("observer", { intent: "Work with the energy cap" });
    call("observer", "read", { path: "world/energy.js", entity: "ENERGY_MAX" });
    if (kind === "entity") {
      call("observer", "write", { path: "creatures/observer.js", content: CREATURE });
    } else {
      call("observer", "replace", { path: "world/energy.js", old: "100", new: "1" });
    }
    unrelated("a_first");
    unrelated("b_second");
    trunk.openAttempt("c_third", { intent: "Change the observed key" });
    call("c_third", "read", { path: "world/energy.js", entity: "ENERGY_MAX" });
    if (kind === "entity") {
      call("c_third", "replace", { path: "world/energy.js", old: "100", new: "50" });
    } else {
      call("c_third", "write", { path: "creatures/third.js", content: CREATURE });
    }
    submit("c_third");
    const pre = keyHash(trunk.pool.files, kind, key).hash;
    trunk.tick();
    expect(trunk.out.accepted).toEqual(["a_first", "b_second", "c_third"]);
    const batch = trunk.pool.landings;
    expect(batch.map((l) => keyHash(l.after, kind, key).hash === pre)).toEqual([true, true, false]);
    const judgment = trunk.out.judgments.find((j) => j.attempt_id === "observer" && j.key === key);
    expect(judgment).toMatchObject({ rule, result: "repair" });
    const head = trunk.pool.attempts.get("observer")!.heads.at(-1)!;
    expect(head.body.cause.seqs).toEqual([1, 2, 3]);
    expect.soft(judgment?.cause_seq).toBe(3);
    expect.soft(head.body.items.find((item) => item.premise.key === key)?.cause_seq).toBe(3);
    expect
      .soft(sql.exec("SELECT cause_seq FROM judgments WHERE attempt_id = ? AND key = ?", "observer", key).toArray())
      .toEqual([{ cause_seq: 3 }]);
    const event = sql
      .exec("SELECT body FROM events_out")
      .toArray()
      .map((row) => JSON.parse(String(row.body)) as Record<string, unknown>)
      .find((event) => event.type === "premise.judged" && event.attempt_id === "observer" && event.key === key);
    expect.soft(event?.cause_seq).toBe(3);
    // The heads-up event names the cause per key too, also where `items` is null (EV6).
    const sent = sql
      .exec("SELECT body FROM events_out")
      .toArray()
      .map((row) => JSON.parse(String(row.body)) as { type: string; attempt_id?: string; keys?: unknown[] })
      .find((event) => event.type === "headsup.sent" && event.attempt_id === "observer");
    expect.soft(sent?.keys).toContainEqual(expect.objectContaining({ key, rule, cause_seq: 3 }));
    trunk.pushOk();
    expect(
      call("observer", "submit", {
        summary: "Keep the adapted change",
        acknowledge: [head.hn],
        statement: "I checked the new cap and its referrers; this change still applies.",
      }).result,
    ).toMatchObject({ status: "validated" });
    trunk.tick();
    expect(trunk.out.accepted).toEqual(["observer"]);
    const note = JSON.parse(trunk.pool.landings.at(-1)!.note) as Note;
    expect(note.judgments.find((j) => j.key === key)).toMatchObject({ rule, cause_seq: 3 });
  });

  it("attributes a candidate's F2 holds judgment to the earlier writer, including in its note", () => {
    const { trunk, call, submit, unrelated } = fixture(4);
    trunk.openAttempt("d_observer", { intent: "Read energy and add an independent creature" });
    call("d_observer", "read", { path: "world/energy.js" });
    call("d_observer", "write", { path: "creatures/observer.js", content: "export const energy = 2;\n" });
    unrelated("a_first");
    unrelated("b_second");
    trunk.openAttempt("c_third", { intent: "Document the energy cap" });
    call("c_third", "read", { path: "world/energy.js" });
    call("c_third", "write", {
      path: "world/energy.js",
      content: "// Maximum energy.\nexport const ENERGY_MAX = 100;\n",
    });
    submit("c_third");
    submit("d_observer");
    trunk.tick();
    expect(trunk.out.accepted).toEqual(["a_first", "b_second", "c_third", "d_observer"]);
    expect(trunk.out.judgments.find((j) => j.attempt_id === "d_observer" && j.rule === "F2")).toMatchObject({
      cause_seq: 3,
      result: "holds",
    });
    const note = JSON.parse(trunk.pool.landings[3]!.note) as Note;
    expect(note.judgments.find((j) => j.rule === "F2")).toMatchObject({ cause_seq: 3 });
  });

  it.each([
    { kind: "listing" as const, key: "world/", tool: "list" as const, args: { path: "world/" }, rule: "L3" },
    { kind: "query" as const, key: "text:/:TOKEN", tool: "search" as const, args: { query: "TOKEN" }, rule: "X0" },
    {
      kind: "query" as const,
      key: "outline:world/energy.js",
      tool: "outline" as const,
      args: { path: "world/energy.js" },
      rule: "QO2",
    },
  ])("attributes the $key judgment to the third prefix", ({ kind, key, tool, args, rule }) => {
    const { trunk, call, submit, unrelated } = fixture();
    // Two observers of the same key exercise shared attribution across attempts.
    for (const id of ["observer", "other"]) {
      trunk.openAttempt(id, { intent: "Inspect the pool" });
      call(id, tool, args);
    }
    unrelated("a_first");
    unrelated("b_second");
    trunk.openAttempt("c_third", { intent: "Add TOKEN" });
    if (key.startsWith("outline:")) {
      call("c_third", "read", { path: "world/energy.js" });
      call("c_third", "write", {
        path: "world/energy.js",
        content: "export const ENERGY_MAX = 100;\nexport const TOKEN = 1;\n",
      });
    } else {
      call("c_third", "write", { path: "world/new.js", content: "export const TOKEN = 1;\n" });
    }
    submit("c_third");
    trunk.tick();
    expect(trunk.out.accepted).toEqual(["a_first", "b_second", "c_third"]);
    for (const id of ["observer", "other"]) {
      expect(trunk.out.judgments.find((j) => j.attempt_id === id && j.kind === kind && j.key === key)).toMatchObject({
        rule,
        cause_seq: 3,
      });
    }
  });

  it("leaves an unchanged QR4 query without a key-changing cause", () => {
    const { trunk, call, submit, unrelated } = fixture();
    trunk.openAttempt("observer", { intent: "Rescale energy" });
    call("observer", "read", { path: "world/energy.js", entity: "ENERGY_MAX" });
    call("observer", "replace", { path: "world/energy.js", old: "100", new: "1" });
    unrelated("a_first");
    unrelated("b_second");
    trunk.openAttempt("c_third", { intent: "Read energy but add an independent creature" });
    call("c_third", "read", { path: "world/energy.js", entity: "ENERGY_MAX" });
    call("c_third", "write", { path: "creatures/third.js", content: "export const energy = 5;\n" });
    submit("c_third");
    trunk.tick();
    expect(trunk.out.accepted).toEqual(["a_first", "b_second", "c_third"]);
    const query = trunk.out.judgments.find((j) => j.attempt_id === "observer" && j.rule === "QR4")!;
    expect(query).toBeDefined();
    expect(query.old_hash).toBe(query.new_hash);
    expect(query.cause_seq).toBeNull();
    const head = trunk.pool.attempts.get("observer")!.heads.at(-1)!;
    expect(head.body.cause.seqs).toEqual([1, 2, 3]);
    expect(head.body.items.find((item) => item.rule === "QR4")?.cause_seq).toBeNull();
  });

  it.each([false, true])(
    "uses the first changed refs hash even when a later landing adds referrers (module-only first change: %s)",
    (moduleOnly) => {
      const { trunk, call, submit, unrelated } = fixture(3, moduleOnly ? { "creatures/existing.js": CREATURE } : {});
      trunk.openAttempt("observer", { intent: "Rescale energy" });
      call("observer", "read", { path: "world/energy.js", entity: "ENERGY_MAX" });
      call("observer", "replace", { path: "world/energy.js", old: "100", new: "1" });
      unrelated("a_first");
      for (const id of ["b_second", "c_third"]) {
        trunk.openAttempt(id, { intent: "Add creature behavior" });
        call(id, "read", { path: "world/energy.js", entity: "ENERGY_MAX" });
        const existing = moduleOnly && id === "b_second";
        if (existing) call(id, "read", { path: "creatures/existing.js" });
        call(id, "write", {
          path: existing ? "creatures/existing.js" : `creatures/${id}.js`,
          content: CREATURE + (existing ? "export const size = 2;\n" : ""),
        });
        submit(id);
      }
      const pre = keyHash(trunk.pool.files, "query", `refs:${ENERGY}`).hash;
      trunk.tick();
      expect(trunk.out.accepted).toEqual(["a_first", "b_second", "c_third"]);
      expect(trunk.pool.landings.map((l) => keyHash(l.after, "query", `refs:${ENERGY}`).hash === pre)).toEqual([
        true,
        false,
        false,
      ]);
      expect(trunk.out.judgments.find((j) => j.attempt_id === "observer" && j.rule === "QR1")).toMatchObject({
        cause_seq: 2,
      });
      const head = trunk.pool.attempts.get("observer")!.heads.at(-1)!;
      expect(head.body.items.find((item) => item.rule === "QR1")?.cause_seq).toBe(2);
      expect(head.body.cause.seqs).toEqual([1, 2, 3]);
    },
  );
});
