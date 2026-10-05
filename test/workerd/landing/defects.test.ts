// test/workerd/landing/defects.test.ts — regression tests for the four defects the first live run
// found and fixed without tests (Slice 3, part 1). Each test names its defect and the rule ids it
// proves, and each was shown to fail when the fix is reverted in the working tree:
//
//   A   the after-commit pipeline re-entered itself from inside the push's own apply, so a refused
//       batch was pushed again before its retry was scheduled — the request never returned
//       (LP5a; fix: the bounded #postCommit loop and the `pushing` guard)
//   B   a pool paused with push_rejected or diverged kept pushing (LP5b, LP8; fix: pushHalted)
//   C   the alarm left a consumed push/repush timer in the table, so the alarm fired without end
//       on a pool with nothing to do (AL1; fix: the timer is deleted before its work runs)
//   D   a Durable Object's SQLite returns a BLOB as an ArrayBuffer — readers that tested
//       instanceof Uint8Array pushed an empty pack (fix: sqlOver converts, blobBytes accepts)
//
// A, B and C run against a remote whose `pre-receive` hook refuses every push (a real refusal by
// real git). The retries are driven through `/internal/alarm?now=`, never by sleeping for backoff.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git, gitBytes } from "../../git/helpers.ts";
import { waitFor } from "../trunk/harness.ts";
import { REPO_ROOT } from "../../support/source.ts";
import { startLandingWorker, type LandingWorker } from "./harness.ts";

const KEY = "owner-key-for-tests-0123456789abcdef";
const REFUSE = "it-refuse"; // every push refused by a real pre-receive hook
const ACCEPT = "it-accept"; // accepts every push
const SEED = "tidepool-swarm";

function bearer(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  };
}

/** The retry schedule driven forward: `?now=` puts every due timer past its `due_at`. */
const FAR = () => Date.now() + 3_600_000;

