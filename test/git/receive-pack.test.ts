// The end-to-end check of docs/spec/01-core.md 9.5 and LP4: one hand-built receive-pack request
// updates `refs/heads/main` and `refs/notes/premise` on a local `git http-backend` server, stock
// git sees both refs, a stale old id is refused with a per-ref reason, and `git notes` reads the
// note blob of NT1 back.

import { afterAll, describe, expect, it } from "vitest";
import { landingCommit, notesCommit } from "../../src/core/git/commit.ts";
import { noteBytes } from "../../src/core/git/note.ts";
import { notesTree, type NoteMapping } from "../../src/core/git/notes-tree.ts";
import { makeBlob, ZERO_OID, type GitObject } from "../../src/core/git/objects.ts";
import { buildPack } from "../../src/core/git/pack.ts";
import {
  buildReceivePackRequest,
  parseReceivePackReport,
  RECEIVE_PACK_CAPABILITIES,
  type RefCommand,
} from "../../src/core/git/receive-pack.ts";
import { makeTreeFromFiles } from "../../src/core/git/tree-files.ts";
import { utf8 } from "../../src/core/sync/bytes.ts";
import {
  createScratchRepo,
  createServerRepo,
  git,
  gitAsync,
  gitBytes,
  postReceivePack,
  repoRoot,
  startGitServer,
  type GitHttpServer,
  type ScratchRepo,
} from "./helpers.ts";

const repos: ScratchRepo[] = [];
let server: GitHttpServer | undefined;

function serverRepo(): ScratchRepo {
  const repo = createServerRepo("premise-git-push-server-");
  repos.push(repo);
  return repo;
}
function scratch(): ScratchRepo {
  const repo = createScratchRepo("premise-git-push-client-");
  repos.push(repo);
  return repo;
}
afterAll(async () => {
  await server?.close();
  for (const repo of repos.splice(0)) repo.remove();
});

type Batch = {
  commit: GitObject;
  noteBlob: GitObject;
  nCommit: GitObject;
  pack: Uint8Array;
};

/** One batch per 9.5: a landing commit, its note blob, and the notes commit over all notes so far. */
function buildBatch(input: {
  seq: number;
  at: number;
  parentMain: string;
  notesParent: string | null;
  /** Every (landing commit, note blob) pair the new notes tree must contain, new one included. */
  notes: { commit: string; blob: GitObject }[];
}): Batch {
  const { root, objects } = makeTreeFromFiles({
    "world/energy.js": `export const E = ${input.seq};\n`,
    "creatures/crab.js": `// crab ${input.seq}\n`,
  });
  const commit = landingCommit({
    tree: root.oid,
    parent: input.parentMain,
    authorName: "model-x",
    attemptId: `a_TEST${input.seq}`,
    acceptedAt: input.at,
    summary: `landing ${input.seq}`,
    intentText: `intent ${input.seq}`,
    changeId: `c_TEST${input.seq}`,
    intentId: `i_TEST${input.seq}`,
  });
  const note = { v: 1, seq: input.seq, kind: "change", batch: { id: 1, index: 0, size: 1 } };
  const noteBlob = makeBlob(noteBytes(note));
  const mappings: NoteMapping[] = [
    ...input.notes.map((n) => ({ commit: n.commit, blob: n.blob.oid })),
    { commit: commit.oid, blob: noteBlob.oid },
  ];
  const notes = notesTree(mappings);
  const nCommit = notesCommit({
    tree: notes.root.oid,
    parent: input.notesParent,
    batchId: input.seq,
    firstSeq: input.seq,
    lastSeq: input.seq,
    at: input.at,
  });
  const extraBlobs = input.notes.map((n) => n.blob);
  return {
    commit,
    noteBlob,
    nCommit,
    pack: buildPack([...objects, commit, noteBlob, ...extraBlobs, ...notes.objects, nCommit]),
  };
}

