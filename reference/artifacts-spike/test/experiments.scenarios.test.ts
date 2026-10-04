/**
 * Does each experiment reach the RIGHT verdict when the server does not behave like
 * plain git? Every scenario here is a server (or binding) with one known property, set
 * up with real git plus a hook, a config value or a small proxy. The expected verdicts
 * follow from that known property, not from the experiment code.
 *
 * These scenarios came from an independent check of the harness. Each one failed, or
 * could not be expressed, before the matching fix.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExperimentRunner, runExperiment, type Deps, type RepoState, type WarmState } from "../src/experiments";
import { pollDelayMs, waitReady } from "../src/experiments/common";
import { GIT_CLI_USER_AGENT } from "../src/experiments/e2-minted-token";
import { authHeader, chooseCapabilities, rawDiscover, rawReceivePack, refResult } from "../src/gitops";
import { FLUSH_PKT, ZERO_OID, concatBytes, makeCommit, makeTreeFromFiles, pktLine } from "../src/rawgit";
import { Recorder, secretForms, sleep, type ExperimentResult } from "../src/recorder";
import { FakeArtifacts, FakeArtifactsError, type FakeOptions } from "./helpers/fake-artifacts";
import { git, makeTempDir, removeDir, startGitServer, type AuthRequest, type AuthResult, type GitServer } from "./helpers/git-http-server";
import { overwriteOldIds, parseCommands, secretFromAuthorization, startProxy, type ParsedCommand, type Proxy, type ProxyHook } from "./helpers/proxy";

const MAIN = "refs/heads/main";

function verdict(result: ExperimentResult): Record<string, any> {
  return (result.data as { verdict: Record<string, any> }).verdict;
}

function explain(result: ExperimentResult): string {
  return JSON.stringify({ error: result.error, observations: result.observations, verdict: result.data?.verdict }, null, 2);
}

interface World {
  fake: FakeArtifacts;
  server: GitServer;
  proxy: Proxy | null;
  deps: Deps;
  state: Map<string, unknown>;
}

interface WorldOptions {
  /** Runs on every repo the fake creates (set a config value, install a hook). */
  prepareRepo?: (path: string) => void;
  /** Puts a proxy between the experiments and the git server. */
  hook?: (fake: FakeArtifacts) => ProxyHook;
  /** Replaces the fake's auth check on the git server. */
  authorize?: (fake: FakeArtifacts) => (req: AuthRequest) => AuthResult;
  fakeOptions?: FakeOptions;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function makeWorld(options: WorldOptions = {}): Promise<World> {
  const root = makeTempDir("scenario");
  let server: GitServer | undefined;
  let proxy: Proxy | null = null;
  class PreparedFake extends FakeArtifacts {
    override async create(name: string, opts?: { description?: string; readOnly?: boolean; setDefaultBranch?: string }) {
      const created = await super.create(name, opts);
      options.prepareRepo?.(this.repoPath(name));
      return created;
    }
  }
  const fake = new PreparedFake(root, (repo) => `${proxy ? proxy.origin : server!.origin}/git/spike/${repo}.git`, options.fakeOptions);
  server = await startGitServer({ root, authorize: options.authorize ? options.authorize(fake) : fake.authorize });
  if (options.hook) proxy = await startProxy(() => server!.origin, options.hook(fake));
  const state = new Map<string, unknown>();
  const warm: WarmState = {};
  const deps: Deps = {
    artifacts: fake as unknown as Artifacts,
    ai: { run: async () => ({ choices: [{ index: 0, message: { role: "assistant", content: "DONE" }, finish_reason: "stop" }] }) },
    store: {
      get: async <T>(key: string) => state.get(key) as T | undefined,
      put: async (key: string, value: unknown) => void state.set(key, structuredClone(value)),
      delete: async (key: string) => state.delete(key),
    },
    warm,
    meta: { scenario: true },
  };
  cleanups.push(async () => {
    await proxy?.close();
    await server!.close();
    removeDir(root);
  });
  return { fake, server, proxy, deps, state };
}

function denyNonFastForwards(path: string): void {
  git(path, ["config", "receive.denyNonFastForwards", "true"]);
}

