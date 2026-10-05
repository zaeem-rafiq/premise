// Plan item 7 (HD1, CD3, CD4, T4, T13, T14, 9.8, SE2): the held card and its owner route,
// proved in local workerd. On the `tidepool` seed `world/` is the held tier, so a real
// scripted rescale-energy's submit goes `held` and the minimal card opens — `preview: null`,
// `risk: null`, an empty blast radius, exactly `land` and `decline`. The route's answers are
// the acceptance's: nothing lands until `land`; `decline` stops the attempt `declined`; an
// option the card does not offer is `invalid_args` 400; a repeated `request_id` changes
// nothing; no owner key is a 401.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "../../git/helpers.ts";
import { startLandingWorker, type LandingWorker } from "../landing/harness.ts";
import { createPool, eventsOf, KEY, launch, waitFor } from "./helpers.ts";

type CardBody = {
  card_id: string;
  kind: string;
  options: Array<{ id: string }>;
  blast_radius: Record<string, unknown>;
  preview: unknown;
  risk: unknown;
  submit_ids: Record<string, string>;
  attempt_ids: string[];
};

describe("item 7 (HD1, CD3, CD4): the held card and its route, in local workerd", () => {
  let worker: LandingWorker;
  let card: CardBody;

  beforeAll(async () => {
    worker = await startLandingWorker({ ownerKey: KEY, repos: ["held-land", "held-decline"] });
    // The `land` pool: one scripted rescale answers `held`; its card is this suite's shared card.
    await createPool(worker, "held-land", { seed: "tidepool" });
    await launch(worker, "held-land", ["rescale-energy"], { request_id: "r-launch-held-land" });
    await waitFor(async () => (await eventsOf(worker, "held-land", "card.opened")).length >= 1, 60_000);
    card = ((await eventsOf(worker, "held-land", "card.opened"))[0] as { card: CardBody }).card;
  }, 120_000);

  afterAll(async () => {
    await worker?.dispose();
  });

  it("opens `held` with preview null, risk null, an empty blast radius, exactly land+decline (HD1, CD4)", () => {
    expect(card.kind).toBe("held");
    expect(card.preview).toBeNull();
    expect(card.risk).toBeNull();
    expect(card.blast_radius).toEqual({});
    expect(card.options.map((o) => o.id)).toEqual(["land", "decline"]);
  });

  it("nothing lands while the card is open; an unoffered option is invalid_args 400 (CD4)", async () => {
    expect(await eventsOf(worker, "held-land", "landing.landed")).toEqual([]);
    const res = await worker.fetch(`/api/pools/held-land/cards/${card.card_id}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ option: "land_now", submit_ids: card.submit_ids, request_id: "r-bad-option" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_args" } });
    // The tap changed nothing: the card is still open, the attempt still held.
    expect(await eventsOf(worker, "held-land", "landing.landed")).toEqual([]);
  }, 30_000);

  it("a request without the owner key answers 401", async () => {
    const res = await worker.fetch(`/api/pools/held-land/cards/${card.card_id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ option: "land", submit_ids: card.submit_ids, request_id: "r-no-key" }),
    });
    expect(res.status).toBe(401);
  }, 30_000);

  it("a malformed body answers invalid_args 400", async () => {
    const res = await worker.fetch(`/api/pools/held-land/cards/${card.card_id}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ option: "land", request_id: "r-no-submits" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_args" } });
  }, 30_000);

  it("land lands the change (T13); a repeated request_id changes nothing (9.8)", async () => {
    const body = { option: "land", submit_ids: card.submit_ids, request_id: "r-land-1" };
    const res = await worker.fetch(`/api/pools/held-land/cards/${card.card_id}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });

    await waitFor(async () => (await eventsOf(worker, "held-land", "landing.landed")).length >= 1, 60_000);
    // T13's approve -> validated -> the tick accepts -> the batch pushes: the remote holds 1.
    const source = git(worker.repoDir("held-land"), ["show", "refs/heads/main:world/energy.js"]);
    expect(source).toContain("ENERGY_MAX = 1");

    // 9.8: the same request_id replays the stored answer and emits nothing new. Work that runs
    // after each push on its own schedule (the plain-merge build of 11.7 and its `plain.updated`)
    // may add events meanwhile, so the check counts the events a card action can cause.
    const CARD_EFFECTS = new Set([
      "card.opened",
      "card.closed",
      "attempt.state",
      "submit.result",
      "landing.accepted",
      "landing.landed",
      "headsup.sent",
    ]);
    const before = await worker.events("held-land");
    const again = await worker.fetch(`/api/pools/held-land/cards/${card.card_id}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });
    expect(again.status).toBe(200);
    const after = await worker.events("held-land");
    const added = after.slice(before.length);
    expect(
      added.filter((e) => CARD_EFFECTS.has(String(e.type))),
      `events after the repeat: ${added.map((e) => e.type).join(", ")}`,
    ).toEqual([]);
  }, 120_000);

  it("decline stops the attempt declined (T14) and nothing lands", async () => {
    await createPool(worker, "held-decline", { seed: "tidepool" });
    await launch(worker, "held-decline", ["rescale-energy"], { request_id: "r-launch-held-decline" });
    await waitFor(async () => (await eventsOf(worker, "held-decline", "card.opened")).length >= 1, 60_000);
    const declineCard = ((await eventsOf(worker, "held-decline", "card.opened"))[0] as { card: CardBody }).card;

    const res = await worker.fetch(`/api/pools/held-decline/cards/${declineCard.card_id}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ option: "decline", submit_ids: declineCard.submit_ids, request_id: "r-decline-1" }),
    });
    expect(res.status, await res.clone().text()).toBe(200);

    await waitFor(
      async () =>
        (await eventsOf(worker, "held-decline", "attempt.state")).some(
          (e) => e.to === "stopped" && e.reason === "declined",
        ),
      30_000,
    );
    expect(await eventsOf(worker, "held-decline", "landing.landed")).toEqual([]);
  }, 120_000);
});
