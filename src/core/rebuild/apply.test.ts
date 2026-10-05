// The engine half of "rebuild from Artifacts" (01-core 3.6): the durable cursor's arm, the wipe
// and new epoch of `beginRebuild` (RB5), the per-run commits of `applyRebuildStep` (RB3), and
// step 8's register deadline — over `node:sqlite`, which stands in for the object's storage.

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Sql } from "../../protocol/ports.ts";
import { applySchema, metaGet } from "../trunk/schema.ts";
import { Trunk } from "../trunk/registry.ts";
import { CURSOR_KEY, rebuildCursorOf } from "./apply.ts";
import type { ApplyPayload, LandingPlan, RemoteCommit } from "./plan.ts";
import { landingFromNote } from "./plan.ts";
import type { Note } from "../../protocol/note.ts";
import { REGISTER_TIMEOUT_MS } from "../../protocol/constants.ts";

function memorySql(): Sql {
  const db = new DatabaseSync(":memory:");
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

const NOW = 1_800_000_000_000;

function newTrunk(sql: Sql): Trunk {
  const trunk = Trunk.create(
    sql,
    { "world/energy.js": "export const MAX = 100;\n" },
    { pool_id: "pool", remote: "https://artifacts.test/pool", now: () => NOW },
  );
  // The seed batch of `createPool` is a pending outbox row; these tests stand in for its push
  // having succeeded, or `beginRebuild` rightly refuses under RB1.
  sql.exec("UPDATE outbox SET state = 'pushed' WHERE batch_id = 0");
  return trunk;
}

const commit = (hash: string, over: Partial<RemoteCommit> = {}): RemoteCommit => ({
  hash,
  treeHash: `${hash.slice(0, 30)}treehash00`,
  message: "",
  parents: [],
  committedAt: 1_800_000_000,
  authorName: "model-a",
  authorEmail: "a_1@agents.premise.invalid",
  ...over,
});

const note = (seq: number, over: Partial<Note> = {}): Note => ({
  v: 1,
  hash_version: "ast1",
  seq,
  kind: "change",
  change_id: `c_${seq}`,
  revision: 1,
  intent: { id: `i_${seq}`, text: `landing ${seq}`, requester: "owner", created_at: "2026-01-01T00:00:00.000Z" },
  attempt: {
    id: `a_${seq}`,
    agent: "real",
    model: "model-a",
    repo: null,
    opened_seq: seq - 1,
    steps: 2,
    model_calls: 2,
    tokens_in: 10,
    tokens_out: 5,
  },
  summary: `landing ${seq}`,
  premises: [],
  writes: [{ kind: "file", key: `f${seq}.js`, old: "absent", new: `oid_${seq}` }],
  ops: [],
  go_arounds: [],
  confirms: [],
  judgments: [],
  checks: [],
  policy: { tier: "auto", approved_by: null, approved_at: null, option: null, risk: null },
  pull_backs: 0,
  batch: { id: seq, index: 0, size: 1 },
  timing: {
    opened_at: "2026-01-01T00:00:00.000Z",
    submitted_at: "2026-01-01T00:00:01.000Z",
    accepted_at: "2026-01-01T00:00:02.000Z",
  },
  ...over,
});

function begin(trunk: Trunk, epoch = 2): Record<string, unknown> {
  return trunk.rebuildBegin({
    epoch,
    pool_id: "pool",
    remote: "https://artifacts.test/pool",
    head_commit: "h".repeat(40),
    notes_commit: null,
    green_commit: null,
  });
}

function landingPlan(seq: number): LandingPlan {
  return landingFromNote(
    commit(`c${seq}`.padEnd(40, "0"), { parents: [seq === 1 ? "s".repeat(40) : `c${seq - 1}`.padEnd(40, "0")] }),
    seq,
    note(seq),
    `note_${seq}`,
    true,
    () => "",
  );
}

describe("armRebuild (13.6, 9.8)", () => {
  it("parks the cursor and arms the rebuild timer; a repeat answers `already`", () => {
    const sql = memorySql();
    const trunk = newTrunk(sql);
    expect(trunk.rebuild("req-1")).toEqual({ ok: true, started: true });
    expect(rebuildCursorOf(trunk.pool)?.stage).toBe("await");
    const timer = sql.exec("SELECT due_at FROM timers WHERE kind = 'rebuild'").toArray();
    expect(timer).toHaveLength(1);
    expect(trunk.rebuild("req-2")).toEqual({ ok: true, already: true, request_id: "req-1" });
    // A repeated request after the job finished still answers `already` (9.8).
    trunk.rebuildStep({
      request_id: "req-1",
      cursor: null,
      finish: {
        head_seq: 0,
        head_commit: "h".repeat(40),
        head_tree: "t".repeat(40),
        notes_commit: "",
        green_seq: 0,
        green_commit: "",
        next_batch_id: 1,
        unwitnessed: [],
        expect: [],
      },
    });
    expect(trunk.rebuild("req-1")).toEqual({ ok: true, already: true, request_id: "req-1" });
  });
});

describe("beginRebuild (3.6 steps 1-2, RB5)", () => {
  it("wipes the derived tables, keeps `expect`, and raises the epoch", () => {
    const sql = memorySql();
    const trunk = newTrunk(sql);
    trunk.openAttempt("a_live", { intent: "still going", requester: "agent" });
    trunk.rebuild("req-9");
    const r = begin(trunk, 3) as { ok: boolean; cursor: { expect: unknown[] } };
    expect(r.ok).toBe(true);
    expect(r.cursor.expect).toHaveLength(1);
    expect((r.cursor.expect[0] as { attempt_id: string }).attempt_id).toBe("a_live");
    // The wipe: no attempt survives; the epoch is the Floor's last plus one (RB5).
    expect(trunk.pool.attempts.size).toBe(0);
    expect(metaGet(sql, "epoch")).toBe("3");
    expect(metaGet(sql, "pool_state")).toBe("rebuilding");
    // The first event of the new epoch is `pool.state` `rebuilding` (RB5: before anything else).
    const ev = sql.exec("SELECT body FROM events_out ORDER BY n").toArray();
    expect(ev.length).toBeGreaterThan(0);
    const last = JSON.parse(String(ev[ev.length - 1]!.body)) as { type: string; state: string; epoch: number };
    expect(last.type).toBe("pool.state");
    expect(last.state).toBe("rebuilding");
    expect(last.epoch).toBe(3);
    // A paused pool rejoins through the same door (LP8): the pause reason is gone.
    expect(metaGet(sql, "pause_reason")).toBeNull();
  });

  it("refuses while an outbox row still names a batch to reconcile (RB1)", () => {
    const sql = memorySql();
    const trunk = newTrunk(sql);
    sql.exec(
      "INSERT INTO outbox (batch_id, state, first_seq, last_seq, old_main, new_main, old_notes, new_notes, created_at) VALUES (9, 'pending', 1, 1, '', 'x', '', '', 1)",
    );
    trunk.rebuild("req-b");
    expect(begin(trunk)).toEqual({ ok: false, error: { code: "busy" } });
    expect(metaGet(sql, "pool_state")).toBe("ready"); // untouched
  });
});

describe("applyRebuildStep (RB3) + finish (step 5)", () => {
  it("commits landing plans across runs and ends `ready` at the rebuilt head", () => {
    const sql = memorySql();
    const trunk = newTrunk(sql);
    trunk.rebuild("req-1");
    begin(trunk, 2);
    // Run 1: landing 1, cursor continues.
    const mid = trunk.rebuildStep({
      cursor: { v: 1, request_id: "req-1", stage: "landings", done: 3, total: 9 },
      landings: [landingPlan(1)],
    });
    expect(mid).toEqual({ ok: true, done: false });
    expect(sql.exec("SELECT seq FROM landings").toArray()).toHaveLength(1);
    expect(metaGet(sql, "pool_state")).toBe("rebuilding");
    // Run 2: the last landing plus the finishing apply.
    const fin: ApplyPayload = {
      cursor: null,
      finish: {
        head_seq: 2,
        head_commit: "c2".padEnd(40, "0"),
        head_tree: "t2".repeat(20),
        notes_commit: "nc".repeat(20),
        green_seq: 1,
        green_commit: "g".repeat(40),
        next_batch_id: 3,
        unwitnessed: [4],
        expect: [
          {
            attempt_id: "a_x",
            intent_id: "i_x",
            change_id: "c_x",
            revision: 1,
            state: "working",
            agent_kind: "real",
            model: "m",
            intent_text: "t",
            requester: "agent",
            opened_seq: 1,
          },
        ],
      },
      landings: [landingPlan(2)],
    };
    expect(trunk.rebuildStep(fin)).toEqual({ ok: true, done: true });
    expect(metaGet(sql, "pool_state")).toBe("ready");
    expect(metaGet(sql, "head_seq")).toBe("2");
    expect(metaGet(sql, "landed_seq")).toBe("2");
    expect(metaGet(sql, "next_batch_id")).toBe("3");
    expect(metaGet(sql, "unwitnessed")).toBe("[4]");
    expect(rebuildCursorOf(trunk.pool)).toBeNull();
    // The rebuilt landing stands: its attempt and intent rows landed with it.
    expect(trunk.pool.landings.map((l) => l.seq)).toEqual([1, 2]);
    expect(trunk.pool.attempts.get("a_2")?.state).toBe("landed");
    expect(trunk.pool.intents.get("i_2")?.state).toBe("landed");
    // Step 8's deadline is armed at REGISTER_TIMEOUT_MS.
    const lost = sql.exec("SELECT due_at FROM timers WHERE kind = 'rebuild_lost'").toArray();
    expect(lost).toHaveLength(1);
    expect(Number(lost[0]!.due_at)).toBe(NOW + REGISTER_TIMEOUT_MS);
    // `rebuild_done` names the request a repeat must answer `already` to.
    expect(metaGet(sql, "rebuild_done")).toBe("req-1");
  });

  it("a note/seq mismatch pauses the pool with `note_seq_mismatch` (step 2)", () => {
    const sql = memorySql();
    const trunk = newTrunk(sql);
    trunk.rebuild("req-2");
    begin(trunk);
    const r = trunk.rebuildStep({ cursor: null, pause: "note_seq_mismatch" });
    expect(r).toEqual({ ok: true, paused: "note_seq_mismatch" });
    expect(metaGet(sql, "pool_state")).toBe("paused");
    expect(metaGet(sql, "pause_reason")).toBe("note_seq_mismatch");
    expect(rebuildCursorOf(trunk.pool)).toBeNull();
  });
});

describe("registerDeadline (3.6 step 8)", () => {
  it("records every still-missing expected attempt `stopped`/`lost` (T20)", () => {
    const sql = memorySql();
    const trunk = newTrunk(sql);
    trunk.rebuild("req-3");
    begin(trunk);
    trunk.rebuildStep({
      cursor: null,
      finish: {
        head_seq: 0,
        head_commit: "h".repeat(40),
        head_tree: "t".repeat(40),
        notes_commit: "",
        green_seq: 0,
        green_commit: "",
        next_batch_id: 1,
        unwitnessed: [],
        expect: [
          {
            attempt_id: "a_gone",
            intent_id: "i_g",
            change_id: "c_g",
            revision: 1,
            state: "working",
            agent_kind: "real",
            model: null,
            intent_text: "",
            requester: "agent",
            opened_seq: 0,
          },
        ],
      },
    });
    trunk.rebuildLost();
    const row = sql.exec("SELECT state, stop_reason FROM attempts WHERE attempt_id = 'a_gone'").toArray()[0];
    expect(row).toEqual({ state: "stopped", stop_reason: "lost" });
    const ev = sql
      .exec("SELECT body FROM events_out WHERE body LIKE '%attempt.state%' ORDER BY n DESC LIMIT 1")
      .toArray()[0];
    const body = JSON.parse(String(ev!.body)) as { to: string; reason: string };
    expect(body).toMatchObject({ to: "stopped", reason: "lost" });
  });
});

describe("the register entry (3.6 steps 6-8)", () => {
  const ready = () => {
    const sql = memorySql();
    const trunk = newTrunk(sql);
    trunk.rebuild("req-r");
    begin(trunk);
    return { sql, trunk };
  };

  const expect_of = (attempt_id: string, state: string, change_id = `c_${attempt_id}`, revision = 1) => ({
    attempt_id,
    intent_id: `i_${attempt_id}`,
    change_id,
    revision,
    state,
    agent_kind: "real" as const,
    model: "m",
    intent_text: "work",
    requester: "agent",
    opened_seq: 1,
  });

  const req = (attempt_id: string, change_id = `c_${attempt_id}`, revision = 1) => ({
    attempt_id,
    intent_id: `i_${attempt_id}`,
    change_id,
    revision,
    agent_kind: "real" as const,
    model: "m",
    ops: [],
    read_premises: [],
  });

  it("a pool that never rebuilt answers `invalid_args`", () => {
    const trunk = newTrunk(memorySql());
    expect(trunk.register(req("a_1"))).toEqual({ ok: false, error: "invalid_args" });
  });

  it("an expected in-flight attempt re-opens and classifies against the rebuilt head", () => {
    const { trunk } = ready();
    trunk.rebuildStep({
      cursor: null,
      finish: {
        head_seq: 0,
        head_commit: "h".repeat(40),
        head_tree: "t".repeat(40),
        notes_commit: "",
        green_seq: 0,
        green_commit: "",
        next_batch_id: 1,
        unwitnessed: [],
        expect: [expect_of("a_live", "working")],
      },
    });
    const r = trunk.register(req("a_live"));
    expect(r.ok).toBe(true);
    expect(trunk.pool.attempts.get("a_live")?.state).toBe("working");
    // A repeat answers its state without re-creating.
    const again = trunk.register(req("a_live"));
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.attempt.state).toBe("working");
  });

  it("an accepted attempt whose landing rebuilt is `landed` (T17a)", () => {
    const { trunk } = ready();
    const plan = landingPlan(1);
    plan.landing.change_id = "c_gone";
    trunk.rebuildStep({ cursor: { v: 1, request_id: "req-r", stage: "landings" }, landings: [plan] });
    trunk.rebuildStep({
      cursor: null,
      finish: {
        head_seq: 1,
        head_commit: "c1".padEnd(40, "0"),
        head_tree: "t".repeat(40),
        notes_commit: "",
        green_seq: 0,
        green_commit: "",
        next_batch_id: 2,
        unwitnessed: [],
        expect: [expect_of("a_gone", "accepted", "c_gone")],
      },
    });
    // note(1).revision is 1 — register with the same revision and change id.
    const r = trunk.register(req("a_gone", "c_gone", 1));
    expect(r).toEqual({ ok: false, error: "attempt_closed" });
    expect(trunk.pool.attempts.get("a_gone")?.state).toBe("landed");
  });

  it("an accepted attempt with no matching landing gets the `push_lost` repair (T17)", () => {
    const { trunk } = ready();
    trunk.rebuildStep({
      cursor: null,
      finish: {
        head_seq: 0,
        head_commit: "h".repeat(40),
        head_tree: "t".repeat(40),
        notes_commit: "",
        green_seq: 0,
        green_commit: "",
        next_batch_id: 1,
        unwitnessed: [],
        expect: [expect_of("a_lost", "accepted", "c_lost")],
      },
    });
    const r = trunk.register(req("a_lost", "c_lost", 1));
    expect(r.ok).toBe(true);
    const a = trunk.pool.attempts.get("a_lost");
    expect(a?.state).toBe("going_around");
    expect(a?.go_arounds).toBe(1);
    const h = a?.heads[a.heads.length - 1];
    const items = (h?.body.items ?? []) as Array<{ result?: string; reason?: string }>;
    expect(items.some((i) => i.result === "repair" && i.reason === "push_lost")).toBe(true);
  });
});
