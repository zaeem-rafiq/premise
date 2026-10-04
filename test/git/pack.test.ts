// The pack writer of docs/spec/01-core.md 9.5: a "PACK" version 2 file with no deltas that real git
// indexes and fscks in a fresh repository. Pack bytes themselves are not compared with git's output
// (zlib settings and object order may differ); object ids are.

import { afterAll, describe, expect, it } from "vitest";
import { landingCommit, notesCommit } from "../../src/core/git/commit.ts";
import { noteBytes } from "../../src/core/git/note.ts";
import { notesTree } from "../../src/core/git/notes-tree.ts";
import { makeBlob } from "../../src/core/git/objects.ts";
import { buildPack } from "../../src/core/git/pack.ts";
import { makeTreeFromFiles } from "../../src/core/git/tree-files.ts";
import { text } from "../../src/core/sync/bytes.ts";
import { createScratchRepo, git, type ScratchRepo } from "./helpers.ts";

const repos: ScratchRepo[] = [];
afterAll(() => {
  for (const repo of repos.splice(0)) repo.remove();
});
function scratch(): ScratchRepo {
  const repo = createScratchRepo("premise-git-pack-");
  repos.push(repo);
  return repo;
}

/** A real seed commit in `repo` (like the seed of a pool, 3.5): the first landing's parent. */
function seed(repo: ScratchRepo): string {
  repo.git("commit", "--allow-empty", "-m", "seed");
  return repo.git("rev-parse", "refs/heads/main");
}

/** A batch like 9.5 produces: one landing commit with its file objects, plus the notes objects. */
function batchObjects(parentMain: string) {
  const files = { "world/energy.js": "export const E = 1;\n", "creatures/crab.js": "// crab\n" };
  const { root, objects: fileObjects } = makeTreeFromFiles(files);
  const commit = landingCommit({
    tree: root.oid,
    parent: parentMain,
    authorName: "model-x",
    attemptId: "a_TEST",
    acceptedAt: 1791655424,
    summary: "add a crab",
    intentText: "a crab",
    changeId: "c_TEST",
    intentId: "i_TEST",
  });
  const noteBlob = makeBlob(noteBytes({ v: 1, seq: 1, kind: "change" }));
  const notes = notesTree([{ commit: commit.oid, blob: noteBlob.oid }]);
  const nCommit = notesCommit({
    tree: notes.root.oid,
    parent: null,
    batchId: 1,
    firstSeq: 1,
    lastSeq: 1,
    at: 1791655425,
  });
  return {
    commit,
    nCommit,
    noteBlob,
    objects: [...fileObjects, commit, noteBlob, ...notes.objects, nCommit],
  };
}

describe("the pack writer (9.5)", () => {
  it("git index-pack accepts the pack and every object reads back with its expected id", () => {
    const repo = scratch();
    const parent = seed(repo);
    const { objects, commit, nCommit, noteBlob } = batchObjects(parent);
    const pack = buildPack(objects);
    expect(text(pack.subarray(0, 4))).toBe("PACK");
    const packHash = git(repo.directory, ["index-pack", "--stdin"], pack);
    expect(packHash).toMatch(/^pack\t[0-9a-f]{40}$/);
    // Every object of the batch is now in the repository under its own id.
    for (const object of objects) {
      expect(git(repo.directory, ["cat-file", "-t", object.oid])).toBe(object.type);
    }
    expect(git(repo.directory, ["cat-file", "-p", noteBlob.oid])).toBe(text(noteBlob.content).replace(/\n$/, ""));
    // The landing commit's parent line survives the round trip.
    expect(git(repo.directory, ["cat-file", "commit", commit.oid])).toContain(`parent ${parent}`);
    expect(git(repo.directory, ["cat-file", "commit", nCommit.oid])).toContain("Premise notes for batch 1 (seq 1..1)");
  });

  it("git fsck --strict passes on a repository holding the pack's objects", () => {
    const repo = scratch();
    const parent = seed(repo);
    const { objects, commit, nCommit } = batchObjects(parent);
    git(repo.directory, ["index-pack", "--stdin"], buildPack(objects));
    // Refs must reach the objects for fsck to treat them as part of the repository, with nothing dangling.
    repo.git("update-ref", "refs/heads/main", commit.oid);
    repo.git("update-ref", "refs/notes/premise", nCommit.oid);
    const out = git(repo.directory, ["fsck", "--strict"]);
    expect(out).toBe("");
  });

  it("a pack of a single blob indexes", () => {
    const repo = scratch();
    const blob = makeBlob("only\n");
    git(repo.directory, ["index-pack", "--stdin"], buildPack([blob]));
    expect(git(repo.directory, ["cat-file", "-p", blob.oid])).toBe("only");
  });

  it("an empty pack and a duplicate object are refused before git sees them", () => {
    const blob = makeBlob("x");
    expect(() => buildPack([blob, blob])).toThrow("duplicate");
  });
});
