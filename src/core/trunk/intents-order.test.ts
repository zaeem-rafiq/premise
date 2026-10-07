import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Sql } from "../../protocol/ports.ts";
import type { ToolRequest } from "../../protocol/tools.ts";
import { openCard, parked } from "./intents.ts";
import { Trunk } from "./registry.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture(reopen: boolean, maxBatch = 64) {
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
  const options = { features: { held: true }, constants: { MAX_BATCH: maxBatch }, now: () => 1_000 };
  const retained = Trunk.create(
    sql,
    {
      ".premise/policy.json": JSON.stringify({
        v: 1,
        default: "auto",
        tiers: [{ paths: ["world.js"], tier: "held" }],
      }),
      "world.js": "export const LIMIT = 100;\n",
    },
    options,
  );
  retained.pushOk();
  const engine = () => (reopen ? Trunk.open(sql, options) : retained);
  let n = 0;
  function call(attempt_id: string, tool: ToolRequest["tool"], args: ToolRequest["args"]) {
    const response = engine().tool({ attempt_id, call_id: `call-${++n}`, tool, args, ack: 0 });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    return response;
  }
  function events() {
    return sql
      .exec("SELECT body FROM events_out ORDER BY n")
      .toArray()
      .map((row) => JSON.parse(String(row.body)) as Record<string, unknown>);
  }
  return { sql, engine, call, events };
}

// These ASCII ids have the same byte order in SQLite and JS comparisons. Their expected
// order intentionally differs from locale collation, and from the opening order below.
const reverseIds = ["z-reader", "_reader", "A-reader"];
const orderedIds = ["A-reader", "_reader", "z-reader"];

describe("attempt order survives retaining or reopening a Pool", () => {
  it("keeps held-card blast radius and classification event order in attempt_id order", () => {
    const outcomes = [false, true].map((reopen) => {
      const { engine, call, events } = fixture(reopen);
      for (const [i, id] of reverseIds.entries()) {
        engine().openAttempt(id, { intent: `Add dependent ${i}` });
        call(id, "write", {
          path: `creatures/reader-${i}.js`,
          content: 'import { LIMIT } from "../world.js";\nexport const creature = LIMIT;\n',
        });
      }
      engine().openAttempt("S", { intent: "Lower the shared limit" });
      call("S", "read", { path: "world.js" });
      call("S", "replace", { path: "world.js", old: "100", new: "1" });
      expect(call("S", "submit", { summary: "Lower LIMIT" }).result).toMatchObject({ status: "held" });
      const card = engine().pool.cards.find((candidate) => candidate.open && candidate.kind === "held")!;
      expect(card.body.blast_radius.S).toEqual({ repair: orderedIds, confirm: [], triage: [], right_of_way: [] });
      const radius = card.body.blast_radius.S;
      engine().owner({ action: "land", attempt: "S" });
      const beforeTick = events().length;
      engine().tick();
      const caused = events()
        .slice(beforeTick)
        .filter((event) => ["premise.judged", "headsup.sent", "attempt.state"].includes(String(event.type)));
      expect(caused.filter((event) => event.type === "headsup.sent").map((event) => event.attempt_id)).toEqual(
        orderedIds,
      );
      return { radius, caused };
    });
    expect(outcomes[0]).toEqual(outcomes[1]);
  });

  it("keeps stopped attempts with open choice cards in attempt_id order", () => {
    for (const reopen of [false, true]) {
      const { engine } = fixture(reopen);
      for (const id of reverseIds) {
        const trunk = engine();
        trunk.openAttempt(id, { intent: `Park ${id}` });
        trunk.stop({ attempt_id: id, reason: "withdrawn" });
        openCard(trunk.pool, "choice", "go_around_limit", [id]);
        trunk.tick();
      }
      expect(parked(engine().pool).map((attempt) => attempt.id)).toEqual(orderedIds);
    }
  });

  it("uses attempt_id to break LP2 ties between same-millisecond validated attempts", () => {
    for (const reopen of [false, true]) {
      const { sql, engine, call, events } = fixture(reopen, 1);
      for (const [i, id] of reverseIds.entries()) {
        engine().openAttempt(id, { intent: `Add independent ${i}` });
        call(id, "write", { path: `creatures/independent-${i}.js`, content: `export const value = ${i};\n` });
        expect(call(id, "submit", { summary: `Add ${i}` }).result).toMatchObject({ status: "validated" });
      }
      // Normal submissions use a logical validation counter. LP2 also defines an exact
      // tie: arrange that stored state explicitly and align the retained working copy.
      sql.exec("UPDATE attempts SET validated_at = ?", 1_000);
      const trunk = engine();
      for (const attempt of trunk.pool.attempts.values()) attempt.validated_at = 1_000;
      expect([...trunk.pool.attempts.values()].map((attempt) => attempt.validated_at)).toEqual([1_000, 1_000, 1_000]);
      trunk.tick();
      expect(
        events()
          .filter((event) => event.type === "landing.accepted")
          .map((event) => event.attempt_id),
      ).toEqual(["A-reader"]);
    }
  });
});
