// test/workerd/repos/repos.test.ts — the 06-repos.md step-1 acceptance (IR1-IR8) in local
// workerd: a pool imported from a real repository through the harness's stand-in for Artifacts
// (`import` clones a local bare repository), the import job's events and limits, IR5's whole
// tree under a real landing, and the refusals of IR7. Stock git on the remote proves the tree
// stayed whole; expected values come from the spec and real git, never the implementation.
//
//   IR1/IR2  POST /api/pools source forms, the binding's error table, request_id replay
//   IR3      pool.state(rebuilding,import,0) → pool.state(ready) → pool.files; pool_not_ready
//   IR4      a tree over IMPORT_MAX_ENTRIES pauses with repo_too_large
//   IR5      a landed change's tree differs from its parent only in the changed path; the
//            symlink, the exec bit, the space path and the gitlink survive; fsck --strict
//   IR7      /pool/<pool>/... 404 no_app; POST /api/swarm 400 invalid_args

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync, symlinkSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { git, gitBytes } from "../../git/helpers.ts";
import { bearer, openAttempt, tool, eventsOf, waitFor } from "../collide/helpers.ts";
import { startLandingWorker, type LandingWorker } from "../landing/harness.ts";

const KEY = "owner-key-for-tests-0123456789abcdef";

// The source repository the pool is imported from. `import` maps the url's last segment here.
const SOURCE = "src-mixed";
const POOL = "imp-mixed";
const BIG = "assets/big.bin"; // over MAX_FILE_BYTES (32KiB): opaque, `too_large`
const LINK = "guide.md"; // symbolic link → AGENTS.md — unmanaged (120000)
const EXEC = "tools/run.sh"; // executable — managed, mode 100755 survives
const ODD = "docs/read me.txt"; // a space in the name: outside 2.1 — unmanaged
const SUB = "vendor/lib"; // a submodule gitlink (160000) — unmanaged
const EDIT = "src/app.js"; // the landing's changed path
const TSMOD = "src/config.ts"; // LG5: a TypeScript module in the imported tree

/** Fill the source repository: a JavaScript, a Python, a Rust and a TypeScript module, an
 * executable, a space path, a symlink, a gitlink, and one blob over MAX_FILE_BYTES. */
function fillSource(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "tools"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "lib"), { recursive: true });
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), "# the guide\nbuild it, test it.\n");
  writeFileSync(join(dir, EDIT), "export const answer = 40;\n");
  writeFileSync(join(dir, "lib/lib.py"), "def weigh(x):\n    return x * 2\n");
  writeFileSync(join(dir, "src/lib.rs"), "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n");
  writeFileSync(
    join(dir, TSMOD),
    "export const CAP: number = 4;\n\nexport interface Named {\n  name: string;\n}\n\nexport type Pair = [number, number];\n",
  );
  writeFileSync(join(dir, EXEC), "#!/bin/sh\necho run\n");
  chmodSync(join(dir, EXEC), 0o755);
  writeFileSync(join(dir, ODD), "a path 2.1 cannot name\n");
  writeFileSync(join(dir, BIG), "x".repeat(40 * 1024));
  symlinkSync("AGENTS.md", join(dir, LINK));
  git(dir, ["add", "-A"]);
  // The gitlink: `update-index --cacheinfo` stages a submodule pointer by object id — a commit
  // the remote never holds (IR5: it is kept, referenced and untouched forever).
  git(dir, ["update-index", "--add", "--cacheinfo", "160000,0123456789012345678901234567890123456789,vendor/lib"]);
  git(dir, ["commit", "--quiet", "-m", "the imported tree"]);
}

async function createImported(worker: LandingWorker, pool: string, request_id: string): Promise<Response> {
  return worker.fetch(
    "/api/pools",
    bearer({
      pool,
      source: { url: `https://github.com/tldrs/${SOURCE}`, branch: "main" },
      request_id,
    }),
  );
}

