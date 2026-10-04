// AC9 / VD9: the token contrast test. Reads the tokens out of `base.css` itself and
// computes each token's lowest WCAG contrast against the three backgrounds of its theme
// (`bg`, `surface`, `raised`). Minimums of 6.3/VD9: `text` 7; every other token used for
// text 4.5; `control`, `focus` and the signal colours used for a shape 3; `on-fill` 4.5
// on every filled signal colour it sits on.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "base.css"), "utf8");

function themeTokens(blockRe: RegExp): Record<string, string> {
  const match = CSS.match(blockRe);
  if (match === null) throw new Error(`no theme block for ${blockRe}`);
  const tokens: Record<string, string> = {};
  for (const pair of match[1].matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    tokens[pair[1]] = pair[2].toLowerCase();
  }
  return tokens;
}

function channel(hex: string, at: number): number {
  const v = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** A token's worst ratio over the three background tones (6.3 "lowest contrast"). */
function lowest(tokens: Record<string, string>, token: string): number {
  return Math.min(contrast(tokens[token], tokens["bg"]), contrast(tokens[token], tokens["surface"]), contrast(tokens[token], tokens["raised"]));
}

const TEXT_TOKENS = ["muted", "accent", "holds", "changed", "confirm", "checking", "synthetic"];
const SHAPE_TOKENS = ["control", "focus"];
const FILLS = ["accent", "holds", "changed", "confirm", "checking", "synthetic"];

describe.each([
  ["dark", /:root,\s*:root\[data-theme="dark"\]\s*\{([^}]*)\}/],
  ["light", /:root\[data-theme="light"\]\s*\{([^}]*)\}/],
])("VD9 token contrast - %s theme", (_name, blockRe) => {
  const tokens = themeTokens(blockRe);

  it("text is at least 7 against every background", () => {
    expect(lowest(tokens, "text")).toBeGreaterThanOrEqual(7);
  });
  it("every other token used for text is at least 4.5", () => {
    for (const token of TEXT_TOKENS) {
      expect(lowest(tokens, token), token).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("control and focus are at least 3 (shapes)", () => {
    for (const token of SHAPE_TOKENS) {
      expect(lowest(tokens, token), token).toBeGreaterThanOrEqual(3);
    }
  });
  it("on-fill reads at least 4.5 on every filled signal colour", () => {
    for (const fill of FILLS) {
      expect(contrast(tokens["on-fill"], tokens[fill]), `on-fill on ${fill}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
