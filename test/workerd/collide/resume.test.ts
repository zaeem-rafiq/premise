// Plan item 9 (T21, RS1-RS4, T20r): the Trunk side of `resume`, proved against a stub Agent
// bound in place of the real one. A stopped attempt that the owner retries owes its Agent a
// `resume` — `resume_n: 1`, the attempt's revision, `cause: "retry"` — sent after the commit,
// repeated every HEADS_UP_REPUSH_MS until an answer comes. An `ok: true` ends it; a silent
// Agent reaches RESUME_ACK_TIMEOUT_MS and T20r stops the attempt `reopen_failed` and opens
// the choice card of UN6 with `new_attempt` and `stop`. The waits are driven through the
// alarm's `?now=` test path — nothing sleeps for the real cadence or deadline.
//
// The choice card is the plan's own: `go_around_limit` (GL1, T9). Three attempts
// reference ENERGY_MAX through new crab files, so repeated changes give E2 repairs.
// Repeated E1 repairs from other intents would instead stop them at contradiction (GL3).
// Two earlier right-of-way holders land changes that give the last holder repairs 3 and 4.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HEADS_UP_REPUSH_MS, RESUME_ACK_TIMEOUT_MS, RIGHT_OF_WAY_MS } from "../../../src/protocol/constants.ts";
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

/** GL1's choice card through four E2 repairs. The first two landings grant right of
 * way to b, c, a in that order. Then b and c each add their first energy edit and land
 * past a's later mark (RW3). The other attempts keep referencing, not editing, ENERGY_MAX,
 * so GL3 does not apply. Deliver every earlier repair before the next one (GA1). */
async function produceGoAroundLimitCard(worker: LandingWorker, pool: string, a: string): Promise<string> {
  // Right-of-way grants follow `pool.attempts` order — `SELECT ... ORDER BY attempt_id`
  // on every open — so the victim's id must sort after the two landers' for theirs to be
  // the earlier marks (RW3's `c.right_of_way_at < P.right_of_way_at` skip).
  const b = `row-b-${a}`;
  const c = `row-c-${a}`;
  const victims = [b, c, a];
  for (const id of victims) {
    await openAttempt(worker, pool, id, { intent: `${id} adds a crab`, truth: TRUTH });
    await tool(worker, pool, id, { tool: "read", args: { path: "world/energy.js", entity: "ENERGY_MAX" } }, 1);
    await tool(worker, pool, id, { tool: "write", args: { path: `creatures/${id}-crab.js`, content: CRAB(id) } }, 2);
  }
  // Landing 1 (d-90): E2 repair 1 for all three. The new files still apply.
  await landEnergy(worker, pool, `${a}-d-90`, 100, 90, 1);
  await waitFor(
    async () =>
      (await headsupCount(worker, pool, a)) >= 1 &&
      (await headsupCount(worker, pool, b)) >= 1 &&
      (await headsupCount(worker, pool, c)) >= 1,
    60_000,
  );
  for (const id of victims) await deliver(worker, pool, id);
  // Landing 2 (d-80): repair 2 for all three — sent_back 2, right of way in order b, c, a.
  await landEnergy(worker, pool, `${a}-d-80`, 90, 80, 2);
  await waitFor(
    async () =>
      (await headsupCount(worker, pool, a)) >= 2 &&
      (await headsupCount(worker, pool, b)) >= 2 &&
      (await headsupCount(worker, pool, c)) >= 2,
    60_000,
  );
  for (const id of victims) await deliver(worker, pool, id);
  await replaceEnergy(worker, pool, b, 80, 91, 3, 2);
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
  for (const id of [c, a]) await deliver(worker, pool, id);
  await replaceEnergy(worker, pool, c, 91, 92, 4, 3);
  // c lands (its mark precedes a's — RW3 skips a): E2 repair 4 for a — T9.
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
  const repairs = (await eventsOf(worker, pool, "headsup.sent")).filter((e) => e.attempt_id === a);
  expect(repairs).toHaveLength(4);
  for (const repair of repairs) {
    expect(repair).toMatchObject({
      result: "repair",
      keys: [{ kind: "entity", key: "world/energy.js#ENERGY_MAX", rule: "E2" }],
    });
  }
  const opened = (await eventsOf(worker, pool, "card.opened")).find(
    (e) => (e.card as { reason?: string })?.reason === "go_around_limit",
  ) as { card: { card_id: string; options: Array<{ id: string }> } };
  return opened.card.card_id;
}

