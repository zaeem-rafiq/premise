// NT1 canonical note bytes, the notes tree's fan-out and the NT2 shrink of docs/spec/01-core.md 3.5.

import { afterAll, describe, expect, it } from "vitest";
import { canonicalJson, noteBytes, shrinkNote } from "../../src/core/git/note.ts";
import { notesTree } from "../../src/core/git/notes-tree.ts";
import { makeBlob } from "../../src/core/git/objects.ts";
import { text, utf8 } from "../../src/core/sync/bytes.ts";
import { blobId } from "../../src/core/sync/sha1.ts";
import { createScratchRepo, git, type ScratchRepo } from "./helpers.ts";

const repos: ScratchRepo[] = [];
afterAll(() => {
  for (const repo of repos.splice(0)) repo.remove();
});
function scratch(): ScratchRepo {
  const repo = createScratchRepo("premise-git-notes-");
  repos.push(repo);
  return repo;
}

describe("NT1 (canonical bytes)", () => {
  it("object keys are sorted at every level, with no whitespace and one trailing LF", () => {
    const note = {
      b: 1,
      a: { d: [{ y: 2, x: 1 }], c: "text" },
      z: "z",
    };
    const bytes = noteBytes(note);
    expect(text(bytes)).toBe('{"a":{"c":"text","d":[{"x":1,"y":2}]},"b":1,"z":"z"}\n');
    // The same record with keys in another order produces the same bytes.
    expect(noteBytes({ z: "z", a: { c: "text", d: [{ x: 1, y: 2 }] }, b: 1 })).toEqual(bytes);
  });

  it("serializes strings and numbers by JSON.stringify rules and non-ASCII as UTF-8", () => {
    const bytes = noteBytes({ k: "emoji 🦀 and\nnewline", n: 0.5 });
    expect(text(bytes)).toBe('{"k":"emoji 🦀 and\\nnewline","n":0.5}\n');
    expect(bytes.byteLength).toBe(utf8('{"k":"emoji 🦀 and\\nnewline","n":0.5}\n').byteLength);
  });

  it("the note blob id is the git blob id of the canonical bytes", () => {
    const repo = scratch();
    const note = { v: 1, seq: 2, kind: "change" };
    const bytes = noteBytes(note);
    expect(makeBlob(bytes).oid).toBe(git(repo.directory, ["hash-object", "-t", "blob", "--stdin"], bytes));
  });

  it("arrays keep their order", () => {
    expect(canonicalJson({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });
});

describe("the notes tree fan-out (3.5)", () => {
  const ZERO = "0".repeat(40);

  it("maps each landing commit id to a note blob at <first 2 hex>/<remaining 38 hex>", () => {
    const repo = scratch();
    const noteBlob = makeBlob(noteBytes({ v: 1 }));
    const commitA = "a".repeat(40);
    const commitB = "b1" + "c".repeat(38); // shares no fan-out directory with commitA? b1 vs aa: distinct.
    const { root, objects } = notesTree([
      { commit: commitA, blob: noteBlob.oid },
      { commit: commitB, blob: noteBlob.oid },
    ]);
    expect(root.oid).not.toBe(ZERO);
    // Real git builds the same two-level tree.
    const dirTree = git(repo.directory, ["mktree", "--missing"], `100644 blob ${noteBlob.oid}\t${"a".repeat(38)}\n`);
    const dirTreeB = git(repo.directory, ["mktree", "--missing"], `100644 blob ${noteBlob.oid}\t${"c".repeat(38)}\n`);
    const realRoot = git(
      repo.directory,
      ["mktree", "--missing"],
      `040000 tree ${dirTree}\taa\n040000 tree ${dirTreeB}\tb1\n`,
    );
    expect(root.oid).toBe(realRoot);
    expect(objects).toHaveLength(3);
  });

  it("two commits in one fan-out directory share one directory tree", () => {
    const noteBlob = makeBlob(noteBytes({ v: 1 }));
    const { root, objects } = notesTree([
      { commit: "ab" + "1".repeat(38), blob: noteBlob.oid },
      { commit: "ab" + "2".repeat(38), blob: noteBlob.oid },
    ]);
    expect(objects).toHaveLength(2); // one directory tree plus the root
    void root;
  });
});

describe("NT2 (a note that is too large)", () => {
  const baseNote = {
    v: 1,
    judgments: [
      { key: "k1", result: "holds", reason: "r".repeat(300) },
      { key: "k2", result: "holds", reason: "r".repeat(300) },
      { key: "k3", result: "repair", reason: "short" },
    ],
    go_arounds: [{ statement: "s".repeat(200) }],
    confirms: [{ statement: "c".repeat(150) }],
    ops: [{ op: "replace", path: "p", old: "o".repeat(200), new: "n".repeat(200), targets: [] }],
  };

  it("a note that fits is returned unchanged", () => {
    const note = { v: 1 };
    const result = shrinkNote(note, 262_144);
    expect(result).toEqual({ ok: true, note });
  });

  it("drops judgments whose result is holds first and records the count", () => {
    // Limit chosen so the note fits once the two holds judgments are gone and `truncated` is recorded.
    const finalShape = {
      ...baseNote,
      judgments: [baseNote.judgments[2]!],
      truncated: { judgments: 2, statements: false, replace_texts: false },
    };
    const limit = noteBytes(finalShape).byteLength + 2;
    expect(noteBytes(baseNote).byteLength).toBeGreaterThan(limit);
    const result = shrinkNote(baseNote, limit);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.note).toMatchObject({
      judgments: [{ key: "k3", result: "repair" }],
      truncated: { judgments: 2, statements: false, replace_texts: false },
    });
    expect(noteBytes(result.note).byteLength).toBeLessThanOrEqual(limit);
  });

  it("cuts every statement to 120 code points when judgments alone are not enough", () => {
    // Limit forces the second step: statements get cut, ops keep their text.
    const step2 = {
      ...baseNote,
      judgments: [baseNote.judgments[2]!],
      go_arounds: [{ statement: "s".repeat(120) }],
      confirms: [{ statement: "c".repeat(120) }],
    };
    const limit =
      noteBytes({ ...step2, truncated: { judgments: 2, statements: true, replace_texts: false } }).byteLength + 2;
    const result = shrinkNote(baseNote, limit);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const note = result.note as Record<string, unknown>;
    const goArrounds = note["go_arounds"] as Array<{ statement: string }>;
    const confirms = note["confirms"] as Array<{ statement: string }>;
    expect(Array.from(goArrounds[0]!.statement)).toHaveLength(120);
    expect(Array.from(confirms[0]!.statement)).toHaveLength(120);
    expect(note["ops"]).toEqual(baseNote.ops);
    expect(note["truncated"]).toEqual({ judgments: 2, statements: true, replace_texts: false });
  });

  it("replaces replace-operation texts by their git blob ids when statements are not enough", () => {
    // A limit that only the third step can satisfy: 200-character texts become 40-character ids.
    const oldText = "o".repeat(200);
    const newText = "n".repeat(200);
    const oldOid = blobId(utf8(oldText));
    const newOid = blobId(utf8(newText));
    const step3 = {
      ...baseNote,
      judgments: [baseNote.judgments[2]!],
      go_arounds: [{ statement: "s".repeat(120) }],
      confirms: [{ statement: "c".repeat(120) }],
      ops: [{ op: "replace", path: "p", old_oid: oldOid, new_oid: newOid, targets: [] }],
    };
    const limit =
      noteBytes({ ...step3, truncated: { judgments: 2, statements: true, replace_texts: true } }).byteLength + 2;
    const result = shrinkNote(baseNote, limit);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const note = result.note as Record<string, unknown>;
    expect(note["ops"]).toEqual(step3.ops);
    expect(note["truncated"]).toEqual({ judgments: 2, statements: true, replace_texts: true });
    expect(noteBytes(result.note).byteLength).toBeLessThanOrEqual(limit);
  });

  it("fails with note_too_large when no step makes the note fit", () => {
    const note = { v: 1, summary: "x".repeat(4000), judgments: [] };
    const result = shrinkNote(note, 100);
    expect(result).toEqual({ ok: false, reason: "note_too_large" });
  });
});
