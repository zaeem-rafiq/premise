// The pure half of "rebuild from Artifacts" (01-core 3.6): trailers, notes, the landing row a
// commit + note describe, the unwitnessed-commit tree diff, and the undo links. Every expected
// value is the specification's or real git's, never the implementation's echo (BP1).

import { describe, expect, it } from "vitest";
import type { Note } from "../../protocol/note.ts";
import { MAX_FILE_BYTES } from "../../protocol/constants.ts";
import {
  applyUndoes,
  blobFits,
  changedSeqs,
  landingFromDiff,
  landingFromNote,
  opBlobRefs,
  parseCommitMessage,
  parseNote,
  type RemoteCommit,
} from "./plan.ts";

const commit = (over: Partial<RemoteCommit> = {}): RemoteCommit => ({
  hash: "a".repeat(40),
  treeHash: "b".repeat(40),
  message: "",
  parents: [],
  committedAt: 1_700_000_000,
  authorName: "A Model",
  authorEmail: "a_1@agents.premise.invalid",
  ...over,
});

const note = (over: Partial<Note> = {}): Note => ({
  v: 1,
  hash_version: "ast1",
  seq: 1,
  kind: "change",
  change_id: "c_a1",
  revision: 1,
  intent: { id: "i_1", text: "add a fish", requester: "owner", created_at: "2024-01-01T00:00:00.000Z" },
  attempt: {
    id: "a_1",
    agent: "real",
    model: "model-a",
    repo: "a_1-repo",
    opened_seq: 0,
    steps: 4,
    model_calls: 5,
    tokens_in: 100,
    tokens_out: 60,
  },
  summary: "a fish",
  premises: [{ kind: "file", key: "world/energy.js", hash: "h1", seq: 0, read: true, edit: true, derived: false }],
  writes: [
    { kind: "file", key: "creatures/fish.js", old: "absent", new: "f15h" },
    { kind: "entity", key: "creatures/fish.js#swim", old: "absent", new: "eh1" },
  ],
  ops: [
    { op: "write", path: "creatures/fish.js", blob: "b100b" },
    { op: "replace", path: "world/energy.js", old_oid: "o1d", new_oid: "n3w", targets: ["world/energy.js#MAX"] },
  ],
  go_arounds: [],
  confirms: [],
  judgments: [],
  checks: [],
  policy: { tier: "auto", approved_by: null, approved_at: null, option: null, risk: null },
  pull_backs: 1,
  batch: { id: 7, index: 0, size: 1 },
  timing: {
    opened_at: "2024-01-01T00:00:00.000Z",
    submitted_at: "2024-01-01T00:01:00.000Z",
    accepted_at: "2024-01-01T00:02:00.000Z",
  },
  ...over,
});

describe("parseCommitMessage (CM4 trailers)", () => {
  it("reads Change-Id, Intent-Id, Intent and every Undoes trailer", () => {
    const t = parseCommitMessage(
      "add a fish\n\nChange-Id: c_a1\nIntent-Id: i_1\nIntent: add a fish\nUndoes: deadbeef\nUndoes: cafe\n",
    );
    expect(t).toEqual({ changeId: "c_a1", intentId: "i_1", intentText: "add a fish", undoes: ["deadbeef", "cafe"] });
  });
  it("a bare message has no trailers", () => {
    expect(parseCommitMessage("seed").changeId).toBeNull();
    expect(parseCommitMessage("seed").undoes).toEqual([]);
  });
});

describe("parseNote", () => {
  it("accepts a v:1 note and rejects malformed blobs", () => {
    expect(parseNote(JSON.stringify(note()))?.seq).toBe(1);
    expect(parseNote("not json")).toBeNull();
    expect(parseNote(JSON.stringify({ v: 2, seq: 1, kind: "change" }))).toBeNull();
    expect(parseNote(JSON.stringify({ v: 1, seq: 1.5, kind: "change" }))).toBeNull();
    expect(parseNote(JSON.stringify({ v: 1, seq: 1, kind: "mystery" }))).toBeNull();
    expect(parseNote(JSON.stringify(["v", 1]))).toBeNull();
  });
});

