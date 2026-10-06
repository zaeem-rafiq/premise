import { expect } from "vitest";
import type { Card } from "../../../src/protocol/cards.ts";
import type { LandingWorker } from "../landing/harness.ts";
import { bearer, eventsOf, waitFor } from "../collide/helpers.ts";

export async function latestCard(worker: LandingWorker, pool: string): Promise<Card | undefined> {
  const events = await worker.events(pool);
  return events.filter((e) => e.type === "card.opened" || e.type === "card.updated").at(-1)?.card as Card | undefined;
}

export async function waitCard(worker: LandingWorker, pool: string, ready: (card: Card) => boolean): Promise<Card> {
  await waitFor(async () => {
    const card = await latestCard(worker, pool);
    return card !== undefined && ready(card);
  }, 30_000);
  return (await latestCard(worker, pool))!;
}

export async function tap(worker: LandingWorker, pool: string, card: Card, option: string, request = option) {
  const response = await worker.fetch(
    `/api/pools/${pool}/cards/${card.card_id}`,
    bearer({
      option,
      submit_ids: card.submit_ids,
      request_id: `${pool}-${request}`,
    }),
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}

export async function waitLanding(worker: LandingWorker, pool: string): Promise<void> {
  await waitFor(async () => (await eventsOf(worker, pool, "landing.landed")).length > 0, 30_000);
}
