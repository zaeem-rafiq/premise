// The push-side adapters of track 1B (04-build-plan.md 2.2): the receive-pack pusher, the
// Artifacts token source and the notes reader, plus the push runner that ties them together.
// A local `git http-backend` server stands in for Artifacts and a fake binding stands in for
// the token mint. Every test names the acceptance statement or rule id it proves.

import { afterAll, describe, expect, it } from "vitest";
import { parseRefAdvertisement } from "../../src/core/git/advertisement.ts";
import { landingCommit, notesCommit } from "../../src/core/git/commit.ts";
import { noteBytes } from "../../src/core/git/note.ts";
import { notesTree, type NoteMapping } from "../../src/core/git/notes-tree.ts";
import { makeBlob, ZERO_OID, type GitObject } from "../../src/core/git/objects.ts";
import { buildPack } from "../../src/core/git/pack.ts";
import { makeTreeFromFiles } from "../../src/core/git/tree-files.ts";
import { text } from "../../src/core/sync/bytes.ts";
import type { TokenSource } from "../../src/protocol/ports.ts";
import { artifactsNotesReader, type ArtifactsNotesRepo } from "../../src/worker/adapters/notes-reader/notes-reader.ts";
import { receivePackPusher } from "../../src/worker/adapters/pusher/pusher.ts";
import {
  artifactsTokenSource,
  type ArtifactsLike,
  type ArtifactsRepoLike,
} from "../../src/worker/adapters/token-source/token-source.ts";
import { runPush } from "../../src/worker/trunk/push-runner.ts";
import {
  createServerRepo,
  getInfoRefs,
  git,
  gitBytes,
  repoRoot,
  startGitServer,
  type GitGate,
  type GitHttpServer,
  type ScratchRepo,
} from "./helpers.ts";

const repos: ScratchRepo[] = [];
const servers: GitHttpServer[] = [];

function serverRepo(): ScratchRepo {
  const repo = createServerRepo("premise-git-adapter-server-");
  repos.push(repo);
  return repo;
}

async function gitServer(repo: ScratchRepo, gate?: GitGate): Promise<GitHttpServer> {
  const server = await startGitServer(repoRoot(repo), { gate });
  servers.push(server);
  return server;
}

afterAll(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const repo of repos.splice(0)) repo.remove();
});

// ---- A landing batch (01-core.md 9.5) -------------------------------------

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
  const note = { v: 1, seq: input.seq, kind: "change", batch: { id: input.seq, index: 0, size: 1 } };
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

// ---- The fake Artifacts binding -------------------------------------------

type MintCall = { scope: string; ttl: number | undefined };

/**
 * A fake `env.POOLS`: every `get` returns a repo handle whose `createToken` records the call
 * and hands out `tokens[n]` in order, and whose `info` reports the test server's remote.
 */
function fakePools(
  remote: string,
  tokens: string[],
): {
  source: TokenSource;
  mints: MintCall[];
  plaintexts: string[];
  gets: string[];
  expiresAt: string;
} {
  const mints: MintCall[] = [];
  const plaintexts: string[] = [];
  const gets: string[] = [];
  const expiresAt = "2026-10-06T00:00:00.000Z";
  const binding: ArtifactsLike = {
    get: (name) => {
      gets.push(name);
      const repo: ArtifactsRepoLike = {
        createToken: (scope, ttl) => {
          mints.push({ scope, ttl });
          const plaintext = tokens[mints.length - 1] ?? `madeup_extra${mints.length}`;
          plaintexts.push(plaintext);
          return Promise.resolve({ plaintext, expiresAt });
        },
        info: () => Promise.resolve({ remote }),
      };
      return Promise.resolve(repo);
    },
  };
  return { source: artifactsTokenSource(binding), mints, plaintexts, gets, expiresAt };
}

/** A fake repository handle for the notes reader, serving the real objects of `dir`. */
function gitBackedRepo(dir: string): ArtifactsNotesRepo {
  return {
    readCommit: (hash) => {
      try {
        const content = git(dir, ["cat-file", "commit", hash]);
        const treeHash = /^tree ([0-9a-f]{40})$/m.exec(content)?.[1];
        return Promise.resolve(treeHash === undefined ? null : { treeHash });
      } catch {
        return Promise.resolve(null);
      }
    },
    readTree: (hash) => {
      try {
        return Promise.resolve(
          git(dir, ["ls-tree", hash])
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => {
              const tab = line.indexOf("\t");
              const [mode, type, oid] = line.slice(0, tab).split(" ");
              return { name: line.slice(tab + 1), mode: mode ?? "", type: type ?? "", hash: oid ?? "" };
            }),
        );
      } catch {
        return Promise.resolve(null);
      }
    },
    readBlob: (hash) => {
      try {
        return Promise.resolve(new Blob([gitBytes(dir, ["cat-file", "blob", hash])]));
      } catch {
        return Promise.resolve(null);
      }
    },
  };
}

