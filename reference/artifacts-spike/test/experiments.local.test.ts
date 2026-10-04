/**
 * Runs the real experiment code (the same functions the Durable Object calls)
 * against a fake Artifacts binding whose repos are real bare git repos served
 * by real `git http-backend`. This checks the harness logic end to end:
 * isomorphic-git over the in-memory filesystem, both auth styles, retries on
 * *_IN_PROGRESS, the raw push path and token redaction.
 *
 * Expected values come from how real git behaves and from the documented
 * Artifacts token rules. The test says nothing about the real service.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runExperiment, type AiLike, type Deps, type RepoState, type WarmState } from "../src/experiments";
import { secretForms, type ExperimentResult } from "../src/recorder";
import { FakeArtifacts } from "./helpers/fake-artifacts";
import { git, makeTempDir, removeDir, startGitServer, type GitServer } from "./helpers/git-http-server";

let root: string;
let server: GitServer;
let fake: FakeArtifacts;
let deps: Deps;
const state = new Map<string, unknown>();
const warm: WarmState = {};
const aiCalls: { model: string; input: Record<string, unknown> }[] = [];

function toolCall(id: string, name: string, args: Record<string, string>) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** Scripted stand-in for Workers AI: read both files, make the edits, say DONE. */
const fakeAi: AiLike = {
  async run(model, input) {
    aiCalls.push({ model, input: structuredClone(input) });
    if (model === "fake/missing") throw new Error("5007: No such model fake/missing");
    const messages = input.messages as { role: string }[];
    const turn = messages.filter((m) => m.role === "assistant").length;
    const newValue = model === "fake/wrong" ? "9000" : "8000";
    const steps = [
      [toolCall("call_a", "read_file", { path: "config.ts" }), toolCall("call_b", "read_file", { path: "client.ts" })],
      [
        toolCall("call_c", "replace_in_file", { path: "config.ts", old_string: "TIMEOUT_MS = 5000", new_string: `TIMEOUT_MS = ${newValue}` }),
        toolCall("call_d", "replace_in_file", { path: "client.ts", old_string: "connect(host, 5000)", new_string: `connect(host, ${newValue})` }),
      ],
    ];
    const calls = steps[turn];
    if (model === "fake/legacy") {
      // Older Workers AI output shape: { response, tool_calls: [{ name, arguments }] }.
      return calls ? { response: null, tool_calls: calls.map((c) => ({ name: c.function.name, arguments: JSON.parse(c.function.arguments) })) } : { response: "DONE" };
    }
    return {
      id: "chatcmpl-fake",
      object: "chat.completion",
      choices: [{ index: 0, message: calls ? { role: "assistant", content: null, tool_calls: calls } : { role: "assistant", content: "DONE" }, finish_reason: calls ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
  },
};

function expectNoTokens(result: ExperimentResult): void {
  const text = JSON.stringify(result);
  expect(fake.issued.length).toBeGreaterThan(0);
  for (const token of fake.issued) {
    for (const form of secretForms(token)) expect(text.includes(form), `result leaks a token form (${form.slice(0, 12)}...)`).toBe(false);
  }
  expect(text).not.toMatch(/art_v1_[0-9a-f]{8}/);
}

function verdict(result: ExperimentResult): Record<string, any> {
  return (result.data as { verdict: Record<string, any> }).verdict;
}

async function run(id: string, body: Record<string, unknown> = {}): Promise<ExperimentResult> {
  const result = await runExperiment(id, deps, body);
  // Same serialisation the Worker applies.
  const roundTripped = JSON.parse(JSON.stringify(result)) as ExperimentResult;
  expect(roundTripped.experiment).toBe(id);
  expect(Array.isArray(roundTripped.observations)).toBe(true);
  expect(Array.isArray(roundTripped.http)).toBe(true);
  expect(typeof roundTripped.timings_ms).toBe("object");
  expectNoTokens(roundTripped);
  return roundTripped;
}

function explain(result: ExperimentResult): string {
  return JSON.stringify({ error: result.error, observations: result.observations, verdict: result.data?.verdict }, null, 2);
}

beforeAll(async () => {
  root = makeTempDir("experiments");
  // The first two get() calls after create() or fork() throw *_IN_PROGRESS, so the retry paths run.
  fake = new FakeArtifacts(root, (repo) => server.remoteFor(repo), { createPendingGets: 2, forkPendingGets: 2 });
  server = await startGitServer({ root, authorize: fake.authorize });
  deps = {
    artifacts: fake as unknown as Artifacts,
    ai: fakeAi,
    store: {
      get: async <T>(key: string) => state.get(key) as T | undefined,
      put: async (key: string, value: unknown) => void state.set(key, structuredClone(value)),
      delete: async (key: string) => state.delete(key),
    },
    warm,
    meta: { test: true },
  };
});

afterAll(async () => {
  await server.close();
  removeDir(root);
});

describe("experiments against a fake binding and real git", () => {
  it("e2 and e5 refuse to run before e1", async () => {
    for (const id of ["e2-minted-token", "e5-fork"]) {
      const result = await runExperiment(id, deps, {});
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/run e1-create-push first/);
    }
  });

  it("e1-create-push: creates a repo, waits out CREATE_IN_PROGRESS, pushes three files from memory", async () => {
    const result = await run("e1-create-push");
    expect(result.ok, explain(result)).toBe(true);
    expect(verdict(result)).toMatchObject({ create_token_push_basic: true, create_token_push_bearer: true, binding_sees_pushed_head: true });
    expect(result.observations.join("\n")).toMatch(/repo became ready after 3 get\(\) attempts \(CREATE_IN_PROGRESS, CREATE_IN_PROGRESS\)/);
    const saved = state.get("e1") as RepoState;
    expect(saved.name).toMatch(/^spike-e1-/);
    const path = fake.repoPath(saved.name);
    expect(git(path, ["rev-parse", "refs/heads/main"]).trim()).toBe(saved.head);
    expect(git(path, ["ls-tree", "-r", "--name-only", "main"]).trim().split("\n")).toEqual(["README.md", "data/config.json", "src/index.ts"]);
    expect(git(path, ["rev-list", "--count", "main"]).trim()).toBe("2");
    expect(git(path, ["fsck", "--strict", "--full"])).not.toMatch(/error|missing/i);
    // Auth was sent up front: no 401 round trip.
    expect(result.http.every((h) => h.status === 200), JSON.stringify(result.http)).toBe(true);
    expect(result.http.map((h) => h.step)).toContain("push1-basic POST /git-receive-pack");
    expect(typeof result.timings_ms.create_call_ms).toBe("number");
  });

  it("e2-minted-token: pushes with a minted write token in both auth styles and fetches with a read token", async () => {
    const before = (state.get("e1") as RepoState).head;
    const result = await run("e2-minted-token");
    expect(result.ok, explain(result)).toBe(true);
    expect(verdict(result)).toMatchObject({
      minted_write_push_bearer: true,
      minted_write_push_basic: true,
      minted_read_fetch_bearer: true,
      minted_read_fetch_basic: true,
      read_token_push_refused: true,
      create_token_still_accepted: true,
      // The minted token pushed, so no control push with the create() token was needed.
      create_token_control_push: "not needed",
      bug_15429_reproduced: false,
      minted_write_token_got_403: false,
      minted_write_token_refused_on: [],
      needed_token_propagation_wait: false,
    });
    expect(result.data!.minted_write_token_refusals).toEqual([]);
    const matrix = result.data!.probe_matrix as { token: string; style: string; service: string; status: number }[];
    expect(matrix).toHaveLength(14);
    expect(matrix.filter((p) => p.token === "none").map((p) => p.status)).toEqual([401, 401]);
    expect(matrix.filter((p) => p.token === "minted_read" && p.service === "git-receive-pack").map((p) => p.status)).toEqual([403, 403]);
    expect(matrix.filter((p) => p.token === "minted_write").every((p) => p.status === 200)).toBe(true);
    const saved = state.get("e1") as RepoState;
    expect(saved.head).not.toBe(before);
    expect(git(fake.repoPath(saved.name), ["rev-parse", "main"]).trim()).toBe(saved.head);
    expect(git(fake.repoPath(saved.name), ["ls-tree", "--name-only", "main"])).not.toContain("should-not-land.txt");
  });

  it("e3-compare-and-swap: detects that real git enforces the old id, allows force push and branch delete", async () => {
    const result = await run("e3-compare-and-swap");
    expect(result.ok, explain(result)).toBe(true);
    expect(verdict(result)).toMatchObject({
      server_enforces_old_id: true,
      // git's reason for a stale old id on a fast-forward update: the ref lock, not "non-fast-forward".
      stale_old_id_refusal_reason: "failed to update ref",
      server_rejects_create_on_existing_ref: true,
      zero_old_id_refusal_reason: "failed to update ref",
      isogit_stale_push_rejected: true,
      isogit_stale_push_rejected_by: "client (no POST sent)",
      force_push_allowed: true,
      branch_delete_allowed: true,
      // Real git refuses to delete the branch HEAD points at.
      default_branch_delete_allowed: false,
      // Every read of the refs showed at once what the server had reported.
      ref_read_lagged_behind_push: false,
    });
    const statuses = Object.fromEntries(result.http.map((h) => [h.step, h.status]));
    expect(statuses["raw-stale-old POST /git-receive-pack"]).toBe(200);
    // Each probe is followed by its control: the same update with the correct old id.
    expect(statuses["raw-stale-old-control POST /git-receive-pack"]).toBe(200);
    expect(statuses["raw-zero-old-control POST /git-receive-pack"]).toBe(200);
    expect(result.observations.join("\n")).toMatch(/control for the stale-old probe: the same update with the correct old id [0-9a-f]{8}: unpack ok; ok refs\/heads\/main/);
    expect(result.http.some((h) => h.step.startsWith("B-push-noforce POST"))).toBe(false);
    expect(result.observations.join("\n")).toMatch(/STALE old id .*ng refs\/heads\/main/);
  });

  it("e4-refs: pushes notes, a branch and custom namespaces, then reads them back by binding and by fetch", async () => {
    const result = await run("e4-refs", { extra_refs: ["refs/pull/1/head"] });
    expect(result.ok, explain(result)).toBe(true);
    const v = verdict(result);
    const refs = ["refs/notes/premise", "refs/heads/green", "refs/session/log", "refs/tags/spike-v0", "refs/agents/a1/head", "refs/pull/1/head"];
    for (const ref of refs) {
      expect(v.push_accepted[ref], `${ref} push`).toBe(true);
      expect(v.advertised_for_push[ref], `${ref} advertised for push`).toBe(true);
      expect(v.advertised_for_fetch_v1[ref], `${ref} advertised for fetch`).toBe(true);
      expect(v.listed_by_v2_ls_refs[ref], `${ref} listed by v2 ls-refs`).toBe(true);
      expect(v.binding_log_full_ref[ref], `${ref} binding log`).toBe("resolved");
      expect(v.binding_readFile_full_ref[ref], `${ref} binding readFile`).toBe("content matches");
      expect(v.fetch[ref], `${ref} fetch`).toBe("fetched, content matches");
    }
    const name = (result.data!.repo as { name: string }).name;
    const head = git(fake.repoPath(name), ["rev-parse", "main"]).trim();
    // Real git can show the note isomorphic-git wrote.
    expect(git(fake.repoPath(name), ["notes", "--ref=premise", "show", head])).toContain("premise: this commit was produced by the spike harness");
  });

  it("e4-refs: uses at most 20 extra refs, and only usable names", async () => {
    const extra = [
      ...Array.from({ length: 100 }, (_, i) => `refs/extra/r${i}`),
      "refs/heads/green", // already one of the built-in cases
      "not-a-ref",
      "refs/has space",
      `refs/${"x".repeat(300)}`,
      42,
    ];
    const result = await run("e4-refs", { extra_refs: extra });
    expect(result.ok, explain(result)).toBe(true);
    const pushed = Object.keys(verdict(result).push_accepted);
    // The 5 built-in refs plus the first 20 usable extra names.
    expect(pushed).toHaveLength(25);
    expect(pushed.slice(5)).toEqual(Array.from({ length: 20 }, (_, i) => `refs/extra/r${i}`));
    expect(result.observations.join("\n")).toContain("extra_refs: 105 given, 20 used");
  });

  it("e5-fork: forks concurrently, retries through FORK_IN_PROGRESS, and pushes to one fork", async () => {
    const source = state.get("e1") as RepoState;
    const result = await run("e5-fork", { n: 4 });
    expect(result.ok, explain(result)).toBe(true);
    expect(verdict(result)).toMatchObject({
      forks_requested: 4,
      forks_usable: 4,
      forks_failed: 0,
      fork_returns_usable_token: true,
      any_fork_retry_needed: true,
      push_to_fork_ok: true,
      source_unchanged_by_fork_push: true,
    });
    const forks = result.data!.forks as { name: string; ready_ms: number; ready_attempts: number; source: string }[];
    expect(forks).toHaveLength(4);
    for (const fork of forks) {
      expect(fork.name).toMatch(/^spike-e5-/);
      // Two FORK_IN_PROGRESS answers, then success.
      expect(fork.ready_attempts).toBe(3);
      expect(fork.source).toBe(`artifacts:spike/${source.name}`);
    }
    expect(git(fake.repoPath(source.name), ["rev-parse", "main"]).trim()).toBe(source.head);
    const pushed = forks.filter((f) => git(fake.repoPath(f.name), ["rev-parse", "main"]).trim() !== source.head);
    expect(pushed).toHaveLength(1);
  });

  it("e5-fork clamps n to the 1..50 range", async () => {
    const result = await run("e5-fork", { n: 0 });
    expect(verdict(result).forks_requested).toBe(1);
  });

  it("e6-read-by-ref: times the binding reads and checks they reflect each push", async () => {
    const result = await run("e6-read-by-ref", { reps: 2, rounds: 2 });
    expect(result.ok, explain(result)).toBe(true);
    for (const label of ["readFile_ms", "log_limit10_ms", "readCommit_ms", "readTree_ms", "readBlob_ms", "info_ms"]) {
      expect(result.timings_ms[label], label).toHaveLength(2);
    }
    const v = verdict(result);
    expect(v.rounds).toBe(2);
    expect(v.some_read_never_caught_up_within_15s).toBe(false);
    expect(v.ms_until_reads_reflect_push.n).toBe(4);
    expect(result.data!.staleness).toHaveLength(2);
  });

  it("e7-soak: runs K commit+push cycles on one warm in-memory repo and reports percentiles", async () => {
    const result = await run("e7-soak", { k: 6 });
    expect(result.ok, explain(result)).toBe(true);
    const v = verdict(result);
    expect(v).toMatchObject({ cycles_requested: 6, cycles_run: 6, failures: 0, first_failure_iteration: null, remote_head_matches_last_push: true });
    expect(result.timings_ms.push_ms).toHaveLength(6);
    expect(v.push_ms_p50).toBeLessThanOrEqual(v.push_ms_p95);
    expect(v.push_ms_p95).toBeLessThanOrEqual(v.push_ms_max);
    // Aggregated rows: 6 discovery GETs and 6 receive-pack POSTs.
    const soakRows = result.http.filter((h) => h.step.startsWith("soak "));
    expect(soakRows.map((h) => [h.step, h.status, h.count])).toEqual([
      ["soak GET /info/refs?service=git-receive-pack", 200, 6],
      ["soak POST /git-receive-pack", 200, 6],
    ]);
    const name = (result.data!.repo as { name: string }).name;
    // Seed commit + 6 soak commits, all on the server.
    expect(git(fake.repoPath(name), ["rev-list", "--count", "main"]).trim()).toBe("7");
    expect(git(fake.repoPath(name), ["show", "main:soak/counter.txt"])).toBe("7\n");
    expect(git(fake.repoPath(name), ["fsck", "--strict", "--full"])).not.toMatch(/error|missing/i);

    const again = await run("e7-soak", { k: 2, reuse: true });
    expect(again.ok, explain(again)).toBe(true);
    expect(again.observations.join("\n")).toMatch(/reusing the warm in-memory repo/);
    expect(git(fake.repoPath(name), ["rev-list", "--count", "main"]).trim()).toBe("9");
  });

  it("e7-soak records the iteration number of a failure", async () => {
    const first = await run("e7-soak", { k: 1 });
    const name = (first.data!.repo as { name: string }).name;
    // Break the remote: the server now answers 404 for this repo.
    await fake.delete(name);
    const result = await run("e7-soak", { k: 8, reuse: true });
    expect(result.ok).toBe(false);
    const v = verdict(result);
    expect(v.first_failure_iteration).toBe(1);
    expect(v.failures).toBe(5); // stops after 5 consecutive failures
    expect(v.cycles_run).toBe(5);
    expect((result.data!.failures as { iteration: number; statuses: number[] }[])[0]).toMatchObject({ iteration: 1, statuses: [401] });
    warm.e7 = undefined;
  });

  it("e8-raw-pack: hand-built single-ref and two-ref pushes, and the atomicity probes, match real git", async () => {
    const result = await run("e8-raw-pack");
    expect(result.ok, explain(result)).toBe(true);
    const v = verdict(result);
    expect(v).toMatchObject({
      single_ref_push: true,
      two_ref_push: { "refs/heads/main": "ok", "refs/notes/premise": "ok", both_updated: true },
      wrong_old_id_rejected: true,
      wrong_old_id_probe_ref: "refs/notes/premise",
      wrong_old_id_refusal_reason: "failed to update ref",
      // Real git without "atomic": the good command is applied in either order.
      one_bad_command_fails_both_without_atomic: { good_first: false, bad_first: false },
      atomic_capability_advertised: true,
      one_bad_command_fails_both_with_atomic: true,
      binding_reads_hand_built_objects: true,
      // A new branch at a commit the server already has: sent with an empty pack, as the git CLI does.
      new_branch_at_existing_commit_with_empty_pack: true,
      ref_read_lagged_behind_push: false,
    });
    const name = (result.data!.repo as { name: string }).name;
    const path = fake.repoPath(name);
    expect(git(path, ["fsck", "--strict", "--full"])).not.toMatch(/error|missing/i);
    // Real git created the branch from the empty-pack request: a 32-byte pack with no objects.
    expect(git(path, ["rev-parse", "refs/heads/e8-existing-commit"]).trim()).toBe(git(path, ["rev-parse", "refs/heads/main"]).trim());
    expect(result.data!.empty_pack_new_branch).toMatchObject({ http_status: 200, pack_bytes: 32, report: { unpackOk: true, refs: [{ ref: "refs/heads/e8-existing-commit", ok: true }] } });
    // commit 1, commit 2, and the good command of each non-atomic mixed push.
    expect(git(path, ["rev-list", "--count", "main"]).trim()).toBe("4");
    // The note from the two-ref push, plus the control update (correct old id) that e8 now
    // sends after the wrong-old-id probes. Before the control existed this count was 1.
    expect(git(path, ["rev-list", "--count", "refs/notes/premise"]).trim()).toBe("2");
    expect((result.data!.atomicity as { control_with_correct_old_id_accepted: boolean }).control_with_correct_old_id_accepted).toBe(true);
    expect(git(path, ["show", "main:docs/notes/readme.txt"])).toBe("nested directory, to exercise sub-trees\n");
    const second = git(path, ["rev-parse", "main~2"]).trim();
    expect(git(path, ["notes", "--ref=premise", "show", second])).toBe("premise: note attached by the two-ref push\n");
    // No isomorphic-git traffic: every recorded request is a raw GET or POST from this module.
    // "control-" is the raw control update added with the precondition check; "empty-pack-" is
    // the raw push of a new branch at an existing commit, added so that e8 measures the empty pack.
    expect(result.http.every((h) => /^(discover|single-ref|two-refs|mixed-|control-|empty-pack-|refs-after-)/.test(h.step)), JSON.stringify(result.http.map((h) => h.step))).toBe(true);
  });

  it("e9-workers-ai: runs the tool loop, feeds tool results back, and checks the final files", async () => {
    aiCalls.length = 0;
    const result = await run("e9-workers-ai", { models: ["fake/good", "fake/legacy", "fake/wrong", "fake/missing"] });
    expect(result.ok).toBe(false); // because of fake/wrong and fake/missing
    const v = verdict(result);
    expect(v["fake/good"]).toMatchObject({ correct: true, turns: 3, error: null });
    expect(v["fake/legacy"]).toMatchObject({ correct: true, turns: 3, error: null });
    expect(v["fake/wrong"]).toMatchObject({ correct: false, turns: 3 });
    expect(v["fake/missing"].correct).toBe(false);
    expect(v["fake/missing"].error).toMatch(/AI\.run threw on turn 1.*No such model/);

    const good = aiCalls.filter((c) => c.model === "fake/good");
    expect(good).toHaveLength(3);
    // Request shape on the first call.
    expect(Object.keys(good[0]!.input).sort()).toEqual(["max_tokens", "messages", "reasoning_effort", "tools"]);
    expect((good[0]!.input.tools as { type: string; function: { name: string } }[]).map((t) => [t.type, t.function.name])).toEqual([
      ["function", "read_file"],
      ["function", "replace_in_file"],
    ]);
    // Second call carries the assistant tool calls and one tool message per call, with the file text.
    const second = good[1]!.input.messages as { role: string; tool_call_id?: string; content?: string; tool_calls?: unknown[] }[];
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool"]);
    expect(second[2]!.tool_calls).toHaveLength(2);
    expect(second[3]).toMatchObject({ tool_call_id: "call_a", content: "export const TIMEOUT_MS = 5000;\nexport const RETRIES = 3;\n" });
    expect(second[4]!.tool_call_id).toBe("call_b");
    const third = good[2]!.input.messages as { role: string; content?: string }[];
    expect(third.slice(-2).map((m) => m.content)).toEqual(["OK: replaced 1 occurrence in config.ts", "OK: replaced 1 occurrence in client.ts"]);

    const onlyGood = await run("e9-workers-ai", { models: ["fake/good"] });
    expect(onlyGood.ok).toBe(true);
  });

  it("e9-workers-ai: runs at most 6 models however many the body names, and falls back to the defaults for a bad list", async () => {
    aiCalls.length = 0;
    const many = Array.from({ length: 5000 }, (_, i) => `fake/model-${i}`);
    const result = await run("e9-workers-ai", { models: many, max_turns: 1 });
    expect(Object.keys(verdict(result))).toEqual(many.slice(0, 6));
    expect(aiCalls).toHaveLength(6);
    expect(result.observations.join("\n")).toContain('"models" named 5000 distinct models; only the first 6 are run');

    aiCalls.length = 0;
    const bad = await run("e9-workers-ai", { models: ["fake/good", 42], max_turns: 1 });
    expect(aiCalls.map((c) => c.model)).toEqual(["@cf/openai/gpt-oss-120b", "@cf/zai-org/glm-5.3-flash"]);
    expect(bad.observations.join("\n")).toContain('"models" must be a non-empty list of model ids');
  });

  it("a hung call ends at the deadline with the observations recorded so far", async () => {
    const hanging: Deps = { ...deps, ai: { run: () => new Promise(() => {}) } };
    const started = Date.now();
    const result = await runExperiment("e9-workers-ai", hanging, { models: ["fake/hangs"], deadline_ms: 1000 });
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/deadline of 1000 ms reached/);
    expect(result.observations[0]).toMatch(/^request shape: env\.AI\.run/);
  });

  it("an unknown experiment id returns ok=false instead of throwing", async () => {
    const result = await runExperiment("e0-nope", deps, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown experiment/);
  });

  it("cleanup: deletes every repo named spike-*, and only those", async () => {
    await fake.create("keep-me");
    const total = fake.repos.size;
    const spikes = [...fake.repos.keys()].filter((n) => n.startsWith("spike-")).length;
    expect(spikes).toBe(total - 1);
    expect(spikes).toBeGreaterThan(8);

    const dry = await run("cleanup", { dry_run: true });
    expect(verdict(dry)).toMatchObject({ matched: spikes, deleted: 0 });
    expect(fake.repos.size).toBe(total);

    const result = await run("cleanup");
    expect(result.ok, explain(result)).toBe(true);
    expect(verdict(result)).toMatchObject({ matched: spikes, deleted: spikes, failed: 0, still_listed_afterwards: 0 });
    expect([...fake.repos.keys()]).toEqual(["keep-me"]);
    expect(state.has("e1")).toBe(false);
  });

  it("released every repo handle it opened", () => {
    expect(fake.handlesOpened).toBeGreaterThan(20);
    expect(fake.handlesDisposed).toBe(fake.handlesOpened);
  });
});

describe("e2 when minted tokens are refused (simulated workers-sdk issue 15429)", () => {
  it("reports the 403, does not wait forever, and still proves the create() token works", async () => {
    const dir = makeTempDir("issue-15429");
    let srv: GitServer | undefined;
    try {
      const broken = new FakeArtifacts(dir, (repo) => srv!.remoteFor(repo), { mintedTokensForbidden: true });
      srv = await startGitServer({ root: dir, authorize: broken.authorize });
      const store = new Map<string, unknown>();
      const local: Deps = {
        artifacts: broken as unknown as Artifacts,
        ai: fakeAi,
        store: { get: async <T>(k: string) => store.get(k) as T | undefined, put: async (k: string, v: unknown) => void store.set(k, v), delete: async (k: string) => store.delete(k) },
        warm: {},
        meta: {},
      };
      expect((await runExperiment("e1-create-push", local, {})).ok).toBe(true);
      const result = await runExperiment("e2-minted-token", local, { token_wait_ms: 1200 });
      expect(result.ok).toBe(false);
      expect(verdict(result)).toMatchObject({
        minted_write_push_bearer: false,
        minted_write_push_basic: false,
        minted_write_clone_bearer: false,
        create_token_still_accepted: true,
        bug_15429_reproduced: true,
        minted_write_token_got_403: true,
        needed_token_propagation_wait: false,
      });
      expect(result.http.some((h) => h.step.startsWith("push-minted-write-bearer GET") && h.status === 403)).toBe(true);
      expect(result.observations.join("\n")).toMatch(/still returned 403 after/);
      expect(result.data!.probe_matrix_after_wait).toHaveLength(14);
      const text = JSON.stringify(result);
      for (const token of broken.issued) for (const form of secretForms(token)) expect(text.includes(form)).toBe(false);
    } finally {
      await srv?.close();
      removeDir(dir);
    }
  });
});
