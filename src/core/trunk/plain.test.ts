// The plain-merge build of 11.7 over a pool whose landing put identical content at two
// paths: the replayed file map shares one blob across the paths, and the pack `buildPack`
// receives must carry it once — the duplicate used to throw inside `plainBuild` and the
// `plain` timer retried forever. Verified against stock git (BP1): `git index-pack` takes
// the pack apart, `ls-tree` of the commit lists both paths at the shared blob id, and
// `git write-tree` of the same files gives the commit's tree.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createScratchRepo, type ScratchRepo } from "../../../test/support/git.ts";
import type { Sql } from "../../protocol/ports.ts";
import type { ToolRequest } from "../../protocol/tools.ts";
import { utf8 } from "../sync/bytes.ts";
import { blobId } from "../sync/sha1.ts";
import { Trunk } from "./registry.ts";

const databases: DatabaseSync[] = [];
const repos: ScratchRepo[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const repo of repos.splice(0)) repo.remove();
});

function scratch(): ScratchRepo {
  const repo = createScratchRepo("premise-plain-dedupe-");
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

/** A pool on the `auto` policy: a submit lands on the next tick, no card involved. */
function fixture() {
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
      ".premise/policy.json": JSON.stringify({ v: 1, default: "auto" }),
      "world.js": "export const LIMIT = 100;\n",
    },
    { now: () => 1000 },
  );
  trunk.pushOk();
  let n = 0;
  function call(attempt_id: string, tool: ToolRequest["tool"], args: ToolRequest["args"]) {
    const r = trunk.tool({ attempt_id, call_id: `call-${++n}`, tool, args, ack: 0 });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return r;
  }
  return { trunk, call };
}

describe("the plain-merge build (11.7) with shared blobs", () => {
  it("a landing of identical content at two paths builds its commit and reaches plain_through_seq", () => {
    const { trunk, call } = fixture();
    const same = "export const CREATURE = { color: 'red', speed: 4 };\n";
    trunk.openAttempt("D", { intent: "add twin creatures" });
    call("D", "write", { path: "creatures/twin-a.js", content: same });
    call("D", "write", { path: "creatures/twin-b.js", content: same });
    call("D", "submit", { summary: "add twin creatures" });
    trunk.tick();
    trunk.pushOk();
    expect(trunk.pool.attempts.get("D")?.state).toBe("landed");
    expect(trunk.pool.headSeq()).toBe(1);

    const built = trunk.plain();
    if (built.state !== "build") throw new Error(`expected a plain build, got ${built.state}`);
    expect(built.through_seq).toBe(1);

    const repo = scratch();
    git(repo, ["index-pack", "--stdin"], built.pack);
    const blob = blobId(utf8(same));
    const leaves = Object.fromEntries(
      git(repo, ["ls-tree", "-r", built.commit])
        .split("\n")
        .map((l) => l.match(/^(\d+) \w+ ([0-9a-f]{40})\t(.+)$/)!)
        .map((m) => [m[3]!, m[2]!]),
    );
    // Both creature paths resolve to the one shared blob id the pack carried once.
    expect(leaves["creatures/twin-a.js"]).toBe(blob);
    expect(leaves["creatures/twin-b.js"]).toBe(blob);

    // The commit's tree is the tree real git writes for the same file map.
    for (const [path, content] of trunk.pool.fileMapAt(1)) {
      const full = join(repo.directory, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    repo.git("add", "-A");
    expect(git(repo, ["write-tree"])).toBe(built.tree);

    const done = trunk.plainDone({ commit: built.commit, remote: "https://artifacts.invalid/plain" });
    expect(done).toMatchObject({ ok: true });
    expect(trunk.pool.meta.get("plain_through_seq")).toBe("1");
    expect(trunk.pool.meta.get("plain_commit")).toBe(built.commit);
  });
});