const requestsOf = (server: GitHttpServer, method: string) => server.requests.filter((r) => r.method === method);

describe("the token source (S2)", () => {
  it("S2b: writeTarget mints with the explicit 'write' scope and returns remote, repo, token and expiry", async () => {
    const pools = fakePools("http://127.0.0.1:9/repo", ["madeup_fake?expires=1791504000"]);
    const target = await pools.source.writeTarget("pool-a");
    expect(pools.gets).toEqual(["pool-a"]);
    expect(pools.mints).toEqual([{ scope: "write", ttl: 3_600 }]);
    expect(target.repo).toBe("pool-a");
    expect(target.remote).toBe("http://127.0.0.1:9/repo");
    expect(target.token).toBe("madeup_fake?expires=1791504000");
    expect(target.expires_at).toBe(Date.parse("2026-10-06T00:00:00.000Z"));
  });

  it("LP5a: every writeTarget call mints a fresh token", async () => {
    const pools = fakePools("http://127.0.0.1:9/repo", ["token-one", "token-two"]);
    const first = await pools.source.writeTarget("pool-a");
    const second = await pools.source.writeTarget("pool-a");
    expect(pools.mints).toHaveLength(2);
    expect(first.token).toBe("token-one");
    expect(second.token).toBe("token-two");
  });
});