describe("06-repos step 1 in local workerd (IR1-IR8)", () => {
  let worker: LandingWorker;

  beforeAll(async () => {
    worker = await startLandingWorker({ ownerKey: KEY, repos: [], importSources: [SOURCE, "src-big"] });
    fillSource(worker.repoDir(SOURCE));
    // The IR4 fixture: a tree over IMPORT_MAX_ENTRIES (5000) — index-info writes the whole
    // index in one command, no worktree walk.
    const big = worker.repoDir("src-big");
    const empty = git(big, ["hash-object", "-w", "--stdin"], "e\n");
    const lines = Array.from({ length: 5001 }, (_, i) => `100644 ${empty}\tf/f${i}.txt`).join("\n");
    git(big, ["update-index", "--index-info"], lines);
    const tree = git(big, ["write-tree"]);
    const commit = git(big, ["commit-tree", tree, "-m", "too many entries"]);
    git(big, ["update-ref", "refs/heads/main", commit]);
  }, 120_000);
  afterAll(async () => {
    await worker?.dispose();
  });

  it("IR2's error table: each binding fault maps to its code and status", async () => {
    const table: Array<[string, number, string]> = [
      ["REMOTE_AUTH_REQUIRED", 400, "repo_private"],
      ["NOT_FOUND", 404, "repo_not_found"],
      ["MEMORY_LIMIT", 413, "repo_too_large"],
      ["UPSTREAM_UNAVAILABLE", 502, "upstream_unavailable"],
      ["INVALID_URL", 400, "invalid_args"],
      ["INVALID_INPUT", 400, "invalid_args"],
      ["SOMETHING_ELSE", 502, "upstream_unavailable"],
    ];
    for (const [code, status, want] of table) {
      worker.setImportFault(code);
      const res = await worker.fetch(
        "/api/pools",
        bearer({
          pool: `err-${code.toLowerCase().replace(/_/g, "-")}`,
          source: { url: `https://github.com/tldrs/${SOURCE}` },
          request_id: `r-err-${code}`,
        }),
      );
      worker.setImportFault(null);
      expect(res.status, `${code}`).toBe(status);
      expect(await res.json()).toEqual({ error: { code: want } });
    }
    // A source no local repository backs answers repo_not_found through the real clone.
    const missing = await worker.fetch(
      "/api/pools",
      bearer({
        pool: "err-missing",
        source: { url: "https://github.com/tldrs/no-such-repo" },
        request_id: "r-err-missing",
      }),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: "repo_not_found" } });
  });

  it("IR1's refused address forms answer 400 invalid_args before the binding is called", async () => {
    const refused = [
      "https://example.com/tldrs/src-mixed",
      "http://github.com/tldrs/src-mixed",
      "https://user:pw@github.com/tldrs/src-mixed",
      "https://github.com:443/tldrs/src-mixed",
      "https://github.com/tldrs/src-mixed?tab=readme",
      "https://github.com/tldrs/src-mixed#readme",
      "https://github.com/tl drs/src-mixed",
      "https://github.com/tldrs",
      "ssh://git@github.com/tldrs/src-mixed",
    ];
    for (const url of refused) {
      const res = await worker.fetch(
        "/api/pools",
        bearer({ pool: "imp-bad", source: { url }, request_id: `r-bad-${refused.indexOf(url)}` }),
      );
      expect(res.status, url).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_args");
    }
    for (const branch of ["bad..branch", "a b", ""] as const) {
      const res = await worker.fetch(
        "/api/pools",
        bearer({
          pool: "imp-bad",
          source: { url: `https://github.com/tldrs/${SOURCE}`, branch },
          request_id: `r-badb-${branch.length}`,
        }),
      );
      expect(res.status, `branch ${branch}`).toBe(400);
    }
    // Exactly one of seed|source: both, or neither, is invalid_args (IR1).
    for (const body of [
      {
        pool: "imp-bad",
        seed: "tidepool",
        source: { url: `https://github.com/tldrs/${SOURCE}` },
        request_id: "r-both",
      },
      { pool: "imp-bad", request_id: "r-neither" },
    ]) {
      const res = await worker.fetch("/api/pools", bearer(body));
      expect(res.status).toBe(400);
    }
  });

  it("IR3: the import's events — state rebuilding/import/0, then ready, then pool.files", async () => {
    const res = await createImported(worker, POOL, "r-import-mixed");
    expect(res.status, `create: ${await res.clone().text()}`).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pool: POOL });
    // The first event lands at create: rebuilding with reason import, head_seq 0, app null.
    const first = (await worker.events(POOL))[0];
    expect(first).toMatchObject({ type: "pool.state", state: "rebuilding", reason: "import", head_seq: 0 });
    await waitFor(async () => (await worker.eventTypes(POOL)).includes("pool.files"), 30_000);
    const events = await worker.events(POOL);
    const readyAt = events.findIndex((e) => e.type === "pool.state" && e.state === "ready");
    const filesAt = events.findIndex((e) => e.type === "pool.files");
    expect(readyAt, "pool.state ready precedes pool.files").toBeGreaterThan(0);
    expect(filesAt).toBe(readyAt + 1);
    const ready = events[readyAt];
    // IR8/IR11: app null, source owner/name; the imported head commit is the seed (IR2).
    expect(ready).toMatchObject({ app: null, source: `tldrs/${SOURCE}`, head_seq: 0, landed_seq: 0 });
    expect(ready?.head_commit).toBe(git(worker.repoDir(SOURCE), ["rev-parse", "refs/heads/main"]));
    // Nothing was pushed for the imported head (IR2): no batch, no outbox.
    expect(events.some((e) => e.type === "batch.pushed")).toBe(false);
    const files = (events[filesAt]?.files ?? []) as Array<{ path: string }>;
    const paths = files.map((f) => f.path).sort();
    // IR5: managed paths are listed; the symlink, the gitlink and the space path are not.
    expect(paths).toContain(EDIT);
    expect(paths).toContain(EXEC);
    expect(paths).toContain(BIG);
    expect(paths).toContain("lib/lib.py");
    expect(paths).not.toContain(LINK);
    expect(paths).not.toContain(ODD);
    expect(paths.some((p) => p.startsWith(SUB))).toBe(false);
  });

  it("IR7: the app server answers no_app and the swarm route answers invalid_args", async () => {
    const app = await worker.fetch(`/pool/${POOL}/main/`);
    expect(app.status).toBe(404);
    expect(await app.json()).toEqual({ error: { code: "no_app" } });
    const appFile = await worker.fetch(`/pool/${POOL}/v/c-0000000000000000000000000000000000000000/index.js`);
    expect(appFile.status).toBe(404);
    expect(await appFile.json()).toEqual({ error: { code: "no_app" } });
    const bare = await worker.fetch(`/pool/${POOL}/`);
    expect(bare.status).toBe(404);
    expect(await bare.json()).toEqual({ error: { code: "no_app" } });
    const swarm = await worker.fetch(
      "/api/swarm",
      bearer({
        seed: 7,
        agents: 1,
        launch_per_second: 1,
        collision_dial: 0,
        think_ms: [10, 20],
        rescale_every_s: 60,
        pool: POOL,
        running: true,
        patterns: ["add-plain"],
        request_id: "r-swarm-imp",
      }),
    );
    expect(swarm.status).toBe(400);
    expect(await swarm.json()).toEqual({ error: { code: "invalid_args" } });
  });

  it("IR5: tools cannot reach an unmanaged entry; an oversized blob answers too_large", async () => {
    await openAttempt(worker, POOL, "imp-a1", { intent: "touch app.js" });
    const readLink = await worker.trunk(POOL).fetch("/tool", {
      method: "POST",
      body: JSON.stringify({
        attempt_id: "imp-a1",
        call_id: "imp-a1:l",
        tool: "read",
        args: { path: LINK },
        ack: 0,
      }),
    });
    const linkBody = (await readLink.json()) as { error?: { code: string } };
    expect(linkBody.error?.code).toBe("not_found");
    const readOdd = await worker.trunk(POOL).fetch("/tool", {
      method: "POST",
      body: JSON.stringify({
        attempt_id: "imp-a1",
        call_id: "imp-a1:o",
        tool: "read",
        args: { path: ODD },
        ack: 0,
      }),
    });
    expect(((await readOdd.json()) as { error?: { code: string } }).error?.code).toBe("invalid_path");
    const readSub = await worker.trunk(POOL).fetch("/tool", {
      method: "POST",
      body: JSON.stringify({
        attempt_id: "imp-a1",
        call_id: "imp-a1:s",
        tool: "read",
        args: { path: `${SUB}/inner.js` },
        ack: 0,
      }),
    });
    expect(((await readSub.json()) as { error?: { code: string } }).error?.code).toBe("not_found");
    const readBig = await worker.trunk(POOL).fetch("/tool", {
      method: "POST",
      body: JSON.stringify({
        attempt_id: "imp-a1",
        call_id: "imp-a1:b",
        tool: "read",
        args: { path: BIG },
        ack: 0,
      }),
    });
    expect(((await readBig.json()) as { error?: { code: string } }).error?.code).toBe("too_large");
    // A list of the root shows the managed tree only.
    const list = await tool(worker, POOL, "imp-a1", { tool: "list", args: { path: "/" } }, 4);
    const listing = JSON.stringify(list.result);
    expect(listing).not.toContain("read me.txt");
    expect(listing).not.toContain(LINK);
    // A managed executable reads whole; an opaque-language file reads whole (LG5's file level).
    const exec = await tool(worker, POOL, "imp-a1", { tool: "read", args: { path: EXEC } }, 5);
    expect(String((exec.result as { content: string }).content)).toContain("echo run");
    const rs = await tool(worker, POOL, "imp-a1", { tool: "read", args: { path: "src/lib.rs" } }, 6);
    expect(String((rs.result as { content: string }).content)).toContain("pub fn add");
    const outline = await worker.trunk(POOL).fetch("/tool", {
      method: "POST",
      body: JSON.stringify({
        attempt_id: "imp-a1",
        call_id: "imp-a1:out",
        tool: "outline",
        args: { path: "src/lib.rs" },
        ack: 0,
      }),
    });
    expect(((await outline.json()) as { error?: { code: string } }).error?.code).toBe("not_a_module");
  });

  it("LG5: `outline` lists the entities of a `.ts` module in an imported pool", async () => {
    await openAttempt(worker, POOL, "imp-t1", { intent: "outline the TypeScript config" });
    const out = await tool(worker, POOL, "imp-t1", { tool: "outline", args: { path: TSMOD } }, 1);
    const entities = (out.result as { entities: Array<{ name: string; kind: string }> }).entities;
    expect(entities.map((e) => e.name)).toEqual(expect.arrayContaining(["CAP", "Named", "Pair"]));
    expect(entities.find((e) => e.name === "CAP")?.kind).toBe("const");
    // LG2's TypeScript kinds reach the wire.
    expect(entities.find((e) => e.name === "Named")?.kind).toBe("interface");
    expect(entities.find((e) => e.name === "Pair")?.kind).toBe("type");
    const rd = await tool(worker, POOL, "imp-t1", { tool: "read", args: { path: TSMOD, entity: "CAP" } }, 2);
    expect(rd.result).toMatchObject({ key: "src/config.ts#CAP", kind: "const" });
  });

  it("IR5: a landed change differs from its parent only in the changed path — git fsck clean", async () => {
    await tool(worker, POOL, "imp-a1", { tool: "read", args: { path: EDIT } }, 7);
    await tool(
      worker,
      POOL,
      "imp-a1",
      { tool: "write", args: { path: EDIT, content: "export const answer = 42;\n" } },
      8,
    );
    await tool(worker, POOL, "imp-a1", { tool: "submit", args: { summary: "the answer" } }, 9);
    await waitFor(async () => (await eventsOf(worker, POOL, "landing.landed")).length >= 1, 60_000);
    const landed = (await eventsOf(worker, POOL, "landing.landed"))[0];
    const commit = String(landed?.commit);
    const repo = worker.repoDir(POOL);
    const parent = git(repo, ["rev-parse", `${commit}^`]);
    // The parent is the imported head itself — the landing sits directly on it (IR2).
    expect(parent).toBe(git(worker.repoDir(SOURCE), ["rev-parse", "refs/heads/main"]));
    expect(git(repo, ["diff", "--name-only", parent, commit]).split("\n")).toEqual([EDIT]);
    // The tree is whole: link, exec bit, space path, gitlink and the opaque blob unchanged.
    const tree = git(repo, ["ls-tree", "-r", commit]);
    const line = (name: string) => tree.split("\n").find((l) => l.endsWith(`\t${name}`));
    expect(line(LINK)).toMatch(/^120000 blob [0-9a-f]{40}\tguide\.md$/);
    expect(line(EXEC)).toMatch(/^100755 blob [0-9a-f]{40}\ttools\/run\.sh$/);
    expect(line(ODD)).toMatch(/^100644 blob [0-9a-f]{40}\tdocs\/read me\.txt$/);
    expect(line(BIG)).toMatch(/^100644 blob [0-9a-f]{40}\tassets\/big\.bin$/);
    const flat = git(repo, ["ls-tree", commit]);
    expect(flat.split("\n").find((l) => l.endsWith("\tvendor"))).toMatch(/^040000 tree/);
    expect(line("vendor/lib")).toMatch(/^160000 commit 0123456789012345678901234567890123456789\tvendor\/lib$/);
    // The opaque blob's bytes on the remote are the source's — stored nowhere in Trunk.
    expect(gitBytes(repo, ["cat-file", "blob", `${commit}:${BIG}`]).byteLength).toBe(40 * 1024);
    // IR5's own check: stock git's object-level audit is clean.
    git(repo, ["fsck", "--strict"]);
  });

  it("IR3: a tool call and an intent while the job runs answer pool_not_ready", async () => {
    // Wedge the job before it reads anything: every blob/tree/log read of the new pool's repo
    // fails, so the run that follows the create's own alarm cannot finish.
    worker.setReadFault(({ path }) =>
      /^\/(blob|tree|log)\/imp-wedged\//.test(path) ? { action: "answer", status: 503 } : { action: "forward" },
    );
    const res = await worker.fetch(
      "/api/pools",
      bearer({
        pool: "imp-wedged",
        source: { url: `https://github.com/tldrs/${SOURCE}`, branch: "main" },
        request_id: "r-wedged",
      }),
    );
    expect(res.status).toBe(200);
    await waitFor(async () => (await worker.eventTypes("imp-wedged")).some(() => true), 30_000);
    const open = await worker.trunk("imp-wedged").fetch("/internal/open-attempt", {
      method: "POST",
      body: JSON.stringify({
        attempt_id: "imp-w1",
        intent: "try",
        agent_kind: "synthetic",
        truth: [],
        requester: "swarm",
      }),
    });
    expect(((await open.json()) as { error?: string }).error).toBe("pool_not_ready");
    const toolRes = await worker.trunk("imp-wedged").fetch("/tool", {
      method: "POST",
      body: JSON.stringify({ attempt_id: "imp-w1", call_id: "imp-w1:1", tool: "list", args: { path: "" }, ack: 0 }),
    });
    // No attempt could open; either refusal carries the same code family — the gate for an
    // existing attempt is pool_not_ready, an unknown one is attempt_unknown.
    const body = (await toolRes.json()) as { error?: { code?: string } };
    expect(["pool_not_ready", "attempt_unknown"]).toContain(body.error?.code);
    // The job survives the restart: clear the fault, drive the alarm, finish.
    await worker.restart();
    worker.setReadFault(null);
    await worker.runAlarm("imp-wedged", Date.now() + 3_600_000);
    await waitFor(async () => (await worker.eventTypes("imp-wedged")).includes("pool.files"), 30_000);
  });

  it("IR4: a tree over IMPORT_MAX_ENTRIES pauses with repo_too_large, nothing stored", async () => {
    const res = await worker.fetch(
      "/api/pools",
      bearer({
        pool: "imp-big",
        source: { url: `https://github.com/tldrs/src-big`, branch: "main" },
        request_id: "r-big",
      }),
    );
    expect(res.status).toBe(200);
    await waitFor(async () => {
      const events = await worker.events("imp-big");
      return events.some((e) => e.type === "pool.state" && e.state === "paused" && e.reason === "repo_too_large");
    }, 60_000);
    const events = await worker.events("imp-big");
    expect(events.some((e) => e.type === "pool.files")).toBe(false);
    const open = await worker.trunk("imp-big").fetch("/internal/open-attempt", {
      method: "POST",
      body: JSON.stringify({
        attempt_id: "imp-b1",
        intent: "try",
        agent_kind: "synthetic",
        truth: [],
        requester: "swarm",
      }),
    });
    expect(((await open.json()) as { error?: string }).error).toBe("pool_not_ready");
  });
});
