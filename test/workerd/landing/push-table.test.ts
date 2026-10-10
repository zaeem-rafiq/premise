// test/workerd/landing/push-table.test.ts — every row of the LP5 table (01-core 9.6, plan 2.4
// acceptance item 1) against the real bare repository behind the harness's fault proxy. Each row
// is produced honestly: the proxy drops the answer after real git applied it, rewrites one ref
// through update-ref, answers an HTTP status before git runs, or fails the ref read itself. The
// expected action comes from the table; the expected refs come from stock git (BP1).
//
// Rows (remote main, remote notes → action):
//   new, new       → mark_pushed    (dropped response after application)
//   new, old       → retry_notes    (main applied, notes did not)
//   old, old       → repush         (503 before git: nothing applied)
//   old, new       → retry_main     (notes applied, main did not)
//   new, other     → pause          (main landed, notes moved)
//   other, any     → pause          (main moved)
//   old, other     → pause          (nothing applied, notes moved)
//   read failure   → retry, outbox unchanged
// Plus LP5a (401 → a fresh write target and one retry), the 429 `Retry-After` wait, LP6's
// same-pack-bytes retry, the notesless seed batch, and LP7's restart between accept and push.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "../../git/helpers.ts";
import { waitFor } from "../trunk/harness.ts";
import { startLandingWorker, type LandingWorker } from "./harness.ts";
import type { GitFault } from "../../git/helpers.ts";
import type { RecordedRequest } from "../../git/helpers.ts";

const KEY = "owner-key-for-tests-0123456789abcdef";
const SEED = "tidepool-swarm";
const MAIN_REF = "refs/heads/main";
const NOTES_REF = "refs/notes/premise";
const FAR = () => Date.now() + 3_600_000;

const POOLS = [
  "lp5-drop",
  "lp5-notes",
  "lp5-main",
  "lp5-repush",
  "lp5-div-main",
  "lp5-div-old",
  "lp5-div-new",
  "lp5-readfail",
  "lp5-401",
  "lp5-429",
  "lp5-seeddrop",
  "lp7-restart",
];

function bearer(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  };
}

