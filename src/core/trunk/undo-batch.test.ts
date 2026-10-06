import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_REVISIONS } from "../../protocol/constants.ts";
import type { Sql } from "../../protocol/ports.ts";
import type { ToolName } from "../../protocol/tools.ts";
import { Trunk } from "./registry.ts";

const databases: DatabaseSync[] = [];
let nextCall = 1;
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  nextCall = 1;
});

function setup() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sql: Sql = {
    exec: (query, ...args) => {
      const rows = db.prepare(query).all(...args) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
    transaction: (run) => {
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
    {
      "world/energy.js": "export const ENERGY_MAX = 100;\n",
      "world/movement.js": "export const MAX_SPEED = 10;\n",
      ".premise/policy.json": JSON.stringify({ v: 1, default: "auto" }),
    },
    { now: () => 1000 },
  );
  trunk.pushOk();
  return { trunk, sql };
}

function call(t: Trunk, id: string, tool: ToolName, args: object): void {
  const response = t.tool({ attempt_id: id, call_id: `${id}:${nextCall++}`, tool, args, ack: 0 });
  expect(response.ok, JSON.stringify(response)).toBe(true);
}

function submit(t: Trunk, id: string): void {
  call(t, id, "submit", { summary: `Land ${id}` });
  expect(t.pool.attempts.get(id)?.state).toBe("validated");
}

function land(t: Trunk, id: string): void {
  submit(t, id);
  t.tick();
  t.pushOk();
  expect(t.pool.attempts.get(id)?.state).toBe("landed");
}

function dependentFixture(revision = 1) {
  const { trunk: t, sql } = setup();
  t.openAttempt("energy", { intent: "Make energy a fraction" });
  call(t, "energy", "read", { path: "world/energy.js", entity: "ENERGY_MAX" });
  call(t, "energy", "replace", { path: "world/energy.js", old: "ENERGY_MAX = 100", new: "ENERGY_MAX = 1" });
  land(t, "energy");
  t.openAttempt("crab", { intent: "Add a crab that uses the shared energy and speed rules" });
  call(t, "crab", "read", { path: "world/energy.js", entity: "ENERGY_MAX" });
  call(t, "crab", "read", { path: "world/movement.js", entity: "MAX_SPEED" });
  call(t, "crab", "write", {
    path: "creatures/crab.js",
    content:
      'import { ENERGY_MAX } from "../world/energy.js";\n' +
      'import { MAX_SPEED } from "../world/movement.js";\n' +
      "export function spawn() { return { energy: ENERGY_MAX, vx: MAX_SPEED }; }\n" +
      "export function update(crab) { crab.hiding = crab.energy < 0.3; }\n",
  });
  land(t, "crab");
  sql.exec("UPDATE attempts SET revision = ? WHERE attempt_id = 'crab'", revision);
  return { trunk: Trunk.open(sql, { now: () => 1000 }), sql };
}

function events(t: Trunk): Array<Record<string, unknown>> {
  return t.pool.sql
    .exec("SELECT body FROM events_out ORDER BY n")
    .toArray()
    .map((row) => JSON.parse(String(row.body)) as Record<string, unknown>);
}

describe("undo batches preserve classification, event order and batch limits", () => {
  it("HU1/UN8: a reopened dependent is told about a concurrent landing that changes another premise", () => {
    const { trunk: t } = dependentFixture();
    t.openAttempt("speed", { intent: "Raise the speed limit" });
    call(t, "speed", "read", { path: "world/movement.js", entity: "MAX_SPEED" });
    call(t, "speed", "replace", { path: "world/movement.js", old: "MAX_SPEED = 10", new: "MAX_SPEED = 20" });
    submit(t, "speed");
    expect(t.undo({ seq: 1, expect_reverted: [1, 2], request_id: "undo-with-candidate" }).ok).toBe(true);
    t.tick();
    t.pushOk();

    const speedItems = () =>
      t.pool.attempts
        .get("crab")!
        .heads.flatMap((head) => head.body.items)
        .filter((item) => item.premise.key === "world/movement.js#MAX_SPEED");
    // A deferred candidate is still safe: once accepted, its changed fact must
    // be reported. It must never be silently absorbed by the undo's re-pinning.
    if (t.pool.attempts.get("speed")?.state === "landed") expect(speedItems()).toHaveLength(1);
    else {
      expect(t.pool.attempts.get("speed")?.state).toBe("validated");
      t.tick();
      t.pushOk();
    }
    expect(t.pool.attempts.get("speed")?.state).toBe("landed");
    expect(t.pool.files.get("world/movement.js")).toBe("export const MAX_SPEED = 20;\n");
    expect(t.pool.attempts.get("crab")?.state).toBe("going_around");
    expect(t.pool.files.has("creatures/crab.js")).toBe(false);
    expect(speedItems()).toHaveLength(1);
    expect(speedItems()[0]).toMatchObject({
      rule: "E2",
      result: "repair",
      diff: {
        kind: "entity",
        before: expect.stringContaining("MAX_SPEED = 10"),
        after: expect.stringContaining("MAX_SPEED = 20"),
      },
    });
    expect(t.pool.attempts.get("crab")?.premises.get("entity|world/movement.js#MAX_SPEED")?.status).toBe(
      "pending_repair",
    );
    expect(t.pool.attempts.get("crab")!.heads.flatMap((head) => head.body.items)).toContainEqual(
      expect.objectContaining({ premise: expect.objectContaining({ key: "world/energy.js#ENERGY_MAX" }), rule: "E2" }),
    );
  });

  it.each([1, MAX_REVISIONS])(
    "EV3: undo landing.accepted precedes the state and card effects at revision %i",
    (revision) => {
      const { trunk: t } = dependentFixture(revision);
      expect(t.undo({ seq: 1, expect_reverted: [1, 2], request_id: `ordered-${revision}` }).ok).toBe(true);
      const before = events(t).length;
      t.tick();
      const batchEvents = events(t).slice(before);
      const accepted = batchEvents
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => event.type === "landing.accepted");
      expect(accepted).toHaveLength(1);
      expect(accepted[0]?.event).toMatchObject({ seq: 3, kind: "undo" });
      const effects = batchEvents
        .map((event, index) => ({ event, index }))
        .filter(({ event }) =>
          ["attempt.state", "attempt.reopened", "card.opened", "headsup.sent"].includes(String(event.type)),
        );
      expect(effects.some(({ event }) => event.type === "attempt.state" && event.transition === "T18")).toBe(true);
      expect(
        effects.some(({ event }) => event.type === (revision === MAX_REVISIONS ? "card.opened" : "attempt.reopened")),
      ).toBe(true);
      for (const effect of effects) expect(effect.index, String(effect.event.type)).toBeGreaterThan(accepted[0]!.index);
    },
  );

  it("LP2: excess disjoint undo requests remain queued after MAX_BATCH and land in the next batch", () => {
    const { trunk: t } = setup();
    t.pool.K.MAX_BATCH = 2;
    for (const name of ["alpha", "beta", "gamma"]) {
      t.openAttempt(name, { intent: `Add ${name}` });
      call(t, name, "write", { path: `creatures/${name}.js`, content: `export const name = "${name}";\n` });
      land(t, name);
    }
    for (const seq of [1, 2, 3]) {
      expect(t.undo({ seq, expect_reverted: [seq], request_id: `bounded-${seq}` })).toEqual({
        ok: true,
        request_id: `bounded-${seq}`,
      });
    }
    t.tick();
    expect(t.pool.landings.slice(3).map((landing) => landing.seq)).toEqual([4, 5]);
    expect(t.pool.outbox).toMatchObject({ first_seq: 4, last_seq: 5 });
    expect(t.pool.undoQueue).toEqual([
      expect.objectContaining({ request_id: "bounded-3", target_seq: 3, state: "queued", reverted: [3] }),
    ]);
    expect(t.pool.files.has("creatures/alpha.js")).toBe(false);
    expect(t.pool.files.has("creatures/beta.js")).toBe(false);
    expect(t.pool.files.get("creatures/gamma.js")).toBe('export const name = "gamma";\n');

    t.pushOk();
    t.tick();
    expect(t.pool.outbox).toMatchObject({ first_seq: 6, last_seq: 6 });
    t.pushOk();
    expect(t.pool.undoQueue).toEqual([]);
    expect(t.pool.landings.slice(3).map((landing) => JSON.parse(landing.note).undo.undoes)).toEqual([[1], [2], [3]]);
    expect(t.pool.files.has("creatures/gamma.js")).toBe(false);
  });
});