describe("the pusher (S1a, LP4)", () => {
  it("S1a: one receive-pack request per batch updates refs/heads/main and refs/notes/premise", async () => {
    const repo = serverRepo();
    const server = await gitServer(repo);
    const remote = server.remoteFor(repo);
    repo.git("commit", "--allow-empty", "-m", "seed");
    const seed = repo.git("rev-parse", "refs/heads/main");
    const batch = buildBatch({ seq: 1, at: 1791655424, parentMain: seed, notesParent: null, notes: [] });
    const pools = fakePools(remote, ["madeup_token"]);

    const outcome = await runPush(
      {
        pool_id: "pool-a",
        updates: [
          { ref: "refs/heads/main", old: seed, new: batch.commit.oid },
          { ref: "refs/notes/premise", old: ZERO_OID, new: batch.nCommit.oid },
        ],
        pack: batch.pack,
      },
      { tokenSource: pools.source, pusher: receivePackPusher() },
    );

    expect(outcome.result).toEqual({
      ok: true,
      refs: { "refs/heads/main": "ok", "refs/notes/premise": "ok" },
    });
    // One request for the whole batch: a single git-receive-pack POST carried both commands.
    expect(requestsOf(server, "POST").filter((r) => r.path.endsWith("/git-receive-pack"))).toHaveLength(1);
    expect(repo.git("rev-parse", "refs/heads/main")).toBe(batch.commit.oid);
    expect(repo.git("rev-parse", "refs/notes/premise")).toBe(batch.nCommit.oid);
  });

  it("X2: the Authorization header is 'Bearer <plaintext>', the form the platform record states", async () => {
    const repo = serverRepo();
    const server = await gitServer(repo);
    const remote = server.remoteFor(repo);
    repo.git("commit", "--allow-empty", "-m", "seed");
    const seed = repo.git("rev-parse", "refs/heads/main");
    const batch = buildBatch({ seq: 1, at: 1791655424, parentMain: seed, notesParent: null, notes: [] });
    // A fake plaintext shaped like a real one: the "?expires=" suffix included (E2/X2).
    const pools = fakePools(remote, ["madeup_0123456789abcdef0123456789abcdef?expires=1791504000"]);

    const outcome = await runPush(
      {
        pool_id: "pool-a",
        updates: [
          { ref: "refs/heads/main", old: seed, new: batch.commit.oid },
          { ref: "refs/notes/premise", old: ZERO_OID, new: batch.nCommit.oid },
        ],
        pack: batch.pack,
      },
      { tokenSource: pools.source, pusher: receivePackPusher() },
    );

    expect(outcome.result.ok).toBe(true);
    expect(server.requests.length).toBeGreaterThan(0);
    for (const request of server.requests) {
      expect(request.authorization).toBe("Bearer madeup_0123456789abcdef0123456789abcdef?expires=1791504000");
    }
  });

  it("LP4, X8: a stale old id is reported ng per ref and nothing is applied", async () => {
    const repo = serverRepo();
    const server = await gitServer(repo);
    const remote = server.remoteFor(repo);
    repo.git("commit", "--allow-empty", "-m", "seed");
    const head = repo.git("rev-parse", "refs/heads/main");
    // The local real git advertises the atomic capability, so the adapter requests it —
    // the condition under which LP4 asks for all-or-nothing semantics.
    const advertisement = parseRefAdvertisement(await getInfoRefs(remote, "git-receive-pack"));
    expect(advertisement.capabilities).toContain("atomic");
    const batch = buildBatch({ seq: 1, at: 1791655424, parentMain: head, notesParent: null, notes: [] });
    const stale = "f".repeat(40);

    const result = await receivePackPusher().push({
      remote,
      token: "madeup_token",
      updates: [
        { ref: "refs/heads/main", old: stale, new: batch.commit.oid },
        { ref: "refs/notes/premise", old: ZERO_OID, new: batch.nCommit.oid },
      ],
      pack: batch.pack,
      atomic: true,
      signal: AbortSignal.timeout(20_000),
    });

    expect(result.ok).toBe(false);
    expect(result).toEqual({
      ok: false,
      kind: "rejected",
      refs: { "refs/heads/main": "ng", "refs/notes/premise": "ng" },
    });
    // Nothing applied: main kept its value and the notes ref was never created.
    expect(repo.git("rev-parse", "refs/heads/main")).toBe(head);
    expect(() => repo.git("rev-parse", "--verify", "refs/notes/premise")).toThrow();
    expect(requestsOf(server, "POST")).toHaveLength(1);
  });

  it("readRefs returns the advertisement's values by ref, never a binding read (S1b)", async () => {
    const repo = serverRepo();
    const server = await gitServer(repo);
    const remote = server.remoteFor(repo);
    repo.git("commit", "--allow-empty", "-m", "seed");
    const seed = repo.git("rev-parse", "refs/heads/main");
    const batch = buildBatch({ seq: 1, at: 1791655424, parentMain: seed, notesParent: null, notes: [] });
    const pusher = receivePackPusher();
    const pushed = await pusher.push({
      remote,
      token: "madeup_token",
      updates: [
        { ref: "refs/heads/main", old: seed, new: batch.commit.oid },
        { ref: "refs/notes/premise", old: ZERO_OID, new: batch.nCommit.oid },
      ],
      pack: batch.pack,
      atomic: true,
      signal: AbortSignal.timeout(20_000),
    });
    expect(pushed.ok).toBe(true);

    const refs = await pusher.readRefs({
      remote,
      token: "madeup_token",
      refs: ["refs/heads/main", "refs/notes/premise", "refs/heads/missing"],
      signal: AbortSignal.timeout(20_000),
    });
    expect(refs).toEqual({
      "refs/heads/main": batch.commit.oid,
      "refs/notes/premise": batch.nCommit.oid,
      "refs/heads/missing": null,
    });
  });

  it("LP5c: an aborted signal makes the request a transport timeout", async () => {
    const result = await receivePackPusher().push({
      remote: "http://127.0.0.1:9/repo",
      token: "madeup_token",
      updates: [{ ref: "refs/heads/main", old: ZERO_OID, new: "f".repeat(40) }],
      pack: new Uint8Array(),
      atomic: true,
      signal: AbortSignal.abort(),
    });
    expect(result).toEqual({ ok: false, kind: "transport", code: "timeout", http_status: null, retry_after_ms: null });
  });

  it("a request that never gets an answer is classified transport with no HTTP status (LP5)", async () => {
    const result = await receivePackPusher().push({
      remote: "http://127.0.0.1:1/repo",
      token: "madeup_token",
      updates: [{ ref: "refs/heads/main", old: ZERO_OID, new: "f".repeat(40) }],
      pack: new Uint8Array(),
      atomic: true,
      signal: AbortSignal.timeout(20_000),
    });
    expect(result).toEqual({
      ok: false,
      kind: "transport",
      code: "transport",
      http_status: null,
      retry_after_ms: null,
    });
  });
});