describe("the LP5 table, every row (Slice 3, part 1)", () => {
  let worker: LandingWorker;

  beforeAll(async () => {
    worker = await startLandingWorker({ ownerKey: KEY, repos: POOLS });
  }, 90_000);
  afterAll(async () => {
    await worker?.dispose();
  });

  /** A pool whose seed batch has landed on the remote: `main` is the seed commit. */
  async function createAndSeed(pool: string): Promise<void> {
    const res = await worker.fetch(
      "/api/pools",
      bearer({ pool, seed: SEED, summary_only: false, request_id: `r-${pool}` }),
    );
    expect(res.status).toBe(200);
    await waitFor(() => worker.refs(pool).main !== null, 30_000);
  }

  /** One scripted add-plain agent on the pool — the landing the fault's push is waiting for. */
  async function launch(pool: string): Promise<void> {
    const swarm = await worker.fetch(
      "/api/swarm",
      bearer({
        seed: 7,
        agents: 1,
        launch_per_second: 1,
        collision_dial: 0,
        think_ms: [10, 20],
        rescale_every_s: 60,
        pool,
        running: true,
        patterns: ["add-plain"],
        request_id: `r-swarm-${pool}`,
      }),
    );
    expect(swarm.status).toBe(200);
  }

  /** The receive-pack POSTs the Worker sent to `repo`, in order, body included for the LP6
   * byte-equality check. */
  function pushes(repo: string): Array<RecordedRequest & { body?: Buffer; commands?: Array<{ ref: string }> }> {
    return worker
      .gitRequests()
      .filter(
        (r) => r.method === "POST" && r.path.startsWith(`/${repo}/`) && r.path.endsWith("/git-receive-pack"),
      ) as Array<RecordedRequest & { body?: Buffer; commands?: Array<{ ref: string }> }>;
  }

  /** Fault only `repo`'s receive-pack POSTs, `times` times, then forward. */
  function faultPushes(repo: string, fault: GitFault, times = 1): void {
    let left = times;
    worker.setGitFault((req) =>
      req.method === "POST" && req.path.startsWith(`/${repo}/`) && req.path.endsWith("/git-receive-pack") && left-- > 0
        ? fault
        : { action: "forward" },
    );
  }

  /** Fault every request to `repo` that `match` names — POSTs and the info/refs reads. */
  function faultRepo(repo: string, match: (req: RecordedRequest) => boolean, fault: GitFault): void {
    worker.setGitFault((req) => (req.path.startsWith(`/${repo}/`) && match(req) ? fault : { action: "forward" }));
  }

  it("row new,new → mark_pushed: a response dropped after the remote applied both refs", async () => {
    const POOL = "lp5-drop";
    await createAndSeed(POOL);
    faultPushes(POOL, { action: "apply_then_drop" });
    await launch(POOL);
    // The transport failure makes the push read the refs: both moved — LP5 marks it pushed,
    // no retry, one landing.landed.
    await waitFor(async () => (await worker.events(POOL)).some((e) => e.type === "landing.landed"), 60_000);
    const events = await worker.events(POOL);
    const landing = events.find((e) => e.type === "landing.landed");
    expect(landing).toBeDefined();
    expect(events.filter((e) => e.type === "landing.landed")).toHaveLength(1);
    // The seed's batch 0 and the landing's batch 1 — each pushed exactly once.
    expect(events.filter((e) => e.type === "batch.pushed").map((e) => e.batch_id)).toEqual([0, 1]);
    expect(events.some((e) => e.type === "push.retry")).toBe(false);
    const refs = worker.refs(POOL);
    expect(refs.main).toBe((landing as { commit: string }).commit);
    expect(refs.notes).not.toBeNull();
    const state = (await worker.trunk(POOL).state()) as { outbox: unknown };
    expect(state.outbox).toBeNull();
  }, 90_000);

  it("row new,old → retry_notes: main applied, notes did not — the retry carries the notes command only", async () => {
    const POOL = "lp5-notes";
    await createAndSeed(POOL);
    // Real git applies both commands, the proxy puts notes back, then answers 500 — a transport
    // failure that is only decided by the refs (LP5), never by the report.
    faultPushes(POOL, { action: "apply_then_answer", status: 500, setRefs: { [NOTES_REF]: "revert" } });
    await launch(POOL);
    await waitFor(async () => (await worker.events(POOL)).some((e) => e.type === "push.retry"), 60_000);
    // main is the landing commit already; notes is absent.
    const landing = (await worker.events(POOL)).find((e) => e.type === "landing.landed") as
      { commit: string } | undefined;
    expect(worker.refs(POOL).main).toBe(landing?.commit ?? "");
    expect(worker.refs(POOL).notes).toBeNull();

    worker.setGitFault(() => ({ action: "forward" }));
    await worker.runAlarm(POOL, FAR());
    // The landing's batch (1): the seed's batch 0 was pushed before the fault, so any
    // `batch.pushed` would end the wait before the retry ran.
    await waitFor(
      async () => (await worker.events(POOL)).some((e) => e.type === "batch.pushed" && e.batch_id === 1),
      30_000,
    );

    // LP6: the retry sent the same stored pack bytes and only the notes command.
    const list = pushes(POOL);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[list.length - 1]!.commands?.map((c) => c.ref)).toEqual([NOTES_REF]);
    expect(worker.refs(POOL).notes).not.toBeNull();
  }, 90_000);

  it("row old,new → retry_main: notes applied, main did not — the retry carries the main command only", async () => {
    const POOL = "lp5-main";
    await createAndSeed(POOL);
    faultPushes(POOL, { action: "apply_then_answer", status: 500, setRefs: { [MAIN_REF]: "revert" } });
    await launch(POOL);
    await waitFor(async () => (await worker.events(POOL)).some((e) => e.type === "push.retry"), 60_000);
    // notes moved, main is still the seed commit.
    expect(worker.refs(POOL).notes).not.toBeNull();

    worker.setGitFault(() => ({ action: "forward" }));
    await worker.runAlarm(POOL, FAR());
    // The landing's batch (1): the seed's batch 0 was pushed before the fault, so any
    // `batch.pushed` would end the wait before the retry ran.
    await waitFor(
      async () => (await worker.events(POOL)).some((e) => e.type === "batch.pushed" && e.batch_id === 1),
      30_000,
    );

    const list = pushes(POOL);
    expect(list[list.length - 1]!.commands?.map((c) => c.ref)).toEqual([MAIN_REF]);
    const landing = (await worker.events(POOL)).find((e) => e.type === "landing.landed") as { commit: string };
    expect(worker.refs(POOL).main).toBe(landing.commit);
  }, 90_000);

  it("row old,old → repush: a 503 before git applied nothing — the retry sends both commands, same pack bytes", async () => {
    const POOL = "lp5-repush";
    await createAndSeed(POOL);
    faultPushes(POOL, { action: "answer", status: 503 });
    await launch(POOL);
    await waitFor(async () => (await worker.events(POOL)).some((e) => e.type === "push.retry"), 60_000);
    expect(worker.refs(POOL).notes).toBeNull();

    worker.setGitFault(() => ({ action: "forward" }));
    await worker.runAlarm(POOL, FAR());
    // The landing's batch (1): the seed's batch 0 was pushed before the fault, so any
    // `batch.pushed` would end the wait before the retry ran.
    await waitFor(
      async () => (await worker.events(POOL)).some((e) => e.type === "batch.pushed" && e.batch_id === 1),
      30_000,
    );

    // LP6: the retry's commands are the whole batch and its pack is the stored bytes, not a rebuild.
    const list = pushes(POOL);
    const retry = list[list.length - 1]!;
    expect(retry.commands?.map((c) => c.ref)).toEqual([MAIN_REF, NOTES_REF]);
    const failed = list[list.length - 2]!;
    expect(retry.body !== undefined && failed.body !== undefined && retry.body.equals(failed.body)).toBe(true);
  }, 90_000);

  it("row other,any → pause: main moved to a value no push of this batch produced (diverged)", async () => {
    const POOL = "lp5-div-main";
    await createAndSeed(POOL);
    faultPushes(POOL, { action: "apply_then_answer", status: 500, setRefs: { [MAIN_REF]: "other" } });
    await launch(POOL);
    await waitFor(
      async () =>
        (await worker.events(POOL)).some(
          (e) => e.type === "pool.paused" && (e as { reason?: string }).reason === "diverged",
        ),
      60_000,
    );
    const state = (await worker.trunk(POOL).state()) as { meta: Record<string, string> };
    expect(state.meta.pool_state).toBe("paused");
    expect(state.meta.pause_reason).toBe("diverged");
    // A diverged pool pushes nothing more (LP7a).
    const before = pushes(POOL).length;
    await worker.runAlarm(POOL, FAR());
    expect(pushes(POOL).length).toBe(before);
  }, 90_000);

  it("row old,other → pause: nothing applied and notes moved to a stranger (diverged)", async () => {
    const POOL = "lp5-div-old";
    await createAndSeed(POOL);
    faultPushes(POOL, {
      action: "apply_then_answer",
      status: 500,
      setRefs: { [MAIN_REF]: "revert", [NOTES_REF]: "other" },
    });
    await launch(POOL);
    await waitFor(
      async () =>
        (await worker.events(POOL)).some(
          (e) => e.type === "pool.paused" && (e as { reason?: string }).reason === "diverged",
        ),
      60_000,
    );
    const state = (await worker.trunk(POOL).state()) as { meta: Record<string, string> };
    expect(state.meta.pool_state).toBe("paused");
    expect(state.meta.pause_reason).toBe("diverged");
  }, 90_000);

  it("row new,other → pause: main landed but notes moved to a stranger (diverged)", async () => {
    const POOL = "lp5-div-new";
    await createAndSeed(POOL);
    faultPushes(POOL, { action: "apply_then_answer", status: 500, setRefs: { [NOTES_REF]: "other" } });
    await launch(POOL);
    await waitFor(
      async () =>
        (await worker.events(POOL)).some(
          (e) => e.type === "pool.paused" && (e as { reason?: string }).reason === "diverged",
        ),
      60_000,
    );
    const state = (await worker.trunk(POOL).state()) as { meta: Record<string, string> };
    expect(state.meta.pool_state).toBe("paused");
    expect(state.meta.pause_reason).toBe("diverged");
  }, 90_000);

  it("last row → retry unchanged: the ref read itself fails — the outbox stands, a later push lands it", async () => {
    const POOL = "lp5-readfail";
    await createAndSeed(POOL);
    // 503 on the receive-pack POST and on the info/refs read it triggers.
    let left = 4;
    faultRepo(POOL, () => true, { action: "answer", status: 503 });
    worker.setGitFault((req) =>
      req.path.startsWith(`/${POOL}/`) && left-- > 0 ? { action: "answer", status: 503 } : { action: "forward" },
    );
    await launch(POOL);
    await waitFor(async () => (await worker.events(POOL)).some((e) => e.type === "push.retry"), 60_000);
    // The outbox stands: still pending, no decision taken.
    const mid = (await worker.trunk(POOL).state()) as { outbox: { state: string } | null };
    expect(mid.outbox?.state).toBe("pending");

    worker.setGitFault(() => ({ action: "forward" }));
    await worker.runAlarm(POOL, FAR());
    // The landing's batch (1): the seed's batch 0 was pushed before the fault, so any
    // `batch.pushed` would end the wait before the retry ran.
    await waitFor(
      async () => (await worker.events(POOL)).some((e) => e.type === "batch.pushed" && e.batch_id === 1),
      30_000,
    );
    const landing = (await worker.events(POOL)).find((e) => e.type === "landing.landed") as { commit: string };
    expect(worker.refs(POOL).main).toBe(landing.commit);
  }, 90_000);

  it("LP5a: a 401 asks for a fresh write target and retries once — then the batch lands", async () => {
    const POOL = "lp5-401";
    await createAndSeed(POOL);
    faultPushes(POOL, { action: "answer", status: 401 });
    await launch(POOL);
    await waitFor(async () => (await worker.events(POOL)).some((e) => e.type === "landing.landed"), 60_000);
    // Seed's POST, the 401'd POST, the retried POST (fresh token): three, and no push.retry.
    const list = pushes(POOL);
    expect(list.length).toBe(3);
    const events = await worker.events(POOL);
    expect(events.some((e) => e.type === "push.retry")).toBe(false);
    const landing = events.find((e) => e.type === "landing.landed") as { commit: string };
    expect(worker.refs(POOL).main).toBe(landing.commit);
  }, 90_000);

  it("429: the retry waits at least Retry-After (LP5a's transport rule)", async () => {
    const POOL = "lp5-429";
    await createAndSeed(POOL);
    faultPushes(POOL, { action: "answer", status: 429, headers: { "Retry-After": "2" } });
    await launch(POOL);
    await waitFor(async () => (await worker.events(POOL)).some((e) => e.type === "push.retry"), 60_000);
    const retry = (await worker.events(POOL)).find((e) => e.type === "push.retry") as {
      next_try_ms: number;
      error: string;
    };
    expect(retry.error).toBe("rate_limited");
    expect(retry.next_try_ms).toBeGreaterThanOrEqual(2000);

    worker.setGitFault(() => ({ action: "forward" }));
    await worker.runAlarm(POOL, FAR());
    // The landing's batch (1): the seed's batch 0 was pushed before the fault, so any
    // `batch.pushed` would end the wait before the retry ran.
    await waitFor(
      async () => (await worker.events(POOL)).some((e) => e.type === "batch.pushed" && e.batch_id === 1),
      30_000,
    );
  }, 90_000);

  it("the seed batch too: a dropped answer after the seed's main applied still marks it pushed", async () => {
    // The seed's batch commands no notes ref — absent notes must read as applied, or the row
    // (new, old) would retry a command that does not exist without end.
    const POOL = "lp5-seeddrop";
    faultPushes(POOL, { action: "apply_then_drop" });
    const res = await worker.fetch(
      "/api/pools",
      bearer({ pool: POOL, seed: SEED, summary_only: false, request_id: `r-${POOL}` }),
    );
    expect(res.status).toBe(200);
    await waitFor(async () => (await worker.events(POOL)).some((e) => e.type === "batch.pushed"), 30_000);
    const state = (await worker.trunk(POOL).state()) as { outbox: unknown; meta: Record<string, string> };
    expect(state.outbox).toBeNull();
    expect(state.meta.pool_state).not.toBe("paused");
    // And the retry loop did not spin: a handful of git requests, not hundreds.
    expect(pushes(POOL).length).toBeLessThan(6);
  }, 60_000);

  it("LP3+LP7: Trunk aborted between the landing's acceptance and its push — the restart lands it exactly once", async () => {
    const POOL = "lp7-restart";
    await createAndSeed(POOL);
    // The next receive-pack POST fails until the Worker is gone: the landing is durable, the push is not.
    faultRepo(POOL, (req) => req.method === "POST" && req.path.endsWith("/git-receive-pack"), {
      action: "answer",
      status: 503,
    });
    await launch(POOL);
    // Acceptance is durable before the push (LP3): `landing.accepted`, a pending outbox, a retry armed.
    await waitFor(async () => (await worker.events(POOL)).some((e) => e.type === "push.retry"), 60_000);
    const mid = (await worker.trunk(POOL).state()) as { outbox: { state: string } | null };
    expect(mid.outbox?.state).toBe("pending");

    // Abort: dispose the Worker, start it again over the same object storage.
    await worker.restart();
    worker.setGitFault(() => ({ action: "forward" }));

    // LP7: the first request reconciles from the remote's refs; the alarm drives the push.
    await worker.runAlarm(POOL, FAR());
    await waitFor(async () => (await worker.events(POOL)).some((e) => e.type === "landing.landed"), 30_000);

    const events = await worker.events(POOL);
    const landing = events.find((e) => e.type === "landing.landed") as { commit: string };
    // Exactly one commit per landing: seed + one landing = 2 on the remote's main history.
    expect(worker.refs(POOL).main).toBe(landing.commit);
    expect(Number(git(worker.repoDir(POOL), ["rev-list", "--count", "refs/heads/main"]))).toBe(2);
    expect(worker.refs(POOL).notes).not.toBeNull();
    // T16/LP9: one batch.pushed per batch (the seed's 0 and the landing's 1), one
    // landing.landed — the restart emitted neither again.
    expect(events.filter((e) => e.type === "batch.pushed").map((e) => e.batch_id)).toEqual([0, 1]);
    expect(events.filter((e) => e.type === "landing.landed")).toHaveLength(1);
    const state = (await worker.trunk(POOL).state()) as { outbox: unknown };
    expect(state.outbox).toBeNull();
  }, 120_000);
});
