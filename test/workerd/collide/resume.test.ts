// Plan item 9 (T21, RS1-RS4, T20r): the Trunk side of `resume`, proved against a stub Agent
// bound in place of the real one. A stopped attempt that the owner retries owes its Agent a
// `resume` — `resume_n: 1`, the attempt's revision, `cause: "retry"` — sent after the commit,
// repeated every HEADS_UP_REPUSH_MS until an answer comes. An `ok: true` ends it; a silent
// Agent reaches RESUME_ACK_TIMEOUT_MS and T20r stops the attempt `reopen_failed` and opens
// the choice card of UN6 with `new_attempt` and `stop`. The waits are driven through the
// alarm's `?now=` test path — nothing sleeps for the real cadence or deadline.
//
// The choice card is the plan's own: `go_around_limit` (GL1, T15). Reaching it takes three
// repair-victims, not one — RW1 grants right of way at sent_back 2 in `pool.attempts` order
// and RW3 blocks every later landing that would repair an earlier-marked holder, so a lone
// victim starves at 2 (the `it.fails` below). Two victims with earlier marks land past the
// last one's right of way — RW3's `c.right_of_way_at < P.right_of_way_at` skip — and give it
// the third and fourth sent-backs the limit's `sentBack >= GO_AROUND_LIMIT` check needs.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HEADS_UP_REPUSH_MS, RESUME_ACK_TIMEOUT_MS } from "../../../src/protocol/constants.ts";
import { startLandingWorker, type LandingWorker } from "../landing/harness.ts";
import { createPool, deliver, eventsOf, openAttempt, tool, waitFor } from "./helpers.ts";

const TRUTH = ["entity:world/energy.js#ENERGY_MAX"];
const KEY = "owner-key-for-tests-0123456789abcdef";

type StubState = { resumes: Array<Record<string, unknown>>; mode: string };

async function stubState(worker: LandingWorker, attempt_id: string): Promise<StubState> {
  return (await worker.object("AGENT", attempt_id).state()) as unknown as StubState;
}

