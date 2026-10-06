// test/workerd/landing/rebuild.test.ts — the Slice-3c acceptance of 01-core.md 3.6 in local
// workerd (04-build-plan 2.4 item 3): a pool rebuilt from Artifacts.
//
//   the happy path  five landings, an open card and two in-flight attempts, then
//                   POST /api/pools/{pool}/rebuild: `pool.state` runs `rebuilding` ->
//                   `ready` with the epoch one higher (RB5) and `head_seq` 5; every
//                   landing's note blob id is the remote's own (S1c); the card the
//                   Floor held open is closed `stale` (RB0); a `register` during the
//                   job answers `pool_not_ready`, after it re-creates the captured
//                   attempt (step 6); the one that never re-registers is `lost` at
//                   REGISTER_TIMEOUT_MS (step 8); and the next landing is `seq` 6.
//   resumability    a failed run leaves the durable cursor mid-stage (RB3): the job
//                   completes after the fault clears and after a Worker restart.
//   idempotency     one `request_id` starts one job (9.8) — during and after it.
//   diverged        a pool paused `diverged` (the remote's `main` moved by hand,
//                   LP8) is `ready` after the rebuild at the remote's head; the
//                   pushed-by-hand commit is an unwitnessed landing (S1c step 4)
//                   and the `accepted` attempt whose batch never landed re-registers
//                   into a repair (T17, step 7).
//   note mismatch   a note whose `seq` is not the commit's position pauses the pool
//                   `note_seq_mismatch` (3.6 step 2).
//   not a pool      a repository that exists but was never seeded (no `main`) arms
//                   the wipe probe, finds nothing to rebuild and disarms quietly.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, gitBytes } from "../../git/helpers.ts";
import { REGISTER_TIMEOUT_MS } from "../../../src/protocol/constants.ts";
import { startLandingWorker, type LandingWorker } from "./harness.ts";
import { bearer, eventsOf, openAttempt, tool, waitFor } from "../collide/helpers.ts";

const KEY = "owner-key-for-tests-0123456789abcdef";
const SEED = "tidepool";

const MAIN = "rb-main";
const DIVERGED = "rb-diverged";
const MISMATCH = "rb-mismatch";
const EMPTY = "rb-empty";
const NO_NOTES = "rb-no-notes";

/** `?now=` this far ahead makes every due timer due (LP5a's convention). */
const FAR = () => Date.now() + 3_600_000;

/** `/internal/open-attempt`, keeping the ids the response gives back. */
async function openFull(
  worker: LandingWorker,
  pool: string,
  attempt_id: string,
  intent: string,
): Promise<{ attempt_id: string; change_id: string; intent_id: string }> {
  const res = await worker.trunk(pool).fetch("/internal/open-attempt", {
    method: "POST",
    body: JSON.stringify({ attempt_id, intent, agent_kind: "synthetic", truth: [], requester: "swarm" }),
  });
  expect(res.status, `open-attempt ${attempt_id}: ${await res.clone().text()}`).toBe(200);
  const body = (await res.json()) as { attempt_id: string; change_id: string; intent_id: string };
  return body;
}

/** One landing: a new auto-tier file (`creatures/*.js` on `tidepool`), then `submit`. */
async function landFile(
  worker: LandingWorker,
  pool: string,
  attempt: string,
  n: number,
  landedCount: number,
): Promise<void> {
  await openAttempt(worker, pool, attempt, { intent: `add note ${n}` });
  await tool(
    worker,
    pool,
    attempt,
    { tool: "write", args: { path: `creatures/rb-${n}.js`, content: `export const RB_${n} = ${n};\n` } },
    1,
  );
  await tool(worker, pool, attempt, { tool: "submit", args: { summary: `add rb-${n}` } }, 2);
  await waitFor(async () => (await eventsOf(worker, pool, "landing.landed")).length >= landedCount, 60_000);
}

/** The trunk DO's internal state, typed to the rows these tests read. */
async function trunkState(
  worker: LandingWorker,
  pool: string,
): Promise<{
  meta: Record<string, string>;
  timers: Array<{ kind: string; key: string; due_at: number }>;
  landings: Array<{ seq: number; kind: string; commit_oid: string; note_oid: string | null; undone_by: number | null }>;
}> {
  return (await worker.trunk(pool).state()) as never;
}

