import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applySchema, metaSet, transcriptAppend } from "../../core/agent/store.ts";
import type { Sql } from "../../protocol/ports.ts";
import type { Env } from "../env.ts";
import type { AttemptCheckpoint, AttemptCheckpointResult } from "../adapters/attempt-repo/index.ts";
import { attemptRepoName } from "../adapters/attempt-repo/index.ts";
import { AttemptRepositoryArchive } from "./attempt-repo.ts";
import { ensureEventsSchema, pendingEvents } from "./events.ts";

const mocks = vi.hoisted(() => ({ push: vi.fn<(input: AttemptCheckpoint) => Promise<AttemptCheckpointResult>>() }));
vi.mock("../adapters/attempt-repo/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/attempt-repo/index.ts")>()),
  artifactsAttemptCheckpointWriter: () => ({ push: mocks.push }),
}));

const databases: DatabaseSync[] = [];
beforeEach(() => {
  mocks.push.mockReset();
  mocks.push.mockResolvedValue({ ok: true, commit_oid: "1".repeat(40) });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sql: Sql = {
    exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
    transaction(run) {
      db.exec("BEGIN");
      try {
        const value = run();
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  applySchema(sql);
  ensureEventsSchema(sql);
  const attemptId = "a_archive_recovery";
  const repo = attemptRepoName(attemptId);
  const ownerKey = "fixture-archive-owner-key";
  let now = 10_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  for (const [key, value] of Object.entries({
    attempt_id: attemptId,
    pool_id: "pool-archive",
    state: "working",
    revision: 0,
    step: 1,
  })) {
    metaSet(sql, key, value);
  }
  transcriptAppend(sql, {
    step: 1,
    role: "user",
    content: `Change the file. ${ownerKey}`,
    tool: null,
    call_id: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    started_at: now,
    ended_at: now,
  });
  let source: Pick<AttemptCheckpoint, "ops" | "premises" | "files"> = {
    ops: [{ op_seq: 1, path: "note.txt", content: ownerKey }],
    premises: [{ kind: "file", key: "note.txt", hash: "a".repeat(40), seq: 0 }],
    files: { "note.txt": `first ${ownerKey}` },
  };
  const background: Promise<unknown>[] = [];
  const enqueues: unknown[] = [];
  const notifications: unknown[] = [];
  let trunkReceipt: string | null = null;
  let nextNotificationReply: Promise<void> | null = null;
  const env = {
    OWNER_KEY: ownerKey,
    ATTEMPTS: {},
    GATE: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (_url: string, options: RequestInit) => {
          enqueues.push(JSON.parse(String(options.body)));
          return Response.json({ ok: true });
        },
      }),
    },
  } as unknown as Env;
  const create = () =>
    new AttemptRepositoryArchive({
      sql,
      env,
      ctx: { waitUntil: (task: Promise<unknown>) => background.push(task) } as unknown as DurableObjectState,
      trunk: {
        post: async (path, body) => {
          if (path === "/internal/attempt-checkpoint") return Response.json(source);
          if (path === "/internal/attempt-repo") {
            notifications.push(body);
            trunkReceipt = (body as { repo: string }).repo;
            const pendingReply = nextNotificationReply;
            nextNotificationReply = null;
            if (pendingReply !== null) await pendingReply;
            return Response.json({ ok: true });
          }
          throw new Error("unexpected archive route");
        },
      },
      arm: async () => {},
      events: async () => {},
    });
  const ready = (archive: AttemptRepositoryArchive) =>
    archive.receive({ attempt_id: attemptId, repo, ms: 50, error: null });
  const drain = async () => {
    for (let batch = 0; background.length > 0; batch += 1) {
      if (batch > 30) throw new Error("archive did not settle");
      await Promise.all(background.splice(0));
    }
  };
  return {
    sql,
    create,
    ready,
    drain,
    repo,
    attemptId,
    ownerKey,
    enqueues,
    notifications,
    receipt: () => trunkReceipt,
    forgetReceipt: () => (trunkReceipt = null),
    holdNextNotificationReply: () => {
      let release!: () => void;
      nextNotificationReply = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    now: () => now,
    setNow: (value: number) => (now = value),
    setFile: (content: string) => {
      source = { ...source, files: { "note.txt": content } };
    },
    setFiles: (files: Record<string, string>) => {
      source = { ...source, files };
    },
  };
}

function storedCheckpoint(sql: Sql): string {
  const rows = sql.exec("SELECT bytes FROM attempt_checkpoint_jobs WHERE slot = 'pending' ORDER BY part").toArray();
  return Buffer.concat(rows.map((row) => row.bytes as Uint8Array)).toString("utf8");
}

/** Let nonblocked background work settle without resolving the deliberately held push. */
async function readyMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
}

describe("AG5, AG7: durable attempt checkpoint delivery", () => {
  it("AG5, S3c: an old receipt reply cannot erase the notification requested after a Trunk rebuild", async () => {
    const f = fixture();
    const archive = f.create();
    archive.start();
    const release = f.holdNextNotificationReply();
    f.ready(archive);
    try {
      await readyMicrotasks();
      expect(f.notifications).toHaveLength(1);
      expect(f.receipt()).toBe(f.repo);
      // The first receipt reached Trunk, but its reply is still in flight when
      // rebuilding removes the row and registration asks for a fresh receipt.
      f.forgetReceipt();
      f.sql.transaction(() => archive.registered());
      archive.kick(f.now());
      expect(f.receipt()).toBeNull();
    } finally {
      release();
      await f.drain();
    }
    expect(f.notifications).toEqual([
      { attempt_id: f.attemptId, repo: f.repo },
      { attempt_id: f.attemptId, repo: f.repo },
    ]);
    expect(f.receipt()).toBe(f.repo);
    expect(pendingEvents(f.sql).map((row) => row.event.type)).toEqual(["attempt.repo"]);
    expect(f.sql.exec("SELECT kind FROM timers WHERE kind = 'repo_notify'").toArray()).toEqual([]);
    expect(f.sql.exec("SELECT v FROM meta WHERE k = 'repo_notified'").toArray()[0]?.v).toBe("1");
  });

  it("AG5, S3c: registration after a Trunk rebuild restores its repository receipt without provisioning or emitting again", async () => {
    const f = fixture();
    const archive = f.create();
    archive.start();
    f.ready(archive);
    await f.drain();
    expect(f.receipt()).toBe(f.repo);
    f.forgetReceipt();
    expect(f.receipt()).toBeNull();
    // Agent's successful registration commits this retry timer with its new mirror.
    f.sql.transaction(() => archive.registered());
    archive.kick(f.now());
    await f.drain();
    expect(f.receipt()).toBe(f.repo);
    expect(f.notifications).toEqual([
      { attempt_id: f.attemptId, repo: f.repo },
      { attempt_id: f.attemptId, repo: f.repo },
    ]);
    expect(f.enqueues).toEqual([{ pool: "pool-archive", attempt_id: f.attemptId }]);
    expect(pendingEvents(f.sql).map((row) => row.event.type)).toEqual(["attempt.repo"]);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("AG5, AG7, S3c: a redacted final checkpoint captured before provisioning survives archive reconstruction", async () => {
    const f = fixture();
    const first = f.create();
    first.start();
    metaSet(f.sql, "state", "stopped");
    first.requestCheckpoint(true);
    first.kick(f.now());
    await f.drain();
    expect(mocks.push).not.toHaveBeenCalled();
    const stored = storedCheckpoint(f.sql);
    expect(stored).not.toContain(f.ownerKey);
    expect(JSON.parse(stored).transcript[0].content).toBe("Change the file. [redacted]");
    f.setNow(20_000);
    const recovered = f.create();
    recovered.start();
    recovered.requestCheckpoint(true);
    expect(f.ready(recovered).status).toBe(200);
    await f.drain();
    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(mocks.push.mock.calls[0]?.[0]).toMatchObject({
      n: 1,
      at: 10_000,
      files: { "note.txt": "first [redacted]" },
      ops: [{ op_seq: 1, path: "note.txt", content: "[redacted]" }],
    });
    expect(f.enqueues).toEqual([{ pool: "pool-archive", attempt_id: f.attemptId }]);
    expect(f.notifications).toEqual([{ attempt_id: f.attemptId, repo: f.repo }]);
    expect(f.ready(recovered).status).toBe(200);
    await f.drain();
    expect(pendingEvents(f.sql).map((row) => row.event.type)).toEqual(["attempt.repo"]);
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  it("AG5, AL2: a failed checkpoint retries its identical durable snapshot after reconstruction", async () => {
    const f = fixture();
    mocks.push
      .mockResolvedValueOnce({ ok: false, error: "attempt_checkpoint_push_failed" })
      .mockResolvedValueOnce({ ok: true, commit_oid: "2".repeat(40) });
    const first = f.create();
    first.start();
    f.ready(first);
    await f.drain();
    first.requestCheckpoint();
    first.kick(f.now());
    await f.drain();
    expect(mocks.push).toHaveBeenCalledTimes(1);
    const sent = mocks.push.mock.calls[0]![0];
    f.setNow(12_000);
    f.setFile("later data must not replace the failed in-flight snapshot");
    const recovered = f.create();
    recovered.kick(f.now());
    await f.drain();
    expect(mocks.push.mock.calls.map(([input]) => input)).toEqual([sent, sent]);
    expect(f.sql.exec("SELECT * FROM attempt_checkpoint_jobs").toArray()).toEqual([]);
  });

  it("AG5, AG7, SQ2: a checkpoint over 2 MiB uses bounded byte rows and restores split UTF-8 after reconstruction", async () => {
    const f = fixture();
    const files = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [
        index === 0 ? "notes/_note-0.txt" : `notes/note-${index}.txt`,
        "🐙".repeat(8_192),
      ]),
    );
    expect(Object.values(files).every((content) => Buffer.byteLength(content) === 32_768)).toBe(true);
    f.setFiles(files);
    const first = f.create();
    first.start();
    metaSet(f.sql, "state", "stopped");
    first.requestCheckpoint(true);
    first.kick(f.now());
    await f.drain();
    expect(mocks.push).not.toHaveBeenCalled();
    const rows = f.sql.exec("SELECT part, bytes FROM attempt_checkpoint_jobs ORDER BY part").toArray();
    const parts = rows.map((row) => row.bytes as Uint8Array);
    expect(parts.reduce((sum, part) => sum + part.byteLength, 0)).toBeGreaterThan(2 * 1_048_576);
    expect(parts.every((part) => part.byteLength > 0 && part.byteLength < 1_048_576)).toBe(true);
    expect(rows.map((row) => row.part)).toEqual(parts.map((_, index) => index));
    // This fixture crosses a multi-byte character: decoding each row separately
    // would corrupt the content. Concatenate bytes before decoding the JSON.
    expect(parts.slice(1).some((part) => (part[0]! & 0xc0) === 0x80)).toBe(true);
    expect(storedCheckpoint(f.sql)).not.toContain(f.ownerKey);
    f.setNow(20_000);
    const recovered = f.create();
    f.ready(recovered);
    await f.drain();
    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(mocks.push.mock.calls[0]?.[0]).toMatchObject({ n: 1, at: 10_000, files });
    expect(f.sql.exec("SELECT * FROM attempt_checkpoint_jobs").toArray()).toEqual([]);
  });

  it("AG5: submits and the final checkpoint coalesce behind one held push without losing the latest file view", async () => {
    const f = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maximum = 0;
    mocks.push.mockImplementation(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      if (mocks.push.mock.calls.length === 1) await held;
      active -= 1;
      return { ok: true, commit_oid: "3".repeat(40) };
    });
    const archive = f.create();
    archive.start();
    f.ready(archive);
    await f.drain();
    try {
      archive.requestCheckpoint();
      archive.kick(f.now());
      await readyMicrotasks();
      expect(mocks.push).toHaveBeenCalledTimes(1);
      expect(active).toBe(1);
      f.setNow(11_000);
      f.setFile("second submission");
      archive.requestCheckpoint();
      archive.kick(f.now());
      await readyMicrotasks();
      f.setNow(12_000);
      f.setFile("final landed content");
      metaSet(f.sql, "state", "landed");
      archive.requestCheckpoint(true);
      archive.kick(f.now());
      await readyMicrotasks();
      expect(mocks.push).toHaveBeenCalledTimes(1);
      expect(active).toBe(1);
    } finally {
      release();
      await f.drain();
    }
    expect(maximum).toBe(1);
    expect(mocks.push.mock.calls.map(([input]) => input.n)).toEqual([1, 3]);
    expect(mocks.push.mock.calls[1]?.[0].files).toEqual({ "note.txt": "final landed content" });
    expect(f.sql.exec("SELECT * FROM attempt_checkpoint_jobs").toArray()).toEqual([]);
  });
});