describe("landingFromNote (step 4)", () => {
  it("builds the landing row and file diffs from the note, not the trees", () => {
    const plan = landingFromNote(commit(), 3, note({ seq: 3 }), "note-oid", true, () => "x");
    expect(plan.landing).toMatchObject({
      seq: 3,
      kind: "change",
      change_id: "c_a1",
      attempt_id: "a_1",
      intent_id: "i_1",
      batch_id: 7,
      note_oid: "note-oid",
      submitted_at: Date.parse("2024-01-01T00:01:00.000Z"),
      accepted_at: Date.parse("2024-01-01T00:02:00.000Z"),
      pushed_at: 1_700_000_000_000,
      undone_by: null,
    });
    // `landing_files` are the note's `file` writes only — the entity write does not make a row.
    expect(plan.files).toEqual([{ path: "creatures/fish.js", old_oid: "absent", new_oid: "f15h" }]);
    // Window rows: writes (entity rows too), premises, and ops with blob refs resolved.
    expect(plan.writes).toHaveLength(2);
    expect(plan.premises).toHaveLength(1);
    const ops = (plan.ops ?? []).map((body) => JSON.parse(body) as Record<string, unknown>);
    expect(ops[0]).toMatchObject({ op: "write", path: "creatures/fish.js", content: "x", base_oid: "b100b" });
    expect(ops[1]).toMatchObject({ op: "replace", path: "world/energy.js", old: "x", new: "x" });
    expect(plan.attempt).toMatchObject({
      attempt_id: "a_1",
      agent_kind: "real",
      model: "model-a",
      landed_seq: 3,
      pull_backs: 1,
      revision: 1,
      steps: 4,
      model_calls: 5,
    });
    expect(plan.intent).toMatchObject({ intent_id: "i_1", text: "add a fish", requester: "owner" });
  });

  it("drops the companion rows outside the undo window (RB2)", () => {
    const plan = landingFromNote(commit(), 9, note(), "n", false, () => "");
    expect(plan.writes).toBeNull();
    expect(plan.premises).toBeNull();
    expect(plan.ops).toBeNull();
    // … but the file rows stand — `landing_files` is the step-5 head-history map's source.
    expect(plan.files).toHaveLength(1);
  });
});

describe("landingFromDiff (unwitnessed commits)", () => {
  it("diffs parent and child trees and keeps the commit's trailers", () => {
    const plan = landingFromDiff(
      commit({ message: "hand move\n\nChange-Id: c_hand\nIntent-Id: i_h\n", parents: ["p".repeat(40)] }),
      4,
      { "a.js": ["o1", "100644"], "gone.js": ["g9", "100644"] },
      { "a.js": ["n2", "100644"], "new.js": ["n1", "100755"] },
    );
    expect(plan.landing.kind).toBe("change");
    expect(plan.landing.change_id).toBe("c_hand");
    expect(plan.landing.attempt_id).toBe("a_1");
    expect(plan.files).toEqual([
      { path: "a.js", old_oid: "o1", new_oid: "n2" },
      { path: "gone.js", old_oid: "g9", new_oid: "absent" },
      { path: "new.js", old_oid: "absent", new_oid: "n1" },
    ]);
    expect(plan.writes).toEqual([]);
    expect(plan.attempt?.model).toBe("A Model");
    expect(plan.attempt?.agent_kind).toBe("real");
  });

  it("an Undoes trailer makes the landing kind `undo`; the trunk author names no attempt", () => {
    const plan = landingFromDiff(
      commit({
        message: "revert\n\nUndoes: abc",
        authorName: "Premise Trunk",
        authorEmail: "trunk@premise.invalid",
      }),
      5,
      {},
      {},
    );
    expect(plan.landing.kind).toBe("undo");
    expect(plan.attempt).toBeNull();
    expect(plan.landing.change_id).toBe("u_5");
  });
});

describe("opBlobRefs / blobFits / changedSeqs / applyUndoes", () => {
  it("opBlobRefs names the note's blob references (NT2)", () => {
    expect(opBlobRefs(note())).toEqual(["b100b", "o1d", "n3w"]);
    expect(opBlobRefs(note({ ops: [{ op: "write", path: "p", content: "c" }] }))).toEqual([]);
  });

  it("blobFits is RB4's cap: at most MAX_FILE_BYTES", () => {
    expect(blobFits(MAX_FILE_BYTES)).toBe(true);
    expect(blobFits(MAX_FILE_BYTES + 1)).toBe(false);
  });

  it("changedSeqs keeps the last landing that touched each path", () => {
    const a = landingFromNote(commit(), 2, note(), "n", false, () => "");
    const b = landingFromNote(
      commit(),
      5,
      note({ writes: [{ kind: "file", key: "creatures/fish.js", old: "x", new: "y" }] }),
      "n",
      false,
      () => "",
    );
    const seqs = changedSeqs([a, b]);
    expect(seqs.get("creatures/fish.js")).toBe(5);
    expect(seqs.get("world/energy.js")).toBeUndefined();
  });

  it("applyUndoes links the target landing's undone_by to the undo's seq", () => {
    const target = commit({ hash: "t".repeat(40) });
    const undo = commit({ hash: "u".repeat(40), message: "undo\n\nUndoes: " + "t".repeat(40) });
    const plans = [
      landingFromNote(target, 1, note({ seq: 1 }), "n1", false, () => ""),
      landingFromNote(undo, 2, note({ seq: 2, kind: "undo" }), "n2", false, () => ""),
    ];
    applyUndoes([commit(), target, undo], plans);
    expect(plans[0]!.landing.undone_by).toBe(2);
    expect(plans[1]!.landing.undone_by).toBeNull();
  });
});
