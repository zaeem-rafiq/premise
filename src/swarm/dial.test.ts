import { describe, expect, it } from "vitest";
import { COLLIDING_WEIGHTS, dialPattern, INDEPENDENT_WEIGHTS } from "./dial.ts";
import { patternById } from "./pattern.ts";
import { agentRandom } from "./prng.ts";

/** A `rand` that answers the two draws `u`, `v` in order. */
function draws(u: number, v: number): () => number {
  let i = 0;
  return () => [u, v][i++] ?? 0.5;
}

describe("the collision dial (02-tidepool.md 10.4)", () => {
  it("the weights of each class sum to 1", () => {
    expect(INDEPENDENT_WEIGHTS.reduce((s, w) => s + w.weight, 0)).toBeCloseTo(1);
    expect(COLLIDING_WEIGHTS.reduce((s, w) => s + w.weight, 0)).toBeCloseTo(1);
  });

  it("`u >= d` picks the independent class; `u < d` the colliding one", () => {
    expect(dialPattern(0.5, draws(0.6, 0.0))).toBe("add-plain"); // u=0.6 >= d=0.5
    expect(dialPattern(0.5, draws(0.4, 0.0))).toBe("add-energy"); // u=0.4 < d=0.5
    expect(dialPattern(0.5, draws(0.5, 0.0))).toBe("add-plain"); // u = d is independent
  });

  it("at `d = 0` every agent is independent; at `d = 1` every one collides", () => {
    for (const u of [0, 0.01, 0.5, 0.999]) {
      expect(INDEPENDENT_WEIGHTS.some((w) => w.id === dialPattern(0, draws(u, 0.4)))).toBe(true);
      expect(COLLIDING_WEIGHTS.some((w) => w.id === dialPattern(1, draws(u, 0.4)))).toBe(true);
    }
  });

  it("the second draw picks by weight, cumulative in table order", () => {
    // Independent: add-plain [0, .85), reader [.85, .95), blind [.95, 1).
    expect(dialPattern(0, draws(0.5, 0.0))).toBe("add-plain");
    expect(dialPattern(0, draws(0.5, 0.84))).toBe("add-plain");
    expect(dialPattern(0, draws(0.5, 0.85))).toBe("reader");
    expect(dialPattern(0, draws(0.5, 0.94))).toBe("reader");
    expect(dialPattern(0, draws(0.5, 0.95))).toBe("blind");
    expect(dialPattern(0, draws(0.5, 0.999))).toBe("blind");
    // Colliding: add-energy [0, .35), edit-creature [.35, .55), retune [.55, .7),
    // add-relative [.7, .8), then .05 each for sweep-colour, sweep-search, same-file,
    // cosmetic.
    expect(dialPattern(1, draws(0.5, 0.0))).toBe("add-energy");
    expect(dialPattern(1, draws(0.5, 0.34))).toBe("add-energy");
    expect(dialPattern(1, draws(0.5, 0.35))).toBe("edit-creature");
    expect(dialPattern(1, draws(0.5, 0.55))).toBe("retune");
    expect(dialPattern(1, draws(0.5, 0.7))).toBe("add-relative");
    expect(dialPattern(1, draws(0.5, 0.8))).toBe("sweep-colour");
    expect(dialPattern(1, draws(0.5, 0.85))).toBe("sweep-search");
    expect(dialPattern(1, draws(0.5, 0.9))).toBe("same-file");
    expect(dialPattern(1, draws(0.5, 0.95))).toBe("cosmetic");
    expect(dialPattern(1, draws(0.5, 0.999))).toBe("cosmetic");
  });

  it("`rescale-energy` is never drawn (10.4: it is launched by the schedule)", () => {
    const seen = new Set<string>();
    for (const d of [0, 0.25, 0.5, 1]) {
      for (let i = 0; i < 100; i += 1) seen.add(dialPattern(d, draws(i / 100, ((i * 37) / 100) % 1)));
    }
    expect(seen.has("rescale-energy")).toBe(false);
  });

  it("SW1: the same SwarmConfig gives the same mix", () => {
    // A run's agent draws are `agentRandom(seed, n)`; two runs of one config give the same
    // pattern per agent.
    const mix = (seed: number, d: number, agents: number) =>
      Array.from({ length: agents }, (_, n) => dialPattern(d, agentRandom(seed, n)));
    expect(mix(7, 0.5, 40)).toEqual(mix(7, 0.5, 40));
    expect(mix(7, 0.5, 40)).not.toEqual(mix(8, 0.5, 40));
    for (const id of mix(7, 0.5, 40)) expect(patternById(id)).toBeDefined();
  });
});
