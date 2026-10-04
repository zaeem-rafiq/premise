/**
 * End-to-end test of the hand-built push path against REAL git:
 * Node http server -> `git http-backend` (CGI) -> git receive-pack.
 * Covers ref discovery, a single-ref push, one request updating two refs,
 * a stale old id, the "atomic" capability and a delete. The last block pushes
 * with isomorphic-git through the recording HTTP client.
 * No Cloudflare access needed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import isogit from "isomorphic-git";
import { chooseCapabilities, commitFiles, describeReport, initRepo, newLocalRepo, pushRef, rawDiscover, rawReceivePack, refResult, type LocalRepo } from "../src/gitops";
import { ZERO_OID, makeCommit, makeTreeFromFiles, type GitObject } from "../src/rawgit";
import { Recorder } from "../src/recorder";
import { git, initBareRepo, makeTempDir, removeDir, startGitServer, type GitServer } from "./helpers/git-http-server";

/** Create a local branch at HEAD in an in-memory isomorphic-git repo. */
async function createBranch(local: LocalRepo, name: string): Promise<void> {
  await isogit.branch({ fs: local.fs, dir: local.dir, ref: name });
}

const AUTH = "Bearer test-token-not-checked-by-this-server";
const MAIN = "refs/heads/main";
const NOTES = "refs/notes/premise";

let root: string;
let server: GitServer;
let counter = 0;

function commit(parents: string[], files: Record<string, string>, message: string): { commit: GitObject; objects: GitObject[] } {
  const { root: tree, objects } = makeTreeFromFiles(files);
  const c = makeCommit({ tree: tree.oid, parents, author: { name: "e2e", email: "e2e@example.invalid", timestamp: 1790000000 + counter++ }, message });
  return { commit: c, objects: [...objects, c] };
}

function note(parents: string[], target: string, text: string) {
  return commit(parents, { [target]: text }, "notes commit");
}

/** New bare repo with one hand-pushed commit on main. */
async function seeded(name: string) {
  const path = initBareRepo(root, name);
  const url = server.remoteFor(name);
  const rec = new Recorder("test");
  const adv = await rawDiscover(rec, "discover", url, "git-receive-pack", AUTH);
  if (!adv.adv) throw new Error(`discovery failed: ${adv.message}`);
  const caps = chooseCapabilities(adv.adv.capabilities);
  const c1 = commit([], { "README.md": "# one\n", "src/a.ts": "export const a = 1;\n" }, "first");
  const push = await rawReceivePack(rec, "seed", { url, authorization: AUTH, commands: [{ oldOid: ZERO_OID, newOid: c1.commit.oid, ref: MAIN }], capabilities: caps, objects: c1.objects });
  if (refResult(push, MAIN) !== "ok") throw new Error(`seed push failed: ${describeReport(push)}`);
  return { path, url, rec, caps, advertised: adv.adv.capabilities, c1 };
}

beforeAll(async () => {
  root = makeTempDir("receive-pack");
  server = await startGitServer({ root });
});

afterAll(async () => {
  await server.close();
  removeDir(root);
});

describe("ref discovery against real git", () => {
  it("parses the advertisement of an empty repo", async () => {
    initBareRepo(root, "empty");
    const rec = new Recorder("test");
    const adv = await rawDiscover(rec, "discover", server.remoteFor("empty"), "git-receive-pack", AUTH);
    expect(adv.status).toBe(200);
    expect(adv.adv?.service).toBe("git-receive-pack");
    expect(adv.adv?.emptyRepo).toBe(true);
    expect(adv.adv?.refs).toEqual({});
    expect(adv.adv?.capabilities).toEqual(expect.arrayContaining(["report-status", "side-band-64k", "delete-refs", "atomic"]));
    expect(rec.httpLog).toEqual([expect.objectContaining({ step: "discover GET /info/refs?service=git-receive-pack", status: 200 })]);
  });

  it("reports a missing repo as a non-200 status with the server message", async () => {
    const rec = new Recorder("test");
    const adv = await rawDiscover(rec, "discover", server.remoteFor("does-not-exist"), "git-receive-pack", AUTH);
    expect(adv.ok).toBe(false);
    expect(adv.status).toBe(404);
    expect(rec.observations.join("\n")).toContain("HTTP 404");
  });
});

