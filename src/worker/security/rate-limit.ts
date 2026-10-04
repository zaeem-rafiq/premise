// Per-address sliding-minute counters of SE21 (01-core 13.2): the unlock brake of SE2a
// (`UNLOCK_FAILS_PER_MIN` failed unlocks, then 429 before the key is compared) and the public-read
// limit of `PUBLIC_RATE_PER_MIN` on `GET /api/session`.
//
// The counters live in the Worker's isolate, not in a Durable Object: SE19 keeps public requests off
// the hot path, and an isolate restart only widens a window that is already permissive.

import { PUBLIC_RATE_PER_MIN, UNLOCK_FAILS_PER_MIN } from "../../protocol/constants.ts";

const MINUTE_MS = 60_000;

/** The client address of SE21's "per client address", the same source the Floor uses. */
export function clientAddress(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "local";
}

/** A sliding-window counter: the timestamps of the last minute per key. `now` is injectable so a
 * test can move the clock without waiting. */
export class SlidingWindow {
  readonly #stamps = new Map<string, number[]>();

  #window(key: string, now: number): number[] {
    const kept = (this.#stamps.get(key) ?? []).filter((stamp) => now - stamp < MINUTE_MS);
    this.#stamps.set(key, kept);
    return kept;
  }

  /** The count of the last minute for `key`. */
  count(key: string, now = Date.now()): number {
    return this.#window(key, now).length;
  }

  /** Record one event for `key` and return the minute's new count. */
  record(key: string, now = Date.now()): number {
    const kept = this.#window(key, now);
    kept.push(now);
    return kept.length;
  }

  /** True when `key` has reached `limit` events inside the last minute. */
  limited(key: string, limit: number, now = Date.now()): boolean {
    return this.#window(key, now).length >= limit;
  }
}

/** SE2a: the failed-unlock counter. Only a wrong key records; a success never resets it. */
export const unlockFails = new SlidingWindow();

/** SE21: the session-read counter (`PUBLIC_RATE_PER_MIN` per address). */
export const publicReads = new SlidingWindow();

/** SE2a: true when `address` already spent `UNLOCK_FAILS_PER_MIN` failures this minute — the next
 * try answers 429 before the key is compared, right key included. */
export function unlockBraked(address: string, now = Date.now()): boolean {
  return unlockFails.limited(address, UNLOCK_FAILS_PER_MIN, now);
}