/** Install an `update` hook. It gets: ref name, old id, new id. Exit 1 refuses that ref. */
function installUpdateHook(path: string, script: string): void {
  const hooks = join(path, "hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "update"), `#!/bin/sh\n${script}\nexit 0\n`);
  chmodSync(join(hooks, "update"), 0o755);
}

/** Repo name of a receive-pack POST, or null for any other request. */
function pushedRepo(req: { method: string; path: string }): string | null {
  return req.method === "POST" ? (/^\/git\/[^/]+\/([^/]+)\.git\/git-receive-pack$/.exec(req.path)?.[1] ?? null) : null;
}

/** Value of a ref in a repo on disk, or the zero id when the ref does not exist. */
function refOnDisk(fake: FakeArtifacts, repo: string, ref: string): string {
  try {
    return git(fake.repoPath(repo), ["rev-parse", "--verify", "-q", ref]).trim();
  } catch {
    return ZERO_OID;
  }
}

/** A "server" that never looks at the old id: the proxy replaces every claimed old id with the ref's real value. */
function ignoreOldIds(fake: FakeArtifacts): ProxyHook {
  return (req) => {
    const repo = pushedRepo(req);
    return repo === null ? undefined : { forwardBody: overwriteOldIds(req.body, (ref) => refOnDisk(fake, repo, ref)) };
  };
}

/** True for a push built by rawgit (the raw probes), false for an isomorphic-git push. */
function isRawPush(commands: ParsedCommand[]): boolean {
  return (commands[0]?.capabilities ?? "").includes("agent=spike-rawgit");
}

const OUTAGE = { status: 503, body: "simulated transient error" } as const;

describe("e3 separates old-id enforcement from a refusal of non-fast-forwards", () => {
  it("ground truth: a server behind the old-id rewrite applies a fast-forward that carries a STALE old id", async () => {
    const { fake } = await makeWorld({ prepareRepo: denyNonFastForwards, hook: ignoreOldIds });
    const created = await fake.create("spike-ground-truth");
    const rec = new Recorder("ground-truth");
    const authorization = authHeader(created.token, "basic");
    const adv = await rawDiscover(rec, "discover", created.remote, "git-receive-pack", authorization);
    const capabilities = chooseCapabilities(adv.adv!.capabilities);
    const tree = makeTreeFromFiles({ "f.txt": "x\n" });
    const who = { name: "scenario", email: "scenario@example.invalid", timestamp: 1_790_000_000 };
    const c1 = makeCommit({ tree: tree.root.oid, parents: [], author: who, message: "c1" });
    const c2 = makeCommit({ tree: tree.root.oid, parents: [c1.oid], author: who, message: "c2" });
    const c3 = makeCommit({ tree: tree.root.oid, parents: [c2.oid], author: who, message: "c3" });
    const push = (oldOid: string, commit: typeof c1, objects = [commit]) => rawReceivePack(rec, "push", { url: created.remote, authorization, commands: [{ oldOid, newOid: commit.oid, ref: MAIN }], capabilities, objects });
    expect(refResult(await push(ZERO_OID, c1, [...tree.objects, c1]), MAIN)).toBe("ok");
    expect(refResult(await push(c1.oid, c2), MAIN)).toBe("ok");
    // The old id c1 is stale (the ref is at c2); the new value c3 is a fast-forward.
    expect(refResult(await push(c1.oid, c3), MAIN)).toBe("ok");
    expect(git(fake.repoPath("spike-ground-truth"), ["rev-parse", MAIN]).trim()).toBe(c3.oid);
  });

  it("reports server_enforces_old_id=false for a server that ignores old ids but refuses non-fast-forwards", async () => {
    const { deps } = await makeWorld({ prepareRepo: denyNonFastForwards, hook: ignoreOldIds });
    const result = await runExperiment("e3-compare-and-swap", deps, {});
    // ok means "the probe gave a clear answer"; the answer is that old ids are NOT enforced.
    expect(result.ok, explain(result)).toBe(true);
    expect(verdict(result)).toMatchObject({
      server_enforces_old_id: false,
      server_rejects_create_on_existing_ref: false,
      // This server does refuse non-fast-forwards. That must not leak into the old-id verdict.
      force_push_allowed: false,
    });
    expect(result.observations.join("\n")).toMatch(/FINDING: the server applied a fast-forward update whose old id was stale/);
  });

  it("e8 agrees on the same server: the wrong-old-id command is applied", async () => {
    const { deps } = await makeWorld({ prepareRepo: denyNonFastForwards, hook: ignoreOldIds });
    const result = await runExperiment("e8-raw-pack", deps, {});
    expect(verdict(result)).toMatchObject({
      wrong_old_id_rejected: false,
      one_bad_command_fails_both_without_atomic: { good_first: "the wrong-old-id command was APPLIED", bad_first: "the wrong-old-id command was APPLIED" },
    });
  });

  it("reports server_enforces_old_id=true for real git that also refuses non-fast-forwards, with git's own reason", async () => {
    const { deps } = await makeWorld({ prepareRepo: denyNonFastForwards });
    const result = await runExperiment("e3-compare-and-swap", deps, {});
    expect(result.ok, explain(result)).toBe(true);
    expect(verdict(result)).toMatchObject({
      server_enforces_old_id: true,
      // The reason is about the ref lock, not about a non-fast-forward.
      stale_old_id_refusal_reason: "failed to update ref",
      server_rejects_create_on_existing_ref: true,
      zero_old_id_refusal_reason: "failed to update ref",
      force_push_allowed: false,
    });
    const statuses = Object.fromEntries(result.http.map((h) => [h.step, h.status]));
    // The control (same update, correct old id) was sent and accepted.
    expect(statuses["raw-stale-old-control POST /git-receive-pack"]).toBe(200);
    expect(result.observations.join("\n")).toMatch(/control for the stale-old probe: the same update with the correct old id [0-9a-f]{8}: unpack ok; ok refs\/heads\/main/);
    // The refusal of the stale-old probe is not a non-fast-forward refusal.
    const staleNote = result.observations.find((o) => o.includes("a STALE old id"))!;
    expect(staleNote).toMatch(/ng refs\/heads\/main \(failed to update ref\)/);
    expect(staleNote).not.toContain("non-fast-forward");
  });

  it("reports 'inconclusive' when the server refuses the control too", async () => {
    // The 4th and 5th receive-pack POSTs of e3 are the stale-old probe and its control
    // (1: seed push, 2: push from clone A, 3: raw update with the correct old id).
    let posts = 0;
    const { deps } = await makeWorld({
      hook: () => (req) => {
        if (req.method !== "POST" || !req.path.endsWith("/git-receive-pack")) return undefined;
        posts++;
        return posts === 4 || posts === 5 ? { status: 503, body: "simulated outage" } : undefined;
      },
    });
    const result = await runExperiment("e3-compare-and-swap", deps, {});
    expect(result.ok).toBe(false);
    expect(verdict(result).server_enforces_old_id).toMatch(/^inconclusive \(the server also refused the same update with the correct old id/);
    // The second probe ran against a healthy server and still gave its answer.
    expect(verdict(result).server_rejects_create_on_existing_ref).toBe(true);
  });

  it("reports 'inconclusive' when only the control fails, and keeps git's reason for the refused probe", async () => {
    // Real git (it enforces old ids). The 3rd raw push of e3 is the control of the stale-old probe.
    let rawPushes = 0;
    const { deps } = await makeWorld({
      hook: () => (req) => (pushedRepo(req) !== null && isRawPush(parseCommands(req.body)) && ++rawPushes === 3 ? OUTAGE : undefined),
    });
    const result = await runExperiment("e3-compare-and-swap", deps, {});
    expect(result.ok).toBe(false);
    expect(verdict(result).server_enforces_old_id).toMatch(/^inconclusive \(the server also refused the same update with the correct old id/);
    expect(verdict(result).stale_old_id_refusal_reason).toBe("failed to update ref");
  });
});

describe("e3 needs the server's own 'ng' before it says that old ids are enforced", () => {
  it("one HTTP 503 on the stale-old probe, on a server that IGNORES old ids, gives 'inconclusive' and never true", async () => {
    // Ground truth: the server ignores old ids. Only the first raw push with a wrong old id
    // (the stale-old probe) is answered 503 and never reaches git. Before the fix e3 read the
    // unchanged ref as a refusal and, after the control passed, reported "enforces old ids".
    let failedOnce = false;
    const { deps } = await makeWorld({
      hook: (fake) => (req) => {
        const repo = pushedRepo(req);
        if (repo === null) return undefined;
        const commands = parseCommands(req.body);
        if (isRawPush(commands) && !failedOnce && commands.some((c) => c.oldOid !== refOnDisk(fake, repo, c.ref))) {
          failedOnce = true;
          return OUTAGE;
        }
        return { forwardBody: overwriteOldIds(req.body, (ref) => refOnDisk(fake, repo, ref)) };
      },
    });
    const result = await runExperiment("e3-compare-and-swap", deps, {});
    expect(failedOnce).toBe(true);
    const v = verdict(result);
    expect(v.server_enforces_old_id).toMatch(/^inconclusive \(the probe got no report-status "ng" for the ref: no report-status \(HTTP 503\)/);
    expect(v.server_enforces_old_id).toContain("Run e3 again");
    // A 503 is not the server's reason for refusing an old id.
    expect(v.stale_old_id_refusal_reason).toBeNull();
    // ok means "the probe gave a clear answer". It did not.
    expect(result.ok).toBe(false);
    expect(result.observations.join("\n")).not.toContain("the server enforces the old id");
    // The zero-old probe was not disturbed, and shows what this server really does.
    expect(v.server_rejects_create_on_existing_ref).toBe(false);
  });

  it("a server that ignores old ids and serves ONE lagging ref read is still found out", async () => {
    // Ground truth: the server ignores old ids, and the first ref read after the stale-old
    // probe still shows the value from before that push. Before the fix e3 took the lagging
    // read for "the ref did not move", sent the control, and reported "enforces old ids".
    let lagging: { repo: string; oid: string } | null = null;
    let lagUsed = false;
    const applied: string[] = [];
    const { deps, fake } = await makeWorld({
      hook: (fake) => (req) => {
        const read = /^\/git\/[^/]+\/([^/]+)\.git\/info\/refs\?service=git-receive-pack$/.exec(req.path);
        if (req.method === "GET" && read && lagging?.repo === read[1]) {
          const oid = lagging.oid;
          lagging = null;
          return { status: 200, body: Buffer.from(concatBytes([pktLine("# service=git-receive-pack\n"), FLUSH_PKT, pktLine(`${oid} ${MAIN}\0report-status delete-refs side-band-64k atomic\n`), FLUSH_PKT])) };
        }
        const repo = pushedRepo(req);
        if (repo === null) return undefined;
        const commands = parseCommands(req.body);
        const wrong = commands.find((c) => c.oldOid !== refOnDisk(fake, repo, c.ref));
        if (isRawPush(commands) && wrong) {
          applied.push(wrong.newOid);
          if (!lagUsed) {
            lagUsed = true;
            lagging = { repo, oid: refOnDisk(fake, repo, wrong.ref) };
          }
        }
        return { forwardBody: overwriteOldIds(req.body, (ref) => refOnDisk(fake, repo, ref)) };
      },
    });
    const result = await runExperiment("e3-compare-and-swap", deps, {});
    expect(lagUsed).toBe(true);
    expect(lagging).toBeNull();
    expect(result.ok, explain(result)).toBe(true);
    expect(verdict(result)).toMatchObject({ server_enforces_old_id: false, stale_old_id_refusal_reason: null, server_rejects_create_on_existing_ref: false, ref_read_lagged_behind_push: true });
    const steps = result.http.map((h) => h.step);
    // The server said "ok", the first read lagged, so the ref was read again. No control was sent.
    expect(steps).toContain("raw-refs-after-stale-old-reread1 GET /info/refs?service=git-receive-pack");
    expect(steps.some((step) => step.startsWith("raw-stale-old-control"))).toBe(false);
    const text = result.observations.join("\n");
    expect(text).toMatch(/raw-refs-after-stale-old: the refs showed the change the server had reported only on read 2/);
    expect(text).toMatch(/FINDING: the server applied a fast-forward update whose old id was stale/);
    // Ground truth on disk: both wrong-old-id updates (stale, then zero) are in the branch history.
    const name = (result.data!.repo as { name: string }).name;
    expect(applied).toHaveLength(2);
    for (const oid of applied) expect(git(fake.repoPath(name), ["cat-file", "-t", oid]).trim()).toBe("commit");
  });
});

describe("e3 'allowed' verdicts need the server's own answer", () => {
  const isDelete = (commands: ParsedCommand[], ref: string) => commands.some((c) => c.ref === ref && c.newOid === ZERO_OID);
  const READ = /\/info\/refs\?service=git-receive-pack$/;

  it("one HTTP 503 on the branch delete gives 'inconclusive', not 'delete is not allowed'", async () => {
    const { deps } = await makeWorld({ hook: () => (req) => (pushedRepo(req) !== null && isDelete(parseCommands(req.body), "refs/heads/e3-temp") ? OUTAGE : undefined) });
    const v = verdict(await runExperiment("e3-compare-and-swap", deps, {}));
    expect(v.branch_delete_allowed).toMatch(/^inconclusive \(the receive-pack POST got HTTP 503, which is not a decision about the ref\)/);
    // The other verdicts are untouched (plain real git).
    expect(v).toMatchObject({ server_enforces_old_id: true, force_push_allowed: true, default_branch_delete_allowed: false });
  });

  it("one HTTP 503 on the default-branch delete gives 'inconclusive', not 'not allowed'", async () => {
    const { deps } = await makeWorld({ hook: () => (req) => (pushedRepo(req) !== null && isDelete(parseCommands(req.body), MAIN) ? OUTAGE : undefined) });
    const v = verdict(await runExperiment("e3-compare-and-swap", deps, {}));
    expect(v.default_branch_delete_allowed).toMatch(/^inconclusive \(no decision about refs\/heads\/main: no report-status \(HTTP 503\)/);
    expect(v.branch_delete_allowed).toBe(true);
  });

  it("one failed ref read after the default-branch delete is repeated, and the verdict stands on the second read", async () => {
    let failNextRead = false;
    const { deps } = await makeWorld({
      hook: () => (req) => {
        if (pushedRepo(req) !== null && isDelete(parseCommands(req.body), MAIN)) failNextRead = true;
        else if (req.method === "GET" && READ.test(req.path) && failNextRead) {
          failNextRead = false;
          return OUTAGE;
        }
        return undefined;
      },
    });
    const result = await runExperiment("e3-compare-and-swap", deps, {});
    // Real git refuses to delete the branch HEAD points at, and the second read confirms it is still there.
    expect(verdict(result).default_branch_delete_allowed).toBe(false);
    const statuses = Object.fromEntries(result.http.map((h) => [h.step, h.status]));
    expect(statuses["refs-after-default-delete GET /info/refs?service=git-receive-pack"]).toBe(503);
    expect(statuses["refs-after-default-delete-reread1 GET /info/refs?service=git-receive-pack"]).toBe(200);
  });

  it("when the refs cannot be read back at all after the default-branch delete, the verdict is 'inconclusive', not false", async () => {
    let readsFail = false;
    const { deps } = await makeWorld({
      hook: () => (req) => {
        if (pushedRepo(req) !== null && isDelete(parseCommands(req.body), MAIN)) readsFail = true;
        return req.method === "GET" && READ.test(req.path) && readsFail ? OUTAGE : undefined;
      },
    });
    const v = verdict(await runExperiment("e3-compare-and-swap", deps, {}));
    expect(v.default_branch_delete_allowed).toBe("inconclusive (the server refused the request, but the refs could not be read back)");
  });

  describe("force push", () => {
    /** Answers 503 to the first `failures` force pushes: isomorphic-git updates of main after the push from clone A. */
    const failForcePushes = (failures: number) => () => {
      let updatesOfMain = 0;
      let failed = 0;
      return (req: { method: string; path: string; body: Buffer }) => {
        if (pushedRepo(req) === null) return undefined;
        const commands = parseCommands(req.body);
        if (isRawPush(commands) || !commands.some((c) => c.ref === MAIN && c.oldOid !== ZERO_OID)) return undefined;
        // The 1st such update is the push from clone A; every later one is the force push from B.
        if (++updatesOfMain >= 2 && failed < failures) {
          failed++;
          return OUTAGE;
        }
        return undefined;
      };
    };

    it("one HTTP 503 on the force push is retried, and the verdict is the server's", async () => {
      const { deps } = await makeWorld({ hook: failForcePushes(1) });
      const result = await runExperiment("e3-compare-and-swap", deps, {});
      expect(verdict(result).force_push_allowed).toBe(true);
      expect(result.observations.join("\n")).toMatch(/B-push-force: attempt 1 failed with HttpError.*retrying/);
    });

    it("a force push that never gets an answer gives 'inconclusive', not 'force push is not allowed'", async () => {
      const { deps } = await makeWorld({ hook: failForcePushes(99) });
      const v = verdict(await runExperiment("e3-compare-and-swap", deps, {}));
      expect(v.force_push_allowed).toMatch(/^inconclusive \(the receive-pack POST got HTTP 503, which is not a decision about the ref\)/);
    }, 60_000);
  });
});

describe("a push that failed is not a push that was refused (e2 read token, e3 stale isomorphic-git push)", () => {
  const RECEIVE_READ = /\/info\/refs\?service=git-receive-pack$/;

  it("e3: when the ref discovery of the stale push fails, nobody refused it", async () => {
    // The GETs of info/refs for push in e3, in order: 1 seed push, 2 push from clone A, 3 stale push from clone B.
    let reads = 0;
    const { deps } = await makeWorld({ hook: () => (req) => (req.method === "GET" && RECEIVE_READ.test(req.path) && ++reads === 3 ? OUTAGE : undefined) });
    const v = verdict(await runExperiment("e3-compare-and-swap", deps, {}));
    expect(v.isogit_stale_push_rejected).toMatch(/^inconclusive \(the ref discovery failed, so the push was never decided: HttpError/);
    expect(v.isogit_stale_push_rejected_by).toBe("nobody (the ref discovery failed)");
    // The raw probes are the server-side check, and they were not disturbed.
    expect(v.server_enforces_old_id).toBe(true);
  });

  it("e2: a read-token push that gets HTTP 503 is 'inconclusive', not 'the read token cannot push'", async () => {
    // Every request for push that carries a minted READ token gets 503 instead of the server's 403.
    const { deps } = await makeWorld({
      hook: (fake) => (req) => {
        const token = fake.tokens.get(secretFromAuthorization(req.headers.authorization));
        return req.method === "GET" && RECEIVE_READ.test(req.path) && token?.scope === "read" ? OUTAGE : undefined;
      },
    });
    expect((await runExperiment("e1-create-push", deps, {})).ok).toBe(true);
    const result = await runExperiment("e2-minted-token", deps, {});
    expect(verdict(result).read_token_push_refused).toMatch(/^inconclusive \(the push failed without a refusal by the server: HttpError/);
    // Undisturbed, the server answers 403 and the verdict is true (see experiments.local.test.ts).
    expect(verdict(result)).toMatchObject({ minted_write_push_bearer: true, minted_read_fetch_bearer: true });
  });
});

describe("e4 push verdicts need the server's own answer", () => {
  const SESSION = "refs/session/log";
  const pushesSession = (req: { method: string; path: string; body: Buffer }) => pushedRepo(req) !== null && parseCommands(req.body).some((c) => c.ref === SESSION);

  it("a namespace the server refuses is reported as false, with the others unaffected", async () => {
    const { deps } = await makeWorld({ prepareRepo: (path) => installUpdateHook(path, 'case "$1" in refs/agents/*) echo "namespace denied" >&2; exit 1;; esac') });
    const result = await runExperiment("e4-refs", deps, {});
    expect(result.ok, explain(result)).toBe(true);
    expect(verdict(result).push_accepted).toEqual({ "refs/notes/premise": true, "refs/heads/green": true, [SESSION]: true, "refs/tags/spike-v0": true, "refs/agents/a1/head": false });
  });

  it("one HTTP 503 on a ref push is retried: the namespace is not reported as refused", async () => {
    let failed = false;
    const { deps } = await makeWorld({
      hook: () => (req) => {
        if (!pushesSession(req) || failed) return undefined;
        failed = true;
        return OUTAGE;
      },
    });
    const result = await runExperiment("e4-refs", deps, {});
    expect(failed).toBe(true);
    expect(result.ok, explain(result)).toBe(true);
    expect(verdict(result).push_accepted[SESSION]).toBe(true);
    expect(result.observations.join("\n")).toMatch(/push refs\/session\/log: attempt 1 failed with HttpError.*retrying/);
  });

  it("a ref push that never gets an answer is 'inconclusive', not 'namespace not accepted'", async () => {
    const { deps } = await makeWorld({ hook: () => (req) => (pushesSession(req) ? OUTAGE : undefined) });
    const result = await runExperiment("e4-refs", deps, {});
    const v = verdict(result);
    expect(v.push_accepted[SESSION]).toMatch(/^inconclusive \(the receive-pack POST got HTTP 503, which is not a decision about the ref\)/);
    expect(v.push_accepted["refs/notes/premise"]).toBe(true);
    expect(v.push_accepted["refs/heads/green"]).toBe(true);
    // refs/session/log is one of the namespaces the design needs, so the experiment is not ok.
    expect(result.ok).toBe(false);
  }, 60_000);

  it("a push whose answer was lost counts as accepted when the server advertises the ref at the pushed commit", async () => {
    // The update is applied on the server (the ref points at a commit the repo already has),
    // but every answer to the client is a 503.
    const { deps, fake } = await makeWorld({
      hook: (fake) => (req) => {
        const repo = pushedRepo(req);
        const green = repo === null ? undefined : parseCommands(req.body).find((c) => c.ref === "refs/heads/green");
        if (repo === null || !green) return undefined;
        git(fake.repoPath(repo), ["update-ref", green.ref, green.newOid]);
        return OUTAGE;
      },
    });
    const result = await runExperiment("e4-refs", deps, {});
    expect(result.ok, explain(result)).toBe(true);
    expect(verdict(result).push_accepted["refs/heads/green"]).toBe(true);
    expect(result.observations.join("\n")).toContain("push refs/heads/green: no decision came back, but the server now advertises the ref at the pushed commit, so it was accepted");
    const name = (result.data!.repo as { name: string }).name;
    expect(refOnDisk(fake, name, "refs/heads/green")).toBe(refOnDisk(fake, name, MAIN));
  }, 60_000);
});

describe("e2 counts a refusal wherever it happens", () => {
  it("flags issue 15429 when a minted token passes GET info/refs but gets 403 on every POST", async () => {
    const { deps, fake, state } = await makeWorld({
      hook: (f) => (req) => (req.method === "POST" && f.minted.has(secretFromAuthorization(req.headers.authorization)) ? { status: 403, body: "forbidden on POST (simulated)" } : undefined),
    });
    expect((await runExperiment("e1-create-push", deps, {})).ok).toBe(true);
    const result = await runExperiment("e2-minted-token", deps, { token_wait_ms: 1000 });
    expect(result.ok).toBe(false);
    const v = verdict(result);
    expect(v).toMatchObject({
      minted_write_push_bearer: false,
      minted_write_push_basic: false,
      minted_write_clone_bearer: false,
      create_token_still_accepted: true,
      create_token_control_push: true,
      bug_15429_reproduced: true,
      minted_write_token_got_403: true,
      // The GET probes passed, so there was nothing to wait for.
      needed_token_propagation_wait: false,
    });
    expect([...v.minted_write_token_refused_on].sort()).toEqual(["POST git-receive-pack", "POST git-upload-pack"]);
    // Every GET probe with the minted write token was accepted: the old verdict looked only at these.
    const matrix = result.data!.probe_matrix as { token: string; status: number }[];
    expect(matrix.filter((p) => p.token === "minted_write").every((p) => p.status === 200)).toBe(true);
    // The control push with the create() token landed, and the stored head follows it.
    const saved = state.get("e1") as RepoState;
    expect(git(fake.repoPath(saved.name), ["rev-parse", MAIN]).trim()).toBe(saved.head);
    expect(git(fake.repoPath(saved.name), ["rev-list", "--count", MAIN]).trim()).toBe("4");
  });

  it("polls both auth styles while a minted token is not accepted yet, and reports the propagation delay", async () => {
    const DELAY_MS = 700;
    let firstMintedUse: number | null = null;
    const { deps } = await makeWorld({
      authorize: (fake) => (req) => {
        if (fake.minted.has(secretFromAuthorization(req.authorization))) {
          firstMintedUse ??= Date.now();
          if (Date.now() - firstMintedUse < DELAY_MS) return { status: 403, body: "token not known yet (simulated propagation delay)" };
        }
        return fake.authorize(req);
      },
    });
    expect((await runExperiment("e1-create-push", deps, {})).ok).toBe(true);
    const result = await runExperiment("e2-minted-token", deps, { token_wait_ms: 10_000 });
    expect(result.ok, explain(result)).toBe(true);
    expect(verdict(result)).toMatchObject({ needed_token_propagation_wait: true, bug_15429_reproduced: false, minted_write_token_got_403: false, minted_write_push_bearer: true, minted_write_push_basic: true });
    const text = result.observations.join("\n");
    expect(text).toMatch(/minted write token \(bearer auth\) was refused at first but returned 200 after \d+ ms/);
    expect(text).toMatch(/minted write token \(basic auth\) was refused at first but returned 200 after \d+ ms/);
    // The polls are in the http list as aggregated rows, per auth style and status.
    for (const style of ["bearer", "basic"]) {
      const rows = result.http.filter((h) => h.step === `poll-minted-write:${style} GET /info/refs?service=git-receive-pack`);
      expect(rows.find((h) => h.status === 403)?.count, style).toBeGreaterThanOrEqual(1);
      expect(rows.find((h) => h.status === 200)?.count, style).toBe(1);
    }
    expect(Number(result.timings_ms.minted_write_token_wait_ms)).toBeLessThan(5_000);
  });
});

describe("e2 outside control (opt-in)", () => {
  it("returns nothing extra unless asked", async () => {
    const { deps } = await makeWorld();
    expect((await runExperiment("e1-create-push", deps, {})).ok).toBe(true);
    const result = await runExperiment("e2-minted-token", deps, {});
    expect(result.ok, explain(result)).toBe(true);
    expect(result.disclosed).toBeUndefined();
    expect(result.data!.outside_control).toBeUndefined();
  });

  it.each([
    [true, "read", "git-upload-pack"],
    ["write", "write", "git-receive-pack"],
  ] as const)("with outside_control=%j it mints one 60-second %s token, probes it inside with GET and POST, and returns it only under `disclosed`", async (flag, scope, service) => {
    const { deps, fake, server, state } = await makeWorld();
    expect((await runExperiment("e1-create-push", deps, {})).ok).toBe(true);
    const before = Date.now();
    const result = await runExperiment("e2-minted-token", deps, { outside_control: flag });
    const after = Date.now();
    expect(result.ok, explain(result)).toBe(true);

    const e1 = state.get("e1") as RepoState;
    const disclosed = result.disclosed as { token: string; remote: string; service: string; scope: string; minted_at: string; expires_at: string; post: Record<string, string> };
    expect(disclosed).toMatchObject({ service, scope, remote: e1.remote });
    const record = fake.tokens.get(disclosed.token.split("?expires=")[0]!);
    expect(record, "the disclosed token is one the binding issued").toBeDefined();
    expect(record!.scope).toBe(scope);
    expect(record!.repo).toBe(e1.name);
    // A lifetime of 60 seconds, the shortest the service allows (the fake rounds down to a whole second).
    expect(record!.expiresAt * 1000).toBeLessThanOrEqual(after + 60_000);
    expect(record!.expiresAt * 1000).toBeGreaterThan(before + 58_000);
    expect(Date.parse(disclosed.expires_at)).toBe(record!.expiresAt * 1000);
    expect(Date.parse(disclosed.minted_at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(disclosed.minted_at)).toBeLessThanOrEqual(after);

    // The POST request to repeat outside. Read token: a real fetch of the branch tip.
    // Write token: a push with no commands (a lone flush-pkt), which cannot change the repo.
    const head = git(fake.repoPath(e1.name), ["rev-parse", MAIN]).trim();
    expect(disclosed.post).toEqual({
      path: `/${service}`,
      content_type: `application/x-${service}-request`,
      accept: `application/x-${service}-result`,
      body: scope === "read" ? `0032want ${head}\n00000009done\n` : "0000",
    });

    // Outside `disclosed`, no token appears in any form: not this one, not any other.
    const { disclosed: _removed, ...rest } = result;
    const text = JSON.stringify(rest);
    for (const token of fake.issued) for (const form of secretForms(token)) expect(text.includes(form)).toBe(false);

    // Inside the Durable Object: GET info/refs and one POST, both auth styles, with and
    // without a git User-Agent, all accepted here.
    const inside = (result.data!.outside_control as { inside_durable_object: { request: string; auth: string; user_agent: string; status: number; ms_after_mint: number }[] }).inside_durable_object;
    expect(inside.map((p) => `${p.request}|${p.auth}/${p.user_agent}=${p.status}`)).toEqual(
      ["bearer", "basic"].flatMap((auth) => ["none set", GIT_CLI_USER_AGENT].flatMap((ua) => [`GET info/refs|${auth}/${ua}=200`, `POST ${service}|${auth}/${ua}=200`])),
    );
    // Each probe carries the age of the token, so a reader can see how fresh it was.
    expect(inside.every((p) => p.ms_after_mint >= 0 && p.ms_after_mint < 10_000)).toBe(true);
    expect(verdict(result).outside_control_inside_statuses).toBe(
      `GET info/refs: bearer/no-ua=200 bearer/git-ua=200 basic/no-ua=200 basic/git-ua=200; POST ${service}: bearer/no-ua=200 bearer/git-ua=200 basic/no-ua=200 basic/git-ua=200`,
    );
    // The git User-Agent really reached the server on the four "git" probes (two GET, two POST).
    const withGitAgent = server.requests.filter((r) => r.userAgent === GIT_CLI_USER_AGENT);
    expect(withGitAgent.map((r) => r.method)).toEqual(["GET", "POST", "GET", "POST"]);
    // The POST probes changed nothing.
    expect(git(fake.repoPath(e1.name), ["rev-parse", MAIN]).trim()).toBe(head);
  });

  it("with outside_control_recheck it probes the SAME token from inside once more, then drops it", async () => {
    // The proxy only records which credential each request carried.
    const secrets: string[] = [];
    const { deps, fake } = await makeWorld({
      hook: () => (req) => {
        secrets.push(secretFromAuthorization(req.headers.authorization));
        return undefined;
      },
    });
    expect((await runExperiment("e1-create-push", deps, {})).ok).toBe(true);
    const first = await runExperiment("e2-minted-token", deps, { outside_control: true });
    const token = (first.disclosed as { token: string }).token;
    const issued = fake.issued.length;
    const sentBefore = secrets.length;

    const again = await runExperiment("e2-minted-token", deps, { outside_control_recheck: true });
    expect(again.ok, explain(again)).toBe(true);
    // No new token was minted, and all 8 requests carried the token from the first call.
    expect(fake.issued.length).toBe(issued);
    expect(secrets.slice(sentBefore)).toEqual(Array.from({ length: 8 }, () => token.split("?expires=")[0]));
    const recheck = again.data!.outside_control_recheck as { token_expired_before_end: boolean; inside_durable_object: { request: string; status: number; ms_after_mint: number }[] };
    expect(recheck.token_expired_before_end).toBe(false);
    expect(recheck.inside_durable_object.map((p) => `${p.request}=${p.status}`)).toEqual(Array.from({ length: 4 }, () => ["GET info/refs=200", "POST git-upload-pack=200"]).flat());
    // Later than every probe of the first round.
    const firstRound = (first.data!.outside_control as { inside_durable_object: { ms_after_mint: number }[] }).inside_durable_object;
    expect(recheck.inside_durable_object[0]!.ms_after_mint).toBeGreaterThanOrEqual(firstRound[firstRound.length - 1]!.ms_after_mint);
    expect(verdict(again)).toMatchObject({ outside_control_recheck: "done" });
    // The recheck returns no token at all.
    expect(again.disclosed).toBeUndefined();
    for (const issuedToken of fake.issued) for (const form of secretForms(issuedToken)) expect(JSON.stringify(again).includes(form)).toBe(false);

    // One use only: the token is gone from memory, and nothing is sent.
    const sentAfter = secrets.length;
    const third = await runExperiment("e2-minted-token", deps, { outside_control_recheck: true });
    expect(third.ok).toBe(false);
    expect(verdict(third).outside_control_recheck).toMatch(/^not run: no outside-control token is held in memory/);
    expect(secrets.length).toBe(sentAfter);
  });

  it("cleanup drops a token that is still held for a recheck", async () => {
    const { deps } = await makeWorld();
    expect((await runExperiment("e1-create-push", deps, {})).ok).toBe(true);
    await runExperiment("e2-minted-token", deps, { outside_control: true });
    expect(deps.warm.e2OutsideControl).toBeDefined();
    expect((await runExperiment("cleanup", deps, {})).ok).toBe(true);
    expect(deps.warm.e2OutsideControl).toBeUndefined();
  });
});

describe("e8 checks its precondition before it blames the old id", () => {
  it("uses a second branch for the probes when the server refuses refs/notes/*", async () => {
    const { deps, fake } = await makeWorld({
      prepareRepo: (path) => installUpdateHook(path, 'case "$1" in refs/notes/*) echo "notes namespace denied" >&2; exit 1;; esac'),
    });
    const result = await runExperiment("e8-raw-pack", deps, {});
    // The two-ref push did not fully work, so the experiment as a whole is not ok.
    expect(result.ok).toBe(false);
    const v = verdict(result);
    expect(v).toMatchObject({
      single_ref_push: true,
      two_ref_push: { [MAIN]: "ok", "refs/notes/premise": "ng", both_updated: false },
      wrong_old_id_probe_ref: "refs/heads/e8-probe",
      // Real git enforces the old id; the reason given is the ref lock, not the hook.
      wrong_old_id_rejected: true,
      wrong_old_id_refusal_reason: "failed to update ref",
      one_bad_command_fails_both_without_atomic: { good_first: false, bad_first: false },
      one_bad_command_fails_both_with_atomic: true,
    });
    const path = fake.repoPath((result.data!.repo as { name: string }).name);
    // commit 1, the first probe-branch commit, and the control commit.
    expect(git(path, ["rev-list", "--count", "refs/heads/e8-probe"]).trim()).toBe("3");
    expect(git(path, ["for-each-ref", "--format=%(refname)", "refs/notes"]).trim()).toBe("");
  });

  it("reports 'inconclusive' when the second ref accepts a create but refuses every update, whatever the old id", async () => {
    const { deps } = await makeWorld({
      prepareRepo: (path) => installUpdateHook(path, `case "$1" in refs/notes/*) if [ "$2" != "${ZERO_OID}" ]; then echo "notes are write-once" >&2; exit 1; fi;; esac`),
    });
    const result = await runExperiment("e8-raw-pack", deps, {});
    const v = verdict(result);
    expect(v.two_ref_push).toMatchObject({ both_updated: true });
    expect(v.wrong_old_id_probe_ref).toBe("refs/notes/premise");
    expect(v.wrong_old_id_rejected).toMatch(/^inconclusive \(an update of refs\/notes\/premise with the correct old id was refused too/);
  });

  it("reports 'inconclusive' when no second ref can be set up at all", async () => {
    const { deps } = await makeWorld({
      prepareRepo: (path) => installUpdateHook(path, 'case "$1" in refs/notes/*|refs/heads/e8-probe) echo "denied" >&2; exit 1;; esac'),
    });
    const result = await runExperiment("e8-raw-pack", deps, {});
    expect(result.ok).toBe(false);
    expect(verdict(result)).toMatchObject({
      single_ref_push: true,
      wrong_old_id_probe_ref: null,
      wrong_old_id_rejected: "inconclusive (no second ref could be set up for the probe)",
      one_bad_command_fails_both_without_atomic: { good_first: "not tested", bad_first: "not tested" },
      one_bad_command_fails_both_with_atomic: "not tested",
    });
  });
});

describe("e8 atomicity verdicts need the server's own answer", () => {
  // The receive-pack POSTs of e8 on plain git, in order: 1 single-ref, 2 two-refs,
  // 3 mixed-good-first, 4 mixed-bad-first, 5 mixed-atomic, 6 control, 7 empty-pack branch.
  const failPost = (failAt: number) => () => {
    let posts = 0;
    return (req: { method: string; path: string }) => (pushedRepo(req) !== null && ++posts === failAt ? OUTAGE : undefined);
  };
  const NO_ANSWER = /^inconclusive \(the request got no report-status line for both refs, so it says nothing about atomicity: no report-status \(HTTP 503\)/;

  it.each([
    [3, "good_first", "bad_first"],
    [4, "bad_first", "good_first"],
  ] as const)("one HTTP 503 on receive-pack POST %i (a mixed push) is 'inconclusive' for %s, not 'one bad command fails both'", async (failAt, hit, other) => {
    const { deps } = await makeWorld({ hook: failPost(failAt) });
    const result = await runExperiment("e8-raw-pack", deps, {});
    const v = verdict(result);
    // Real git without "atomic" applies the good command: the undisturbed answer is false for both orders.
    expect(v.one_bad_command_fails_both_without_atomic[hit]).toMatch(NO_ANSWER);
    expect(v.one_bad_command_fails_both_without_atomic[other]).toBe(false);
    expect(v.one_bad_command_fails_both_with_atomic).toBe(true);
    // The failed probe carried a wrong-old-id command that the server never answered.
    expect(v.wrong_old_id_rejected).toMatch(/^inconclusive \(a probe got no report-status "ng" for the wrong-old-id command with the ref confirmed unchanged; a failed request is not a refusal/);
    expect((result.data!.atomicity as { without_atomic_capability: Record<string, { http_status: number }> }).without_atomic_capability[hit]!.http_status).toBe(503);
    // The raw push itself works, which is what ok stands for.
    expect(result.ok, explain(result)).toBe(true);
  });

  it("one HTTP 503 on the atomic push is 'inconclusive', not 'atomic works'", async () => {
    const { deps } = await makeWorld({ hook: failPost(5) });
    const v = verdict(await runExperiment("e8-raw-pack", deps, {}));
    expect(v.one_bad_command_fails_both_with_atomic).toMatch(NO_ANSWER);
    expect(v.one_bad_command_fails_both_without_atomic).toEqual({ good_first: false, bad_first: false });
    expect(v.wrong_old_id_rejected).toBe(true);
  });

  it("a server that ignores old ids and serves ONE lagging ref read is reported as 'APPLIED', not as 'fails both'", async () => {
    // The first read after the first mixed push still shows every ref at its value from
    // before that push. Read alone, that looks like "neither command was applied".
    let lagging: { repo: string; body: Buffer } | null = null;
    let lagUsed = false;
    const { deps } = await makeWorld({
      hook: (fake) => (req) => {
        const read = /^\/git\/[^/]+\/([^/]+)\.git\/info\/refs\?service=git-receive-pack$/.exec(req.path);
        if (req.method === "GET" && read && lagging?.repo === read[1]) {
          const body = lagging.body;
          lagging = null;
          return { status: 200, body };
        }
        const repo = pushedRepo(req);
        if (repo === null) return undefined;
        if (!lagUsed && parseCommands(req.body).some((c) => c.oldOid !== refOnDisk(fake, repo, c.ref))) {
          lagUsed = true;
          const refs = git(fake.repoPath(repo), ["for-each-ref", "--format=%(objectname) %(refname)"]).trim().split("\n");
          lagging = { repo, body: Buffer.from(concatBytes([pktLine("# service=git-receive-pack\n"), FLUSH_PKT, ...refs.map((line, i) => pktLine(i === 0 ? `${line}\0report-status delete-refs side-band-64k atomic\n` : `${line}\n`)), FLUSH_PKT])) };
        }
        return { forwardBody: overwriteOldIds(req.body, (ref) => refOnDisk(fake, repo, ref)) };
      },
    });
    const result = await runExperiment("e8-raw-pack", deps, {});
    expect(lagUsed).toBe(true);
    expect(verdict(result)).toMatchObject({
      wrong_old_id_rejected: false,
      one_bad_command_fails_both_without_atomic: { good_first: "the wrong-old-id command was APPLIED", bad_first: "the wrong-old-id command was APPLIED" },
      ref_read_lagged_behind_push: true,
    });
    expect(result.http.map((h) => h.step)).toContain("refs-after-mixed-good-first-reread1 GET /info/refs?service=git-receive-pack");
  });
});

describe("e5 compares forks with the source's current head", () => {
  it("still finds every fork usable when the head stored by e1 is stale", async () => {
    const { deps, fake, state } = await makeWorld();
    expect((await runExperiment("e1-create-push", deps, {})).ok).toBe(true);
    const saved = state.get("e1") as RepoState;
    const realHead = git(fake.repoPath(saved.name), ["rev-parse", MAIN]).trim();
    const olderCommit = git(fake.repoPath(saved.name), ["rev-parse", `${MAIN}~1`]).trim();
    expect(saved.head).toBe(realHead);
    // Stored state falls behind the repo, as it would if e2 were cut off after a push.
    state.set("e1", { ...saved, head: olderCommit });

    const result = await runExperiment("e5-fork", deps, { n: 2 });
    expect(result.ok, explain(result)).toBe(true);
    expect(verdict(result)).toMatchObject({ forks_usable: 2, forks_failed: 0, source_head_checked_against: realHead, source_unchanged_by_fork_push: true });
    expect(result.observations.join("\n")).toContain(`the stored head ${olderCommit} is stale: the source repo is at ${realHead}`);
  });

  it("lists the fork-token probes in http as aggregated rows, and gives a lower bound for each ready time", async () => {
    const { deps } = await makeWorld({ fakeOptions: { forkPendingGets: 2 } });
    expect((await runExperiment("e1-create-push", deps, {})).ok).toBe(true);
    const result = await runExperiment("e5-fork", deps, { n: 3 });
    expect(result.ok, explain(result)).toBe(true);
    const probes = result.http.filter((h) => h.step.startsWith("fork-token-probe:"));
    expect(probes).toEqual([expect.objectContaining({ step: "fork-token-probe:basic GET /info/refs?service=git-receive-pack", status: 200, count: 3 })]);
    const forks = result.data!.forks as { fork_call_ms: number; ready_ms: number; ready_lower_bound_ms: number; ready_attempts: number }[];
    for (const fork of forks) {
      expect(fork.ready_attempts).toBe(3);
      // The fork was seen "not ready" at least once, so the lower bound is past the fork() call.
      expect(fork.ready_lower_bound_ms).toBeGreaterThanOrEqual(fork.fork_call_ms);
      expect(fork.ready_lower_bound_ms).toBeLessThanOrEqual(fork.ready_ms);
    }
    expect(verdict(result).ready_lower_bound_ms).toMatchObject({ n: 3 });
  });
});

describe("readiness polling", () => {
  it("spaces polls by at most 10% of the time waited, within fixed limits", () => {
    expect(pollDelayMs(0)).toBe(50);
    expect(pollDelayMs(400)).toBe(50);
    expect(pollDelayMs(1_000)).toBe(100);
    expect(pollDelayMs(3_000)).toBe(300);
    expect(pollDelayMs(60_000)).toBe(500);
    // 50 repos polled in parallel: a higher floor keeps the total request rate down.
    expect(pollDelayMs(0, 50)).toBe(250);
    expect(pollDelayMs(60_000, 50)).toBe(500);
  });

  it("brackets the true ready time tightly: it lies between notReadyAtMs and ms, less than 150 ms apart", async () => {
    const READY_AFTER_MS = 700;
    const started = Date.now();
    const info = { id: "id", name: "spike-x", description: null, defaultBranch: "main", createdAt: "", updatedAt: "", lastPushAt: null, source: null, readOnly: false, remote: "http://127.0.0.1/git/spike/spike-x.git" };
    const artifacts = {
      get: async () => {
        if (Date.now() - started < READY_AFTER_MS) throw new FakeArtifactsError("CREATE_IN_PROGRESS", 0, "not ready yet");
        return { info: async () => info };
      },
    } as unknown as Artifacts;
    const outcome = await waitReady(new Recorder("t"), artifacts, "spike-x", "test");
    expect(outcome.notReadyAtMs).not.toBeNull();
    // Lower bound <= true time <= upper bound (2 ms of slack for timer rounding).
    expect(outcome.notReadyAtMs!).toBeLessThanOrEqual(READY_AFTER_MS + 2);
    expect(outcome.ms).toBeGreaterThanOrEqual(READY_AFTER_MS - 2);
    // The exponential backoff this replaced polled at 350 ms and then at 750 ms: a 400 ms gap.
    expect(outcome.ms - outcome.notReadyAtMs!).toBeLessThan(150);
    expect(outcome.attempts).toBeGreaterThan(8);
  });

  it("reports no lower bound when the first poll already succeeds", async () => {
    const artifacts = { get: async () => ({ info: async () => ({ name: "spike-y" }) }) } as unknown as Artifacts;
    const outcome = await waitReady(new Recorder("t"), artifacts, "spike-y", "test");
    expect(outcome).toMatchObject({ attempts: 1, notReadyAtMs: null });
  });
});

describe("deadline and single flight", () => {
  it("a run that reaches its deadline is cancelled: it sends no further request", async () => {
    const { deps, server, fake } = await makeWorld();
    const started = Date.now();
    const result = await runExperiment("e7-soak", deps, { k: 500, deadline_ms: 1000 });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/deadline of 1000 ms reached/);
    expect(result.error).toMatch(/The experiment was cancelled and stopped \d+ ms later/);
    const returnedAt = Date.now();
    // Before the fix the abandoned loop kept pushing after the response had gone out.
    await sleep(1_500);
    // The request that was in flight at the deadline may still finish on the server.
    // What must not happen is a request that ARRIVES after the result was returned.
    expect(server.requests.filter((r) => r.receivedAt > returnedAt)).toEqual([]);
    expect(server.requests.length).toBeGreaterThan(10);
    const name = [...fake.repos.keys()].find((n) => n.startsWith("spike-e7-"))!;
    expect(Number(git(fake.repoPath(name), ["rev-list", "--count", MAIN]).trim())).toBeLessThan(100);
  });

  it("refuses a second experiment while one is running, and accepts it afterwards", async () => {
    const { deps, fake } = await makeWorld();
    const runner = new ExperimentRunner();
    const soak = runner.run("e7-soak", deps, { k: 15 });
    // Sent while the soak is running: cleanup would delete the repo under it.
    const early = await runner.run("cleanup", deps, {});
    expect(early.ok).toBe(false);
    expect(early.experiment).toBe("cleanup");
    expect(early.error).toMatch(/^busy: experiment "e7-soak" has been running on this Durable Object for \d+ ms; one experiment runs at a time\. Nothing was run\./);
    const soakResult = await soak;
    expect(soakResult.ok, explain(soakResult)).toBe(true);
    expect(verdict(soakResult)).toMatchObject({ cycles_run: 15, failures: 0 });
    expect(fake.repos.size).toBe(1);
    // The lock is free again once the experiment has stopped.
    const late = await runner.run("cleanup", deps, {});
    expect(late.ok, explain(late)).toBe(true);
    expect(fake.repos.size).toBe(0);
  });

  it("keeps the lock while a cancelled run has not stopped, then gives up on it after the configured time", async () => {
    const { deps, fake } = await makeWorld();
    // A repo handle whose info() never answers: a binding call that hangs.
    const hanging = Object.assign(Object.create(fake) as FakeArtifacts, {
      get: async () => ({ info: () => new Promise<never>(() => {}), [Symbol.dispose]() {} }),
    });
    const stuckDeps: Deps = { ...deps, artifacts: hanging as unknown as Artifacts };
    const runner = new ExperimentRunner(6_000);
    const stuck = await runner.run("e1-create-push", stuckDeps, { deadline_ms: 1000 });
    expect(stuck.ok).toBe(false);
    expect(stuck.error).toMatch(/deadline of 1000 ms reached.*The experiment was cancelled but had not stopped 5000 ms later/);

    // About 5 s after the cancellation: still locked.
    const refused = await runner.run("cleanup", deps, { dry_run: true });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/^busy: experiment "e1-create-push" .*\(cancelled \d+ ms ago, not stopped yet\)/);

    // More than 6 s after the cancellation: the stuck run is given up on.
    await sleep(1_500);
    const accepted = await runner.run("cleanup", deps, { dry_run: true });
    expect(accepted.ok, explain(accepted)).toBe(true);
    expect(accepted.observations[0]).toMatch(/^experiment "e1-create-push" was cancelled \d+ ms ago and has not stopped/);
  }, 30_000);
});