async function setMode(worker: LandingWorker, attempt_id: string, mode: string): Promise<void> {
  const res = await worker.object("AGENT", attempt_id).fetch("/internal/mode", {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
  expect(res.status).toBe(200);
}

/** `replace` on `world/energy.js` — `call` numbers the attempt's `call_id`, `ack` carries the
 * heads-up number already in context (TA3 blocks a write while a higher hn is undelivered). */
async function replaceEnergy(
  worker: LandingWorker,
  pool: string,
  attempt: string,
  before: number,
  target: number,
  call: number,
  ack: number,
): Promise<void> {
  await tool(
    worker,
    pool,
    attempt,
    {
      tool: "replace",
      args: { path: "world/energy.js", old: `ENERGY_MAX = ${before}`, new: `ENERGY_MAX = ${target}` },
    },
    call,
    ack,
  );
}

/** Land one `replace` of `ENERGY_MAX = {before}` -> `{target}` and wait for its `landing.landed`. */
async function landEnergy(
  worker: LandingWorker,
  pool: string,
  attempt: string,
  before: number,
  target: number,
  landedCount: number,
): Promise<void> {
  await openAttempt(worker, pool, attempt, { intent: `lower the energy cap to ${target}`, truth: TRUTH });
  await replaceEnergy(worker, pool, attempt, before, target, 1, 0);
  await tool(worker, pool, attempt, { tool: "submit", args: { summary: `lower ENERGY_MAX to ${target}` } }, 2);
  await waitFor(async () => (await eventsOf(worker, pool, "landing.landed")).length >= landedCount, 60_000);
}

async function headsupCount(worker: LandingWorker, pool: string, attempt: string): Promise<number> {
  return (await eventsOf(worker, pool, "headsup.sent")).filter((e) => e.attempt_id === attempt).length;
}

/** T15's `go_around_limit` card on `a` (GL1): three repair-victims `b`, `c`, `a` (opened in
 * that order — RW1's `right_of_way_at = ++pool.order` follows `pool.attempts` order) each hold
 * an edit premise on `ENERGY_MAX`. Two breaker landings send all three back twice; `b` then
 * `c` land past `a`'s later right of way (RW3's earlier-mark skip), giving `a` sent-backs 3
 * and 4 — the `sentBack >= GO_AROUND_LIMIT` check fires on the fourth. Each victim re-applies
 * its edit after every landing (OP1 drops it) and acknowledges each heads-up (GA1 joins a
 * go-around only once every earlier repair is delivered). */
async function produceGoAroundLimitCard(worker: LandingWorker, pool: string, a: string): Promise<string> {
  // Right-of-way grants follow `pool.attempts` order — `SELECT ... ORDER BY attempt_id`
  // on every open — so the victim's id must sort after the two landers' for theirs to be
  // the earlier marks (RW3's `c.right_of_way_at < P.right_of_way_at` skip).
  const b = `row-b-${a}`;
  const c = `row-c-${a}`;
  const victims: Array<[string, number]> = [
    [b, 91],
    [c, 92],
    [a, 93],
  ];
  for (const [id, target] of victims) {
    await openAttempt(worker, pool, id, { intent: `${id} lowers the energy cap`, truth: TRUTH });
    await replaceEnergy(worker, pool, id, 100, target, 1, 0);
  }
  // Landing 1 (d-90): repair 1 for all three — delivered, then the edit re-applied on 90.
  await landEnergy(worker, pool, `${a}-d-90`, 100, 90, 1);
  await waitFor(
    async () =>
      (await headsupCount(worker, pool, a)) >= 1 &&
      (await headsupCount(worker, pool, b)) >= 1 &&
      (await headsupCount(worker, pool, c)) >= 1,
    60_000,
  );
  for (const [id, target] of victims) {
    await deliver(worker, pool, id);
    await replaceEnergy(worker, pool, id, 90, target, 2, 1);
  }
  // Landing 2 (d-80): repair 2 for all three — sent_back 2, right of way in order b, c, a.
  await landEnergy(worker, pool, `${a}-d-80`, 90, 80, 2);
  await waitFor(
    async () =>
      (await headsupCount(worker, pool, a)) >= 2 &&
      (await headsupCount(worker, pool, b)) >= 2 &&
      (await headsupCount(worker, pool, c)) >= 2,
    60_000,
  );
  for (const [id, target] of victims) {
    await deliver(worker, pool, id);
    await replaceEnergy(worker, pool, id, 80, target, 3, 2);
  }
  // b lands (the earliest mark — RW3 skips every other holder): repair 3 for c and a.
  // CK8 refuses a submit while heads-ups are unresolved — the acknowledge on the submit
  // answers them (CK1), the way a repaired agent would.
  await tool(
    worker,
    pool,
    b,
    { tool: "submit", args: { summary: "b lowers ENERGY_MAX to 91", acknowledge: [1, 2] } },
    4,
    2,
  );
  await waitFor(async () => (await eventsOf(worker, pool, "landing.landed")).length >= 3, 60_000);
  await waitFor(async () => (await headsupCount(worker, pool, a)) >= 3, 60_000);
  for (const [id, target] of [
    [c, 92],
    [a, 93],
  ] as Array<[string, number]>) {
    await deliver(worker, pool, id);
    await replaceEnergy(worker, pool, id, 91, target, 4, 3);
  }
  // c lands (its mark precedes a's — RW3 skips a): repair 4 for a — T15.
  await tool(
    worker,
    pool,
    c,
    { tool: "submit", args: { summary: "c lowers ENERGY_MAX to 92", acknowledge: [1, 2, 3] } },
    5,
    3,
  );
  await waitFor(
    async () =>
      (await eventsOf(worker, pool, "attempt.state")).some(
        (e) => e.attempt_id === a && e.to === "stopped" && e.reason === "go_around_limit",
      ),
    60_000,
  );
  const opened = (await eventsOf(worker, pool, "card.opened")).find(
    (e) => (e.card as { reason?: string })?.reason === "go_around_limit",
  ) as { card: { card_id: string; options: Array<{ id: string }> } };
  return opened.card.card_id;
}

/** A lone victim's side of the same production, stopped before the right-of-way wall — the
 * `it.fails` below documents what the engine does with the landing that would be its third. */
async function produceTwoGoArounds(worker: LandingWorker, pool: string, a: string): Promise<void> {
  await openAttempt(worker, pool, a, { intent: `${a} lowers the energy cap`, truth: TRUTH });
  await replaceEnergy(worker, pool, a, 100, 93, 1, 0);
  await landEnergy(worker, pool, `${a}-d-90`, 100, 90, 1);
  await waitFor(async () => (await headsupCount(worker, pool, a)) >= 1, 60_000);
  await deliver(worker, pool, a);
  await replaceEnergy(worker, pool, a, 90, 93, 2, 1);
  await landEnergy(worker, pool, `${a}-d-80`, 90, 80, 2);
  await waitFor(async () => (await headsupCount(worker, pool, a)) >= 2, 60_000);
}

/** Tap an option on a card through the owner route (CD4). */
async function tap(worker: LandingWorker, pool: string, card_id: string, body: unknown): Promise<void> {
  const res = await worker.fetch(`/api/pools/${pool}/cards/${card_id}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

describe("item 9 (RS1-RS4, T21, T20r): resume delivery to a stub Agent, in local workerd", () => {
  let worker: LandingWorker;

  beforeAll(async () => {
    worker = await startLandingWorker({
      ownerKey: KEY,
      repos: ["resume-ack", "resume-fail", "resume-gal"],
      agentStub: true,
    });
    await createPool(worker, "resume-ack");
    await createPool(worker, "resume-fail");
    await createPool(worker, "resume-gal");
  }, 180_000);

  afterAll(async () => {
    await worker?.dispose();
  });

  it.fails(
    "a lone victim cannot reach the limit: RW1 grants right of way at sent_back 2 " +
      "(STARVATION_AFTER) and the `right_of_way` timer the spec gives it (RW1, " +
      "RIGHT_OF_WAY_MS = 120000) is never armed — the constant has no reader — so RW3 " +
      'skips every landing that would give the third repair: `tick.skipped {why: "right_of_way"}` forever',
    async () => {
      const a = "a-gal";
      await produceTwoGoArounds(worker, "resume-gal", a);
      // The third colliding submit validates, then every tick skips it for right of way.
      await openAttempt(worker, "resume-gal", `${a}-d-70`, { intent: "lower the energy cap to 70", truth: TRUTH });
      await replaceEnergy(worker, "resume-gal", `${a}-d-70`, 80, 70, 1, 0);
      await tool(worker, "resume-gal", `${a}-d-70`, { tool: "submit", args: { summary: "lower ENERGY_MAX to 70" } }, 2);
      await waitFor(
        async () =>
          (await eventsOf(worker, "resume-gal", "tick.skipped")).some(
            (e) => e.attempt_id === `${a}-d-70` && e.why === "right_of_way",
          ),
        30_000,
      );
      // GL1/T15: at sent_back 3 the attempt would stop `go_around_limit` with the card.
      // What happened instead: sent_back stays 2, the mark never lapses, no card opens.
      await waitFor(
        async () =>
          (await eventsOf(worker, "resume-gal", "card.opened")).some(
            (e) => (e.card as { reason?: string })?.reason === "go_around_limit",
          ),
        5_000,
      );
    },
    300_000,
  );

  it("retry on the go-around-limit card emits attempt.reopened cause retry (T21) and sends resume_n 1 (RS1, RS2)", async () => {
    const a = "z-ack";
    const card_id = await produceGoAroundLimitCard(worker, "resume-ack", a);
    await setMode(worker, a, "ack");
    await tap(worker, "resume-ack", card_id, { option: "retry", submit_ids: {}, request_id: "r-retry-ack" });

    // T21: `attempt.reopened` carries the retry's cause; the attempt is going_around again.
    await waitFor(
      async () => (await eventsOf(worker, "resume-ack", "attempt.reopened")).some((e) => e.attempt_id === a),
      30_000,
    );
    const reopened = (await eventsOf(worker, "resume-ack", "attempt.reopened")).find((e) => e.attempt_id === a);
    expect(reopened).toMatchObject({ attempt_id: a, cause: "retry" });

    // RS1/RS2: the resume reached the Agent after the commit — attempt_id, the revision,
    // cause retry, resume_n 1 — and the `ok` answer ended the cycle without a repush.
    await waitFor(async () => (await stubState(worker, a)).resumes.length >= 1, 30_000);
    const stub = await stubState(worker, a);
    expect(stub.resumes).toHaveLength(1);
    expect(stub.resumes[0]).toMatchObject({ attempt_id: a, cause: "retry", resume_n: 1 });
    expect(typeof stub.resumes[0]?.revision).toBe("number");

    // RS2: the `ok` ended it — driven alarm passes send nothing more.
    await worker.runAlarm("resume-ack", Date.now() + HEADS_UP_REPUSH_MS + 1);
    await worker.runAlarm("resume-ack", Date.now() + 2 * HEADS_UP_REPUSH_MS + 1);
    expect((await stubState(worker, a)).resumes).toHaveLength(1);
    // And no T20r: A stays going_around, no reopen_failed card opens.
    const last = (await eventsOf(worker, "resume-ack", "attempt.state")).filter((e) => e.attempt_id === a).at(-1);
    expect(last).toMatchObject({ to: "going_around" });
    expect(
      (await eventsOf(worker, "resume-ack", "card.opened")).some(
        (e) => (e.card as { reason?: string })?.reason === "reopen_failed",
      ),
    ).toBe(false);
  }, 300_000);

  it("a silent Agent gets the repush cadence, then T20r: stopped reopen_failed and the UN6 card (RS1, RS4)", async () => {
    const a = "z-fail";
    const card_id = await produceGoAroundLimitCard(worker, "resume-fail", a);
    await tap(worker, "resume-fail", card_id, { option: "retry", submit_ids: {}, request_id: "r-retry-fail" });

    // RS1: the first send lands right after the commit.
    await waitFor(async () => (await stubState(worker, a)).resumes.length >= 1, 30_000);
    expect((await stubState(worker, a)).resumes[0]).toMatchObject({ attempt_id: a, cause: "retry", resume_n: 1 });

    // The `resume` timer's cadence, driven — each due pass repeats the send (RS1's repush).
    const t0 = Date.now();
    await worker.runAlarm("resume-fail", t0 + HEADS_UP_REPUSH_MS + 1);
    await worker.runAlarm("resume-fail", t0 + 2 * HEADS_UP_REPUSH_MS + 1);
    expect((await stubState(worker, a)).resumes.length).toBeGreaterThanOrEqual(2);

    // RS4: past RESUME_ACK_TIMEOUT_MS with no `ok`, T20r stops the attempt `reopen_failed`
    // and opens the choice card of UN6 — `new_attempt` and `stop`.
    await worker.runAlarm("resume-fail", t0 + RESUME_ACK_TIMEOUT_MS + HEADS_UP_REPUSH_MS);
    await waitFor(
      async () =>
        (await eventsOf(worker, "resume-fail", "attempt.state")).some(
          (e) => e.attempt_id === a && e.to === "stopped" && e.reason === "reopen_failed",
        ),
      30_000,
    );
    const stopped = (await eventsOf(worker, "resume-fail", "attempt.state")).find(
      (e) => e.attempt_id === a && e.to === "stopped" && e.reason === "reopen_failed",
    );
    expect(stopped).toMatchObject({ attempt_id: a, to: "stopped", transition: "T20r", reason: "reopen_failed" });

    const opened = (await eventsOf(worker, "resume-fail", "card.opened")).find(
      (e) => (e.card as { reason?: string })?.reason === "reopen_failed",
    ) as { card: { kind: string; options: Array<{ id: string }> } };
    expect(opened.card.kind).toBe("choice");
    expect(opened.card.options.map((o) => o.id)).toEqual(["new_attempt", "stop"]);

    // "No attempt is left in going_around with nobody working on it": the last transition
    // for A is the T20r stop, and the cycle sends nothing more.
    const last = (await eventsOf(worker, "resume-fail", "attempt.state")).filter((e) => e.attempt_id === a).at(-1);
    expect(last).toMatchObject({ to: "stopped", reason: "reopen_failed" });
    const sent = (await stubState(worker, a)).resumes.length;
    await worker.runAlarm("resume-fail", t0 + RESUME_ACK_TIMEOUT_MS + 3 * HEADS_UP_REPUSH_MS);
    expect((await stubState(worker, a)).resumes).toHaveLength(sent);
  }, 300_000);
});
