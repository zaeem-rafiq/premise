// Shared pieces of the Slice-7 reads acceptance (04-build-plan 2.8, items 2, 3 and 5): pool
// creation, one scripted `add-plain` landing, and the public fetches every file here makes.

import { waitFor } from "../trunk/harness.ts";
import type { LandingWorker } from "../landing/harness.ts";

/** The owner credential every pool in these tests is created with. */
export const OWNER_KEY = "owner-key-for-tests-0123456789abcdef";

/** An owner-key POST body, the shape every mutating route takes. */
export function bearer(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OWNER_KEY}` },
    body: JSON.stringify(body),
  };
}

/** `POST /api/pools` then the first events of the seed push (PL1). */
export async function createPool(
  worker: LandingWorker,
  pool: string,
  options: { seed?: string; summaryOnly?: boolean } = {},
): Promise<void> {
  const response = await worker.fetch(
    "/api/pools",
    bearer({
      pool,
      seed: options.seed ?? "tidepool-swarm",
      summary_only: options.summaryOnly ?? false,
      request_id: `r-${pool}-create`,
    }),
  );
  if (response.status !== 200) throw new Error(`create ${pool}: ${response.status} ${await response.text()}`);
  await waitFor(async () => (await worker.eventTypes(pool)).includes("pool.files"), 30_000);
}

/** One scripted `add-plain` agent to `landing.landed`; returns the landed event's fields. */
export async function landOne(
  worker: LandingWorker,
  pool: string,
  requestId: string,
): Promise<{ seq: number; commit: string; note: string; note_json: string | null }> {
  const before = (await worker.events(pool)).filter((event) => event.type === "landing.landed").length;
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
      request_id: requestId,
    }),
  );
  if (swarm.status !== 200) throw new Error(`swarm ${pool}: ${swarm.status} ${await swarm.text()}`);
  await waitFor(async () => {
    const landed = (await worker.events(pool)).filter((event) => event.type === "landing.landed");
    return landed.length > before;
  }, 60_000);
  const landed = (await worker.events(pool)).filter((event) => event.type === "landing.landed").at(-1) as
    { seq: number; commit: string; note: string; note_json: string | null } | undefined;
  if (landed === undefined) throw new Error(`no landing.landed on ${pool}`);
  return landed;
}

/** The one message a stream socket answers to `{hello, after}`, with a short time-out. */
export function snapshotFrame(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no stream frame in 10 s")), 10_000);
    ws.addEventListener("message", (message) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(message.data)) as Record<string, unknown>);
    });
  });
}
