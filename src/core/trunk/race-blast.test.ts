// src/core/trunk/race-blast.test.ts — RC3 as amended (01-core.md 11.4): a race candidate's
// blast radius leaves out the other candidates of its own race, whatever their states —
// choosing it stops them in the same transaction (RC4), so none of them would receive a
// heads-up from it. Every other in-flight attempt is classified as today, and the held card
// and every non-candidate attempt are unchanged.

import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Sql } from "../../protocol/ports.ts";
import type { ToolRequest } from "../../protocol/tools.ts";
import { Trunk } from "./registry.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

const seed = {
  ".premise/policy.json": '{"v":1,"default":"auto"}',
  "world.js": "export const LIMIT = 100;\n",
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
  const trunk = Trunk.create(sql, seed, { features: { held: true }, now: () => now });
  trunk.pushOk();
  function call(attempt_id: string, tool: ToolRequest["tool"], args: ToolRequest["args"]) {
    const response = trunk.tool({ attempt_id, call_id: `call-${++n}`, tool, args, ack: 0 });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    return response;
  }
  // Three candidates of one intent's race, each writing the same entity — one another's
  // repair if they were ordinary attempts (E1).
  const candidate = (id: string, value: string) => {
    trunk.openAttempt(id, { intent: "Change the limit", intent_id: "i_race", race: true, agent_kind: "real" });
    call(id, "read", { path: "world.js" });
    call(id, "replace", { path: "world.js", old: "100", new: value });
    expect(call(id, "submit", { summary: `Set LIMIT to ${value}` }).result).toMatchObject({ status: "held" });
  };
  const raceCard = () => trunk.pool.cards.find((c) => c.open && c.kind === "race")!;
  return { trunk, call, candidate, raceCard };
}

const EMPTY = { repair: [], confirm: [], triage: [], right_of_way: [] };

describe("a race candidate's blast radius leaves out its siblings (RC3 amended)", () => {
  it("lists no other candidate of the same race, whatever their states", () => {
    const { candidate, raceCard } = fixture();
    candidate("A", "1");
    candidate("B", "2");
    candidate("C", "3");
    const blast = raceCard().body.blast_radius;
    for (const id of ["A", "B", "C"]) expect(blast[id]).toEqual(EMPTY);
  });

  it("keeps every other in-flight attempt classified as today", () => {
    const { trunk, call, candidate, raceCard } = fixture();
    candidate("A", "1");
    candidate("B", "2");
    candidate("C", "3");
    // D is not of the race but relies on the entity every candidate writes (E2).
    trunk.openAttempt("D", { intent: "Add a crab", agent_kind: "real" });
    call("D", "write", {
      path: "crab.js",
      content: 'import { LIMIT } from "./world.js";\nexport const crab = LIMIT;\n',
    });
    // CD2: a batch-free tick recomputes each open card's blast radius as it stands.
    trunk.tick();
    const blast = raceCard().body.blast_radius;
    for (const id of ["A", "B", "C"]) expect(blast[id]).toEqual({ ...EMPTY, repair: ["D"] });
  });
});