const CRAB = (name: string): string =>
  'import { ENERGY_MAX } from "../world/energy.js";\n\n' +
  `export function spawn_${name.replaceAll("-", "_")}() {\n  return { x: 20, y: 180, en: ENERGY_MAX };\n}\n`;

/** A lone victim's side of the same production, stopped at the right-of-way wall: `a` reads
 * `ENERGY_MAX` and writes a *new* file that imports it, so each breaker landing is an E2
 * repair whose heads-up the victim acknowledges — while its own `write` op keeps applying,
 * keeping the premise live. At sent_back 2 the victim holds the mark (RW1). */
async function produceTwoGoArounds(worker: LandingWorker, pool: string, a: string): Promise<void> {
  await openAttempt(worker, pool, a, { intent: `${a} adds a crab`, truth: TRUTH });
  await tool(worker, pool, a, { tool: "read", args: { path: "world/energy.js", entity: "ENERGY_MAX" } }, 1, 0);
  await tool(worker, pool, a, { tool: "write", args: { path: `creatures/${a}-crab.js`, content: CRAB(a) } }, 2, 0);
  await landEnergy(worker, pool, `${a}-d-90`, 100, 90, 1);
  await waitFor(async () => (await headsupCount(worker, pool, a)) >= 1, 60_000);
  await deliver(worker, pool, a);
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

  it(
    "right of way lapses (RW1): the waiting landing goes after RIGHT_OF_WAY_MS and the " +
      "victim's next sent-backs reach the go-around-limit card (RW3, GL1)",
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
      // RW1: the mark lapses RIGHT_OF_WAY_MS after the grant — driven through the alarm's
      // `?now=` hook. The `right_of_way` timer's own pass clears the grant and runs the tick
      // that lands d-70; the alarm's driven `now` is the engine clock for that call, so a
      // merely re-armed `tick` row would sit in the future. The repair joins `a`'s still-open
      // go-around (T10: its earlier heads-up was never delivered), so the limit is two more
      // breakers away — each counts only once the previous heads-up is delivered (GA1).
      await worker.runAlarm("resume-gal", Date.now() + RIGHT_OF_WAY_MS + 1_000);
      await waitFor(async () => (await eventsOf(worker, "resume-gal", "landing.landed")).length >= 3, 60_000);
      // No right of way now: each breaker lands, `a` goes around once more, and sent_back 3
      // trips GL1 — `a` stops `go_around_limit` with its choice card.
      await deliver(worker, "resume-gal", a);
      await landEnergy(worker, "resume-gal", `${a}-d-60`, 70, 60, 4);
      await waitFor(
        async () =>
          (await eventsOf(worker, "resume-gal", "attempt.state")).some(
            (e) => e.attempt_id === a && e.to === "going_around" && e.go_arounds === 3,
          ),
        30_000,
      );
      await deliver(worker, "resume-gal", a);
      await landEnergy(worker, "resume-gal", `${a}-d-50`, 60, 50, 5);
      await waitFor(
        async () =>
          (await eventsOf(worker, "resume-gal", "attempt.state")).some(
            (e) => e.attempt_id === a && e.to === "stopped" && e.reason === "go_around_limit",
          ),
        30_000,
      );
      const opened = (await eventsOf(worker, "resume-gal", "card.opened")).find(
        (e) => (e.card as { reason?: string })?.reason === "go_around_limit",
      ) as { card: { kind: string; options: Array<{ id: string }> } } | undefined;
      expect(opened).toBeDefined();
      expect(opened!.card.kind).toBe("choice");
      expect(opened!.card.options.map((o) => o.id)).toContain("retry");
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