describe("defects A-D of the first live run (Slice 3, part 1)", () => {
  let worker: LandingWorker;

  beforeAll(async () => {
    worker = await startLandingWorker({ ownerKey: KEY, repos: [REFUSE, ACCEPT, "it-head"], refuseRepos: [REFUSE] });
  }, 60_000);
  afterAll(async () => {
    await worker?.dispose();
  });

  it("A+B (LP5a, LP5b, LP8): refused pushes retry on a schedule, then pause and stop", async () => {
    // A: the create answers — a refused batch is not pushed again from inside its own apply.
    const create = await worker.fetch("/api/pools", {
      ...bearer({ pool: REFUSE, seed: SEED, summary_only: false, request_id: "r-refuse" }),
      signal: AbortSignal.timeout(15_000),
    });
    expect(create.status).toBe(200);

    // LP5a: the first rejection already left one push.retry inside the request's post-commit.
    await waitFor(async () => (await worker.events(REFUSE)).some((e) => e.type === "push.retry"), 30_000);

    // Drive the retries through the alarm test path until the pool pauses (LP5b, limit 5). The
    // real alarm also pushes at each backoff, and a run that finds that push still in flight does
    // nothing: on a loaded machine a fixed count of runs can end before the fifth refusal, so the
    // loop is bounded by time instead. Every refusal, whoever drives it, is checked below.
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      const meta = (await worker.trunk(REFUSE).state()).meta as Record<string, string>;
      if (meta.pool_state === "paused") break;
      await worker.runAlarm(REFUSE, FAR());
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const state = (await worker.trunk(REFUSE).state()) as {
      meta: Record<string, string>;
      timers: Array<{ kind: string; key: string; due_at: number }>;
      outbox: unknown;
    };
    // On a failure, name what the pool did so the cause can be read off the report. (These lines
    // found the lost retry timer of `alarm.ts` - see `src/worker/trunk/alarm.test.ts`.)
    const seen = (await worker.events(REFUSE))
      .filter((e) => e.type === "push.retry" || e.type === "pool.paused" || e.type === "trunk.error")
      .map((e) => JSON.stringify(e));
    const why = `events: ${seen.join(" ")} | outbox: ${JSON.stringify(state.outbox)} | timers: ${JSON.stringify(state.timers)}`;
    expect(state.meta.pool_state, why).toBe("paused");
    expect(state.meta.pause_reason).toBe("push_rejected");

    const events = await worker.events(REFUSE);
    // LP5a: rising tries with min(250 * 2^tries, 30_000) spacing — the 5th refusal pauses instead.
    const retries = events.filter((e) => e.type === "push.retry");
    expect(retries.map((e) => e.tries)).toEqual([1, 2, 3, 4]);
    expect(retries.map((e) => e.next_try_ms)).toEqual([500, 1000, 2000, 4000]);
    expect(retries.every((e) => e.error === "rejected")).toBe(true);
    expect(events.filter((e) => e.type === "pool.paused")).toHaveLength(1);
    expect(events.find((e) => e.type === "pool.paused")).toMatchObject({ reason: "push_rejected" });

    // B: the paused pool pushes nothing more — not over alarm runs, real time, or another
    // request's post-commit pass (the pipeline calls the push after every entry). The last
    // refusal left `next_try` ~4s out, so the check out-waits it before the request.
    const before = worker.gitRequests().length;
    await worker.runAlarm(REFUSE, FAR());
    await new Promise((resolve) => setTimeout(resolve, 4_500));
    const tick = await worker.trunk(REFUSE).fetch("/internal/tick", { method: "POST", body: "{}" });
    expect(tick.status).toBe(200);
    await worker.runAlarm(REFUSE, FAR());
    await new Promise((resolve) => setTimeout(resolve, 750));
    await worker.runAlarm(REFUSE, FAR());
    expect(worker.gitRequests().length).toBe(before);

    // C (AL1): the consumed push timer did not stay in the table, and nothing is due in the past.
    const after = (await worker.trunk(REFUSE).state()) as { timers: Array<{ kind: string; due_at: number }> };
    expect(after.timers.filter((t) => t.kind === "push" || t.kind === "repush")).toHaveLength(0);
    expect(after.timers.filter((t) => t.due_at < Date.now())).toHaveLength(0);
  }, 90_000);

  it("C (AL1): an alarm run on a fresh object with nothing pending leaves the timers table empty", async () => {
    const res = await worker.trunk("it-empty").fetch("/internal/alarm", { method: "POST" });
    expect(res.status).toBe(200);
    const state = (await worker.trunk("it-empty").state()) as { timers: unknown[] };
    expect(state.timers).toHaveLength(0);
  });

  it("D: the seed push lands its objects — fsck --strict clean, tree equal to the seed's files", async () => {
    const create = await worker.fetch(
      "/api/pools",
      bearer({ pool: ACCEPT, seed: SEED, summary_only: false, request_id: "r-accept" }),
    );
    expect(create.status).toBe(200);
    await waitFor(() => worker.refs(ACCEPT).main !== null, 30_000);

    const dir = worker.repoDir(ACCEPT);
    expect(() => git(dir, ["fsck", "--strict"])).not.toThrow();

    const main = worker.refs(ACCEPT).main!;
    const events = await worker.events(ACCEPT);
    const seedCommit = String(events.find((e) => e.type === "pool.state")?.head_commit);
    expect(main).toBe(seedCommit);

    // `git cat-file -p` of the seed commit names a tree whose files equal the seed's.
    expect(git(dir, ["cat-file", "-t", main])).toBe("commit");
    const tree = git(dir, ["cat-file", "-p", main])
      .split("\n")
      .find((l) => l.startsWith("tree "))!
      .slice(5);
    const files = git(dir, ["ls-tree", "-r", "--name-only", tree])
      .split("\n")
      .filter((line) => line !== "")
      .sort();
    const seeds = JSON.parse(readFileSync(join(REPO_ROOT, "dist", "seeds.json"), "utf8")) as Record<
      string,
      Record<string, string>
    >;
    const expected = seeds[SEED]!;
    expect(files).toEqual(Object.keys(expected).sort());
    for (const name of files) {
      expect(gitBytes(dir, ["show", `${main}:${name}`]).equals(Buffer.from(expected[name]!, "utf8")), name).toBe(true);
    }
  }, 60_000);

  it("E (SE14, plan 2.2 item 5): HEAD answers what GET answers — status, headers, no body", async () => {
    const create = await worker.fetch(
      "/api/pools",
      bearer({ pool: "it-head", seed: SEED, summary_only: false, request_id: "r-head" }),
    );
    expect(create.status).toBe(200);
    await waitFor(() => worker.refs("it-head").main !== null, 30_000);
    const get = await worker.fetch(`/pool/it-head/main/`, { method: "GET" });
    expect(get.status).toBe(200);
    const head = await worker.fetch(`/pool/it-head/main/`, { method: "HEAD" });
    expect(head.status).toBe(get.status);
    for (const name of ["content-type", "cache-control", "x-content-type-options", "content-security-policy"]) {
      expect(head.headers.get(name), name).toBe(get.headers.get(name));
    }
    expect(await head.text()).toBe("");

    // A versioned file the same way, and a path nothing serves: HEAD answers GET's 404 too.
    const main = worker.refs("it-head").main!;
    const fileGet = await worker.fetch(`/pool/it-head/v/c-${main}/missing.js`, { method: "GET" });
    const fileHead = await worker.fetch(`/pool/it-head/v/c-${main}/missing.js`, { method: "HEAD" });
    expect(fileHead.status).toBe(fileGet.status);
    expect(await fileHead.text()).toBe("");

    const healthGet = await worker.fetch("/api/health", { method: "GET" });
    const healthHead = await worker.fetch("/api/health", { method: "HEAD" });
    expect(healthHead.status).toBe(healthGet.status);
  }, 30_000);
});

describe("defects F and G of the first live run (Slice 3, part 1)", () => {
  const DUP = "it-dup";
  const HANG = "it-hang";
  let worker: LandingWorker;
  beforeAll(async () => {
    // The real workflows binding: `env.SWARM` is the local engine's `SwarmWorkflow`.
    worker = await startLandingWorker({ ownerKey: KEY, repos: [DUP, HANG], swarm: true });
  }, 60_000);
  afterAll(async () => {
    await worker?.dispose();
  });

  it("F (9.8): a second POST /api/pools with the same request_id replays the first answer", async () => {
    const body = { pool: DUP, seed: SEED, summary_only: false, request_id: "r-dup" };
    const first = await worker.fetch("/api/pools", bearer(body));
    expect(first.status).toBe(200);
    const second = await worker.fetch("/api/pools", bearer(body));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    // And a different request_id for the same pool still answers pool_exists (the 9.8 table).
    const third = await worker.fetch("/api/pools", bearer({ ...body, request_id: "r-other" }));
    expect(third.status).toBe(409);
    expect(await third.json()).toMatchObject({ error: { code: "pool_exists" } });
  }, 60_000);

  it("G (PL1): the registration a pool create starts completes — nothing hangs", async () => {
    const create = await worker.fetch(
      "/api/pools",
      bearer({ pool: HANG, seed: SEED, summary_only: false, request_id: "r-hang" }),
    );
    expect(create.status).toBe(200);
    await waitFor(async () => {
      try {
        return (await worker.swarmInstanceStatus(`register-pool-${HANG}-r-hang`)) === "complete";
      } catch {
        return false; // instance.not_found while the engine creates it
      }
    }, 20_000);
  }, 60_000);
});