describe("single-ref push against real git", () => {
  it("creates main, and git can read everything back", async () => {
    const { path, url, rec, c1 } = await seeded("single");
    expect(git(path, ["rev-parse", MAIN]).trim()).toBe(c1.commit.oid);
    expect(git(path, ["fsck", "--strict", "--full"])).not.toMatch(/error|missing/i);
    expect(git(path, ["show", `${MAIN}:src/a.ts`])).toBe("export const a = 1;\n");
    const after = await rawDiscover(rec, "after", url, "git-receive-pack", AUTH);
    expect(after.adv?.refs).toEqual({ [MAIN]: c1.commit.oid });
  });

  it("fast-forwards with a pack that holds only the new objects", async () => {
    const { path, url, rec, caps, c1 } = await seeded("single-ff");
    const c2 = commit([c1.commit.oid], { "README.md": "# two\n", "src/a.ts": "export const a = 1;\n" }, "second");
    const push = await rawReceivePack(rec, "ff", { url, authorization: AUTH, commands: [{ oldOid: c1.commit.oid, newOid: c2.commit.oid, ref: MAIN }], capabilities: caps, objects: c2.objects });
    expect(push.status).toBe(200);
    expect(push.report?.sideband).toBe(true);
    expect(push.report?.unpackOk).toBe(true);
    expect(push.report?.refs).toEqual([{ ref: MAIN, ok: true }]);
    expect(git(path, ["rev-list", "--count", MAIN]).trim()).toBe("2");
    expect(git(path, ["fsck", "--strict", "--full"])).not.toMatch(/error|missing/i);
  });

  it("works without side-band and with LF-terminated commands too", async () => {
    const { path, url, rec, c1 } = await seeded("single-plain");
    const c2 = commit([c1.commit.oid], { "README.md": "# plain\n" }, "plain");
    const push = await rawReceivePack(rec, "plain", { url, authorization: AUTH, commands: [{ oldOid: c1.commit.oid, newOid: c2.commit.oid, ref: MAIN }], capabilities: ["report-status"], objects: c2.objects, trailingNewline: true });
    expect(push.report?.sideband).toBe(false);
    expect(push.report?.refs).toEqual([{ ref: MAIN, ok: true }]);
    expect(git(path, ["rev-parse", MAIN]).trim()).toBe(c2.commit.oid);
  });
});

