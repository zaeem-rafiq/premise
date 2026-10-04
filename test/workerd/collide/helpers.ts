// Shared helpers of the Slice-2 collision proofs (docs/spec/04-build-plan.md 2.3) in local
// workerd: pool creation through the route, the Floor's replay for assertions, the Swarm
// launch for real scripted Agents, and the direct Durable Object calls a test makes when it
// stands in for an agent (item 9's stub-Agent track: the attempt's own /tool and /sync calls
// are the test's, the object they reach is real).

import { expect } from "vitest";
import type { LandingWorker } from "../landing/harness.ts";
import { waitFor } from "../trunk/harness.ts";

export const KEY = "owner-key-for-tests-0123456789abcdef";

export function bearer(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  };
}

/** `POST /api/pools`, then a wait for the seed's own `batch.pushed` — PL1's batch 0 must be on
 * the remote before any attempt's landing can leave the outbox. */
export async function createPool(
  worker: LandingWorker,
  pool: string,
  opts: { seed?: string; summary_only?: boolean } = {},
): Promise<void> {
  const res = await worker.fetch(
    "/api/pools",
    bearer({
      pool,
      seed: opts.seed ?? "tidepool-swarm",
      summary_only: opts.summary_only ?? false,
      request_id: `r-create-${pool}`,
    }),
  );
  expect(res.status, `create ${pool}: ${await res.clone().text()}`).toBe(200);
  await waitFor(async () => (await worker.eventTypes(pool)).includes("batch.pushed"), 30_000);
}

/** `POST /api/swarm` — SWR2's launch. Returns the attempt ids it launched, in pattern order. */
export async function launch(
  worker: LandingWorker,
  pool: string,
  patterns: string[],
  opts: { hold?: string[]; request_id?: string } = {},
): Promise<string[]> {
  const res = await worker.fetch(
    "/api/swarm",
    bearer({
      seed: 7,
      agents: patterns.length,
      launch_per_second: 1,
      collision_dial: 0,
      think_ms: [10, 20],
      rescale_every_s: 60,
      pool,
      running: true,
      patterns,
      ...(opts.hold === undefined ? {} : { hold_before_submit: opts.hold }),
      request_id: opts.request_id ?? `r-launch-${pool}-${patterns.join("+")}`,
    }),
  );
  expect(res.status, `swarm launch ${pool}: ${await res.clone().text()}`).toBe(200);
  return ((await res.json()) as { launched: string[] }).launched;
}

/** SWR3's release: names held patterns whose agents may now call `submit`. */
export async function release(worker: LandingWorker, pool: string, patterns: string[]): Promise<void> {
  const res = await worker.fetch(
    "/api/swarm",
    bearer({
      pool,
      running: true,
      release: patterns,
      request_id: `r-release-${pool}-${patterns.join("+")}-${Date.now()}`,
    }),
  );
  expect(res.status, `swarm release ${pool}: ${await res.clone().text()}`).toBe(200);
}

// ---- Direct Durable Object calls (the test stands in for an agent; the objects are real) ----

export async function openAttempt(
  worker: LandingWorker,
  pool: string,
  attempt_id: string,
  opts: { intent?: string; truth?: string[] } = {},
): Promise<void> {
  const res = await worker.trunk(pool).fetch("/internal/open-attempt", {
    method: "POST",
    body: JSON.stringify({
      attempt_id,
      intent: opts.intent ?? `change of ${attempt_id}`,
      agent_kind: "synthetic",
      truth: opts.truth ?? [],
      requester: "swarm",
    }),
  });
  expect(res.status, `open-attempt ${attempt_id}: ${await res.clone().text()}`).toBe(200);
}

export async function tool(
  worker: LandingWorker,
  pool: string,
  attempt_id: string,
  call: { tool: string; args: object },
  n: number,
  ack = 0,
): Promise<Record<string, unknown>> {
  const res = await worker.trunk(pool).fetch("/tool", {
    method: "POST",
    body: JSON.stringify({
      attempt_id,
      call_id: `${attempt_id}:${n}`,
      tool: call.tool,
      args: call.args,
      ack,
    }),
  });
  expect(res.status, `tool ${call.tool} for ${attempt_id}: ${await res.clone().text()}`).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  if (body.ok !== true) throw new Error(`tool ${call.tool} for ${attempt_id}: ${JSON.stringify(body)}`);
  return body;
}

/** T12 `sync`: the pending heads-ups (`hn > ack`) — a read, not a delivery. Delivery is
 * HU6a's: the `ack` carried on a tool request marks `delivered_at` (what GA1 counts). */
export async function sync(
  worker: LandingWorker,
  pool: string,
  attempt_id: string,
  ack: number,
): Promise<Array<Record<string, unknown>>> {
  const res = await worker.trunk(pool).fetch("/sync", {
    method: "POST",
    body: JSON.stringify({ attempt_id, ack }),
  });
  expect(res.status, `sync ${attempt_id}: ${await res.clone().text()}`).toBe(200);
  const body = (await res.json()) as { heads_ups?: Array<Record<string, unknown>> };
  return body.heads_ups ?? [];
}

/** A tool call whose only job is to carry `ack` — HU6a's delivery path. `read` of a file
 * nothing in these tests touches: the premise it records (`file:GUIDE.md`) can never collide
 * with the premise the heads-up counts, and a read of the heads-up's own key would overwrite
 * the attempt's premise (premises key on `kind|key`) and change what the next landing judges. */
export async function ack(worker: LandingWorker, pool: string, attempt_id: string, ackN: number): Promise<void> {
  const res = await worker.trunk(pool).fetch("/tool", {
    method: "POST",
    body: JSON.stringify({
      attempt_id,
      call_id: `${attempt_id}:ack${ackN}`,
      tool: "read",
      args: { path: "GUIDE.md" },
      ack: ackN,
    }),
  });
  expect(res.status, `ack ${ackN} for ${attempt_id}: ${await res.clone().text()}`).toBe(200);
}

/** Drains the attempt's waiting heads-ups the way an Agent does: a `sync` reads them, then a
 * tool call's `ack` marks the highest `hn` delivered (HU6a, HU8) — what GA1's go-around join
 * condition counts. */
export async function deliver(
  worker: LandingWorker,
  pool: string,
  attempt_id: string,
): Promise<Array<Record<string, unknown>>> {
  const seen = await sync(worker, pool, attempt_id, 0);
  const max = Math.max(0, ...seen.map((h) => Number(h.hn ?? 0)));
  if (max > 0) await ack(worker, pool, attempt_id, max);
  return seen;
}

/** The 9.4 accept transaction, driven by the test where a real deployment lets the alarm fire. */
export async function tick(worker: LandingWorker, pool: string): Promise<void> {
  const res = await worker.trunk(pool).fetch("/internal/tick", { method: "POST", body: "{}" });
  expect(res.status, `tick ${pool}: ${await res.clone().text()}`).toBe(200);
}

/** TA9 `stop` on the Trunk object — the call an Agent makes, here the test's. */
export async function stop(
  worker: LandingWorker,
  pool: string,
  attempt_id: string,
  reason: string,
): Promise<Record<string, unknown>> {
  const res = await worker.trunk(pool).fetch("/stop", {
    method: "POST",
    body: JSON.stringify({ attempt_id, reason }),
  });
  expect(res.status, `stop ${attempt_id}: ${await res.clone().text()}`).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

// ---- Event stream reads ----

export async function eventsOf(
  worker: LandingWorker,
  pool: string,
  type: string,
): Promise<Array<Record<string, unknown>>> {
  return (await worker.events(pool)).filter((e) => e.type === type);
}

export { waitFor };