describe("the push runner (first version: one request per batch, no retry)", () => {
  it.each([401, 403])("S2, LP5a: a %i leads to one token refresh and one more try", async (status) => {
    const repo = serverRepo();
    const gate: GitGate = { expectedToken: "madeup_freshtoken", status };
    const server = await gitServer(repo, gate);
    const remote = server.remoteFor(repo);
    repo.git("commit", "--allow-empty", "-m", "seed");
    const seed = repo.git("rev-parse", "refs/heads/main");
    const batch = buildBatch({ seq: 1, at: 1791655424, parentMain: seed, notesParent: null, notes: [] });
    const pools = fakePools(remote, ["madeup_deadtoken", "madeup_freshtoken"]);

    const outcome = await runPush(
      {
        pool_id: "pool-a",
        updates: [
          { ref: "refs/heads/main", old: seed, new: batch.commit.oid },
          { ref: "refs/notes/premise", old: ZERO_OID, new: batch.nCommit.oid },
        ],
        pack: batch.pack,
      },
      { tokenSource: pools.source, pusher: receivePackPusher() },
    );

    expect(outcome.result.ok).toBe(true);
    // One refresh: the binding minted exactly twice.
    expect(pools.mints).toHaveLength(2);
    // One more try: only the retried push reached git-receive-pack.
    expect(requestsOf(server, "POST").filter((r) => r.path.endsWith("/git-receive-pack"))).toHaveLength(1);
    expect(repo.git("rev-parse", "refs/heads/main")).toBe(batch.commit.oid);
    expect(repo.git("rev-parse", "refs/notes/premise")).toBe(batch.nCommit.oid);
    expect(outcome.target.token).toBe("madeup_freshtoken");
  });

  it("a rejected batch is returned unretried: one mint, one receive-pack request", async () => {
    const repo = serverRepo();
    const server = await gitServer(repo);
    const remote = server.remoteFor(repo);
    repo.git("commit", "--allow-empty", "-m", "seed");
    const head = repo.git("rev-parse", "refs/heads/main");
    const batch = buildBatch({ seq: 1, at: 1791655424, parentMain: head, notesParent: null, notes: [] });
    const pools = fakePools(remote, ["madeup_token"]);

    const outcome = await runPush(
      {
        pool_id: "pool-a",
        updates: [
          { ref: "refs/heads/main", old: "f".repeat(40), new: batch.commit.oid },
          { ref: "refs/notes/premise", old: ZERO_OID, new: batch.nCommit.oid },
        ],
        pack: batch.pack,
      },
      { tokenSource: pools.source, pusher: receivePackPusher() },
    );

    expect(outcome.result.ok).toBe(false);
    expect(outcome.result).toEqual({
      ok: false,
      kind: "rejected",
      refs: { "refs/heads/main": "ng", "refs/notes/premise": "ng" },
    });
    expect(pools.mints).toHaveLength(1);
    expect(requestsOf(server, "POST")).toHaveLength(1);
  });
});

describe("the notes reader (S1c)", () => {
  it("reads the notes tree and the note blobs by object id", async () => {
    const repo = serverRepo();
    const server = await gitServer(repo);
    const remote = server.remoteFor(repo);
    repo.git("commit", "--allow-empty", "-m", "seed");
    const seed = repo.git("rev-parse", "refs/heads/main");
    const pusher = receivePackPusher();
    const first = buildBatch({ seq: 1, at: 1791655424, parentMain: seed, notesParent: null, notes: [] });
    const second = buildBatch({
      seq: 2,
      at: 1791655500,
      parentMain: first.commit.oid,
      notesParent: first.nCommit.oid,
      notes: [{ commit: first.commit.oid, blob: first.noteBlob }],
    });
    for (const batch of [first, second]) {
      const pushed = await pusher.push({
        remote,
        token: "madeup_token",
        updates: [
          { ref: "refs/heads/main", old: batch === first ? seed : first.commit.oid, new: batch.commit.oid },
          { ref: "refs/notes/premise", old: batch === first ? ZERO_OID : first.nCommit.oid, new: batch.nCommit.oid },
        ],
        pack: batch.pack,
        atomic: true,
        signal: AbortSignal.timeout(20_000),
      });
      expect(pushed.ok).toBe(true);
    }

    const reader = artifactsNotesReader(gitBackedRepo(repo.directory), second.nCommit.oid);
    const firstNote = { v: 1, seq: 1, kind: "change", batch: { id: 1, index: 0, size: 1 } };
    const secondNote = { v: 1, seq: 2, kind: "change", batch: { id: 2, index: 0, size: 1 } };
    expect(await reader.readNote(first.commit.oid)).toBe(text(noteBytes(firstNote)));
    expect(await reader.readNote(second.commit.oid)).toBe(text(noteBytes(secondNote)));
    expect(await reader.readNote("f".repeat(40))).toBeNull();

    const listed: { commit: string; blob: string }[] = [];
    for await (const entry of reader.listNotes()) listed.push(entry);
    const expected = [
      { commit: first.commit.oid, blob: first.noteBlob.oid },
      { commit: second.commit.oid, blob: second.noteBlob.oid },
    ].sort((a, b) => a.commit.localeCompare(b.commit));
    expect(listed).toEqual(expected);
  });

  it("returns null and an empty list when the pool has no notes ref yet", async () => {
    const reader = artifactsNotesReader(gitBackedRepo(serverRepo().directory), null);
    expect(await reader.readNote("f".repeat(40))).toBeNull();
    const listed: { commit: string; blob: string }[] = [];
    for await (const entry of reader.listNotes()) listed.push(entry);
    expect(listed).toEqual([]);
  });
});
