// The seeded generator of HO2 (02-tidepool 4.5). The host installs it as `Math.random` before any
// pool code runs; the self-test's `reseed` restarts it.

/** `mulberry32(seed)`: the generator of HO2, verbatim. */
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
