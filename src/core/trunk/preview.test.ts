import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createScratchRepo, type ScratchRepo } from "../../../test/support/git.ts";
import type { Sql } from "../../protocol/ports.ts";
import type { ToolRequest } from "../../protocol/tools.ts";
import { utf8 } from "../sync/bytes.ts";
import { blobId } from "../sync/sha1.ts";
import { Trunk } from "./registry.ts";
import { previewBuild, previewDone } from "./preview.ts";

const databases: DatabaseSync[] = [];
const repos: ScratchRepo[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const repo of repos.splice(0)) repo.remove();
});

function scratch(): ScratchRepo {
  const repo = createScratchRepo("premise-preview-dedupe-");
  repos.push(repo);
  return repo;
}

/** `git` in the scratch repository, with optional stdin (a pack for `index-pack`). */
function git(repo: ScratchRepo, args: string[], input?: Uint8Array): string {
  const r = spawnSync("git", args, {
    cwd: repo.directory,
    env: repo.env,
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  return r.stdout.replace(/\r?\n$/, "");
}

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
  const trunk = Trunk.create(
    sql,
    {
      ".premise/policy.json": JSON.stringify({ v: 1, default: "held", tiers: [{ paths: ["other.js"], tier: "auto" }] }),
      "world.js": "export const LIMIT = 100;\n",
    },
    { features: { held }, now: () => 1_000 },
  );
  let n = 0;
  function call(attempt_id: string, tool: ToolRequest["tool"], args: ToolRequest["args"]) {
    const r = trunk.tool({ attempt_id, call_id: `call-${++n}`, tool, args, ack: 0 });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return r;
  }
  trunk.openAttempt("S", { intent: "change the limit", agent_kind: "real" });
  call("S", "read", { path: "world.js" });
  call("S", "replace", { path: "world.js", old: "100", new: "1" });
  call("S", "submit", { summary: "Change the limit" });
  expect(trunk.pool.attempts.get("S")?.state).toBe("held");
  return { trunk, call, sql, card: trunk.pool.cards[0]! };
}

describe("preview snapshots (PV1-PV3, HD1)", () => {
  it("freezes head at card open across delayed builds and a restart", () => {
    const { trunk, call, sql, card } = fixture();
    const original = previewBuild(trunk.pool);
    expect(original.state).toBe("build");
    trunk.openAttempt("J", { intent: "add a disjoint module", agent_kind: "real" });
    call("J", "write", { path: "other.js", content: "export const unrelated = true;\n" });
    call("J", "submit", { summary: "Add other" });
    trunk.pushOk();
    trunk.tick();
    trunk.pushOk();
    expect(trunk.pool.headSeq()).toBe(1);
    const reopened = Trunk.open(sql, { now: () => 8_000 });
    expect(previewBuild(reopened.pool)).toEqual(original);
    expect(reopened.pool.cards[0]!.body.preview?.before).toEqual(card.body.preview?.before);
  });

  it("a push failure sets an error without disabling the card and retry clears it", () => {
    const { trunk, card } = fixture();
    const built = previewBuild(trunk.pool);
    if (built.state !== "build") throw new Error("preview missing");
    const p = built.previews[0]!;
    previewDone(trunk.pool, { retried: [p.submit_id] });
    expect(card.body.preview?.error).toBe("preview_push_failed");
    expect(card.body.preview?.after).toEqual({});
    expect(card.body.options.map((o) => o.id)).toEqual(["land", "decline"]);
    previewDone(trunk.pool, { results: [{ submit_id: p.submit_id, commit: p.commit }] });
    expect(card.body.preview?.error).toBeNull();
    expect(card.body.preview?.after.S).toEqual({ repo: "plain", commit: p.commit });
    expect(previewBuild(trunk.pool)).toEqual({ state: "idle" });
  });

  it("a snapshot read failure records a build error and leaves Land usable", () => {
    const { trunk, card } = fixture();
    const fileMapAt = trunk.pool.fileMapAt;
    trunk.pool.fileMapAt = () => {
      throw new Error("snapshot storage unavailable");
    };
    const built = trunk.preview();
    trunk.pool.fileMapAt = fileMapAt;
    if (built.state !== "build") throw new Error("preview missing");
    expect(built.previews).toEqual([]);
    expect(built.errors).toEqual([{ submit_id: card.body.submit_ids.S, error: "preview_build_failed" }]);
    trunk.previewDone({ epoch: built.epoch, results: built.errors });
    expect(card.body.preview?.after).toEqual({});
    expect(card.body.preview?.error).toBe("preview_build_failed");
    expect(card.body.options.map((option) => option.id)).toEqual(["land", "decline"]);
    trunk.pushOk();
    trunk.owner({ action: "land", attempt: "S" });
    trunk.tick();
    expect(trunk.pool.headSeq()).toBe(1);
  });

  it("ignores a completion that does not match the built commit", () => {
    const { trunk, card } = fixture();
    const built = previewBuild(trunk.pool);
    if (built.state !== "build") throw new Error("preview missing");
    previewDone(trunk.pool, { results: [{ submit_id: built.previews[0]!.submit_id, commit: "f".repeat(40) }] });
    expect(card.body.preview?.after).toEqual({});
    expect(previewBuild(trunk.pool)).toEqual(built);
  });

  it("does not attach a late completion to a stale card or its replacement", () => {
    const { trunk, call, card } = fixture();
    const built = trunk.preview();
    if (built.state !== "build") throw new Error("preview missing");
    call("S", "replace", { path: "world.js", old: "LIMIT = 1", new: "LIMIT = 2" });
    call("S", "submit", { summary: "Updated limit" });
    trunk.previewDone({ results: [{ submit_id: built.previews[0]!.submit_id, commit: built.previews[0]!.commit }] });
    expect(card.open).toBe(false);
    expect(card.body.preview?.after).toEqual({});
    expect(trunk.pool.cards[1]!.body.preview?.after).toEqual({});
    const next = trunk.preview();
    if (next.state !== "build") throw new Error("replacement preview missing");
    expect(next.previews).toHaveLength(1);
    expect(next.previews[0]!.commit).not.toBe(built.previews[0]!.commit);
  });

  it("each race candidate has its own preview and a new submit replaces only its preview", () => {
    const { trunk, call } = fixture();
    trunk.openAttempt("A", { intent: "add other", intent_id: "race", race: true });
    trunk.openAttempt("B", { intent: "add other", intent_id: "race", race: true });
    const card = trunk.pool.cards.find((c) => c.kind === "race")!;
    expect(card.body.title).toBe('2 attempts at "add other" are still working.');
    call("A", "write", { path: "other.js", content: "export const A = 1;\n" });
    call("A", "submit", { summary: "Option A" });
    expect(card.body.title).toBe('1 of 2 attempts at "add other" is ready. Choose it, or wait for the others.');
    call("B", "write", { path: "other.js", content: "export const B = 1;\n" });
    call("B", "submit", { summary: "Option B" });
    const built = trunk.preview();
    if (built.state !== "build") throw new Error("previews missing");
    trunk.previewDone({ results: built.previews.map((p) => ({ submit_id: p.submit_id, commit: p.commit })) });
    const oldA = card.body.preview!.after.A;
    const oldB = card.body.preview!.after.B;
    expect(oldA).toBeDefined();
    expect(oldB).toBeDefined();
    expect(oldA).not.toEqual(oldB);
    call("A", "replace", { path: "other.js", old: "A = 1", new: "A = 2" });
    expect(card.body.title).toBe('1 of 2 attempts at "add other" is ready. Choose it, or wait for the others.');
    call("A", "submit", { summary: "Updated A" });
    expect(card.body.preview!.after.A).toBeUndefined();
    expect(card.body.preview!.after.B).toEqual(oldB);
    const next = trunk.preview();
    if (next.state !== "build") throw new Error("replacement preview missing");
    expect(next.previews).toHaveLength(1);
    expect(next.previews[0]!.commit).not.toBe(oldA!.commit);
  });

  it("an explicit disabled build overrides the stored feature setting", () => {
    const { sql } = fixture(true);
    expect(Trunk.open(sql, { features: { held: false } }).pool.featuresHeld).toBe(false);
  });

  it("a refused rebuild leaves the card's pending preview intact", () => {
    const { trunk } = fixture();
    const built = trunk.preview();
    expect(
      trunk.rebuildBegin({
        epoch: 2,
        head_commit: trunk.pool.meta.get("head_commit")!,
        notes_commit: null,
        green_commit: null,
      }),
    ).toMatchObject({ ok: false });
    expect(trunk.preview()).toEqual(built);
  });

  it("before stays empty until the seed has actually pushed", () => {
    const { trunk, card, call } = fixture();
    expect(card.body.preview?.before).toBeNull();
    trunk.pushOk();
    call("S", "replace", { path: "world.js", old: "LIMIT = 1", new: "LIMIT = 2" });
    call("S", "submit", { summary: "Updated limit" });
    expect(trunk.pool.cards[1]!.body.preview?.before).toEqual({
      repo: "main",
      commit: trunk.pool.meta.get("landed_commit"),
    });
  });

  it("a rebuild drops queued previews and rejects an old epoch's completion", () => {
    const { trunk } = fixture();
    const built = trunk.preview();
    if (built.state !== "build") throw new Error("preview missing");
    trunk.pushOk();
    trunk.rebuild("preview-rebuild");
    expect(
      trunk.rebuildBegin({
        epoch: 2,
        head_commit: trunk.pool.meta.get("head_commit")!,
        notes_commit: null,
        green_commit: null,
      }),
    ).toMatchObject({ ok: true });
    expect(trunk.pool.meta.has("preview_pending")).toBe(false);
    expect(
      trunk.previewDone({
        epoch: built.epoch,
        results: built.previews.map((p) => ({ submit_id: p.submit_id, commit: p.commit })),
      }),
    ).toMatchObject({ ok: false, error: { code: "stale" } });
    expect(trunk.pool.cards).toEqual([]);
    expect(trunk.preview()).toEqual({ state: "idle" });
  });

  it("does not build previews for the minimal held form", () => {
    const { trunk, card } = fixture(false);
    expect(card.body.preview).toBeNull();
    expect(previewBuild(trunk.pool)).toEqual({ state: "idle" });
  });

  it("a change writing a file identical to an existing one still builds (the pack carries the blob once)", () => {
    const { trunk, call } = fixture();
    // D writes a new path whose content equals the seed's world.js: head plus the submitted
    // operations holds the same blob under two paths (PV1).
    const same = "export const LIMIT = 100;\n";
    trunk.openAttempt("D", { intent: "mirror the limit file", agent_kind: "real" });
    call("D", "write", { path: "mirror.js", content: same });
    call("D", "submit", { summary: "Mirror world.js" });
    const card = trunk.pool.cards.find((c) => c.attempt_ids.includes("D"))!;
    const sid = card.body.submit_ids.D!;
    const built = trunk.preview();
    if (built.state !== "build") throw new Error("preview missing");
    expect(built.errors).toEqual([]);
    const push = built.previews.find((x) => x.submit_id === sid);
    expect(push, "a preview for D").toBeDefined();
    // Stock git takes the pack apart and reads the commit's tree: both paths at the shared id.
    const repo = scratch();
    git(repo, ["index-pack", "--stdin"], push!.pack);
    const blob = blobId(utf8(same));
    const leaves = Object.fromEntries(
      git(repo, ["ls-tree", "-r", push!.commit])
        .split("\n")
        .map((l) => l.match(/^(\d+) \w+ ([0-9a-f]{40})\t(.+)$/)!)
        .map((m) => [m[3]!, m[2]!]),
    );
    expect(leaves["world.js"]).toBe(blob);
    expect(leaves["mirror.js"]).toBe(blob);
  });
});
