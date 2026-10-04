/**
 * Checks written by the independent checker of this harness (round 2: scenarios C, D and E),
 * kept as regression tests. Each one looks at the harness from outside the experiment code:
 *  - what the experiments really put on the wire (a recording proxy in front of real git);
 *  - that nothing is logged and no key or token comes back (the real entry point and the
 *    real SpikeDO class, with console spied);
 *  - that cleanup deletes only names that start with "spike-", across pages.
 * The checker's scenarios A, B, F, G and H are in experiments.scenarios.test.ts and
 * outside-control.test.ts, with the expected verdicts asserted.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { runExperiment, type Deps, type RepoState, type WarmState } from "../src/experiments";
import worker, { SpikeDO } from "../src/index";
import { ZERO_OID } from "../src/rawgit";
import { secretForms, type ExperimentResult } from "../src/recorder";
import { FakeArtifacts } from "./helpers/fake-artifacts";
import { git, makeTempDir, removeDir, startGitServer, type GitServer } from "./helpers/git-http-server";
import { parseCommands, secretFromAuthorization, startProxy, type ProxiedRequest } from "./helpers/proxy";

const MAIN = "refs/heads/main";
const verdict = (r: ExperimentResult) => (r.data as { verdict: Record<string, any> }).verdict;

function makeDeps(fake: FakeArtifacts): { deps: Deps; state: Map<string, unknown> } {
  const state = new Map<string, unknown>();
  const warm: WarmState = {};
  const deps: Deps = {
    artifacts: fake as unknown as Artifacts,
    ai: { run: async () => ({ choices: [{ message: { role: "assistant", content: "DONE" }, finish_reason: "stop" }] }) },
    store: {
      get: async <T>(key: string) => state.get(key) as T | undefined,
      put: async (key: string, value: unknown) => void state.set(key, structuredClone(value)),
      delete: async (key: string) => state.delete(key),
    },
    warm,
    meta: { independent_check: true },
  };
  return { deps, state };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("what the experiments really put on the wire (plain real git)", () => {
  async function recordedWorld() {
    const root = makeTempDir("wire");
    let server: GitServer | undefined;
    let origin = "";
    const fake = new FakeArtifacts(root, (repo) => `${origin}/git/spike/${repo}.git`);
    server = await startGitServer({ root, authorize: fake.authorize });
    const seen: ProxiedRequest[] = [];
    const proxy = await startProxy(
      () => server!.origin,
      (req) => {
        seen.push(req);
        return undefined;
      },
    );
    origin = proxy.origin;
    cleanups.push(async () => {
      await proxy.close();
      await server!.close();
      removeDir(root);
    });
    return { fake, seen, ...makeDeps(fake) };
  }
  const pushes = (seen: ProxiedRequest[]) => seen.filter((r) => r.method === "POST" && r.path.endsWith("/git-receive-pack"));

  it("e8: the two-ref push is ONE POST with two commands, 'atomic' is sent once, the last push carries an empty pack, and no request comes from isomorphic-git", async () => {
    const { deps, seen } = await recordedWorld();
    const result = await runExperiment("e8-raw-pack", deps, {});
    const all = pushes(seen).map((r) => parseCommands(r.body));
    expect(all[1]!.map((c) => c.ref)).toEqual([MAIN, "refs/notes/premise"]);
    expect((result.data as any).two_refs.report.refs).toEqual([
      { ref: MAIN, ok: true },
      { ref: "refs/notes/premise", ok: true },
    ]);
    expect(all.filter((commands) => commands[0]!.capabilities.split(" ").includes("atomic")).length).toBe(1);
    expect(all.every((commands) => commands[0]!.capabilities.includes("agent=spike-rawgit"))).toBe(true);
    // The last push creates a branch at an existing commit: one command, then a 32-byte pack with zero objects.
    const last = pushes(seen).at(-1)!;
    expect(parseCommands(last.body).map((c) => [c.oldOid, c.ref])).toEqual([[ZERO_OID, "refs/heads/e8-existing-commit"]]);
    const pack = last.body.subarray(last.body.indexOf("PACK"));
    expect(pack.byteLength).toBe(32);
    expect(pack.readUInt32BE(4)).toBe(2); // pack version
    expect(pack.readUInt32BE(8)).toBe(0); // number of objects
  }, 60_000);

  it("e3: the isomorphic-git stale push sends no POST; the raw stale-old probe is a fast-forward with a stale old id, and its control is the same update", async () => {
    const { deps, seen, fake } = await recordedWorld();
    const result = await runExperiment("e3-compare-and-swap", deps, {});
    const path = fake.repoPath((result.data as any).repo.name as string);
    const raw = pushes(seen)
      .map((r) => parseCommands(r.body))
      .filter((commands) => commands[0]!.capabilities.includes("agent=spike-rawgit"));
    // raw[0]: update with the correct old id; raw[1]: stale-old probe; raw[2]: its control.
    const probe = raw[1]![0]!;
    const control = raw[2]![0]!;
    // The default branch is deleted at the end of e3, so the commits are looked up by id.
    const parentOfNew = git(path, ["rev-parse", `${probe.newOid}^`]).trim();
    expect(control.newOid).toBe(probe.newOid);
    expect(control.oldOid).toBe(parentOfNew); // correct old id = parent of the new commit: a fast-forward
    expect(probe.oldOid).not.toBe(parentOfNew);
    expect(git(path, ["merge-base", "--is-ancestor", probe.oldOid, parentOfNew])).toBe(""); // stale, but a real earlier value
    expect(result.http.filter((h) => h.step.startsWith("B-push-noforce") && h.step.includes("POST"))).toEqual([]);
    expect(verdict(result).isogit_stale_push_rejected_by).toBe("client (no POST sent)");
  }, 60_000);

  it("e2: the pushes named 'minted' really carry tokens from createToken() on a repo made by an earlier experiment", async () => {
    const { deps, seen, fake, state } = await recordedWorld();
    expect((await runExperiment("e1-create-push", deps, {})).ok).toBe(true);
    const e1Repo = (state.get("e1") as RepoState).name;
    const before = seen.length;
    await runExperiment("e2-minted-token", deps, {});
    const mine = seen.slice(before);
    const kinds = pushes(mine).map((r) => {
      const secret = secretFromAuthorization(r.headers.authorization);
      const record = fake.tokens.get(secret);
      return `${r.headers.authorization!.split(" ")[0]} ${fake.minted.has(secret) ? "minted" : "create()"}-${record?.scope} repo=${record?.repo === e1Repo ? "e1 repo" : record?.repo}`;
    });
    expect(kinds.slice(0, 2)).toEqual(["Bearer minted-write repo=e1 repo", "Basic minted-write repo=e1 repo"]);
    expect([...new Set(mine.map((r) => /\/git\/spike\/([^/]+)\.git/.exec(r.path)![1]))]).toEqual([e1Repo]);
  }, 60_000);
});

describe("nothing is logged, and the key never comes back", () => {
  it("runs e1, e2 (with the outside control and its recheck) and e3 through the real entry point and the real SpikeDO class with console spied", async () => {
    const root = makeTempDir("no-logging");
    let server: GitServer | undefined;
    const fake = new FakeArtifacts(root, (repo) => server!.remoteFor(repo));
    server = await startGitServer({ root, authorize: fake.authorize });
    cleanups.push(async () => {
      await server!.close();
      removeDir(root);
    });
    const KEY = "independent-check-key-0123456789abcdef";
    const stored = new Map<string, unknown>();
    const ctx = { storage: { get: async (k: string) => stored.get(k), put: async (k: string, value: unknown) => void stored.set(k, structuredClone(value)), delete: async (k: string) => stored.delete(k) } };
    const env = { SPIKE_KEY: KEY, ARTIFACTS: fake, AI: { run: async () => ({ response: "DONE" }) } } as unknown as Env;
    const instance = new (SpikeDO as unknown as new (ctx: unknown, env: Env) => SpikeDO)(ctx, env);
    (env as any).SPIKE_DO = { idFromName: (name: string) => name, get: () => instance };
    const calls: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void calls.push(`${level}: ${args.map(String).join(" ")}`)));
    const bodies: string[] = [];
    try {
      const requests: [string, Record<string, unknown>][] = [
        ["e1-create-push", {}],
        ["e2-minted-token", { outside_control: "write" }],
        ["e2-minted-token", { outside_control_recheck: true }],
        ["e3-compare-and-swap", {}],
        ["nope", {}],
      ];
      for (const [id, body] of requests) {
        const res = await worker.fetch(new Request(`https://w.example/run/${id}`, { method: "POST", headers: { "x-spike-key": KEY, "content-type": "application/json" }, body: JSON.stringify(body) }) as never, env);
        bodies.push(await res.text());
      }
      // An exception inside the Durable Object call, with a token and an account label in its message.
      (env as any).SPIKE_DO = {
        idFromName: (name: string) => name,
        get: () => ({
          run: async () => {
            throw new Error(`boom Authorization: Bearer ${fake.issued[0]} https://x:${fake.issued[0]!.split("?")[0]}@acct123.artifacts.cloudflare.net/git/spike/r.git`);
          },
        }),
      };
      const res = await worker.fetch(new Request("https://w.example/run/e1-create-push", { method: "POST", headers: { "x-spike-key": KEY } }) as never, env);
      bodies.push(await res.text());
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const e2 = JSON.parse(bodies[1]!) as ExperimentResult;
    const recheck = JSON.parse(bodies[2]!) as ExperimentResult;
    expect(recheck.ok).toBe(true);
    // The only token in any response is the one e2 was asked to disclose.
    const withoutDisclosed = bodies.map((body, i) => (i === 1 ? JSON.stringify({ ...e2, disclosed: undefined }) : body)).join("\n");
    const leaks = fake.issued.flatMap((token) => secretForms(token)).filter((form) => withoutDisclosed.includes(form));
    expect(calls).toEqual([]);
    expect(bodies.join("\n").includes(KEY)).toBe(false);
    expect(leaks).toEqual([]);
    expect(withoutDisclosed).not.toContain("acct123");
    expect(fake.tokens.get((e2.disclosed as { token: string }).token.split("?")[0]!)?.scope).toBe("write");
  }, 120_000);
});

describe("cleanup deletes only names that start with 'spike-', across pages", () => {
  it("leaves near-miss names alone, walks every page, and deletes nothing on a dry run", async () => {
    const nearMisses = ["spike", "spike_", "spikey-repo", "Spike-upper", "SPIKE-x", "xspike-1", "my-spike-1", " spike-lead", "prod-main", "spike.-dot"];
    const names = [...nearMisses, ...Array.from({ length: 430 }, (_, i) => `spike-bulk-${String(i).padStart(3, "0")}`), "spike-", "spike-e1-abcd1234", ...Array.from({ length: 25 }, (_, i) => `keep-${i}`)];
    const live = new Set(names);
    const deleted: string[] = [];
    const listCalls: unknown[] = [];
    const artifacts = {
      list: async (opts?: { limit?: number; cursor?: string }) => {
        listCalls.push(opts);
        const sorted = [...live].sort();
        const start = opts?.cursor ? Number(opts.cursor) : 0;
        const limit = opts?.limit ?? 50;
        return { repos: sorted.slice(start, start + limit).map((name) => ({ name })), total: sorted.length, cursor: start + limit < sorted.length ? String(start + limit) : undefined };
      },
      delete: async (name: string) => {
        deleted.push(name);
        return live.delete(name);
      },
    } as unknown as Artifacts;
    const { deps, state } = makeDeps(null as never);
    state.set("e1", { name: "spike-e1-abcd1234" });
    const result = await runExperiment("cleanup", { ...deps, artifacts }, {});
    expect(result.ok).toBe(true);
    expect(deleted.filter((name) => !name.startsWith("spike-"))).toEqual([]);
    expect([...live].filter((name) => name.startsWith("spike-"))).toEqual([]);
    expect(deleted.length).toBe(432);
    expect([...live].filter((name) => !name.startsWith("keep-")).sort()).toEqual([...nearMisses].sort());
    expect(listCalls.length).toBeGreaterThan(1);
    expect(state.has("e1")).toBe(false);

    live.add("spike-again");
    const before = deleted.length;
    const dry = await runExperiment("cleanup", { ...deps, artifacts }, { dry_run: true });
    expect(deleted.length).toBe(before);
    expect((dry.data as { would_delete?: string[] }).would_delete).toEqual(["spike-again"]);
  });
});
