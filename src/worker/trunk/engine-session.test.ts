import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Sql } from "../../protocol/ports.ts";
import type { ToolRequest } from "../../protocol/tools.ts";
import { Trunk } from "../../core/trunk/registry.ts";
import { EngineSession } from "./engine-session.ts";
import { ScriptedTriage } from "../../swarm/scripted-triage.ts";
import { appendEvent, confirmEvents, metaDelete, metaSet, timerDelete, timerPut } from "./sql.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function fixture(extraFiles: Record<string, string> = {}, scriptedTriage = false) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const reads: string[] = [];
  const raw: Sql = {
    exec(query, ...bindings) {
      reads.push(query);
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
  const session = new EngineSession(raw);
  const opts = { now: () => 1_000, syncTriage: scriptedTriage ? ScriptedTriage : undefined };
  const trunk = Trunk.create(
    session,
    { ".premise/policy.json": '{"v":1,"default":"auto"}', "guide.txt": "Guide\n", ...extraFiles },
    opts,
  );
  trunk.pushOk();
  const run = <T>(name: string, call: (trunk: Trunk) => T) => session.run(name, opts, call);
  run("open_attempt", (t) => t.openAttempt("probe", { intent: "Read and write", agent_kind: "synthetic" }));
  let n = 0;
  const read = () =>
    run("tool", (t) =>
      t.tool({ attempt_id: "probe", call_id: `read-${++n}`, tool: "read", args: { path: "guide.txt" }, ack: 0 }),
    );
  reads.length = 0;
  return { db, raw, session, run, read, reads, opts };
}
const opens = (reads: string[]) => reads.filter((q) => q === "SELECT * FROM attempts ORDER BY attempt_id").length;

describe("Trunk engine session", () => {
  it("counts every engine call and identifies an invalidating statement without its values", () => {
    const { session, read } = fixture();
    read();
    session.exec("UPDATE attempts SET attempt_repo = 'private--value' WHERE attempt_id = 'probe'");
    read();
    expect(session.metrics()).toEqual({
      calls: { open_attempt: { reused: 0, reopened: 1 }, tool: { reused: 1, reopened: 1 } },
      invalidations: { "shell: UPDATE attempts SET attempt_repo = ? WHERE attempt_id = ?": 1 },
    });
    const snapshot = session.metrics();
    snapshot.calls.tool!.reused = 99;
    expect(session.metrics().calls.tool!.reused).toBe(1);
  });
  it("retains the pool across shell timers, event acknowledgments and trunk.error numbering", () => {
    const { session, read, reads } = fixture();
    expect(read().ok).toBe(true);
    session.transaction(() => {
      appendEvent(session, 1_500, { type: "trunk.error", code: "transport" });
      timerPut(session, "events", "", 2_000);
      metaSet(session, "events_failures", "1");
    });
    const next = Number(session.exec("SELECT v FROM meta WHERE k = 'next_event_n'").toArray()[0]!.v);
    confirmEvents(session, next - 1);
    timerDelete(session, "events", "");
    metaDelete(session, "events_failures");
    expect(read().ok).toBe(true);
    expect(opens(reads)).toBe(0);
    session.run("open_attempt", { now: () => 2_000 }, (t) => {
      expect(t.pool.meta.has("events_failures")).toBe(false);
      t.openAttempt("next", { intent: "More work" });
    });
    expect(session.exec("SELECT MIN(n) AS n FROM events_out").toArray()[0]!.n).toBe(next);
  });

  it("reopens after external engine-table writes and independent facade calls", () => {
    const { session, run, reads } = fixture();
    session.exec("UPDATE attempts SET attempt_repo = ? WHERE attempt_id = ?", "restored-repo", "probe");
    run("sync", (t) => expect(t.pool.attempts.get("probe")!.attempt_repo).toBe("restored-repo"));
    expect(opens(reads)).toBe(1);
    Trunk.open(session).stop({ attempt_id: "probe", reason: "cancelled" });
    run("sync", (t) => expect(t.state("probe")).toBe("stopped"));
    expect(opens(reads)).toBe(3);
  });

  it("mirrors outbox retries and rejects before reconciliation without reopening", () => {
    const { session, run, read, reads } = fixture();
    run("tool", (t) =>
      t.tool({
        attempt_id: "probe",
        call_id: "write",
        tool: "write",
        args: { path: "new.txt", content: "new\n" },
        ack: 0,
      }),
    );
    run("tool", (t) =>
      t.tool({ attempt_id: "probe", call_id: "submit", tool: "submit", args: { summary: "New file" }, ack: 0 }),
    );
    run("tick", (t) => t.tick());
    const batch = run("sync", (t) => {
      expect(t.pool.outbox?.state).toBe("pending");
      return t.pool.outbox!.batch_id;
    });
    session.exec(
      "UPDATE outbox SET tries = ?, next_try = ?, last_error = ? WHERE batch_id = ?",
      2,
      5_000,
      "transport",
      batch,
    );
    for (let n = 0; n < 5; n += 1) session.exec("UPDATE outbox SET rejects = rejects + 1 WHERE batch_id = ?", batch);
    run("push_result", (t) => {
      expect(t.pool.outbox).toMatchObject({ tries: 2, next_try: 5_000, last_error: "transport", rejects: 5 });
      expect(t.pushResult("old", "old")).toBe("pause");
    });
    expect(session.exec("SELECT tries, rejects, next_try FROM outbox").toArray()[0]).toEqual({
      tries: 2,
      rejects: 5,
      next_try: 5_000,
    });
    expect(opens(reads)).toBe(0);
    // Unrecognized outbox writes still discard the working set.
    session.exec("UPDATE outbox SET tries = 7");
    read();
    expect(opens(reads)).toBe(1);
  });

  it("preserves a heads-up receipt through attempt persistence and duplicate delivery", () => {
    const { session, run, read, reads } = fixture({}, true);
    expect(read().ok).toBe(true);
    run("open_attempt", (t) => t.openAttempt("changer", { intent: "Change guide", agent_kind: "synthetic" }));
    expect(
      run("tool", (t) =>
        t.tool({ attempt_id: "changer", call_id: "read-guide", tool: "read", args: { path: "guide.txt" }, ack: 0 }),
      ).ok,
    ).toBe(true);
    run("tool", (t) =>
      t.tool({
        attempt_id: "changer",
        call_id: "change",
        tool: "write",
        args: { path: "guide.txt", content: "Changed\n" },
        ack: 0,
      }),
    );
    run("tool", (t) =>
      t.tool({ attempt_id: "changer", call_id: "submit", tool: "submit", args: { summary: "Guide" }, ack: 0 }),
    );
    run("tick", (t) => t.tick());
    const hn = run("sync", (t) => {
      expect(t.pool.attempts.get("probe")!.heads).toHaveLength(1);
      return t.pool.attempts.get("probe")!.heads[0]!.hn;
    });
    const query = "UPDATE heads_ups SET received_at = ? WHERE attempt_id = ? AND hn = ? AND received_at IS NULL";
    session.exec(query, 2_000, "probe", hn);
    session.exec(query, 3_000, "probe", hn);
    expect(read().ok).toBe(true);
    expect(
      session.exec("SELECT received_at FROM heads_ups WHERE attempt_id = ? AND hn = ?", "probe", hn).toArray()[0]
        ?.received_at,
    ).toBe(2_000);
    expect(opens(reads)).toBe(0);
  });

  it("discards mirrored outbox changes when their shell transaction rolls back", () => {
    const { session, run, reads } = fixture();
    run("tool", (t) =>
      t.tool({
        attempt_id: "probe",
        call_id: "write",
        tool: "write",
        args: { path: "new.txt", content: "new\n" },
        ack: 0,
      }),
    );
    run("tool", (t) =>
      t.tool({ attempt_id: "probe", call_id: "submit", tool: "submit", args: { summary: "New file" }, ack: 0 }),
    );
    run("tick", (t) => t.tick());
    const batch = run("sync", (t) => t.pool.outbox!.batch_id);
    expect(() =>
      session.transaction(() => {
        session.exec("UPDATE outbox SET rejects = rejects + 1 WHERE batch_id = ?", batch);
        throw new Error("rollback retry");
      }),
    ).toThrow("rollback retry");
    run("sync", (t) => expect(t.pool.outbox!.rejects).toBe(0));
    expect(opens(reads)).toBe(1);
  });

  it("accounts for synchronous native alarm writes without swallowing later bypass writes", async () => {
    const { session, raw, run, reads } = fixture();
    await session.alarmWrite(() => {
      raw.exec("CREATE TABLE _cf_METADATA (key INTEGER PRIMARY KEY, value BLOB)");
      raw.exec("INSERT INTO _cf_METADATA VALUES (1, 2000)");
      return Promise.resolve();
    });
    run("sync", (t) => expect(t.state("probe")).toBe("opened"));
    expect(opens(reads)).toBe(0);
    let resolve!: () => void;
    const pending = session.alarmWrite(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    raw.exec("UPDATE attempts SET attempt_repo = 'after-alarm' WHERE attempt_id = 'probe'");
    resolve();
    await pending;
    run("sync", (t) => expect(t.pool.attempts.get("probe")!.attempt_repo).toBe("after-alarm"));
    expect(opens(reads)).toBe(1);
    raw.exec("UPDATE attempts SET attempt_repo = 'before-alarm' WHERE attempt_id = 'probe'");
    await session.alarmWrite(() => Promise.resolve());
    run("sync", (t) => expect(t.pool.attempts.get("probe")!.attempt_repo).toBe("before-alarm"));
    expect(opens(reads)).toBe(2);
    await expect(session.alarmWrite(() => Promise.reject(new Error("alarm failed")))).rejects.toThrow("alarm failed");
    run("sync", (t) => expect(t.state("probe")).toBe("opened"));
    expect(opens(reads)).toBe(3);
  });

  it("detects bypass writes even when followed by a permitted shell write", () => {
    const { db, session, run, reads } = fixture();
    db.exec("UPDATE attempts SET attempt_repo = 'raw-repo' WHERE attempt_id = 'probe'");
    timerPut(session, "events", "", 2_000);
    run("sync", (t) => expect(t.pool.attempts.get("probe")!.attempt_repo).toBe("raw-repo"));
    expect(opens(reads)).toBe(1);
    db.exec("CREATE TABLE external_marker (n INTEGER)");
    run("sync", (t) => expect(t.state("probe")).toBe("opened"));
    expect(opens(reads)).toBe(2);
  });

  it("discards memory after a late SQL failure and retries from committed tables", () => {
    const { db, session, read, run } = fixture();
    // Abort at persistence after the tool has changed state, premises, counters and events.
    db.exec("CREATE TRIGGER fail_save BEFORE INSERT ON attempts BEGIN SELECT RAISE(ABORT, 'save rejected'); END");
    expect(() => read()).toThrow("save rejected");
    expect(
      session.exec("SELECT state, last_call_id FROM attempts WHERE attempt_id = 'probe'").toArray()[0],
    ).toMatchObject({ state: "opened", last_call_id: null });
    expect(session.exec("SELECT * FROM premises").toArray()).toEqual([]);
    db.exec("DROP TRIGGER fail_save");
    run("sync", (t) => {
      expect(t.state("probe")).toBe("opened");
      expect(t.pool.attempts.get("probe")!.premises.size).toBe(0);
    });
    expect(read().ok).toBe(true);
    expect(Trunk.open(session).pool.attempts.get("probe")!.premises.size).toBe(1);
  });

  it("reloads after a rolled-back shell transaction and unknown metadata mutations", () => {
    const { session, run, reads } = fixture();
    expect(() =>
      session.transaction(() => {
        metaSet(session, "pool_state", "paused");
        throw new Error("rollback shell");
      }),
    ).toThrow("rollback shell");
    run("sync", (t) => expect(t.pool.meta.get("pool_state")).toBe("ready"));
    expect(opens(reads)).toBe(1);
    session.exec("UPDATE meta SET v = 'paused' WHERE k = 'pool_state'");
    run("sync", (t) => expect(t.pool.meta.get("pool_state")).toBe("paused"));
    expect(opens(reads)).toBe(2);
  });

  it("uses each call's clock and gates, and eviction reconstructs the same durable state", () => {
    const { session, raw, read } = fixture();
    expect(read().ok).toBe(true);
    const inspect = (t: Trunk) => ({
      state: t.state("probe"),
      head: t.pool.headSeq(),
      premises: [...t.pool.attempts.get("probe")!.premises],
    });
    const snapshot = session.run("sync", { now: () => 2_500, killed: true }, (t) => {
      expect(t.pool.now()).toBe(2_500);
      expect(t.pool.killed).toBe(true);
      return inspect(t);
    });
    session.run("sync", { now: () => 3_000 }, (t) => {
      expect(t.pool.now()).toBe(3_000);
      expect(t.pool.killed).toBe(false);
    });
    const fresh = new EngineSession(raw);
    expect(fresh.run("sync", {}, inspect)).toEqual(snapshot);
  });

  it("uses the full-open path around rebuild and import boundaries", () => {
    const { session, run, reads } = fixture();
    run("import_step", (t) => {
      t.pool.sql.exec("UPDATE attempts SET attempt_repo = 'import-result' WHERE attempt_id = 'probe'");
    });
    run("sync", (t) => expect(t.pool.attempts.get("probe")!.attempt_repo).toBe("import-result"));
    expect(opens(reads)).toBe(2);
    session.exec("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", "steps:probe", "99");
    run("sync", (t) => expect(t.pool.steps.get("probe")).toBe(99));
    expect(opens(reads)).toBe(3);
  });
  it("does not retain a pool whose triggers can change engine tables from shell writes", () => {
    const { db, session, run } = fixture();
    db.exec(
      "CREATE TRIGGER shell_side_effect AFTER INSERT ON timers BEGIN UPDATE attempts SET attempt_repo = 'trigger-repo' WHERE attempt_id = 'probe'; END",
    );
    run("sync", (t) => expect(t.pool.attempts.get("probe")!.attempt_repo).toBeNull());
    timerPut(session, "events", "", 2_000);
    run("sync", (t) => expect(t.pool.attempts.get("probe")!.attempt_repo).toBe("trigger-repo"));
  });

  it("reopens for multi-statement writes and for changed or omitted call options", () => {
    const { session, run, reads, opts } = fixture();
    session.exec("DELETE FROM timers; DELETE FROM events_out");
    run("sync", (t) => expect(t.state("probe")).toBe("opened"));
    expect(opens(reads)).toBe(1);
    session.run("sync", { ...opts, constants: { MAX_BATCH: 1 } }, (t) => expect(t.pool.K.MAX_BATCH).toBe(1));
    run("sync", (t) => expect(t.pool.K.MAX_BATCH).toBe(64));
    session.run("sync", {}, (t) => expect(t.pool.now()).toBe(1));
  });
  it("detects raw DROP and identical recreation even when total_changes and schema match", () => {
    const { db, run, reads } = fixture();
    const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'attempts'").get()!.sql);
    const writes = db.prepare("SELECT total_changes() AS n").get()!.n;
    db.exec("DROP TABLE attempts");
    db.exec(ddl);
    expect(db.prepare("SELECT total_changes() AS n").get()!.n).toBe(writes);
    run("sync", (t) => expect(t.state("probe")).toBeUndefined());
    expect(opens(reads)).toBe(1);
  });

  it("reopens while triage is pending instead of retaining call-local frozen maps", () => {
    const { run, reads } = fixture({ "world.js": "export const LIMIT = 100;\n" });
    let n = 0;
    const call = (id: string, tool: ToolRequest["tool"], args: ToolRequest["args"]) => {
      const response = run("tool", (trunk) =>
        trunk.tool({ attempt_id: id, call_id: `triage-${++n}`, tool, args, ack: 0 }),
      );
      expect(response.ok, JSON.stringify(response)).toBe(true);
    };
    run("open_attempt", (trunk) => trunk.openAttempt("reader", { intent: "Read the limit", agent_kind: "real" }));
    call("reader", "read", { path: "world.js", entity: "LIMIT" });
    call("reader", "write", { path: "reader.js", content: "export const colour = 'blue';\n" });
    run("open_attempt", (trunk) => trunk.openAttempt("changer", { intent: "Change the limit" }));
    call("changer", "read", { path: "world.js" });
    call("changer", "write", { path: "world.js", content: "export const LIMIT = 1;\n" });
    call("changer", "submit", { summary: "Change LIMIT" });
    run("tick", (trunk) => {
      trunk.tick();
      expect(trunk.pool.pendingTriage.length).toBeGreaterThan(0);
      expect(trunk.pool.pendingTriage[0]!.it).not.toBeNull();
    });
    reads.length = 0;
    run("sync", (trunk) => {
      expect(trunk.pool.pendingTriage.length).toBeGreaterThan(0);
      expect(trunk.pool.pendingTriage[0]!.it).toBeNull();
    });
    expect(opens(reads)).toBe(1);
  });
});
