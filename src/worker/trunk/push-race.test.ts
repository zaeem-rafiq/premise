// LP5/LP7: an answer about one batch must never confirm a later batch.
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { Trunk } from "../../core/trunk/registry.ts";
import type { Pusher, Sql } from "../../protocol/ports.ts";
import type { Env } from "../env.ts";
import { outboxRow, pushOutbox, reconcileOnStart, type ApplyPush } from "./push.ts";
import { appendEvent, metaGet, metaSet, sqlOf, timerPut } from "./sql.ts";
// The helper is typechecked in the Node test program. Loading it here at runtime keeps
// Cloudflare's generated ProcessEnv requirements out of that Node-only module.
type ScratchRepo = { directory: string; env: NodeJS.ProcessEnv; git(...args: string[]): string };
const { createScratchRepo } = createRequire(import.meta.url)("../../../test/support/git.ts") as {
  createScratchRepo(prefix: string): ScratchRepo;
};

const MAIN = "refs/heads/main";
const NOTES = "refs/notes/premise";

/** Real git imports each pack and atomically compares both old refs before moving either. */
function gitPusher(repo: ScratchRepo): Pusher {
  const write = (args: string[], input: string | Uint8Array) =>
    execFileSync("git", args, { cwd: repo.directory, env: repo.env, input, stdio: ["pipe", "pipe", "pipe"] });
  return {
    async push({ pack, updates }) {
      try {
        write(["index-pack", "--stdin"], pack);
        write(
          ["update-ref", "--stdin"],
          [
            "start",
            ...updates.map((update) => `update ${update.ref} ${update.new} ${update.old}`),
            "prepare",
            "commit",
            "",
          ].join("\n"),
        );
        return { ok: true, refs: Object.fromEntries(updates.map(({ ref }) => [ref, "ok" as const])) };
      } catch {
        return {
          ok: false,
          kind: "rejected",
          refs: Object.fromEntries(updates.map(({ ref }) => [ref, "ng" as const])),
        };
      }
    },
    async readRefs({ refs }) {
      return Object.fromEntries(
        refs.map((ref) => {
          try {
            return [ref, repo.git("rev-parse", "--verify", "-q", ref)];
          } catch {
            return [ref, null];
          }
        }),
      );
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function holdPush(pusher: Pusher) {
  const applied = deferred<Awaited<ReturnType<Pusher["push"]>>>();
  const release = deferred<void>();
  const delayed: Pusher = {
    ...pusher,
    async push(input) {
      const answer = await pusher.push(input);
      applied.resolve(answer);
      await release.promise;
      return answer;
    },
  };
  return { delayed, applied, release };
}

function fixture(retained: boolean) {
  const db = new DatabaseSync(":memory:");
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
    id: { name: "push-race" },
    storage: { sql: raw, transactionSync: raw.transaction },
  } as unknown as DurableObjectState;
  const session = sqlOf(ctx);
  const opts = { now: () => 1_000 };
  const run = <T>(name: string, call: (trunk: Trunk) => T): T => {
    if (!retained) session.invalidate("reproduction full open");
    return session.run(name, opts, call);
  };
  Trunk.create(
    session,
    { ".premise/policy.json": '{"v":1,"default":"auto"}', "guide.txt": "Guide\n" },
    { ...opts, summary_only: true },
  );
  const apply: ApplyPush = async (name, input) =>
    run(name, (trunk) => {
      if (name === "push_ok") return trunk.pushOk();
      const values = input as { remote_main: "old" | "new" | "other"; remote_notes: "old" | "new" | "other" };
      return trunk.pushResult(values.remote_main, values.remote_notes);
    });
  function accept(id: string) {
    run("open_attempt", (trunk) => trunk.openAttempt(id, { intent: `Add ${id}`, agent_kind: "synthetic" }));
    expect(
      run("tool", (trunk) =>
        trunk.tool({
          attempt_id: id,
          call_id: `${id}-write`,
          tool: "write",
          args: { path: `${id}.txt`, content: `${id}\n` },
          ack: 0,
        }),
      ).ok,
    ).toBe(true);
    expect(
      run("tool", (trunk) =>
        trunk.tool({
          attempt_id: id,
          call_id: `${id}-submit`,
          tool: "submit",
          args: { summary: `Add ${id}` },
          ack: 0,
        }),
      ).ok,
    ).toBe(true);
    run("tick", (trunk) => trunk.tick());
    return outboxRow(ctx)!;
  }
  return { db, ctx, session, run, apply, accept };
}

describe.each([true, false])("push and startup reconciliation overlap with retained=%s", (retained) => {
  it("keeps a later batch accepted until real git confirms its own commits", async () => {
    const f = fixture(retained);
    const repo = createScratchRepo("premise-push-race-");
    const pusher = gitPusher(repo);
    const target = { remote: "local-git", repo: "push-race", token: "local-test", expires_at: null };
    const tokenSource = { writeTarget: async () => target };
    const deps = { tokenSource, pusher };
    const env = {} as Env;
    const captured = deferred<Record<string, string | null>>();
    const release = deferred<void>();
    let reconciliation: Promise<void> | undefined;
    try {
      await pushOutbox(env, f.ctx, f.apply, deps);
      const a = f.accept("a");
      // Git applied A, but Trunk has not received its answer: the ordinary LP7 lost-answer case.
      const pack = f.run("sync", (trunk) => trunk.pool.outboxPack!);
      expect(
        await pusher.push({
          ...target,
          updates: [
            { ref: MAIN, old: a.old_main, new: a.new_main },
            { ref: NOTES, old: a.old_notes || "0".repeat(40), new: a.new_notes },
          ],
          pack,
          atomic: true,
          signal: AbortSignal.timeout(5_000),
        }),
      ).toMatchObject({ ok: true });
      const delayed: Pusher = {
        ...pusher,
        async readRefs(input) {
          const refs = await pusher.readRefs(input);
          captured.resolve(refs);
          await release.promise;
          return refs;
        },
      };
      reconciliation = reconcileOnStart(
        env,
        f.ctx,
        async (input) => {
          f.run("restart", (trunk) => trunk.restart(input));
        },
        { tokenSource, pusher: delayed },
      );
      expect(await captured.promise).toMatchObject({ [MAIN]: a.new_main, [NOTES]: a.new_notes });
      // The normal after-commit push also observes A on git and applies A first.
      await pushOutbox(env, f.ctx, f.apply, deps);
      expect(f.run("sync", (trunk) => trunk.state("a"))).toBe("landed");
      const b = f.accept("b");
      expect(b.old_main).toBe(a.new_main);
      f.session.transaction(() => {
        appendEvent(f.session, 1_001, { type: "trunk.error", code: "transport" });
        timerPut(f.session, "events", "", 2_000);
      });
      // A's delayed read must not mark B landed or delete B's durable pack.
      release.resolve();
      await reconciliation;
      const state = f.run("sync", (trunk) => trunk.state("b"));
      const pending = outboxRow(f.ctx);
      const onMain = repo.git("rev-list", MAIN).split("\n");
      expect(repo.git("rev-parse", MAIN)).toBe(a.new_main);
      expect(onMain).not.toContain(b.new_main);
      expect({ state, pending: pending?.batch_id }).toEqual({ state: "accepted", pending: b.batch_id });
      await pushOutbox(env, f.ctx, f.apply, deps);
      expect(f.run("sync", (trunk) => trunk.state("b"))).toBe("landed");
      expect(repo.git("rev-list", "--count", MAIN)).toBe("3");
      expect(repo.git("notes", "--ref=premise", "list").split("\n")).toHaveLength(2);
    } finally {
      release.resolve();
      await reconciliation;
      f.db.close();
    }
  });

  it("ignores an earlier successful push answer after reconciliation confirms it and a tick accepts another batch", async () => {
    const f = fixture(retained);
    const repo = createScratchRepo("premise-push-answer-race-");
    const pusher = gitPusher(repo);
    const tokenSource = {
      writeTarget: async () => ({ remote: "local-git", repo: "push-race", token: "local-test", expires_at: null }),
    };
    const deps = { tokenSource, pusher };
    const env = {} as Env;
    const held = holdPush(pusher);
    let pushing: Promise<void> | undefined;
    try {
      await pushOutbox(env, f.ctx, f.apply, deps);
      const a = f.accept("a");
      pushing = pushOutbox(env, f.ctx, f.apply, { tokenSource, pusher: held.delayed });
      expect(await held.applied.promise).toMatchObject({ ok: true });
      expect(repo.git("rev-parse", MAIN)).toBe(a.new_main);
      await reconcileOnStart(
        env,
        f.ctx,
        async (input) => {
          f.run("restart", (trunk) => trunk.restart(input));
        },
        deps,
      );
      expect(f.run("sync", (trunk) => trunk.state("a"))).toBe("landed");
      const b = f.accept("b");
      held.release.resolve();
      await pushing;
      expect(f.run("sync", (trunk) => trunk.state("b"))).toBe("accepted");
      expect(outboxRow(f.ctx)?.batch_id).toBe(b.batch_id);
      expect(repo.git("rev-list", MAIN).split("\n")).not.toContain(b.new_main);
      await pushOutbox(env, f.ctx, f.apply, deps);
      expect(f.run("sync", (trunk) => trunk.state("b"))).toBe("landed");
      expect(repo.git("rev-parse", MAIN)).toBe(b.new_main);
      expect(repo.git("rev-list", "--count", MAIN)).toBe("3");
      expect(repo.git("notes", "--ref=premise", "list").split("\n")).toHaveLength(2);
    } finally {
      held.release.resolve();
      await pushing;
      f.db.close();
    }
  });

  it("ignores an old epoch's successful push answer even when the batch identity is unchanged", async () => {
    const f = fixture(retained);
    const repo = createScratchRepo("premise-push-epoch-race-");
    const pusher = gitPusher(repo);
    const tokenSource = {
      writeTarget: async () => ({ remote: "local-git", repo: "push-race", token: "local-test", expires_at: null }),
    };
    const env = {} as Env;
    const held = holdPush(pusher);
    let pushing: Promise<void> | undefined;
    let answersApplied = 0;
    try {
      await pushOutbox(env, f.ctx, f.apply, { tokenSource, pusher });
      const a = f.accept("a");
      pushing = pushOutbox(
        env,
        f.ctx,
        async (name, input) => {
          answersApplied += 1;
          return f.apply(name, input);
        },
        { tokenSource, pusher: held.delayed },
      );
      expect(await held.applied.promise).toMatchObject({ ok: true });
      // Rebuild increments the epoch. Reusing every batch field must still reject the old answer.
      metaSet(f.session, "epoch", Number(metaGet(f.session, "epoch")) + 1);
      held.release.resolve();
      await pushing;
      expect(answersApplied).toBe(0);
      expect(outboxRow(f.ctx)).toEqual(a);
      expect(f.run("sync", (trunk) => trunk.state("a"))).toBe("accepted");
      expect(repo.git("rev-parse", MAIN)).toBe(a.new_main);
    } finally {
      held.release.resolve();
      await pushing;
      f.db.close();
    }
  });
});
