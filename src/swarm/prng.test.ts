import { describe, expect, it } from "vitest";
import { agentRandom, h32, mulberry32 } from "./prng.ts";
import { H } from "../core/sync/h.ts";

describe("prng (02-tidepool.md 10.3 SW1)", () => {
  it("mulberry32 produces the stream of the generator of 02 4.5 HO2", () => {
    // Expected values computed independently from the algorithm written in the specification.
    const gen = mulberry32(0);
    expect([gen(), gen(), gen(), gen()]).toEqual([
      0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111,
    ]);
  });

  it("h32 is the first 8 hex digits of H() read as an integer", () => {
    // H("7:0") = f5ff61d7b533cd7371f120b74bb93602, from the SHA-256 the spec defines.
    expect(H("7:0")).toBe("f5ff61d7b533cd7371f120b74bb93602");
    expect(h32("7:0")).toBe(4127154647);
    expect(h32("7:0")).toBe(Number.parseInt(H("7:0").slice(0, 8), 16) >>> 0);
  });

  it("SW1: the same seed and agent number give the same stream", () => {
    const first = agentRandom(7, 0);
    const second = agentRandom(7, 0);
    const draws = 8;
    const a = Array.from({ length: draws }, () => first());
    const b = Array.from({ length: draws }, () => second());
    expect(a).toEqual(b);
    // Independently computed from mulberry32(H32("7:0")).
    expect(a.slice(0, 4)).toEqual([0.6111038187518716, 0.9475811808370054, 0.02899453858844936, 0.1652757441624999]);
  });

  it("SW1: different agent numbers draw different streams", () => {
    const byN = (n: number) => {
      const gen = agentRandom(7, n);
      return Array.from({ length: 4 }, () => gen());
    };
    expect(byN(0)).not.toEqual(byN(1));
    expect(byN(1)).not.toEqual(byN(2));
  });

  it("SW1: different seeds draw different streams", () => {
    const a = agentRandom(7, 0);
    const b = agentRandom(8, 0);
    expect(Array.from({ length: 4 }, () => a())).not.toEqual(Array.from({ length: 4 }, () => b()));
  });
});
