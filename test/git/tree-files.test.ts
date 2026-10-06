// The overlay form of makeTreeFromFiles (06-repos IR5): entries carried by object id and mode
// alone — a symbolic link, a submodule, an untouched blob — are written into the tree unchanged
// and emit no object; a directory the change does not touch reuses its stored tree id, so the
// emitted `objects` are only the ones the remote does not have yet. Expected values come from
// real git (BP1): `git ls-tree`, `git mktree`, `git hash-object`, `git write-tree`.

import { describe, expect, it } from "vitest";
import { afterAll } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync, symlinkSync, chmodSync } from "node:fs";
import { makeBlob, makeTree, type TreeEntry } from "../../src/core/git/objects.ts";
import { buildPack } from "../../src/core/git/pack.ts";
import { makeTreeFromFiles, type FileMapValue } from "../../src/core/git/tree-files.ts";
import { utf8 } from "../../src/core/sync/bytes.ts";
import { blobId } from "../../src/core/sync/sha1.ts";
import { createScratchRepo, git, type ScratchRepo } from "./helpers.ts";

const repos: ScratchRepo[] = [];
afterAll(() => {
  for (const repo of repos.splice(0)) repo.remove();
});
function scratch(): ScratchRepo {
  const repo = createScratchRepo("premise-git-overlay-");
  repos.push(repo);
  return repo;
}

describe("makeTreeFromFiles with entries given by object id (IR5)", () => {
  it("writes a symlink entry by oid+mode 120000, byte-identical to real git's tree", () => {
    const repo = scratch();
    // Build the same tree in a real working directory: a link and a file.
    writeFileSync(join(repo.directory, "a.txt"), "alpha\n");
    symlinkSync("a.txt", join(repo.directory, "link.txt"));
    repo.git("add", "-A");
    const real = git(repo.directory, ["write-tree"]);
    const rows = git(repo.directory, ["ls-tree", "-r", real])
      .split("\n")
      .map((l) => l.match(/^(\d+) (\w+) ([0-9a-f]{40})\t(.+)$/)!)
      .map((m) => ({ mode: m[1]!, type: m[2]!, oid: m[3]!, name: m[4]! }));
    const link = rows.find((r) => r.name === "link.txt")!;
    expect(link.mode).toBe("120000");
    const { root, objects } = makeTreeFromFiles({
      "a.txt": "alpha\n",
      "link.txt": { oid: link.oid, mode: "120000" },
    });
    expect(root.oid).toBe(real);
    // The link's blob is not among the emitted objects — only the file's blob and the root tree.
    expect(objects.some((o) => o.oid === link.oid)).toBe(false);
  });

  it("writes a submodule entry by oid+mode 160000 (a gitlink — the oid is a commit, not a blob)", () => {
    const repo = scratch();
    const sub = scratch();
    // A real commit id to point at.
    writeFileSync(join(sub.directory, "x.txt"), "x\n");
    sub.git("add", "-A");
    sub.git("commit", "-m", "sub", "--quiet");
    const subCommit = git(sub.directory, ["rev-parse", "HEAD"]);
    writeFileSync(join(repo.directory, "a.txt"), "alpha\n");
    repo.git("add", "a.txt");
    // Real git: `git update-index --add --cacheinfo` writes a gitlink without a worktree.
    // (`git add -A` after it would drop the gitlink again, so the index holds it to write-tree.)
    git(repo.directory, ["update-index", "--add", "--cacheinfo", `160000,${subCommit},vendor/lib`]);
    const real = git(repo.directory, ["write-tree"]);
    const { root, objects } = makeTreeFromFiles({
      "a.txt": "alpha\n",
      "vendor/lib": { oid: subCommit, mode: "160000" },
    });
    expect(root.oid).toBe(real);
    // A gitlink emits no object and is never walked into the pack.
    expect(objects.every((o) => o.oid !== subCommit)).toBe(true);
  });

  it("keeps an executable file's 100755 mode by oid, and an unchanged blob emits no object", () => {
    const repo = scratch();
    writeFileSync(join(repo.directory, "run.sh"), "#!/bin/sh\necho hi\n");
    chmodSync(join(repo.directory, "run.sh"), 0o755);
    writeFileSync(join(repo.directory, "a.txt"), "alpha\n");
    repo.git("add", "-A");
    const real = git(repo.directory, ["write-tree"]);
    const scriptOid = git(repo.directory, ["hash-object", "run.sh"]);
    const aOid = git(repo.directory, ["hash-object", "a.txt"]);
    const { root, objects } = makeTreeFromFiles({
      "run.sh": { oid: scriptOid, mode: "100755" },
      "a.txt": { oid: aOid, mode: "100644" },
    });
    expect(root.oid).toBe(real);
    expect(objects.length).toBe(1); // only the root tree — every leaf is by oid
  });
});

