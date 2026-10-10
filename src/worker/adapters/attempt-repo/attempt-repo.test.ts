import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createScratchRepo, type ScratchRepo } from "../../../../test/support/git.ts";
import type { Pusher } from "../../../protocol/ports.ts";
import {
  ATTEMPT_REF,
  ATTEMPT_REPO_OPTION,
  artifactsAttemptCheckpointWriter,
  artifactsAttemptRepoProvisioner,
  type AttemptCheckpoint,
  type AttemptNamespace,
  type AttemptRepository,
} from "./index.ts";

const repos: ScratchRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.remove();
});

function fixture() {
  const gitRepo = createScratchRepo("premise-attempt-checkpoint-");
  repos.push(gitRepo);
  const existing = new Set<string>();
  const creates: Array<{ name: string; opts: unknown }> = [];
  const forks: Array<{ source: string; name: string; opts: unknown }> = [];
  const gets: string[] = [];
  const mints: Array<{ repo: string; args: unknown[] }> = [];
  const pushes: Parameters<Pusher["push"]>[0][] = [];
  const reads: Parameters<Pusher["readRefs"]>[0][] = [];
  let lostReply = false;
  let rejectPush = false;
  let lagRead = false;
  const initialResult = (name: string) => ({
    name,
    get token(): string {
      throw new Error("S3b: the implicit token must never be read");
    },
  });
  const makeHandle = (name: string): AttemptRepository => ({
    info: async () => ({ name, remote: `https://attempts.example/${name}` }),
    createToken: async (...args) => {
      mints.push({ repo: name, args });
      return { plaintext: `scoped-checkpoint-token-${mints.length}`, expiresAt: "2026-10-11T12:00:00Z" };
    },
    readCommit: async (oid) => {
      if (lagRead) return null;
      const [treeHash, message] = gitRepo.git("show", "-s", "--format=%T%x00%B", oid).split("\0");
      return { treeHash: treeHash!, message: message! };
    },
    fork: async (target, opts) => {
      forks.push({ source: name, name: target, opts });
      if (existing.has(target)) throw { code: "ALREADY_EXISTS" };
      existing.add(target);
      return initialResult(target);
    },
  });
  const binding: AttemptNamespace = {
    create: async (name, opts) => {
      creates.push({ name, opts });
      if (existing.has(name)) throw { code: "ALREADY_EXISTS" };
      existing.add(name);
      return initialResult(name);
    },
    get: async (name) => {
      gets.push(name);
      if (!existing.has(name)) throw { code: "NOT_FOUND" };
      return makeHandle(name);
    },
  };
  const pusher: Pusher = {
    readRefs: async (input) => {
      reads.push(input);
      let head: string | null = null;
      try {
        head = gitRepo.git("rev-parse", "--verify", ATTEMPT_REF);
      } catch {
        // Empty repository, as provisioned by option A.
      }
      return { [ATTEMPT_REF]: head };
    },
    push: async (input) => {
      pushes.push(input);
      if (rejectPush) return { ok: false, kind: "rejected", refs: { [ATTEMPT_REF]: "ng" } };
      execFileSync("git", ["index-pack", "--stdin", "--strict"], {
        cwd: gitRepo.directory,
        env: gitRepo.env,
        input: input.pack,
        stdio: ["pipe", "pipe", "pipe"],
      });
      for (const update of input.updates) gitRepo.git("update-ref", update.ref, update.new, update.old);
      return lostReply
        ? { ok: false, kind: "transport", code: "timeout", http_status: null, retry_after_ms: null }
        : { ok: true, refs: { [ATTEMPT_REF]: "ok" } };
    },
  };
  return {
    gitRepo,
    binding,
    pusher,
    existing,
    creates,
    forks,
    gets,
    mints,
    pushes,
    reads,
    setLostReply: () => (lostReply = true),
    setRejectPush: () => (rejectPush = true),
    setLagRead: () => (lagRead = true),
  };
}

