import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { FEATURES } from "../../config/features.ts";
import { Trunk } from "../../core/trunk/registry.ts";
import { openCard } from "../../core/trunk/intents.ts";
import type { Sql } from "../../protocol/ports.ts";
import { ScriptedTriage } from "../../swarm/scripted-triage.ts";
import type { Env } from "../env.ts";
import { deliverResumes } from "./resume.ts";
import { metaSet, sqlOf } from "./sql.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const queries: string[] = [];
  const raw: Sql = {
    exec(query, ...bindings) {
      queries.push(query);
      const rows = db.prepare(query).all(...bindings) as Record<string, unknown>[];
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
  const ctx = {
    id: { name: "resume-session" },
    storage: { sql: raw, transactionSync: raw.transaction },
  } as unknown as DurableObjectState;
  const session = sqlOf(ctx);
  const opts = { now: () => 1_000, syncTriage: ScriptedTriage, features: FEATURES };
  const trunk = Trunk.create(
    session,
    { ".premise/policy.json": '{"v":1,"default":"auto"}', "guide.txt": "Guide\n" },
    opts,
  );
  trunk.pushOk();
  trunk.openAttempt("probe", { intent: "Add a guide", agent_kind: "synthetic" });
  expect(
    trunk.tool({
      attempt_id: "probe",
      call_id: "read-guide",
      tool: "read",
      args: { path: "guide.txt" },
      ack: 0,
    }).ok,
  ).toBe(true);
  expect(
    trunk.tool({
      attempt_id: "probe",
      call_id: "before-resume",
      tool: "write",
      args: { path: "guide.txt", content: "Updated guide\n" },
      ack: 0,
    }).ok,
  ).toBe(true);
  // T19/T21's durable source state: a reopened working attempt still holds its change.
  session.exec("UPDATE attempts SET resumes = 1 WHERE attempt_id = ?", "probe");
  const retained = session.run("sync", opts, (current) => current);
  queries.length = 0;
  return { db, raw, ctx, session, opts, retained, queries };
}

const refusedAgent = {
  AGENT: {
    idFromName: (id: string) => id,
    get: () => ({ fetch: () => Response.json({ ok: false }) }),
  },
} as unknown as Env;
const opens = (queries: string[]) =>
  queries.filter((query) => query === "SELECT * FROM attempts ORDER BY attempt_id").length;

describe("resume delivery with a retained Trunk", () => {
  it("applies T20r, closes the old card and clears the change without reopening", async () => {
    const { session, raw, ctx, opts, retained, queries } = fixture();
    const old = session.run("sync", opts, (trunk) => {
      const card = openCard(trunk.pool, "held", "held_path", ["probe"]);
      trunk.sync({ attempt_id: "probe", ack: 0 });
      return card.card_id;
    });
    await deliverResumes(refusedAgent, ctx, 1_000);
    session.run("sync", opts, (trunk) => {
      expect(trunk).toBe(retained);
      const attempt = trunk.pool.attempts.get("probe")!;
      expect(attempt).toMatchObject({ state: "stopped", stop_reason: "reopen_failed", opCount: 0 });
      expect(attempt.premises.size).toBe(0);
      expect(attempt.ops).toEqual([]);
      expect(trunk.pool.cards.find((card) => card.card_id === old)?.open).toBe(false);
      const choice = trunk.pool.cards.find((card) => card.reason === "reopen_failed")!;
      expect(choice.open).toBe(true);
      expect(choice.body.options.map((option) => option.id)).toEqual(["new_attempt", "stop"]);
      expect(choice.body.paths).toEqual([]);
      expect(trunk.pool.meta.get("resume_done:probe")).toBe("1");
      expect(trunk.pool.meta.has("resume_cycle:probe")).toBe(false);
      expect(trunk.pool.cardCounter).toBe(3);
    });
    expect(opens(queries)).toBe(0);
    const fresh = Trunk.open(raw, opts);
    expect(fresh.pool.attempts.get("probe")).toMatchObject({ state: "stopped", stop_reason: "reopen_failed", ops: [] });
    expect(fresh.pool.attempts.get("probe")!.premises.size).toBe(0);
    expect(fresh.pool.cards.map((card) => ({ id: card.card_id, open: card.open, body: card.body }))).toEqual(
      retained.pool.cards.map((card) => ({ id: card.card_id, open: card.open, body: card.body })),
    );
    const events = raw
      .exec("SELECT body FROM events_out ORDER BY n")
      .toArray()
      .map((row) => JSON.parse(String(row.body)));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "attempt.state", transition: "T20r", to: "stopped", reason: "reopen_failed" }),
    );
    expect(raw.exec("SELECT * FROM timers WHERE kind = 'resume'").toArray()).toEqual([]);
  });

  it("rechecks the no-step guard and resume number before a stale failure can stop an attempt", () => {
    const { session, opts, queries } = fixture();
    for (const input of [
      { attempt_id: "probe", resume_n: 1, since_call: "older-step" },
      { attempt_id: "probe", resume_n: 0, since_call: "before-resume" },
    ]) {
      expect(session.run("resume_failed", opts, (trunk) => trunk.resumeFailed(input))).toBe(false);
    }
    session.run("sync", opts, (trunk) => {
      expect(trunk.state("probe")).toBe("working");
      expect(trunk.pool.attempts.get("probe")!.ops).toHaveLength(1);
      expect(trunk.pool.cards).toEqual([]);
    });
    expect(opens(queries)).toBe(0);
  });

  it("stops an unstartable fresh Agent through the retained stop entry", async () => {
    const { session, ctx, opts, retained, queries } = fixture();
    metaSet(session, "resume_done:probe", 1);
    metaSet(session, "new_agent_open:probe", JSON.stringify({ attempt_id: "probe", pool: "resume-session" }));
    await deliverResumes(refusedAgent, ctx, 1_000);
    session.run("sync", opts, (trunk) => {
      expect(trunk).toBe(retained);
      expect(trunk.pool.attempts.get("probe")).toMatchObject({ state: "stopped", stop_reason: "lost" });
      expect(trunk.pool.meta.has("new_agent_open:probe")).toBe(false);
      expect(trunk.pool.meta.has("new_agent_cycle:probe")).toBe(false);
    });
    expect(opens(queries)).toBe(0);
  });
});