describe("one request, two refs, against real git", () => {
  it("updates refs/heads/main and creates refs/notes/premise together", async () => {
    const { path, url, rec, caps, c1 } = await seeded("two-refs");
    const c2 = commit([c1.commit.oid], { "README.md": "# two refs\n" }, "second");
    const n1 = note([], c2.commit.oid, "premise: checked by real git\n");
    const push = await rawReceivePack(rec, "two", {
      url,
      authorization: AUTH,
      commands: [
        { oldOid: c1.commit.oid, newOid: c2.commit.oid, ref: MAIN },
        { oldOid: ZERO_OID, newOid: n1.commit.oid, ref: NOTES },
      ],
      capabilities: caps,
      objects: [...c2.objects, ...n1.objects],
    });
    expect(push.report?.unpackOk).toBe(true);
    expect(push.report?.refs).toEqual([
      { ref: MAIN, ok: true },
      { ref: NOTES, ok: true },
    ]);
    expect(git(path, ["rev-parse", MAIN]).trim()).toBe(c2.commit.oid);
    expect(git(path, ["rev-parse", NOTES]).trim()).toBe(n1.commit.oid);
    // Real git resolves the hand-built notes tree.
    expect(git(path, ["notes", "--ref=premise", "show", c2.commit.oid])).toBe("premise: checked by real git\n");
    expect(git(path, ["fsck", "--strict", "--full"])).not.toMatch(/error|missing/i);
  });

  it("without the atomic capability, real git applies the good command and rejects the one with a wrong old id", async () => {
    const { path, url, rec, caps, c1 } = await seeded("mixed");
    const n1 = note([], c1.commit.oid, "first note\n");
    await rawReceivePack(rec, "notes", { url, authorization: AUTH, commands: [{ oldOid: ZERO_OID, newOid: n1.commit.oid, ref: NOTES }], capabilities: caps, objects: n1.objects });
    const c2 = commit([c1.commit.oid], { "README.md": "# mixed\n" }, "second");
    const n2 = note([n1.commit.oid], c2.commit.oid, "second note\n");
    const push = await rawReceivePack(rec, "mixed", {
      url,
      authorization: AUTH,
      commands: [
        { oldOid: c1.commit.oid, newOid: c2.commit.oid, ref: MAIN },
        { oldOid: c1.commit.oid, newOid: n2.commit.oid, ref: NOTES }, // wrong: notes is at n1
      ],
      capabilities: caps,
      objects: [...c2.objects, ...n2.objects],
    });
    expect(refResult(push, MAIN)).toBe("ok");
    expect(refResult(push, NOTES)).toBe("ng");
    expect(git(path, ["rev-parse", MAIN]).trim()).toBe(c2.commit.oid);
    expect(git(path, ["rev-parse", NOTES]).trim()).toBe(n1.commit.oid);
  });

  it("with the atomic capability, real git rejects both commands", async () => {
    const { path, url, rec, caps, advertised, c1 } = await seeded("atomic");
    expect(advertised).toContain("atomic");
    const n1 = note([], c1.commit.oid, "first note\n");
    await rawReceivePack(rec, "notes", { url, authorization: AUTH, commands: [{ oldOid: ZERO_OID, newOid: n1.commit.oid, ref: NOTES }], capabilities: caps, objects: n1.objects });
    const c2 = commit([c1.commit.oid], { "README.md": "# atomic\n" }, "second");
    const n2 = note([n1.commit.oid], c2.commit.oid, "second note\n");
    const push = await rawReceivePack(rec, "atomic", {
      url,
      authorization: AUTH,
      commands: [
        { oldOid: c1.commit.oid, newOid: c2.commit.oid, ref: MAIN },
        { oldOid: c1.commit.oid, newOid: n2.commit.oid, ref: NOTES },
      ],
      capabilities: [...caps, "atomic"],
      objects: [...c2.objects, ...n2.objects],
    });
    expect(refResult(push, MAIN)).toBe("ng");
    expect(refResult(push, NOTES)).toBe("ng");
    expect(git(path, ["rev-parse", MAIN]).trim()).toBe(c1.commit.oid);
    expect(git(path, ["rev-parse", NOTES]).trim()).toBe(n1.commit.oid);
  });
});

