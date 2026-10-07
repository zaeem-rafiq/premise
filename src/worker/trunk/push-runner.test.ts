import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Trunk } from "../../core/trunk/registry.ts";
import { PUSH_BACKOFF_BASE_MS, PUSH_TIMEOUT_MS } from "../../protocol/constants.ts";
import type { Pusher, Sql, TokenSource } from "../../protocol/ports.ts";
import type { Env } from "../env.ts";
import { runPush, type PushBatch } from "./push-runner.ts";
import { outboxRow, pushOutbox, reconcileOnStart, type ApplyPush } from "./push.ts";
import { sqlOf } from "./sql.ts";

const databases: DatabaseSync[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
});

const target = { remote: "https://artifacts.test/pool", repo: "pool", token: "unit-write", expires_at: null };
const batch: PushBatch = { pool_id: "pool", updates: [], pack: new Uint8Array() };
const ok = { ok: true, refs: {} } as const;
const authRefusal = (status: number) =>
  ({ ok: false, kind: "transport", code: "transport", http_status: status, retry_after_ms: null }) as const;
const pusher = () => ({ push: vi.fn<Pusher["push"]>().mockResolvedValue(ok), readRefs: vi.fn<Pusher["readRefs"]>() });

describe("bounded token minting for a push", () => {
  it.each([undefined, 37])("bounds a never-resolving token source with timeoutMs=%s", async (timeoutMs) => {
    const source: TokenSource = { writeTarget: () => new Promise(() => {}) };
    const push = pusher();
    let settled = false;
    const result = runPush(batch, { tokenSource: source, pusher: push, timeoutMs }).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync((timeoutMs ?? PUSH_TIMEOUT_MS) - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await result).toEqual(new Error("Write token mint timed out"));
    expect(push.push).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 403])("bounds a hung refresh after HTTP %s", async (status) => {
    const source = { writeTarget: vi.fn<TokenSource["writeTarget"]>() };
    source.writeTarget.mockResolvedValueOnce(target).mockImplementationOnce(() => new Promise(() => {}));
    const push = pusher();
    push.push.mockResolvedValueOnce(authRefusal(status));
    const result = runPush(batch, { tokenSource: source, pusher: push, timeoutMs: 37 });
    const failure = expect(result).rejects.toThrow("Write token mint timed out");
    await vi.advanceTimersByTimeAsync(37);
    await failure;
    expect(source.writeTarget).toHaveBeenCalledTimes(2);
    expect(push.push).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("mints a fresh token for each push and clears successful mint timers", async () => {
    const source = { writeTarget: vi.fn<TokenSource["writeTarget"]>() };
    source.writeTarget.mockResolvedValueOnce({ ...target, token: "unit-first" });
    source.writeTarget.mockResolvedValueOnce({ ...target, token: "unit-second" });
    const push = pusher();
    await runPush(batch, { tokenSource: source, pusher: push });
    await runPush(batch, { tokenSource: source, pusher: push });
    expect(source.writeTarget.mock.calls).toEqual([["pool"], ["pool"]]);
    expect(push.push.mock.calls.map(([input]) => input.token)).toEqual(["unit-first", "unit-second"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates a mint failure and clears its timer", async () => {
    const source: TokenSource = { writeTarget: () => Promise.reject(new Error("mint unavailable")) };
    const push = pusher();
    await expect(runPush(batch, { tokenSource: source, pusher: push })).rejects.toThrow("mint unavailable");
    expect(push.push).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

function outboxFixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const raw: Sql = {
    exec(query, ...bindings) {
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
    id: { name: "pool" },
    storage: { sql: raw, transactionSync: raw.transaction },
  } as unknown as DurableObjectState;
  const session = sqlOf(ctx);
  const opts = { now: () => Date.now() };
  const trunk = Trunk.create(session, { ".premise/policy.json": '{"v":1,"default":"auto"}' }, opts);
  trunk.pushOk();
  trunk.openAttempt("a", { intent: "Write a guide" });
  expect(
    trunk.tool({
      attempt_id: "a",
      call_id: "write",
      tool: "write",
      args: { path: "guide.txt", content: "Guide\n" },
      ack: 0,
    }).ok,
  ).toBe(true);
  expect(
    trunk.tool({ attempt_id: "a", call_id: "submit", tool: "submit", args: { summary: "Write a guide" }, ack: 0 })
      .result,
  ).toMatchObject({ status: "validated" });
  trunk.tick();
  expect(trunk.state("a")).toBe("accepted");
  const apply: ApplyPush = async (name, input) =>
    session.run(name, opts, (current) => {
      if (name === "push_ok") return current.pushOk();
      const refs = input as { remote_main: "old" | "new" | "other"; remote_notes: "old" | "new" | "other" };
      return current.pushResult(refs.remote_main, refs.remote_notes);
    });
  const events = () =>
    raw
      .exec("SELECT body FROM events_out ORDER BY n")
      .toArray()
      .map((row) => JSON.parse(String(row.body)));
  return { ctx, raw, apply, session, opts, events };
}

describe("outbox recovery after a token mint failure", () => {
  it.each([
    ["initial target", 1, "hang"],
    ["push target", 2, "hang"],
    ["authentication refresh", 3, "hang"],
    ["initial target", 1, "reject"],
    ["push target", 2, "reject"],
    ["authentication refresh", 3, "reject"],
  ] as const)("retries the %s mint (call %s, %s)", async (_stage, failAt, fault) => {
    const f = outboxFixture();
    const before = outboxRow(f.ctx)!;
    const pack = () => f.raw.exec("SELECT * FROM outbox_chunks ORDER BY batch_id, i").toArray();
    const savedPack = pack();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let count = 0;
    let releaseLate!: (value: typeof target) => void;
    const source: TokenSource = {
      writeTarget() {
        count += 1;
        if (count === failAt) {
          return fault === "reject"
            ? Promise.reject(new Error("mint unavailable"))
            : new Promise((resolve) => {
                releaseLate = resolve;
              });
        }
        return Promise.resolve({ ...target, token: `unit-fresh-${count}` });
      },
    };
    const push = pusher();
    if (failAt === 3) push.push.mockResolvedValueOnce(authRefusal(401));
    push.readRefs.mockResolvedValue({ "refs/heads/main": before.old_main, "refs/notes/premise": before.old_notes });
    const deps = { tokenSource: source, pusher: push };
    const pending = pushOutbox({} as Env, f.ctx, f.apply, deps);
    await vi.advanceTimersByTimeAsync(fault === "hang" ? PUSH_TIMEOUT_MS : 0);
    await pending;
    const retry = outboxRow(f.ctx)!;
    expect(retry).toMatchObject({
      batch_id: before.batch_id,
      state: "pending",
      tries: 1,
      rejects: 0,
      next_try: Date.now() + 2 * PUSH_BACKOFF_BASE_MS,
    });
    expect(pack()).toEqual(savedPack);
    expect(f.events()).toContainEqual(expect.objectContaining({ type: "push.retry", error: "transport", tries: 1 }));
    expect(f.events()).toContainEqual(
      expect.objectContaining({ type: "trunk.error", where: "push", code: "transport" }),
    );
    expect(f.raw.exec("SELECT due_at FROM timers WHERE kind = 'push'").toArray()).toEqual([{ due_at: retry.next_try }]);
    expect(f.session.run("sync", f.opts, (current) => current.state("a"))).toBe("accepted");
    expect(log).toHaveBeenCalledTimes(1);
    const requests = push.push.mock.calls.length;
    if (fault === "hang") {
      releaseLate(target);
      await vi.advanceTimersByTimeAsync(0);
      expect(push.push).toHaveBeenCalledTimes(requests);
      expect(outboxRow(f.ctx)).toEqual(retry);
    }
    await pushOutbox({} as Env, f.ctx, f.apply, deps, retry.next_try! - 1);
    expect(push.push).toHaveBeenCalledTimes(requests);
    await pushOutbox({} as Env, f.ctx, f.apply, deps, retry.next_try!);
    expect(outboxRow(f.ctx)).toBeNull();
    expect(f.session.run("sync", f.opts, (current) => current.state("a"))).toBe("landed");
    expect(push.push.mock.calls.at(-1)?.[0].token).toBe(`unit-fresh-${count}`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds the startup mint so the pending batch can reach the push retry path", async () => {
    const f = outboxFixture();
    const restart = vi.fn();
    const push = pusher();
    const source: TokenSource = { writeTarget: () => new Promise(() => {}) };
    const before = outboxRow(f.ctx);
    const pending = reconcileOnStart({} as Env, f.ctx, restart, { tokenSource: source, pusher: push });
    await vi.advanceTimersByTimeAsync(PUSH_TIMEOUT_MS);
    await pending;
    expect(restart).not.toHaveBeenCalled();
    expect(push.readRefs).not.toHaveBeenCalled();
    expect(outboxRow(f.ctx)).toEqual(before);
    expect(f.events()).toContainEqual(
      expect.objectContaining({ type: "trunk.error", where: "restart", code: "transport" }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
