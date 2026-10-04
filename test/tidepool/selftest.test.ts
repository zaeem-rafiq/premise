// Appendix A rows A1 and A2: the seed's own self-test, run in plain Node with the generator of
// HO2 installed as Math.random. The verdict shape is 02-tidepool.md section 5; the bounds come
// from the rows of the appendix, never from the seed's output.

import { describe, expect, it } from "vitest";
import * as anemone from "../../seeds/tidepool/creatures/anemone.js";
import * as fish from "../../seeds/tidepool/creatures/fish.js";
import * as minnow from "../../seeds/tidepool/creatures/minnow.js";
import * as snail from "../../seeds/tidepool/creatures/snail.js";
import * as turtle from "../../seeds/tidepool/creatures/turtle.js";
import { runSelfTest } from "../../seeds/tidepool/selftest/run.js";
import { specBlock, specNumber } from "./spec.ts";

// The kinds of the seed: each creature file's base name is its kind (02-tidepool.md 2.5).
const KINDS = { anemone, fish, minnow, snail, turtle };

// The seeded generator of HO2, taken from the specification text and built by evaluating it.
function makeReseed(): (n: number) => void {
  const source = specBlock("replace `Math.random` with the generator below", "```js");
  const build = new Function(`${source}\nreturn mulberry32;`) as () => (seed: number) => () => number;
  const mulberry32 = build();
  return (n: number): void => {
    Math.random = mulberry32(n);
  };
}

/** The rest-share bound of an Appendix A row: the number after "at most" in its third column. */
function restShareBound(row: "A1" | "A2"): number {
  return specNumber(new RegExp(`\\| ${row} \\|[^\\n]*at most (\\d+(?:\\.\\d+)?)`));
}

describe("Appendix A, row A1 (the seed's self-test verdict)", () => {
  const ticks = specNumber(/\| A1 \|[^\n]*?(\d[\d,]*) ticks/);
  const share = restShareBound("A1");

  it("the row names the run this test repeats", () => {
    expect(ticks).toBe(3600);
    expect(share).toBe(0.1);
  });

  it("the verdict is ok and every kind's rest share is at most the row's bound", () => {
    const verdict = runSelfTest({ kinds: KINDS, reseed: makeReseed(), ticks });
    expect(verdict.ok).toBe(true);
    for (const [kind, rest] of Object.entries(verdict.rest_share as Record<string, number>)) {
      expect(rest, `${kind} rests ${rest} of the run (bound ${share})`).toBeLessThanOrEqual(share);
    }
    expect(Object.keys(verdict.rest_share).sort()).toEqual(Object.keys(KINDS).sort());
  });

  it("two runs produce identical verdicts", () => {
    const first = runSelfTest({ kinds: KINDS, reseed: makeReseed(), ticks });
    const second = runSelfTest({ kinds: KINDS, reseed: makeReseed(), ticks });
    expect(second).toEqual(first);
  });
});

describe("Appendix A, row A2 (the seed over 36,000 ticks)", () => {
  const ticks = specNumber(/\| A2 \| The seed, ([\d,]+) ticks/);
  const share = restShareBound("A2");

  it("the row names the run this test repeats", () => {
    expect(ticks).toBe(36000);
    expect(share).toBe(0.1);
  });

  it("every kind's rest share stays at most the row's bound", () => {
    const verdict = runSelfTest({ kinds: KINDS, reseed: makeReseed(), ticks });
    for (const [kind, rest] of Object.entries(verdict.rest_share as Record<string, number>)) {
      expect(rest, `${kind} rests ${rest} of the run (bound ${share})`).toBeLessThanOrEqual(share);
    }
  }, 60_000);
});