export type FloorSnapshot = {
  pool: {
    state: string;
    epoch: number;
    head_seq: number;
    head_commit: string;
    rebuild: unknown;
    unwitnessed: number[];
  };
  cards: Record<string, { open: boolean; closed: { action: string; by: string } | null }>;
  open_cards: string[];
  files: Record<string, { exists: boolean; tier: string | null; last_landed_seq: number | null }>;
};

/** One message off a client socket (floor.test.ts's helper shape). */
function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no message in 4 s")), 4_000);
    ws.addEventListener("message", (message) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(message.data)) as Record<string, unknown>);
    });
  });
}

/** The Floor's full reduced state for the pool (the stream's snapshot frame — `/internal/state`
 * answers the smaller FloorRead of FS2, which carries neither epoch nor cards). */
async function floorSnapshot(worker: LandingWorker, pool: string): Promise<FloorSnapshot> {
  const socket = await worker.stream(pool);
  try {
    socket.send(JSON.stringify({ hello: 1, after: 0 }));
    const frame = (await nextMessage(socket)) as { snapshot?: { state?: FloorSnapshot } };
    if (frame.snapshot?.state === undefined) throw new Error(`no snapshot for ${pool}`);
    return frame.snapshot.state;
  } finally {
    socket.close();
  }
}

/** The remote's notes tree: commit oid -> note blob oid (the `refs/notes/premise` fanout). */
function noteBlobs(dir: string): Map<string, string> {
  let ref: string;
  try {
    ref = git(dir, ["rev-parse", "--verify", "refs/notes/premise"]);
  } catch {
    return new Map();
  }
  if (ref === "") return new Map();
  const map = new Map<string, string>();
  for (const line of git(dir, ["ls-tree", "-r", ref])
    .split("\n")
    .filter((l) => l !== "")) {
    const [meta, path] = line.split("\t");
    const oid = (meta ?? "").split(" ")[2];
    if (path !== undefined && oid !== undefined) map.set(path.replace("/", ""), oid);
  }
  return map;
}

/** `refs/notes/premise show <commit>` with its bytes intact (NT1's trailing LF). */
function noteText(dir: string, commit: string): string {
  return gitBytes(dir, ["notes", "--ref=premise", "show", commit]).toString("utf8");
}

