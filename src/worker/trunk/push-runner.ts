// The push runner's first version (Slice 1, track 1B): one receive-pack request per batch —
// both ref commands — with one token refresh and one more try after an HTTP 401 or 403
// (S2, LP5a). Scheduling, backoff, the ref-value decision of LP5 and the outbox apply come
// with the later outbox work; this runner only performs a batch's push once.

import { PUSH_TIMEOUT_MS } from "../../protocol/constants.ts";
import type { Pusher, PushResult, RefUpdate, TokenSource } from "../../protocol/ports.ts";

/** The batch the caller asks Trunk to push: its ref commands and its stored pack bytes. */
export type PushBatch = {
  /** The pool whose repository receives the push; `TokenSource.writeTarget` resolves it. */
  pool_id: string;
  /** The ref commands the request carries — `refs/heads/main` and `refs/notes/premise` for a landing. */
  updates: RefUpdate[];
  /** The batch's pack bytes exactly as the transaction stored them (LP6). */
  pack: Uint8Array;
};

export type PushDeps = {
  tokenSource: TokenSource;
  pusher: Pusher;
  /** Each token mint and push request's timeout in ms (LP5c); default `PUSH_TIMEOUT_MS`. */
  timeoutMs?: number;
};

export type PushOutcome = {
  /**
   * The write target of the last request — the refreshed one after a 401 or 403. It carries
   * secret material: callers may use it for the LP5 ref read but must never log or store it.
   */
  target: { remote: string; repo: string; token: string; expires_at: number | null };
  result: PushResult;
};

function isAuthRefusal(result: PushResult): boolean {
  return !result.ok && result.kind === "transport" && (result.http_status === 401 || result.http_status === 403);
}

/** Bound S2's mint even when the source never settles. The port cannot cancel a late mint. */
export async function writeTargetWithTimeout(
  source: TokenSource,
  pool_id: string,
  timeoutMs = PUSH_TIMEOUT_MS,
): Promise<PushOutcome["target"]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      source.writeTarget(pool_id),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Write token mint timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Mints a write target, sends the batch's one request, and on a 401 or 403 mints once more
 * and sends once more (LP5a: "mints a new one after a 401 or 403"). A rejected result is
 * returned unretried — its consequence is the outbox's LP5 decision, not a retry.
 */
export async function runPush(batch: PushBatch, deps: PushDeps): Promise<PushOutcome> {
  const timeout = deps.timeoutMs ?? PUSH_TIMEOUT_MS;
  let target = await writeTargetWithTimeout(deps.tokenSource, batch.pool_id, timeout);
  let result = await deps.pusher.push({
    remote: target.remote,
    token: target.token,
    updates: batch.updates,
    pack: batch.pack,
    atomic: true,
    signal: AbortSignal.timeout(timeout),
  });
  if (isAuthRefusal(result)) {
    target = await writeTargetWithTimeout(deps.tokenSource, batch.pool_id, timeout);
    result = await deps.pusher.push({
      remote: target.remote,
      token: target.token,
      updates: batch.updates,
      pack: batch.pack,
      atomic: true,
      signal: AbortSignal.timeout(timeout),
    });
  }
  return { target, result };
}