function snapshot(attemptId = "a_checkpoint"): AttemptCheckpoint {
  return {
    repo: `attempt-${createHash("sha1").update(attemptId, "utf8").digest("hex")}`,
    attempt_id: attemptId,
    n: 1,
    step: 3,
    at: 1_791_715_200_000,
    transcript: [
      { step: 1, role: "user", content: "Add a drifting jellyfish." },
      { step: 2, role: "assistant", content: "I will update the jellyfish." },
    ],
    ops: [{ op_seq: 1, tool: "write", path: "creatures/jellyfish.js", content: "export const speed = 2;\n" }],
    premises: [{ kind: "file", key: "creatures/jellyfish.js", hash: "1234", seq: 0 }],
    files: { "creatures/jellyfish.js": "export const speed = 2;\n", "ops.json": '{"pool":true}\n' },
  };
}

describe("S3, S3b, SE22: attempt provisioning", () => {
  it("S3, SE22: defaults to A and creates an empty repository only in ATTEMPTS", async () => {
    const f = fixture();
    const input = snapshot();
    expect(ATTEMPT_REPO_OPTION).toBe("A");
    const result = await artifactsAttemptRepoProvisioner(f.binding).provision(input.attempt_id);
    expect(result).toEqual({ repo: input.repo });
    expect(f.creates).toEqual([{ name: input.repo, opts: { readOnly: false, setDefaultBranch: "attempt" } }]);
    expect(f.gets).toEqual([input.repo]);
    expect(f.forks).toEqual([]);
    expect(f.mints).toEqual([]);
    expect(f.gitRepo.git("for-each-ref")).toBe("");
  });

  it("S3a: a retry after uncertain creation confirms an existing repository", async () => {
    const f = fixture();
    const input = snapshot();
    f.existing.add(input.repo);
    expect(await artifactsAttemptRepoProvisioner(f.binding).provision(input.attempt_id)).toEqual({ repo: input.repo });
    expect(f.gets).toEqual([input.repo]);
    const inaccessible: AttemptNamespace = {
      ...f.binding,
      get: async () => {
        throw { code: "NOT_FOUND" };
      },
    };
    expect(await artifactsAttemptRepoProvisioner(inaccessible).provision(input.attempt_id)).toEqual({
      error: "attempt_repo_provision_failed",
      retry_after_ms: 2_000,
    });
  });

  it("S3a, AG7: failures use a fixed code, do not disclose exception text, and do not assume existence", async () => {
    const f = fixture();
    const binding: AttemptNamespace = {
      ...f.binding,
      create: async () => {
        throw new Error("Authorization: secret credential");
      },
    };
    expect(await artifactsAttemptRepoProvisioner(binding).provision("a_failed")).toEqual({
      error: "attempt_repo_provision_failed",
      retry_after_ms: 2_000,
    });
    expect(f.gets).toEqual([]);
  });

  it("S3, S3b, SE22: B forks only a source in ATTEMPTS and ignores its implicit token", async () => {
    const f = fixture();
    f.existing.add("source-already-in-attempts");
    const input = snapshot();
    const provisioner = artifactsAttemptRepoProvisioner(f.binding, {
      option: "B",
      forkSourceRepo: "source-already-in-attempts",
    });
    expect(await provisioner.provision(input.attempt_id)).toEqual({ repo: input.repo });
    expect(f.creates).toEqual([]);
    expect(f.forks).toEqual([
      {
        source: "source-already-in-attempts",
        name: input.repo,
        opts: { readOnly: false, defaultBranchOnly: false },
      },
    ]);
    expect(f.gets).toEqual(["source-already-in-attempts", input.repo]);
    expect(await artifactsAttemptRepoProvisioner(f.binding, { option: "B" }).provision("a_no_source")).toEqual({
      error: "attempt_repo_fork_namespace",
      retry_after_ms: 2_000,
    });
    expect(f.forks).toHaveLength(1);
  });

  it("SE22, S3b: binding metadata cannot redirect a token to a mismatched or credential-bearing target", async () => {
    const f = fixture();
    const input = snapshot();
    for (const info of [
      { name: "pool-main", remote: "https://attempts.example/safe" },
      { name: input.repo, remote: "https://user:password@attempts.example/unsafe" },
      { name: input.repo, remote: "http://attempts.example/unsafe" },
    ]) {
      const binding: AttemptNamespace = {
        ...f.binding,
        get: async (name) => ({ ...(await f.binding.get(name)), info: async () => info }),
      };
      expect(await artifactsAttemptRepoProvisioner(binding).provision(input.attempt_id)).toEqual({
        error: "attempt_repo_invalid_target",
        retry_after_ms: 2_000,
      });
      expect(await artifactsAttemptCheckpointWriter(binding, { pusher: f.pusher }).push(input)).toEqual({
        ok: false,
        error: "attempt_repo_invalid_target",
      });
    }
    expect(f.mints).toHaveLength(0);
    expect(f.pushes).toHaveLength(0);
  });
});