describe("compare-and-swap and delete against real git", () => {
  it("real git refuses an update whose old id is stale", async () => {
    const { path, url, rec, caps, c1 } = await seeded("cas");
    const r1 = commit([c1.commit.oid], { "README.md": "# r1\n" }, "r1");
    const r2 = commit([c1.commit.oid], { "README.md": "# r2\n" }, "r2");
    const good = await rawReceivePack(rec, "good", { url, authorization: AUTH, commands: [{ oldOid: c1.commit.oid, newOid: r1.commit.oid, ref: MAIN }], capabilities: caps, objects: r1.objects });
    expect(refResult(good, MAIN)).toBe("ok");
    const stale = await rawReceivePack(rec, "stale", { url, authorization: AUTH, commands: [{ oldOid: c1.commit.oid, newOid: r2.commit.oid, ref: MAIN }], capabilities: caps, objects: r2.objects });
    expect(refResult(stale, MAIN)).toBe("ng");
    expect(git(path, ["rev-parse", MAIN]).trim()).toBe(r1.commit.oid);
    const zero = await rawReceivePack(rec, "zero", { url, authorization: AUTH, commands: [{ oldOid: ZERO_OID, newOid: r2.commit.oid, ref: MAIN }], capabilities: caps, objects: r2.objects });
    expect(refResult(zero, MAIN)).toBe("ng");
    expect(git(path, ["rev-parse", MAIN]).trim()).toBe(r1.commit.oid);
  });

  it("points a new ref at a commit the server already has, with an empty pack (as the git CLI does)", async () => {
    // Before the fix rawReceivePack() built no pack for an empty object list and then threw
    // "a pack is required unless every command is a delete", outside its own try block.
    const { path, url, rec, caps, c1 } = await seeded("empty-pack");
    const green = "refs/heads/green";
    const push = await rawReceivePack(rec, "green", { url, authorization: AUTH, commands: [{ oldOid: ZERO_OID, newOid: c1.commit.oid, ref: green }], capabilities: caps, objects: [] });
    expect(push.status).toBe(200);
    // 12-byte header (zero objects) plus the 20-byte SHA-1 trailer.
    expect(push.packBytes).toBe(32);
    expect(push.report?.unpackOk).toBe(true);
    expect(push.report?.refs).toEqual([{ ref: green, ok: true }]);
    expect(git(path, ["rev-parse", green]).trim()).toBe(c1.commit.oid);
    expect(git(path, ["fsck", "--strict", "--full"])).not.toMatch(/error|missing/i);

    // An update together with a delete also carries the (empty) pack; only an all-delete request has none.
    const temp = "refs/heads/temp";
    const mixed = await rawReceivePack(rec, "mixed", {
      url,
      authorization: AUTH,
      commands: [
        { oldOid: c1.commit.oid, newOid: ZERO_OID, ref: green },
        { oldOid: ZERO_OID, newOid: c1.commit.oid, ref: temp },
      ],
      capabilities: caps,
      objects: [],
    });
    expect(mixed.packBytes).toBe(32);
    expect(mixed.report?.refs).toEqual([
      { ref: green, ok: true },
      { ref: temp, ok: true },
    ]);
    expect(git(path, ["for-each-ref", "--format=%(refname)"]).trim().split("\n")).toEqual([MAIN, temp]);
  });

  it("deletes a branch with a pack-less request", async () => {
    const { path, url, rec, caps, c1 } = await seeded("delete");
    const branch = "refs/heads/temp";
    await rawReceivePack(rec, "create", { url, authorization: AUTH, commands: [{ oldOid: ZERO_OID, newOid: c1.commit.oid, ref: branch }], capabilities: caps, objects: c1.objects });
    expect(git(path, ["rev-parse", branch]).trim()).toBe(c1.commit.oid);
    const del = await rawReceivePack(rec, "delete", { url, authorization: AUTH, commands: [{ oldOid: c1.commit.oid, newOid: ZERO_OID, ref: branch }], capabilities: caps, objects: [] });
    expect(del.packBytes).toBe(0);
    expect(refResult(del, branch)).toBe("ok");
    expect(git(path, ["for-each-ref", "--format=%(refname)"]).trim().split("\n")).toEqual([MAIN]);
  });
});

