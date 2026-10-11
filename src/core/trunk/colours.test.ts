import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { paletteOf, unknownColours } from "./colours.ts";

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