async function rebuild(worker: LandingWorker, pool: string, request_id: string): Promise<Record<string, unknown>> {
  const res = await worker.fetch(`/api/pools/${pool}/rebuild`, bearer({ request_id }));
  expect(res.status, `rebuild ${pool}: ${await res.clone().text()}`).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** Alarm runs until the rebuild cursor is gone — the job finished (`ready`), paused on a
 * `note_seq_mismatch`, or disarmed — then the pool's state answers what happened (bounded). */
async function driveRebuild(worker: LandingWorker, pool: string): Promise<string> {
  for (let i = 0; i < 60; i += 1) {
    const meta = (await trunkState(worker, pool)).meta;
    if (meta.rebuild_cursor === undefined) return meta.pool_state ?? "wiped";
    await worker.runAlarm(pool);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return String((await trunkState(worker, pool)).meta.pool_state);
}

describe("rebuild from Artifacts (01-core 3.6, plan 2.4 item 3) in local workerd", () => {
  let worker: LandingWorker;

  beforeAll(async () => {
    worker = await startLandingWorker({
      ownerKey: KEY,
      repos: [MAIN, DIVERGED, MISMATCH, EMPTY, NO_NOTES],
    });
  }, 60_000);
  afterAll(async () => {
    await worker?.dispose();
  });

  it("the route's guards: no key is 401, a missing request_id is invalid_args", async () => {
    const unauth = await worker.fetch(`/api/pools/${MAIN}/rebuild`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: "r-no-key" }),
    });
    expect(unauth.status).toBe(401);
    const bad = await worker.fetch(`/api/pools/${MAIN}/rebuild`, bearer({}));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "invalid_args" } });
  });

  it("a name no repository answers arms nothing (the wipe probe's `not a pool` half)", async () => {
    // "rb-gone-pool" is not in `repos`: `info()` answers NOT_FOUND — nothing is armed or marked.
    const res = await worker.trunk("rb-gone-pool").fetch("/internal/alarm", { method: "POST" });
    expect(res.status).toBe(200);
    const state = (await worker.trunk("rb-gone-pool").state()) as { meta: Record<string, string>; timers: unknown[] };
    expect(state.meta.rebuild_cursor).toBeUndefined();
    expect(state.timers).toHaveLength(0);
  });

  it("a repository with no `main` disarms the probe cleanly (exists but never seeded)", async () => {
    const res = await worker.trunk(EMPTY).fetch("/internal/alarm", { method: "POST" });
    expect(res.status).toBe(200);
    // The probe's arm is asynchronous: the cursor appears first…
    await waitFor(async () => (await trunkState(worker, EMPTY)).meta.rebuild_cursor !== undefined, 30_000);
    // …then the `rebuild` timer runs the job, which finds no `main` in the ref advertisement and
    // releases the arm — the store stays empty (no pool born, no event emitted, EM1).
    await waitFor(async () => {
      await worker.runAlarm(EMPTY, FAR());
      const s = await trunkState(worker, EMPTY);
      return s.meta.rebuild_cursor === undefined;
    }, 30_000);
    const state = await trunkState(worker, EMPTY);
    expect(state.meta.pool_id).toBeUndefined();
    expect(state.meta.rebuild_cursor).toBeUndefined();
    expect(state.timers).toHaveLength(0);
    expect((await worker.events(EMPTY)).filter((e) => e.src === "trunk")).toHaveLength(0);
  });

  it("a pool with no landing has no notes ref, and still rebuilds to ready@0", async () => {
    // Before any landing the remote has `main` and no `refs/notes/premise`: the job skips the notes
    // walk. On the test deployment (2026-10-05) that path left the landings stage's lists unset, and
    // every run of the job failed with a TypeError, so such a pool never left `rebuilding`.
    const create = await worker.fetch(
      "/api/pools",
      bearer({ pool: NO_NOTES, seed: SEED, summary_only: false, request_id: "r-create-rb-no-notes" }),
    );
    expect(create.status, await create.clone().text()).toBe(200);
    await waitFor(async () => (await eventsOf(worker, NO_NOTES, "batch.pushed")).length >= 1, 30_000);
    const refsBefore = worker.refs(NO_NOTES);
    expect(refsBefore.main).not.toBeNull();
    expect(refsBefore.notes, "the seed push writes no note").toBeNull();
    const epochBefore = (await floorSnapshot(worker, NO_NOTES)).pool.epoch;

    expect(await rebuild(worker, NO_NOTES, "r-rb-no-notes-1")).toMatchObject({ ok: true, started: true });
    expect(await driveRebuild(worker, NO_NOTES)).toBe("ready");

    const meta = (await trunkState(worker, NO_NOTES)).meta;
    expect(meta.head_seq).toBe("0");
    expect(meta.head_commit).toBe(refsBefore.main);
    const floor = await floorSnapshot(worker, NO_NOTES);
    expect(floor.pool.epoch).toBe(epochBefore + 1); // RB5
    expect(floor.pool.state).toBe("ready");
    // No failure of the job itself (the harness's plain-merge stand-in has no repo, so `plain` errors
    // are its own noise and not the rebuild's).
    const errors = (await worker.events(NO_NOTES)).filter(
      (e) => e.type === "trunk.error" && String(e.where).includes("rebuild"),
    );
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });

  it("the happy path: 5 landings, a held card, two in-flight attempts — rebuild to ready@5", async () => {
    // ---- arrange: five landings (auto tier), one held card, two in-flight attempts. ----
    const create = await worker.fetch(
      "/api/pools",
      bearer({ pool: MAIN, seed: SEED, summary_only: false, request_id: "r-create-rb-main" }),
    );
    expect(create.status, await create.clone().text()).toBe(200);
    await waitFor(async () => (await eventsOf(worker, MAIN, "batch.pushed")).length >= 1, 30_000);
    for (let i = 1; i <= 5; i += 1) {
      await landFile(worker, MAIN, `rb-land-${i}`, i, i);
    }
    const dir = worker.repoDir(MAIN);
    const landedEvents = await eventsOf(worker, MAIN, "landing.landed");
    const commits = landedEvents.map((e) => String(e.commit));
    const noteIds = noteBlobs(dir);
    const noteContents = new Map(commits.map((c) => [c, noteText(dir, c)]));
    expect(commits).toHaveLength(5);

    // The held card (RB0): a `world/` change answers `held` and its card opens.
    const held = await openFull(worker, MAIN, "rb-held", "raise the energy cap");
    await tool(worker, MAIN, "rb-held", { tool: "read", args: { path: "world/energy.js" } }, 1);
    await tool(
      worker,
      MAIN,
      "rb-held",
      { tool: "replace", args: { path: "world/energy.js", old: "ENERGY_MAX = 100", new: "ENERGY_MAX = 90" } },
      2,
    );
    await tool(worker, MAIN, "rb-held", { tool: "submit", args: { summary: "raise ENERGY_MAX to 90" } }, 3);
    await waitFor(async () => (await eventsOf(worker, MAIN, "card.opened")).length >= 1, 30_000);
    const cardId = String(
      ((await eventsOf(worker, MAIN, "card.opened"))[0] as { card: { card_id: string } }).card.card_id,
    );
    expect(cardId).not.toBe("undefined");

    // In-flight (step 6): one attempt re-registers, one never does (step 8's `lost`).
    const live = await openFull(worker, MAIN, "rb-live", "a change still in flight");
    await tool(worker, MAIN, "rb-live", { tool: "read", args: { path: "GUIDE.md" } }, 1);
    await openAttempt(worker, MAIN, "rb-gone", { intent: "an agent that never comes back" });
    const epochBefore = (await floorSnapshot(worker, MAIN)).pool.epoch;
    const refsBefore = worker.refs(MAIN);

    // ---- act 1: the owner's request arms the job; a repeat is `already`. ----
    expect(await rebuild(worker, MAIN, "r-rb-main-1")).toMatchObject({ ok: true, started: true });
    expect(await rebuild(worker, MAIN, "r-rb-main-1")).toMatchObject({ ok: true, already: true });

    // A fault on object reads wedges the job after `rebuild_begin` — `rebuilding` stands, and
    // `register` answers pool_not_ready (the Agent retries later, 3.6 step 6).
    worker.setReadFault(({ path }) =>
      /\/(log|tree|blob)\//.test(path) ? { action: "answer", status: 503 } : { action: "forward" },
    );
    await worker.runAlarm(MAIN);
    await new Promise((r) => setTimeout(r, 200));
    let meta = (await trunkState(worker, MAIN)).meta;
    expect(meta.pool_state, "begin ran; the walk's log read failed").toBe("rebuilding");

    const during = await worker.trunk(MAIN).fetch("/register", {
      method: "POST",
      body: JSON.stringify({
        attempt_id: live.attempt_id,
        intent_id: live.intent_id,
        change_id: live.change_id,
        revision: 1,
        agent_kind: "synthetic",
        model: null,
        ops: [],
        read_premises: [],
        truth: [],
      }),
    });
    expect(await during.json()).toMatchObject({ ok: false, error: "pool_not_ready" });
    // The same request_id mid-run is still one job.
    expect(await rebuild(worker, MAIN, "r-rb-main-1")).toMatchObject({ ok: true, already: true });

    // ---- act 2: a Worker restart mid-rebuild, then the fault cleared — the cursor resumes. ----
    await worker.restart();
    worker.setReadFault(null);
    expect(await driveRebuild(worker, MAIN)).toBe("ready");

    // ---- the pool rebuilt ----
    meta = (await trunkState(worker, MAIN)).meta;
    expect(meta.pool_state).toBe("ready");
    expect(meta.head_seq).toBe("5");
    expect(meta.head_commit).toBe(refsBefore.main);
    expect(meta.notes_commit).toBe(refsBefore.notes);
    const floor = await floorSnapshot(worker, MAIN);
    expect(floor.pool.epoch).toBe(epochBefore + 1); // RB5
    expect(floor.pool.state).toBe("ready");
    expect(floor.pool.head_seq).toBe(5);

    // The epoch's stream: `pool.state` `rebuilding` then `ready` (3.6's emit pair).
    const states = (await worker.events(MAIN)).filter((e) => e.type === "pool.state" && e.epoch === epochBefore + 1);
    expect(states[0]).toMatchObject({ state: "rebuilding", epoch: epochBefore + 1 });
    expect(states[states.length - 1]).toMatchObject({ state: "ready", epoch: epochBefore + 1, head_seq: 5 });
    expect(states.some((e) => (e.rebuild as { done: number } | null)?.done !== undefined)).toBe(true);

    // S1c: every landing's note blob id is the remote's own — the job read notes by object id.
    const landings = (await trunkState(worker, MAIN)).landings;
    expect(landings.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5]);
    for (const l of landings) {
      expect(l.commit_oid).toBe(commits[l.seq - 1]);
      expect(l.note_oid, `note oid of seq ${l.seq}`).toBe(noteIds.get(l.commit_oid));
    }

    // RB0: the open card is closed `stale` by the epoch bump (the Floor's reducer does it).
    const floorAfter = await floorSnapshot(worker, MAIN);
    expect(floorAfter.cards[cardId]?.closed?.action).toBe("stale");
    expect(floorAfter.open_cards).not.toContain(cardId);

    // Step 6: the captured attempt re-registers — rebuilt `working`, its own intent back.
    const re = await worker.trunk(MAIN).fetch("/register", {
      method: "POST",
      body: JSON.stringify({
        attempt_id: live.attempt_id,
        intent_id: live.intent_id,
        change_id: live.change_id,
        revision: 1,
        agent_kind: "synthetic",
        model: null,
        ops: [],
        read_premises: [],
        truth: [],
      }),
    });
    expect(await re.json()).toMatchObject({ ok: true, attempt: { state: "working" } });
    // An attempt nobody expected is refused (no `register_expect` row for it).
    const bogus = await worker.trunk(MAIN).fetch("/register", {
      method: "POST",
      body: JSON.stringify({
        attempt_id: "rb-never",
        intent_id: "i_x",
        change_id: "c_x",
        revision: 1,
        agent_kind: "synthetic",
        model: null,
        ops: [],
        read_premises: [],
        truth: [],
      }),
    });
    expect(await bogus.json()).toMatchObject({ ok: false, error: "invalid_args" });

    // Step 8: the expected-but-missing attempts (`rb-held`, `rb-gone`) are `lost` at the deadline.
    await worker.runAlarm(MAIN, FAR());
    await worker.runAlarm(MAIN, Date.now() + REGISTER_TIMEOUT_MS + 60_000);
    await waitFor(
      async () =>
        (await eventsOf(worker, MAIN, "attempt.state")).some((e) => e.attempt_id === "rb-gone" && e.reason === "lost"),
      30_000,
    );
    const lost = (await eventsOf(worker, MAIN, "attempt.state")).filter((e) => e.reason === "lost");
    expect(lost.map((e) => e.attempt_id).sort()).toEqual(["rb-gone", "rb-held"]);
    // After the deadline the register that never came answers attempt_closed — the `lost` row
    // exists and `stopped` is terminal.
    const late = await worker.trunk(MAIN).fetch("/register", {
      method: "POST",
      body: JSON.stringify({
        attempt_id: "rb-held",
        intent_id: held.intent_id,
        change_id: held.change_id,
        revision: 1,
        agent_kind: "synthetic",
        model: null,
        ops: [],
        read_premises: [],
        truth: [],
      }),
    });
    expect(await late.json()).toMatchObject({ ok: false, error: "attempt_closed" });

    // The note contents the rebuilt rows serve are the remote's own bytes (S1c, by blob id).
    for (let seq = 1; seq <= 5; seq += 1) {
      const res = await worker.trunk(MAIN).fetch("/internal/state");
      expect(res.status).toBe(200);
      const l = (await trunkState(worker, MAIN)).landings[seq - 1]!;
      const original = JSON.parse(noteContents.get(l.commit_oid)!) as { seq: number };
      expect(original.seq).toBe(seq);
    }

    // The remote is untouched: rebuild reads, never writes.
    expect(worker.refs(MAIN)).toEqual(refsBefore);

    // The rebuilt pool lands again: the next landing is `seq` 6 and pushes as usual.
    await landFile(worker, MAIN, "rb-land-6", 6, 6);
    const six = (await eventsOf(worker, MAIN, "landing.landed")).at(-1);
    expect(six).toMatchObject({ seq: 6 });
    expect((await trunkState(worker, MAIN)).meta.head_seq).toBe("6");

    // 9.8, post-finish: the same request_id still does not start a second job.
    expect(await rebuild(worker, MAIN, "r-rb-main-1")).toMatchObject({ ok: true, already: true });
  }, 240_000);

  it("diverged (LP8): a hand-moved remote pauses the pool; the rebuild lands at its head", async () => {
    const create = await worker.fetch(
      "/api/pools",
      bearer({ pool: DIVERGED, seed: SEED, summary_only: false, request_id: "r-create-rb-diverged" }),
    );
    expect(create.status).toBe(200);
    await waitFor(async () => (await eventsOf(worker, DIVERGED, "batch.pushed")).length >= 1, 30_000);
    await landFile(worker, DIVERGED, "rb-d-1", 1, 1);

    // The remote's `main` moves without Trunk: a hand commit on top (S1c: it has no note).
    const dir = worker.repoDir(DIVERGED);
    writeFileSync(join(dir, "foreign.txt"), "moved by hand\n");
    git(dir, ["add", "foreign.txt"]);
    git(dir, ["commit", "-q", "-m", "hand moved main"]);
    const foreign = git(dir, ["rev-parse", "main"]);

    // The next landing's push is a non-fast-forward — the reconcile pauses `diverged` (LP7).
    // rb-d-2's batch is the diverged one: the attempt is `accepted` but never lands (T17, step 7).
    const opened = await worker.trunk(DIVERGED).fetch("/internal/open-attempt", {
      method: "POST",
      body: JSON.stringify({
        attempt_id: "rb-d-2",
        intent: "an accepted batch that never lands",
        agent_kind: "synthetic",
        truth: [],
        requester: "swarm",
      }),
    });
    expect(opened.status).toBe(200);
    const d2 = (await opened.json()) as { change_id: string; intent_id: string };
    await tool(
      worker,
      DIVERGED,
      "rb-d-2",
      { tool: "write", args: { path: "creatures/rb-d2.js", content: "export const X = 1;\n" } },
      1,
    );
    await tool(worker, DIVERGED, "rb-d-2", { tool: "submit", args: { summary: "blocked" } }, 2);
    await waitFor(async () => {
      const m = (await trunkState(worker, DIVERGED)).meta;
      return m.pool_state === "paused";
    }, 60_000);
    const paused = (await trunkState(worker, DIVERGED)).meta;
    expect(paused.pause_reason).toBe("diverged");

    // The rebuild resolves it (LP8): main is walked to the remote's head — seed, the witnessed
    // landing and the hand commit (unwitnessed, so `unwitnessed` names seq 2).
    expect(await rebuild(worker, DIVERGED, "r-rb-div-1")).toMatchObject({ ok: true, started: true });
    expect(await driveRebuild(worker, DIVERGED)).toBe("ready");
    const meta = (await trunkState(worker, DIVERGED)).meta;
    expect(meta.pool_state).toBe("ready");
    expect(meta.head_seq).toBe("2");
    expect(meta.head_commit).toBe(foreign);
    const floor = await floorSnapshot(worker, DIVERGED);
    expect(floor.pool.unwitnessed).toEqual([2]);
    // The rebuilt head's tree carries the hand commit's file — `pool.files` of the finish makes
    // it exist on the Floor (it was never in this pool before: the remote is its only source).
    expect(floor.files["foreign.txt"]?.exists).toBe(true);

    // Step 7 (T17): rb-d-2's `accepted` attempt's batch never reached `main` — its register gets
    // a repair heads-up and the attempt goes around.
    const re = await worker.trunk(DIVERGED).fetch("/register", {
      method: "POST",
      body: JSON.stringify({
        attempt_id: "rb-d-2",
        intent_id: d2.intent_id,
        change_id: d2.change_id,
        revision: 1,
        agent_kind: "synthetic",
        model: null,
        ops: [],
        read_premises: [],
        truth: [],
      }),
    });
    const body = (await re.json()) as {
      ok: boolean;
      heads_ups?: Array<{ result?: string }>;
      attempt?: { state: string };
    };
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.attempt?.state).toBe("going_around");
    expect(body.heads_ups?.some((h) => h.result === "repair")).toBe(true);
  }, 240_000);

  it("a note whose `seq` is not the commit's position pauses `note_seq_mismatch` (3.6 step 2)", async () => {
    const create = await worker.fetch(
      "/api/pools",
      bearer({ pool: MISMATCH, seed: SEED, summary_only: false, request_id: "r-create-rb-mismatch" }),
    );
    expect(create.status).toBe(200);
    await waitFor(async () => (await eventsOf(worker, MISMATCH, "batch.pushed")).length >= 1, 30_000);
    await landFile(worker, MISMATCH, "rb-m-1", 1, 1);

    // Rewrite the landing's note with a wrong `seq` — parseable, but not its position's number.
    const dir = worker.repoDir(MISMATCH);
    const commit = String((await eventsOf(worker, MISMATCH, "landing.landed"))[0]?.commit);
    const note = JSON.parse(noteText(dir, commit)) as { seq: number };
    note.seq = 99;
    git(dir, ["notes", "--ref=premise", "add", "-f", "-m", JSON.stringify(note)], commit);

    expect(await rebuild(worker, MISMATCH, "r-rb-mm-1")).toMatchObject({ ok: true, started: true });
    expect(await driveRebuild(worker, MISMATCH)).toBe("paused");
    const meta = (await trunkState(worker, MISMATCH)).meta;
    expect(meta.pause_reason).toBe("note_seq_mismatch");
    const pause = (await eventsOf(worker, MISMATCH, "pool.paused")).at(-1);
    expect(pause).toMatchObject({ reason: "note_seq_mismatch" });
  }, 240_000);
});