describe("makeTreeFromFiles overlay reuse (the thin pack of IR5)", () => {
  it("reuses a stored tree id for a directory outside `fresh`, emits only new objects", () => {
    const repo = scratch();
    mkdirSync(join(repo.directory, "lib"), { recursive: true });
    writeFileSync(join(repo.directory, "lib/keep.js"), "keep\n");
    writeFileSync(join(repo.directory, "top.txt"), "old\n");
    repo.git("add", "-A");
    const before = git(repo.directory, ["write-tree"]);
    const libTreeOid = git(repo.directory, ["rev-parse", `${before}:lib`]);

    // The change: top.txt edited. `lib/` is untouched -> reused by id.
    const keepOid = blobId(utf8("keep\n"));
    const first = makeTreeFromFiles({ "lib/keep.js": "keep\n", "top.txt": "old\n" });
    expect(first.root.oid).toBe(before);
    expect(first.dirs.get("lib")).toBe(libTreeOid);
    expect(first.dirs.get("")).toBe(before);

    const second = makeTreeFromFiles(
      {
        "lib/keep.js": { oid: keepOid, mode: "100644" },
        "top.txt": "new\n",
      },
      { stored: first.dirs, fresh: new Set([""]) }, // only the root changed
    );
    writeFileSync(join(repo.directory, "top.txt"), "new\n");
    repo.git("add", "-A");
    const after = git(repo.directory, ["write-tree"]);
    expect(second.root.oid).toBe(after);
    // Emitted: the new blob, the rebuilt root — and nothing under lib/.
    const emitted = new Set(second.objects.map((o) => o.oid));
    expect(emitted.has(libTreeOid)).toBe(false);
    expect(emitted.has(keepOid)).toBe(false);
    expect(second.dirs.get("lib")).toBeUndefined(); // reused, not rebuilt
    expect(second.dirs.get("")).toBe(after);
  });

  it("a changed nested path keeps the whole subtree whole except the touched chain", () => {
    const repo = scratch();
    const files = {
      "a/b/c.txt": "deep\n",
      "a/b/d.txt": "other\n",
      "a/top.txt": "top\n",
      "z.txt": "z\n",
    };
    const first = makeTreeFromFiles(files);
    for (const [p, c] of Object.entries(files)) {
      const full = join(repo.directory, p);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, c);
    }
    repo.git("add", "-A");
    const realBefore = git(repo.directory, ["write-tree"]);
    expect(first.root.oid).toBe(realBefore);
    const aTree = git(repo.directory, ["rev-parse", `${realBefore}:a`]);
    const abTree = git(repo.directory, ["rev-parse", `${realBefore}:a/b`]);

    // Change only a/b/c.txt: fresh = "", "a", "a/b" — nothing else rebuilds... wait,
    // a/b contains the change, so it IS fresh; a is fresh; root is fresh.
    const cOid = git(repo.directory, ["hash-object", "a/b/c.txt"]);
    const second = makeTreeFromFiles(
      {
        "a/b/c.txt": "changed\n",
        "a/b/d.txt": { oid: git(repo.directory, ["hash-object", "a/b/d.txt"]), mode: "100644" },
        "a/top.txt": { oid: git(repo.directory, ["hash-object", "a/top.txt"]), mode: "100644" },
        "z.txt": { oid: git(repo.directory, ["hash-object", "z.txt"]), mode: "100644" },
      },
      { stored: first.dirs, fresh: new Set(["", "a", "a/b"]) },
    );
    writeFileSync(join(repo.directory, "a/b/c.txt"), "changed\n");
    repo.git("add", "-A");
    const realAfter = git(repo.directory, ["write-tree"]);
    expect(second.root.oid).toBe(realAfter);
    expect(git(repo.directory, ["rev-parse", `${realAfter}:a/b`])).not.toBe(abTree);
    expect(git(repo.directory, ["rev-parse", `${realAfter}:a`])).not.toBe(aTree);
    // The new a/b tree was rebuilt (a/b is fresh); a and root rebuilt; z.txt never emitted.
    const emitted = new Set(second.objects.map((o) => o.oid));
    expect(emitted.has(git(repo.directory, ["hash-object", "z.txt"]))).toBe(false);
  });

  it("a removed path drops out of its directory while siblings keep their ids", () => {
    const files = { "dir/keep.txt": "k\n", "dir/gone.txt": "g\n", "root.txt": "r\n" };
    const first = makeTreeFromFiles(files);
    const second = makeTreeFromFiles(
      {
        "dir/keep.txt": { oid: blobId(utf8("k\n")), mode: "100644" },
        "root.txt": { oid: blobId(utf8("r\n")), mode: "100644" },
      },
      { stored: first.dirs, fresh: new Set(["", "dir"]) }, // dir is fresh: a child was deleted
    );
    const keepOid = blobId(utf8("k\n"));
    const expectedDir = makeTree([{ mode: "100644", name: "keep.txt", oid: keepOid }]);
    expect(second.dirs.get("dir")).toBe(expectedDir.oid);
  });
});

describe("shared content (9.5)", () => {
  it("paths with identical content share one blob, and the pack indexes in real git", () => {
    const repo = scratch();
    const same = "export const TWIN = 1;\n";
    const files = {
      "dup/one.js": same,
      "dup/two.js": same,
      "copy/one.js": same,
      "copy/two.js": same,
      "top.txt": "top\n",
    };
    for (const [path, content] of Object.entries(files)) {
      const full = join(repo.directory, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
    repo.git("add", "-A");
    const real = git(repo.directory, ["write-tree"]);

    const { root, objects } = makeTreeFromFiles(files);
    expect(root.oid).toBe(real);
    const blob = blobId(utf8(same));
    // Four paths share the blob; `dup/` and `copy/` share one subtree tree. Each is emitted once.
    expect(objects.filter((o) => o.oid === blob)).toHaveLength(1);
    const oids = objects.map((o) => o.oid);
    expect(new Set(oids).size).toBe(oids.length);
    // Stock git indexes the pack and resolves every shared path to the one blob id.
    git(repo.directory, ["index-pack", "--stdin"], buildPack(objects));
    const leaves = Object.fromEntries(
      git(repo.directory, ["ls-tree", "-r", root.oid])
        .split("\n")
        .map((l) => l.match(/^(\d+) \w+ ([0-9a-f]{40})\t(.+)$/)!)
        .map((m) => [m[3]!, m[2]!]),
    );
    for (const path of ["dup/one.js", "dup/two.js", "copy/one.js", "copy/two.js"]) {
      expect(leaves[path]).toBe(blob);
    }
  });
});
