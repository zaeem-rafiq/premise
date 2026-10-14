// `POST /api/try` (09-try TY2): a visitor's try. No owner key: the route checks the switch (TY1),
// the kill switch (TY7) and the limits (TY6), then creates a `try-<id>` pool from seed `tidepool`
// exactly as `POST /api/pools` does (TY3, TY4) and starts the try conductor's Workflow on it
// (TY9). The visitor names nothing: the body is ignored. The client address goes to the model
// gate, which keeps only its salted hash (TY6a); it is never logged or answered.

import type { Env } from "../env.ts";
import type { RouteInput } from "../index.ts";
import { FEATURES } from "../../config/features.ts";
import { text } from "../../copy/strings.ts";
import { FEATURE_OFF, ROUTES } from "../../protocol/routes.ts";
import { clientAddress } from "../security/rate-limit.ts";
import { tryLimitCopyId, type TryDecision } from "../gate/try-ledger.ts";
import type { TryParams } from "../try/conduct.ts";
import { createPool, POOL_NAME } from "./pools.ts";

/** TY3: characters after `try-`. */
export const TRY_ID_LENGTH = 10;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** TY4: the seed of every try pool. */
const TRY_SEED = "tidepool";

type CopyId = Parameters<typeof text>[0];

function refuse(status: number, code: string, copyId: CopyId): Response {
  return Response.json({ error: { code, message: text(copyId) } }, { status });
}

/** TY3: `try-` and TRY_ID_LENGTH characters of `a-z0-9`, uniform (bytes past 252 are redrawn). */
export function tryPoolName(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  let id = "";
  while (id.length < TRY_ID_LENGTH) {
    for (const byte of random(new Uint8Array(TRY_ID_LENGTH))) {
      if (byte < 252 && id.length < TRY_ID_LENGTH) id += ALPHABET[byte % ALPHABET.length];
    }
  }
  return `try-${id}`;
}

async function killed(env: Env): Promise<boolean> {
  try {
    const response = await env.GATE.get(env.GATE.idFromName("premise")).fetch("https://gate/killed");
    if (!response.ok) return false;
    return ((await response.json()) as { killed?: unknown }).killed === true;
  } catch {
    return false;
  }
}

/** TY6: the gate records the try or names the limit that refuses it. */
async function record(env: Env, address: string): Promise<TryDecision | null> {
  try {
    const response = await env.GATE.get(env.GATE.idFromName("premise")).fetch("https://gate/internal/try-record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address }),
    });
    if (!response.ok) return null;
    return (await response.json()) as TryDecision;
  } catch {
    return null;
  }
}

const POOLS_ROUTE = ROUTES.find((route) => route.method === "POST" && route.paths.includes("/api/pools"))!;

export async function handleTry(input: RouteInput): Promise<Response> {
  const { env } = input;
  if (!FEATURES.try) return refuse(404, FEATURE_OFF, "try.off");
  if (await killed(env)) return refuse(403, "killed", "try.killed");
  const workflow = env.TRY as Workflow | undefined;
  if (workflow === undefined) return refuse(502, "try_failed", "try.failed");

  const decision = await record(env, clientAddress(input.request));
  if (decision === null) return refuse(502, "try_failed", "try.failed");
  if (!decision.ok) return refuse(429, "try_limited", tryLimitCopyId(decision.limit));

  const pool = tryPoolName();
  if (!POOL_NAME.test(pool)) return refuse(502, "try_failed", "try.failed");
  // TY4: the pool exactly as PL1 makes it — the same handler, with a body the Worker writes.
  const created = await createPool({
    request: new Request("https://premise.internal/api/pools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pool, seed: TRY_SEED, summary_only: false, request_id: `${pool}-create` }),
    }),
    env,
    params: {},
    route: POOLS_ROUTE,
  });
  if (!created.ok) {
    console.error("try pool create failed", created.status);
    return refuse(502, "try_failed", "try.failed");
  }
  try {
    await workflow.create({ id: pool, params: { pool } satisfies TryParams });
  } catch (cause) {
    console.error("try conductor start failed", cause instanceof Error ? cause.name : "unknown");
    return refuse(502, "try_failed", "try.failed");
  }
  return Response.json({ pool, path: `/p/${pool}` });
}