describe("AG5, S3: checkpoint commits through the existing Pusher", () => {
  it("AG5, S3, S3b: real git reads the three records and every touched file on refs/heads/attempt", async () => {
    const f = fixture();
    const input = snapshot();
    await artifactsAttemptRepoProvisioner(f.binding).provision(input.attempt_id);
    const result = await artifactsAttemptCheckpointWriter(f.binding, { pusher: f.pusher }).push(input);
    expect(result.ok).toBe(true);
    expect(f.gitRepo.git("ls-tree", "-r", "--name-only", ATTEMPT_REF).split("\n")).toEqual([
      "files/creatures/jellyfish.js",
      "files/ops.json",
      "ops.json",
      "premises.json",
      "transcript.jsonl",
    ]);
    expect(
      f.gitRepo
        .git("show", `${ATTEMPT_REF}:transcript.jsonl`)
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(input.transcript);
    expect(JSON.parse(f.gitRepo.git("show", `${ATTEMPT_REF}:ops.json`))).toEqual(input.ops);
    expect(JSON.parse(f.gitRepo.git("show", `${ATTEMPT_REF}:premises.json`))).toEqual(input.premises);
    expect(f.gitRepo.git("show", `${ATTEMPT_REF}:files/creatures/jellyfish.js`)).toBe("export const speed = 2;");
    expect(f.gitRepo.git("show", `${ATTEMPT_REF}:files/ops.json`)).toBe('{"pool":true}');
    expect(f.mints).toEqual([{ repo: input.repo, args: ["write", 3_600] }]);
    expect([...f.reads, ...f.pushes].every((call) => call.token === "scoped-checkpoint-token-1")).toBe(true);
    expect([...f.reads, ...f.pushes].every((call) => call.signal instanceof AbortSignal)).toBe(true);
    expect(f.gitRepo.git("fsck", "--strict")).toBe("");
  });

  it("AG5: checkpoint retries are idempotent and the next checkpoint parents the confirmed ref", async () => {
    const f = fixture();
    const input = snapshot();
    await artifactsAttemptRepoProvisioner(f.binding).provision(input.attempt_id);
    const writer = artifactsAttemptCheckpointWriter(f.binding, { pusher: f.pusher });
    const first = await writer.push(input);
    expect(first.ok).toBe(true);
    expect(await writer.push(input)).toEqual(first);
    expect(f.pushes).toHaveLength(1);
    const next = await writer.push({ ...input, n: 2, step: 5, at: input.at + 1_000, files: { "done.txt": "landed" } });
    expect(next.ok).toBe(true);
    expect(f.gitRepo.git("rev-list", "--count", ATTEMPT_REF)).toBe("2");
    expect(f.gitRepo.git("show", "-s", "--format=%P", ATTEMPT_REF)).toBe(first.ok ? first.commit_oid : "unreachable");
    expect(f.mints.map((mint) => mint.args)).toEqual([
      ["write", 3_600],
      ["write", 3_600],
      ["write", 3_600],
    ]);
  });

  it("AG5: a push that succeeds before its reply is lost is recovered by the live ref", async () => {
    const f = fixture();
    const input = snapshot();
    await artifactsAttemptRepoProvisioner(f.binding).provision(input.attempt_id);
    f.setLostReply();
    const result = await artifactsAttemptCheckpointWriter(f.binding, { pusher: f.pusher }).push(input);
    expect(result).toEqual({ ok: true, commit_oid: f.gitRepo.git("rev-parse", ATTEMPT_REF) });
    expect(f.reads).toHaveLength(2);
    expect(f.gitRepo.git("rev-list", "--count", ATTEMPT_REF)).toBe("1");
  });

  it("AG5: a refused checkpoint stays failed and a lagging object read never creates a duplicate", async () => {
    const f = fixture();
    const input = snapshot();
    await artifactsAttemptRepoProvisioner(f.binding).provision(input.attempt_id);
    const writer = artifactsAttemptCheckpointWriter(f.binding, { pusher: f.pusher });
    expect((await writer.push(input)).ok).toBe(true);
    f.setLagRead();
    expect(await writer.push(input)).toEqual({ ok: false, error: "attempt_checkpoint_not_ready" });
    expect(f.pushes).toHaveLength(1);
    const empty = fixture();
    await artifactsAttemptRepoProvisioner(empty.binding).provision(input.attempt_id);
    empty.setRejectPush();
    expect(await artifactsAttemptCheckpointWriter(empty.binding, { pusher: empty.pusher }).push(input)).toEqual({
      ok: false,
      error: "attempt_checkpoint_push_failed",
    });
    expect(empty.gitRepo.git("for-each-ref")).toBe("");
  });

  it("AG7, SE5a: all checkpoint strings are redacted and JSON records remain valid", async () => {
    const f = fixture();
    const input = snapshot();
    await artifactsAttemptRepoProvisioner(f.binding).provision(input.attempt_id);
    const secret = ["art", "v1", "0123456789abcdef"].join("_");
    const ownerKey = "fixture-owner-credential";
    const result = await artifactsAttemptCheckpointWriter(f.binding, { pusher: f.pusher, secrets: [ownerKey] }).push({
      ...input,
      transcript: [{ content: `Authorization: ${secret}\nNext line ${ownerKey}`, [ownerKey]: "value" }],
      ops: [{ content: secret }],
      premises: [{ key: ownerKey }],
      files: { [`nested/${ownerKey}.js`]: `export const value = '${secret}';` },
    });
    expect(result.ok).toBe(true);
    const transcript = JSON.parse(f.gitRepo.git("show", `${ATTEMPT_REF}:transcript.jsonl`));
    expect(transcript).toEqual({ content: "Authorization: [redacted]\nNext line [redacted]", "[redacted]": "value" });
    for (const path of f.gitRepo.git("ls-tree", "-r", "--name-only", ATTEMPT_REF).split("\n")) {
      const content = f.gitRepo.git("show", `${ATTEMPT_REF}:${path}`);
      expect(content).not.toContain(secret);
      expect(content).not.toContain(ownerKey);
    }
    expect(f.gitRepo.git("show", `${ATTEMPT_REF}:files/nested/[redacted].js`)).toBe(
      "export const value = '[redacted]';",
    );
  });

  it("SE22, AG7: refuses a mismatched repository or unsafe path before minting a token or pushing", async () => {
    const f = fixture();
    const input = snapshot();
    await artifactsAttemptRepoProvisioner(f.binding).provision(input.attempt_id);
    const writer = artifactsAttemptCheckpointWriter(f.binding, { pusher: f.pusher });
    expect(await writer.push({ ...input, repo: "pool-main" })).toEqual({
      ok: false,
      error: "attempt_repo_invalid_target",
    });
    expect(await writer.push({ ...input, files: { "../escape": "bad" } })).toEqual({
      ok: false,
      error: "attempt_checkpoint_failed",
    });
    expect(f.mints).toHaveLength(0);
    expect(f.pushes).toHaveLength(0);
  });
});