describe("isomorphic-git push through the recording HTTP client, against real git", () => {
  it("pushes from the in-memory filesystem and records each request", async () => {
    const path = initBareRepo(root, "isogit");
    const rec = new Recorder("test");
    const local = newLocalRepo();
    await initRepo(local, "main");
    const head = await commitFiles(local, { "README.md": "# isomorphic-git\n", "src/deep/file.ts": "export {};\n" }, "first");
    const push = await pushRef(rec, "push", local, { url: server.remoteFor("isogit"), token: "art_v1_" + "ab".repeat(20) + "?expires=1", style: "bearer" }, { ref: "main" });
    expect(push.ok, push.errorText).toBe(true);
    expect(push.posted).toBe(true);
    expect(push.statuses).toEqual([200, 200]);
    expect(rec.httpLog.map((h) => h.step)).toEqual(["push GET /info/refs?service=git-receive-pack", "push POST /git-receive-pack"]);
    expect(git(path, ["rev-parse", MAIN]).trim()).toBe(head);
    expect(git(path, ["fsck", "--strict", "--full"])).not.toMatch(/error|missing/i);
  });

  it("sends the same User-Agent on the isomorphic-git path and on the raw path", async () => {
    // Neither path sets a User-Agent: isomorphic-git 1.43.0 puts "git/isomorphic-git@1.43.0" in the
    // pkt-line "agent=" capability, not in an HTTP header, and both paths go through the same fetch().
    // So the User-Agent cannot make the raw results differ from the isomorphic-git results.
    initBareRepo(root, "user-agent");
    const url = server.remoteFor("user-agent");
    const rec = new Recorder("test");
    const local = newLocalRepo();
    await initRepo(local, "main");
    await commitFiles(local, { "README.md": "# user agent\n" }, "first");
    const start = server.requests.length;
    expect((await pushRef(rec, "push", local, { url, token: "unused-token-value", style: "basic" }, { ref: "main" })).ok).toBe(true);
    const viaIsomorphicGit = server.requests.slice(start);
    const mark = server.requests.length;
    const adv = await rawDiscover(rec, "discover", url, "git-receive-pack", AUTH);
    const next = commit([adv.adv!.refs[MAIN]!], { "README.md": "# raw\n" }, "raw");
    const raw = await rawReceivePack(rec, "raw", { url, authorization: AUTH, commands: [{ oldOid: adv.adv!.refs[MAIN]!, newOid: next.commit.oid, ref: MAIN }], capabilities: chooseCapabilities(adv.adv!.capabilities), objects: next.objects });
    expect(refResult(raw, MAIN)).toBe("ok");
    const viaRaw = server.requests.slice(mark);
    expect(viaIsomorphicGit.map((r) => r.method)).toEqual(["GET", "POST"]);
    expect(viaRaw.map((r) => r.method)).toEqual(["GET", "POST"]);
    const agents = new Set([...viaIsomorphicGit, ...viaRaw].map((r) => String(r.userAgent)));
    expect([...agents]).toHaveLength(1);
    // The one value is the runtime's default (Node's fetch here), not a git client name.
    expect([...agents][0]).not.toMatch(/^git\//);
    // A caller can still set one per request.
    await rawDiscover(rec, "discover-git-ua", url, "git-receive-pack", AUTH, { "User-Agent": "git/2.50.1" });
    expect(server.requests.at(-1)!.userAgent).toBe("git/2.50.1");
  });

  it("reports a server-side refusal with the server's own message", async () => {
    const path = initBareRepo(root, "isogit-deny");
    git(path, ["config", "receive.denyDeletes", "true"]);
    const rec = new Recorder("test");
    const local = newLocalRepo();
    await initRepo(local, "main");
    await commitFiles(local, { "README.md": "# deny deletes\n" }, "first");
    const target = { url: server.remoteFor("isogit-deny"), token: "unused-token-value", style: "basic" as const };
    expect((await pushRef(rec, "main", local, target, { ref: "main" })).ok).toBe(true);
    await createBranch(local, "doomed");
    expect((await pushRef(rec, "create", local, target, { ref: "doomed" })).ok).toBe(true);
    const del = await pushRef(rec, "delete", local, target, { ref: "doomed", delete: true });
    expect(del.ok).toBe(false);
    expect(del.posted).toBe(true);
    expect(del.statuses).toEqual([200, 200]);
    expect(del.refs).toEqual({ "refs/heads/doomed": { ok: false, error: "deletion prohibited" } });
    expect(del.error?.name).toBe("GitPushError");
    expect(del.serverMessages.join("\n")).toMatch(/denying ref deletion for refs\/heads\/doomed/);
    expect(git(path, ["rev-parse", "--verify", "refs/heads/doomed"]).trim()).toMatch(/^[0-9a-f]{40}$/);
  });
});
