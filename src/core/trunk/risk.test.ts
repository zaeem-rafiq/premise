// RK1, RK3, RK5 (01-core 10.4): the held card's Clef risk questions, engine side. A full held
// card opened while CLEF_RISK is on queues its submit; the dispatch carries the 10.4 state; the
// answer fills `Card.risk` with `card.updated`; a closed card's answer is discarded; a question
// past its deadline is unavailable with the code `timeout`. Expected shapes are 10.4's.

import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Sql } from "../../protocol/ports.ts";
import type { ToolRequest } from "../../protocol/tools.ts";
import { CLEF_TIMEOUT_MS } from "../../protocol/constants.ts";
import { Trunk } from "./registry.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

const seed = {
  ".premise/policy.json": JSON.stringify({ v: 1, default: "auto", tiers: [{ paths: ["world.js"], tier: "held" }] }),
  "world.js": "export const LIMIT = 100;\n",
  "notes.txt": "plain notes\n",
};

function fixture(opts: { risk?: "on" | "off"; held?: boolean } = {}) {
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
  const trunk = Trunk.create(sql, seed, {
    features: { held: opts.held ?? true },
    switches: { CLEF_RISK: opts.risk ?? "on" },
    now: () => now,
  });
  trunk.pushOk();
  const call = (attempt_id: string, tool: ToolRequest["tool"], args: ToolRequest["args"]) => {
    const response = trunk.tool({ attempt_id, call_id: `c${++n}`, tool, args, ack: 0 });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    return response;
  };
  function openHeld() {
    trunk.openAttempt("S", { intent: "Lower the limit", agent_kind: "real" });
    call("S", "read", { path: "world.js" });
    call("S", "replace", { path: "world.js", old: "100", new: "1" });
    call("S", "read", { path: "notes.txt" });
    call("S", "write", { path: "notes.txt", content: "plain notes, lower limit\n" });
    expect(call("S", "submit", { summary: "Lower LIMIT to one" }).result).toMatchObject({ status: "held" });
    return trunk.pool.cards.find((c) => c.open && c.attempt_ids.includes("S"))!;
  }
  const events = () =>
    sql
      .exec("SELECT body FROM events_out ORDER BY n")
      .toArray()
      .map((r) => JSON.parse(String(r.body)) as Record<string, unknown>);
  const timer = () => sql.exec("SELECT due_at FROM timers WHERE kind = 'risk'").toArray()[0]?.due_at ?? null;
  return { trunk, sql, call, openHeld, events, timer, setNow: (v: number) => (now = v) };
}

describe("RK5: the held card's risk questions (10.4)", () => {
  it("RK5: a full held card queues its submit and the dispatch carries the 10.4 state", () => {
    const f = fixture();
    const card = f.openHeld();
    expect(card.body.risk).toBeNull();
    expect(f.timer()).toBe(1_000 + CLEF_TIMEOUT_MS);
    const { requests } = f.trunk.riskDispatch();
    expect(requests).toEqual([
      {
        submit_id: card.body.submit_ids.S,
        attempt_id: "S",
        card_id: card.card_id,
        input: {
          intent: "Lower the limit",
          summary: "Lower LIMIT to one",
          held_paths: ["world.js"],
          files: [
            {
              path: "notes.txt",
              tier: "auto",
              entities: [{ key: "notes.txt", before: "plain notes\n", after: "plain notes, lower limit\n" }],
            },
            {
              path: "world.js",
              tier: "held",
              entities: [
                { key: "world.js#LIMIT", before: "export const LIMIT = 100;\n", after: "export const LIMIT = 1;\n" },
              ],
            },
          ],
        },
      },
    ]);
    // Asked once per submit: a second dispatch sends nothing.
    expect(f.trunk.riskDispatch().requests).toEqual([]);
  });

  it("RK1: the answers fill Card.risk and the card is updated; they decide nothing", () => {
    const f = fixture();
    const card = f.openHeld();
    const [req] = f.trunk.riskDispatch().requests;
    const risk = { model: "clef", does_what_asked: 0.92, changes_shared_meaning: 0.81, unrelated_edits: 0.07 };
    f.trunk.riskAnswer({ submit_id: req!.submit_id, risk });
    expect(card.body.risk).toEqual(risk);
    const updated = f.events().filter((e) => e.type === "card.updated");
    expect(updated.at(-1)).toMatchObject({ card: { card_id: card.card_id, risk } });
    expect(card.open).toBe(true);
    expect(f.trunk.pool.attempts.get("S")?.state).toBe("held");
    expect(f.timer()).toBeNull();
  });

  it("RK1: an answer for a card that closed is discarded", () => {
    const f = fixture();
    const card = f.openHeld();
    const [req] = f.trunk.riskDispatch().requests;
    f.trunk.owner({ action: "decline", attempt: "S" });
    expect(card.open).toBe(false);
    const before = f.events().length;
    f.trunk.riskAnswer({
      submit_id: req!.submit_id,
      risk: { model: "clef", does_what_asked: 0.1, changes_shared_meaning: 0.1, unrelated_edits: 0.1 },
    });
    expect(f.events().filter((e, i) => i >= before && e.type === "card.updated")).toEqual([]);
  });

  it("RK3: a question past CLEF_TIMEOUT_MS is unavailable with the code `timeout`", () => {
    const f = fixture();
    const card = f.openHeld();
    f.trunk.riskDispatch();
    f.setNow(1_000 + CLEF_TIMEOUT_MS);
    f.trunk.riskDeadline();
    expect(card.body.risk).toEqual({
      model: "clef",
      does_what_asked: null,
      changes_shared_meaning: null,
      unrelated_edits: null,
      error: "timeout",
    });
  });

  it("RK3/CLEF_RISK off: no question is queued; HD1's minimal card asks none either", () => {
    const off = fixture({ risk: "off" });
    off.openHeld();
    expect(off.trunk.riskDispatch().requests).toEqual([]);
    expect(off.timer()).toBeNull();
    const minimal = fixture({ held: false });
    minimal.openHeld();
    expect(minimal.trunk.riskDispatch().requests).toEqual([]);
  });
});