describe("a receive-pack request updates main and the notes ref together (9.5, LP4)", () => {
  it("updates both refs in one request; stock git sees them and git notes reads NT1 bytes", async () => {
    const repo = serverRepo();
    server = server ?? (await startGitServer(repoRoot(repo)));
    const remote = server.remoteFor(repo);
    // The pool's seed commit (seq 0): the first landing's parent, so the pack's commits are
    // connected to history the server already has.
    repo.git("commit", "--allow-empty", "-m", "seed");
    const seed = repo.git("rev-parse", "refs/heads/main");
    const batch = buildBatch({ seq: 1, at: 1791655424, parentMain: seed, notesParent: null, notes: [] });
    const commands: RefCommand[] = [
      { ref: "refs/heads/main", oldOid: seed, newOid: batch.commit.oid },
      { ref: "refs/notes/premise", oldOid: ZERO_OID, newOid: batch.nCommit.oid },
    ];
    const request = buildReceivePackRequest(commands, RECEIVE_PACK_CAPABILITIES, batch.pack);
    const response = await postReceivePack(remote, request);
    expect(response.status).toBe(200);
    const report = parseReceivePackReport(response.body);
    expect(report.unpackOk).toBe(true);
    expect(report.results).toEqual([
      { ref: "refs/heads/main", ok: true },
      { ref: "refs/notes/premise", ok: true },
    ]);

    // Stock git sees both refs.
    const client = scratch();
    const listed = await gitAsync(client.directory, ["ls-remote", remote]);
    expect(listed).toContain(`${batch.commit.oid}\trefs/heads/main`);
    expect(listed).toContain(`${batch.nCommit.oid}\trefs/notes/premise`);

    // The objects arrived: the commit and the note blob read back by id.
    expect(git(repo.directory, ["cat-file", "-t", batch.commit.oid])).toBe("commit");
    expect(git(repo.directory, ["cat-file", "-t", batch.noteBlob.oid])).toBe("blob");

    // `git notes --ref=premise show <commit>` prints exactly the NT1 note bytes.
    const shown = gitBytes(repo.directory, ["notes", "--ref=premise", "show", batch.commit.oid]);
    expect(new Uint8Array(shown)).toEqual(
      noteBytes({ v: 1, seq: 1, kind: "change", batch: { id: 1, index: 0, size: 1 } }),
    );
  });

  it("a second request with the correct old ids updates both refs again (LP6)", async () => {
    const repo = serverRepo();
    server = server ?? (await startGitServer(repoRoot(repo)));
    const remote = server.remoteFor(repo);
    repo.git("commit", "--allow-empty", "-m", "seed");
    const seed = repo.git("rev-parse", "refs/heads/main");
    const first = buildBatch({ seq: 1, at: 1791655424, parentMain: seed, notesParent: null, notes: [] });
    const r1 = await postReceivePack(
      remote,
      buildReceivePackRequest(
        [
          { ref: "refs/heads/main", oldOid: seed, newOid: first.commit.oid },
          { ref: "refs/notes/premise", oldOid: ZERO_OID, newOid: first.nCommit.oid },
        ],
        RECEIVE_PACK_CAPABILITIES,
        first.pack,
      ),
    );
    expect(parseReceivePackReport(r1.body).results).toEqual([
      { ref: "refs/heads/main", ok: true },
      { ref: "refs/notes/premise", ok: true },
    ]);
    const second = buildBatch({
      seq: 2,
      at: 1791655500,
      parentMain: first.commit.oid,
      notesParent: first.nCommit.oid,
      notes: [{ commit: first.commit.oid, blob: first.noteBlob }],
    });
    const r2 = await postReceivePack(
      remote,
      buildReceivePackRequest(
        [
          { ref: "refs/heads/main", oldOid: first.commit.oid, newOid: second.commit.oid },
          { ref: "refs/notes/premise", oldOid: first.nCommit.oid, newOid: second.nCommit.oid },
        ],
        RECEIVE_PACK_CAPABILITIES,
        second.pack,
      ),
    );
    const report2 = parseReceivePackReport(r2.body);
    expect(report2.unpackOk).toBe(true);
    expect(report2.results).toEqual([
      { ref: "refs/heads/main", ok: true },
      { ref: "refs/notes/premise", ok: true },
    ]);
    const client = scratch();
    const listed = await gitAsync(client.directory, ["ls-remote", remote]);
    expect(listed).toContain(`${second.commit.oid}\trefs/heads/main`);
    expect(listed).toContain(`${second.nCommit.oid}\trefs/notes/premise`);
    // The earlier note is still reachable: its mapping is in the second notes tree.
    expect(git(repo.directory, ["notes", "--ref=premise", "show", first.commit.oid])).toContain('"seq":1');
  });

  it("a stale old id is refused and the report gives the server's reason per ref", async () => {
    const repo = serverRepo();
    server = server ?? (await startGitServer(repoRoot(repo)));
    const remote = server.remoteFor(repo);
    // The server holds a real commit on refs/heads/main.
    repo.git("commit", "--allow-empty", "-m", "seed");
    const head = repo.git("rev-parse", "refs/heads/main");
    const stale = "f".repeat(40);
    // The batch's commit is well-formed (parented on the real head); only the command's old id is stale.
    const batch = buildBatch({ seq: 1, at: 1791655424, parentMain: head, notesParent: null, notes: [] });
    const response = await postReceivePack(
      remote,
      buildReceivePackRequest(
        [
          { ref: "refs/heads/main", oldOid: stale, newOid: batch.commit.oid },
          { ref: "refs/notes/premise", oldOid: ZERO_OID, newOid: batch.nCommit.oid },
        ],
        RECEIVE_PACK_CAPABILITIES,
        batch.pack,
      ),
    );
    expect(response.status).toBe(200);
    const report = parseReceivePackReport(response.body);
    const main = report.results.find((r) => r.ref === "refs/heads/main");
    const notes = report.results.find((r) => r.ref === "refs/notes/premise");
    expect(main).toBeDefined();
    expect(main!.ok).toBe(false);
    if (main !== undefined && !main.ok) expect(main.error.length).toBeGreaterThan(0);
    // Real git without the atomic capability applies the other command anyway.
    expect(notes).toEqual({ ref: "refs/notes/premise", ok: true });
    // The refused ref kept its value; the accepted one moved.
    expect(repo.git("rev-parse", "refs/heads/main")).toBe(head);
    expect(repo.git("rev-parse", "refs/notes/premise")).toBe(batch.nCommit.oid);
  });
});
