// The object builders of src/core/git/objects.ts against the ids of docs/spec/01-core.md 3.5 and
// against real git (BP1: expected values come from the specification and real git, never from the
// implementation's own output).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { landingCommit } from "../../src/core/git/commit.ts";
import { makeBlob, makeCommit, makeTree, type TreeEntry } from "../../src/core/git/objects.ts";
import { makeTreeFromFiles } from "../../src/core/git/tree-files.ts";
import { text, utf8 } from "../../src/core/sync/bytes.ts";
import { blobId, gitObjectId, sha1Hex } from "../../src/core/sync/sha1.ts";
import { H } from "../../src/core/sync/h.ts";
import { createScratchRepo, git, gitWithEnv, type ScratchRepo } from "./helpers.ts";

const repos: ScratchRepo[] = [];
afterAll(() => {
  for (const repo of repos.splice(0)) repo.remove();
});
function scratch(): ScratchRepo {
  const repo = createScratchRepo("premise-git-objects-");
  repos.push(repo);
  return repo;
}

/** The id real git computes for `type` + `content` bytes. */
function realObjectId(repo: ScratchRepo, type: string, content: Uint8Array): string {
  return git(repo.directory, ["hash-object", "-t", type, "--stdin"], content);
}

/** The tree id real git writes for a working tree holding `files` (path -> content). */
function realWriteTree(repo: ScratchRepo, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) {
    const full = join(repo.directory, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  repo.git("add", "-A");
  return git(repo.directory, ["write-tree"]);
}

describe("H and the hash primitives (01-core.md 2)", () => {
  it("H is the first 32 lowercase hex characters of SHA-256 over the UTF-8 bytes", () => {
    // Expected values from `echo -n <s> | shasum -a 256` (real SHA-256, not this implementation).
    expect(H("premise")).toBe("d68e3ec2d5ff0cb321539a21d477615a");
    expect(H("")).toBe("e3b0c44298fc1c149afbf4c8996fb924");
    expect(H("🦀")).toBe("7224c588fa9887541bea6fc37a50363c");
    expect(H("a")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("the blob id of a byte string is SHA-1 over 'blob <size>\\0<bytes>'", () => {
    // `printf 'hello\n' | git hash-object --stdin` is the well-known id below.
    expect(blobId(utf8("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    // `echo -n abc | shasum` is the well-known SHA-1 below.
    expect(sha1Hex(utf8("abc"))).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });
});

describe("blob and tree ids vs real git", () => {
  it("an empty file gets the id of git's empty blob", () => {
    const repo = scratch();
    const blob = makeBlob(new Uint8Array(0));
    expect(blob.oid).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(blob.oid).toBe(realObjectId(repo, "blob", blob.content));
  });

  it("a file over 64 KiB gets the id git hash-object computes", () => {
    const repo = scratch();
    const content = new Uint8Array(70_001);
    for (let i = 0; i < content.length; i += 1) content[i] = (i * 31 + 7) & 0xff;
    const blob = makeBlob(content);
    expect(blob.oid).toBe(realObjectId(repo, "blob", content));
  });

  it("a text file gets the id git hash-object computes", () => {
    const repo = scratch();
    const blob = makeBlob("const x = 42;\n");
    expect(blob.oid).toBe(realObjectId(repo, "blob", utf8("const x = 42;\n")));
  });

  it("the empty tree has git's well-known id 4b825dc642cb6eb9a060e54bf8d69288fbee4904 (01-core.md 3.5)", () => {
    const repo = scratch();
    const tree = makeTree([]);
    expect(tree.oid).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    expect(tree.oid).toBe(git(repo.directory, ["mktree"], ""));
  });

  it("a nested file map gets the tree id git write-tree computes", () => {
    const repo = scratch();
    const files = {
      "a/b/c.txt": "deep",
      "a/top.txt": "shallow",
      "README.md": "readme",
    };
    const { root } = makeTreeFromFiles(files);
    expect(root.oid).toBe(realWriteTree(repo, files));
    expect(root.oid).toBe(gitObjectId("tree", root.content));
  });

  it("tree sort order: a file sorts before a directory that shares its prefix (foo.bar vs foo/)", () => {
    const repo = scratch();
    const blob = makeBlob("x");
    const dir = makeTree([{ mode: "40000", name: "sub", oid: blob.oid }]);
    const entries: TreeEntry[] = [
      { mode: "100644", name: "foo.bar", oid: blob.oid },
      { mode: "40000", name: "foo", oid: dir.oid },
    ];
    const tree = makeTree(entries);
    // Real git serializes the same entries through git mktree (--missing: the ids are synthetic).
    const input = `100644 blob ${blob.oid}\tfoo.bar\n040000 tree ${dir.oid}\tfoo\n`;
    expect(tree.oid).toBe(git(repo.directory, ["mktree", "--missing"], input));
    // "foo.bar" (0x2e) sorts before "foo/" (0x2f), so the file entry comes first in the bytes.
    const firstNul = tree.content.indexOf(0);
    expect(text(tree.content.subarray(0, firstNul))).toBe("100644 foo.bar");
  });

  it("a tree built by makeTreeFromFiles matches git write-tree for a file and directory with a common prefix", () => {
    const repo = scratch();
    const files = { "foo.bar": "file", "foo/baz.txt": "in dir" };
    const { root } = makeTreeFromFiles(files);
    expect(root.oid).toBe(realWriteTree(repo, files));
  });
});

describe("the example commit of 01-core.md 3.5", () => {
  const EXAMPLE = {
    tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    parents: ["8a1f0c2d3e4b5a69788796a5b4c3d2e1f0a9b8c7"],
    author: {
      name: "@cf/openai/gpt-oss-120b",
      email: "a_01JB2M7B5D9F3H7K1N5R9T3V7X@agents.premise.invalid",
      timestamp: 1791655424,
    },
    committer: { name: "Premise Trunk", email: "trunk@premise.invalid", timestamp: 1791655424 },
    message:
      "Add a crab that hides when its energy is low\n\n" +
      "Intent: a crab that hides when its energy is low\n\n" +
      "Change-Id: c_01JB2M8Q4T6Y3W9XKZ5R7N1V0P\n" +
      "Intent-Id: i_01JB2M7A0C4E8G2J6M0Q4S8U2W\n",
  };

  it("makeCommit produces the spec's object id 6bd48525d87d048e928a6dce65cd7e033fcbd839", () => {
    const commit = makeCommit(EXAMPLE);
    expect(commit.oid).toBe("6bd48525d87d048e928a6dce65cd7e033fcbd839");
    expect(commit.content.byteLength).toBe(438);
  });

  it("real git gives the spec's bytes the same id and parses exactly the two trailers", () => {
    const repo = scratch();
    const commit = makeCommit(EXAMPLE);
    expect(git(repo.directory, ["hash-object", "-w", "-t", "commit", "--stdin"], commit.content)).toBe(commit.oid);
    const trailers = git(
      repo.directory,
      ["interpret-trailers", "--parse"],
      git(repo.directory, ["cat-file", "commit", commit.oid]),
    );
    expect(trailers).toBe("Change-Id: c_01JB2M8Q4T6Y3W9XKZ5R7N1V0P\nIntent-Id: i_01JB2M7A0C4E8G2J6M0Q4S8U2W");
  });

  it("landingCommit of the same fields produces the same bytes", () => {
    const viaMake = makeCommit(EXAMPLE);
    const viaLanding = landingCommit({
      tree: EXAMPLE.tree,
      parent: EXAMPLE.parents[0]!,
      authorName: "@cf/openai/gpt-oss-120b",
      attemptId: "a_01JB2M7B5D9F3H7K1N5R9T3V7X",
      acceptedAt: 1791655424,
      summary: "Add a crab that hides when its energy is low",
      intentText: "a crab that hides when its energy is low",
      changeId: "c_01JB2M8Q4T6Y3W9XKZ5R7N1V0P",
      intentId: "i_01JB2M7A0C4E8G2J6M0Q4S8U2W",
    });
    expect(viaLanding.oid).toBe(viaMake.oid);
    expect(viaLanding.content).toEqual(viaMake.content);
  });

  it("git commit-tree with the same fields produces the same commit bytes", () => {
    const repo = scratch();
    const message = "a summary\n\nIntent: an intent\n\nChange-Id: c_TEST\nIntent-Id: i_TEST\n";
    const parent = gitWithEnv(
      repo.directory,
      ["commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-m", "seed"],
      { GIT_AUTHOR_DATE: "1791655400 +0000", GIT_COMMITTER_DATE: "1791655400 +0000" },
    );
    const commit = makeCommit({
      tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      parents: [parent],
      author: { name: "model-x", email: "a_TEST@agents.premise.invalid", timestamp: 1791655424 },
      committer: { name: "Premise Trunk", email: "trunk@premise.invalid", timestamp: 1791655424 },
      message,
    });
    const real = gitWithEnv(
      repo.directory,
      ["commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-p", parent, "-F", "-"],
      {
        GIT_AUTHOR_NAME: "model-x",
        GIT_AUTHOR_EMAIL: "a_TEST@agents.premise.invalid",
        GIT_AUTHOR_DATE: "1791655424 +0000",
        GIT_COMMITTER_NAME: "Premise Trunk",
        GIT_COMMITTER_EMAIL: "trunk@premise.invalid",
        GIT_COMMITTER_DATE: "1791655424 +0000",
      },
      message,
    );
    expect(real).toBe(commit.oid);
    // The bytes git stored are the bytes we produced (cat-file strips the trailing LF display adds).
    const stored = git(repo.directory, ["cat-file", "commit", real]);
    expect(utf8(stored + "\n")).toEqual(commit.content);
  });
});
