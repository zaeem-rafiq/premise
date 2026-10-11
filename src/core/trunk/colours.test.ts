import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { directEnergyWrites, paletteOf, unknownColours } from "./colours.ts";

// The tide pool's own pen (02-tidepool): the palette is read from the file, not repeated here.
const PEN = readFileSync("seeds/tidepool/pen.js", "utf8");

describe("CK6b colours the pen does not know", () => {
  it("reads the 15 palette names of the seed's pen.js", () => {
    const palette = paletteOf(PEN);
    expect(palette).toHaveLength(15);
    expect(palette).toEqual(expect.arrayContaining(["grey", "gold", "blue", "purple", "sand"]));
  });

  it("finds no palette in a file without one", () => {
    expect(paletteOf(undefined)).toBeNull();
    expect(paletteOf("export const X = 1;")).toBeNull();
  });

  // The three names found on production on 2026-10-11: check-1011's jellyfish ("lightblue"),
  // tidepool's anglerfish ("darkpurple") and manta ray ("gray"; the palette spells it "grey").
  it("flags CSS names and shaded names outside the palette, once each", () => {
    const palette = paletteOf(PEN)!;
    const source = [
      'const TENTACLE = "lightblue";',
      "const BODY = 'darkpurple';",
      "const FIN = `gray`;",
      'const EYE = "lightblue";',
      'const SHELL = "grey";',
      'const GLOW = "gold";',
      'const SPOT = "#aabbcc";',
      'export const kind = "jellyfish";',
      'const MODE = "drift";',
    ].join("\n");
    expect(unknownColours(source, palette)).toEqual(["darkpurple", "gray", "lightblue"]);
  });

  it("passes a creature that uses only palette names and hex colours", () => {
    const palette = paletteOf(PEN)!;
    expect(unknownColours('const A = "teal"; const B = "#fff"; const C = "white";', palette)).toEqual([]);
  });
});

describe("CK6d energy through the shared rules", () => {
  // The squid of rehearsal 2b on production (2026-10-11): it spent energy by hand, so the sweep's
  // search for drain( never matched it and the second catch of beat 5 did not happen.
  it("names each line that assigns to .energy, and not spawn's object or a comparison", () => {
    const source = [
      'import { ENERGY_MAX } from "../world/energy.js";',
      "export function spawn() {",
      "  return { vx: 0, energy: ENERGY_MAX };",
      "}",
      "export function update(squid) {",
      "  if (squid.energy > ENERGY_MAX / 10) {",
      "    squid.energy -= ENERGY_MAX / 10; // spend a tenth",
      "  }",
      "  if (squid.energy === 0) squid.energy = 1;",
      "  squid.energy++;",
      "}",
    ].join("\n");
    expect(directEnergyWrites(source)).toEqual([7, 9, 10]);
  });

  it("passes a creature that spends with drain()", () => {
    expect(directEnergyWrites("drain(shrimp, 5);\nif (shrimp.energy <= 0) return;\n")).toEqual([]);
  });
});
