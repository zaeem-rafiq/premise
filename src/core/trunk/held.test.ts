import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Sql } from "../../protocol/ports.ts";
import type { ToolRequest } from "../../protocol/tools.ts";
import { RIGHT_OF_WAY_MS } from "../../protocol/constants.ts";
import { makeTreeFromFiles } from "../git/tree-files.ts";
import { grantRightOfWay } from "./intents.ts";
import { Trunk } from "./registry.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

const policy = JSON.stringify({ v: 1, default: "auto", tiers: [{ paths: ["world.js"], tier: "held" }] });
const seed = {
  ".premise/policy.json": policy,
  "world.js": "export const LIMIT = 100;\n",
  "consumer.js": 'import { LIMIT } from "./world.js";\nexport const total = LIMIT;\nexport const shade = 1;\n',
};

function fixture(held = true) {
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
  const trunk = Trunk.create(sql, seed, { features: { held }, now: () => now });
  trunk.pushOk();
  function call(attempt_id: string, tool: ToolRequest["tool"], args: ToolRequest["args"], engine = trunk) {
    const response = engine.tool({ attempt_id, call_id: `call-${++n}`, tool, args, ack: 0 });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    return response;
  }
  function openHeld(engine = trunk) {
    engine.openAttempt("S", { intent: "Lower the limit", agent_kind: "real" });
    call("S", "read", { path: "world.js" }, engine);
    call("S", "replace", { path: "world.js", old: "100", new: "1" }, engine);
    expect(call("S", "submit", { summary: "Lower LIMIT to one" }, engine).result).toMatchObject({ status: "held" });
    return engine.pool.cards.find((card) => card.open && card.attempt_ids.includes("S"))!;
  }
  function dependent() {
    const attempt = trunk.openAttempt("R", { intent: "Add crab", agent_kind: "real" });
    call("R", "write", {
      path: "crab.js",
      content: 'import { LIMIT } from "./world.js";\nexport const crab = LIMIT;\n',
    });
    return attempt;
  }
  return {
    trunk,
    sql,
    call,
    openHeld,
    dependent,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("full held card (10.2, 11.6, CD2, CD4)", () => {
  it("shows touched paths with their tiers and the held-path sentence", () => {
    const { trunk, call } = fixture();
    trunk.openAttempt("S", { intent: "Lower the limit and add help", agent_kind: "real" });
    call("S", "read", { path: "world.js" });
    call("S", "replace", { path: "world.js", old: "100", new: "1" });
    call("S", "write", { path: "help.js", content: "export const help = true;\n" });
    call("S", "submit", { summary: "Lower LIMIT to one and add help" });
    const card = trunk.pool.cards[0]!;
    expect(card.body.paths).toEqual([
      { path: "help.js", tier: "auto" },
      { path: "world.js", tier: "held" },
    ]);
    expect(card.body.title).toBe("This change touches shared rules. Land it?");
    expect(card.body.body).toEqual(["It changes help.js, world.js. No change in flight relies on what this changes."]);
    expect(card.body.options).toEqual([
      { id: "land", label: "Land" },
      { id: "decline", label: "Decline" },
    ]);
    expect(card.body.preview?.before).toEqual({ repo: "main", commit: trunk.pool.meta.get("landed_commit") });
    expect(trunk.pool.attempts.get("S")).toMatchObject({
      intentText: "Lower the limit and add help",
      summary: "Lower LIMIT to one and add help",
      approved_by: null,
    });
    expect(trunk.pool.outbox).toBeNull();
  });

  it("classifies repair, confirm, and triage without including unpatched or stopped attempts", () => {
    const { trunk, call, openHeld, dependent } = fixture();
    dependent();
    trunk.openAttempt("C", { intent: "Adjust consumer shade", agent_kind: "real" });
    call("C", "read", { path: "consumer.js" });
    call("C", "replace", { path: "consumer.js", old: "shade = 1", new: "shade = 2" });
    trunk.openAttempt("T", { intent: "Add unrelated helper", agent_kind: "real" });
    call("T", "read", { path: "world.js", entity: "LIMIT" });
    call("T", "write", { path: "helper.js", content: "export const helper = true;\n" });
    trunk.openAttempt("I", { intent: "Read without a patch", agent_kind: "real" });
    call("I", "read", { path: "world.js" });
    trunk.openAttempt("X", { intent: "Abandoned crab", agent_kind: "real" });
    call("X", "write", {
      path: "abandoned.js",
      content: 'import { LIMIT } from "./world.js";\nexport const abandoned = LIMIT;\n',
    });
    trunk.stop({ attempt_id: "X", reason: "withdrawn" });
    const card = openHeld();
    // E2, E2m, E3 and X0 respectively: 01-core 7.2 and the dry run required by 11.6.
    expect(card.body.blast_radius).toEqual({ S: { repair: ["R"], confirm: ["C"], triage: ["T"], right_of_way: [] } });
    expect(card.body.body).toEqual(["It changes world.js. Landing this sends 1 change back to its agent: crab."]);
  });

  it("refreshes radius, options, and right-of-way sentence after a batch while the same card stays open", () => {
    const { trunk, call, openHeld, dependent } = fixture();
    const card = openHeld();
    const submit = card.body.submit_ids.S;
    grantRightOfWay(trunk.pool, dependent());
    trunk.openAttempt("J", { intent: "Add another module", agent_kind: "real" });
    call("J", "write", { path: "other.js", content: "export const other = true;\n" });
    call("J", "submit", { summary: "Add other" });
    trunk.tick();
    expect(trunk.pool.headSeq()).toBe(1);
    expect(card.open).toBe(true);
    expect(card.body.submit_ids.S).toBe(submit);
    expect(card.body.blast_radius.S).toEqual({ repair: ["R"], confirm: [], triage: [], right_of_way: ["R"] });
    expect(card.body.options.map((option) => option.id)).toEqual(["land", "land_now", "decline"]);
    expect(card.body.body).toEqual([
      "It changes world.js. Landing this sends crab around again. It will wait until that change has landed.",
    ]);
    expect(trunk.out.events).toContain("card.updated");
    trunk.pushOk();
    trunk.stop({ attempt_id: "R", reason: "withdrawn" });
    trunk.tick();
    expect(card.open).toBe(true);
    expect(card.body.blast_radius.S).toEqual({ repair: [], confirm: [], triage: [], right_of_way: [] });
    expect(card.body.options.map((option) => option.id)).toEqual(["land", "decline"]);
    expect(card.body.body).toEqual(["It changes world.js. No change in flight relies on what this changes."]);
    expect(trunk.out.events).toContain("card.updated");
  });

  it.each(["timer", "tap"] as const)("removes expired right of way from the card at %s", (surface) => {
    const { trunk, openHeld, dependent, setNow } = fixture();
    grantRightOfWay(trunk.pool, dependent());
    const card = openHeld();
    expect(card.body.options.map((option) => option.id)).toEqual(["land", "land_now", "decline"]);
    setNow(1_000 + RIGHT_OF_WAY_MS);
    if (surface === "timer") trunk.expireRightOfWay({ attempt_id: "R", due_at: 1_000 + RIGHT_OF_WAY_MS });
    else
      expect(trunk.owner({ action: "land_now", attempt: "S" })).toMatchObject({
        ok: false,
        error: { code: "invalid_args" },
      });
    expect(card.open).toBe(true);
    expect(trunk.state("S")).toBe("held");
    expect(card.body.blast_radius.S).toEqual({ repair: ["R"], confirm: [], triage: [], right_of_way: [] });
    expect(card.body.options.map((option) => option.id)).toEqual(["land", "decline"]);
    expect(card.body.body).toEqual(["It changes world.js. Landing this sends 1 change back to its agent: crab."]);
    expect(trunk.out.events).toContain("card.updated");
  });

  it("does not offer Land now when right of way is present only under triage", () => {
    const { trunk, call, openHeld } = fixture();
    const reader = trunk.openAttempt("T", { intent: "Add helper after reading", agent_kind: "real" });
    call("T", "read", { path: "world.js", entity: "LIMIT" });
    call("T", "write", { path: "helper.js", content: "export const helper = true;\n" });
    grantRightOfWay(trunk.pool, reader);
    const card = openHeld();
    expect(card.body.blast_radius.S).toEqual({ repair: [], confirm: [], triage: ["T"], right_of_way: ["T"] });
    expect(card.body.options.map((option) => option.id)).toEqual(["land", "decline"]);
    expect(card.body.body).toEqual(["It changes world.js. Clef will judge 1 change that reads it: helper."]);
  });

  it("uses the minimal held form when an explicit false overrides persisted full features", () => {
    const { sql, call, openHeld, dependent, trunk } = fixture();
    grantRightOfWay(trunk.pool, dependent());
    // Flush the grant before reopening the same durable state with the build's feature flag.
    call("R", "submit", { summary: "Add crab" });
    const reopened = Trunk.open(sql, { features: { held: false }, now: () => 1_000 });
    const card = openHeld(reopened);
    expect(reopened.pool.featuresHeld).toBe(false);
    expect(card.body).toMatchObject({ blast_radius: {}, preview: null, risk: null, body: ["It changes world.js."] });
    expect(card.body.options.map((option) => option.id)).toEqual(["land", "decline"]);
    expect(reopened.state("S")).toBe("held");
    expect(reopened.preview()).toEqual({ state: "idle" });
    expect(reopened.owner({ action: "land_now", attempt: "S" })).toMatchObject({
      ok: false,
      error: { code: "invalid_args" },
    });
    reopened.owner({ action: "decline", attempt: "S", reason: "Keep the current limit" });
    expect(reopened.state("S")).toBe("stopped");
    const event = sql
      .exec("SELECT body FROM events_out ORDER BY n DESC")
      .toArray()
      .map((row) => JSON.parse(String(row.body)))
      .find((body) => body.type === "card.closed");
    expect(event).toMatchObject({
      card_id: card.card_id,
      action: "decline",
      attempt_id: null,
      reason: "Keep the current limit",
    });
  });

  it("closes an edited card as stale and never carries its approval into a new submit (C34)", () => {
    const { trunk, sql, call, openHeld } = fixture();
    const card = openHeld();
    const oldSubmit = card.body.submit_ids.S;
    call("S", "replace", { path: "world.js", old: "1", new: "2" });
    expect(card.open).toBe(false);
    expect(trunk.state("S")).toBe("working");
    const event = sql
      .exec("SELECT body FROM events_out ORDER BY n DESC")
      .toArray()
      .map((row) => JSON.parse(String(row.body)))
      .find((body) => body.type === "card.closed");
    expect(event).toMatchObject({ card_id: card.card_id, action: "stale", attempt_id: null, reason: null });
    trunk.owner({ action: "land", attempt: "S" });
    expect(trunk.state("S")).toBe("working");
    expect(trunk.pool.attempts.get("S")?.approved_by).toBeNull();
    call("S", "submit", { summary: "Lower LIMIT to two" });
    const next = trunk.pool.cards.find((current) => current.open)!;
    expect(next.card_id).not.toBe(card.card_id);
    expect(next.body.submit_ids.S).not.toBe(oldSubmit);
    expect(trunk.state("S")).toBe("held");
    expect(trunk.pool.attempts.get("S")).toMatchObject({
      approved_by: null,
      approved_at: null,
      approved_option: null,
      bypass_row: false,
    });
    trunk.tick();
    expect(trunk.pool.headSeq()).toBe(0);
  });

  it("keeps a held card open without a timeout or a model turn", () => {
    const { trunk, openHeld, setNow } = fixture();
    const card = openHeld();
    setNow(1_000 + 30 * 24 * 60 * 60 * 1_000);
    trunk.tick();
    expect(card.open).toBe(true);
    expect(trunk.state("S")).toBe("held");
    expect(trunk.pool.headSeq()).toBe(0);
    expect(trunk.pool.attempts.get("S")).toMatchObject({ model_calls: 0, tokens_in: 0, tokens_out: 0, heads: [] });
    expect(trunk.out.events).not.toContain("card.closed");
  });

  it("uses the running policy and tree when a prior batch member turns a candidate held", () => {
    const { trunk, call } = fixture();
    const nextPolicy = JSON.stringify({
      v: 1,
      default: "auto",
      tiers: [{ paths: ["world.js", "later.js"], tier: "held" }],
    });
    trunk.openAttempt("P", { intent: "Hold later modules", agent_kind: "real" });
    call("P", "read", { path: ".premise/policy.json" });
    call("P", "write", { path: ".premise/policy.json", content: nextPolicy });
    call("P", "submit", { summary: "Hold later modules" });
    trunk.owner({ action: "land", attempt: "P" });
    trunk.openAttempt("L", { intent: "Add later", agent_kind: "real" });
    call("L", "write", { path: "later.js", content: "export const later = true;\n" });
    expect(call("L", "submit", { summary: "Add later" }).result).toMatchObject({ status: "validated" });
    trunk.tick();
    expect(trunk.out.accepted).toEqual(["P"]);
    expect(trunk.state("L")).toBe("held");
    const card = trunk.pool.cards.find((current) => current.open && current.attempt_ids.includes("L"))!;
    expect(card.body.paths).toEqual([{ path: "later.js", tier: "held" }]);
    const preview = trunk.preview();
    if (preview.state !== "build") throw new Error("preview missing");
    const candidate = preview.previews.find((item) => item.submit_id === card.body.submit_ids.L);
    // Expected files come from the accepted policy edit plus L's submitted file (PV1).
    const expected = makeTreeFromFiles({
      ...seed,
      ".premise/policy.json": nextPolicy,
      "later.js": "export const later = true;\n",
    });
    expect(candidate?.tree).toBe(expected.root.oid);
  });
});
