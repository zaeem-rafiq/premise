// The deterministic generators of the Swarm (02-tidepool.md 10.3 SW1; the mulberry32 source text is
// copied from 02-tidepool.md 4.5 HO2). Time, ids and draws are arguments: nothing here reads a clock
// or a global source of chance (SY1, SY2).

import { H } from "../core/sync/h.ts";

/** `H32(s)`: the first 8 hex digits of `H(s)` read as an integer (SW1). Unsigned 32 bits. */
export function h32(s: string): number {
  return Number.parseInt(H(s).slice(0, 8), 16) >>> 0;
}

/**
 * mulberry32 of `02-tidepool.md` 4.5 (HO2), verbatim. One stream of draws in [0, 1); the same seed
 * always gives the same stream.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The generator of agent `n` in a run of `seed` (SW1): `mulberry32(H32(seed + ":" + n))`.
 * Every choice a scripted pattern makes is drawn from this stream.
 */
export function agentRandom(seed: number, n: number): () => number {
  return mulberry32(h32(`${seed}:${n}`));
}
