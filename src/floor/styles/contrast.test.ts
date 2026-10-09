// AC9 / VD9: the token contrast test. Reads the tokens out of `base.css` itself and
// computes each token's lowest WCAG contrast against the three backgrounds of its theme
// (`bg`, `surface`, `raised`). Minimums of 6.3/VD9: `text` 7; every other token used for
// text 4.5; `control`, `focus` and the signal colours used for a shape 3; `on-fill` 4.5
// on every filled signal colour it sits on.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "base.css"), "utf8");

function themeTokens(blockRe: RegExp): Record<string, string> {
  const match = CSS.match(blockRe);
  if (match === null || match[1] === undefined) throw new Error(`no theme block for ${blockRe}`);
  const tokens: Record<string, string> = {};
  for (const pair of match[1].matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    if (pair[1] !== undefined && pair[2] !== undefined) tokens[pair[1]] = pair[2].toLowerCase();
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
  if (hi === undefined || lo === undefined) throw new Error("unreachable");
  return (hi + 0.05) / (lo + 0.05);
}

/** A token's worst ratio over the three background tones (6.3 "lowest contrast"). */
function lowest(tokens: Record<string, string>, token: string): number {
  const read = (name: string): string => {
    const value = tokens[name];
    if (value === undefined) throw new Error(`token --${name} is missing`);
    return value;
  };
  return Math.min(
    contrast(read(token), read("bg")),
    contrast(read(token), read("surface")),
    contrast(read(token), read("raised")),
  );
}

const TEXT_TOKENS = ["muted", "accent", "holds", "changed", "confirm", "checking", "synthetic"];
const SHAPE_TOKENS = ["control", "focus"];
const FILLS = ["accent", "holds", "changed", "confirm", "checking", "synthetic"];

describe.each([
  ["dark", /:root,\s*:root\[data-theme="dark"\]\s*\{([^}]*)\}/],
  ["light", /:root\[data-theme="light"\]\s*\{([^}]*)\}/],
])("VD9/AC9 token contrast - %s theme", (_name, blockRe) => {
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
      const onFill = tokens["on-fill"];
      const on = tokens[fill];
      if (onFill === undefined || on === undefined) throw new Error(`token --${fill} or --on-fill is missing`);
      expect(contrast(onFill, on), `on-fill on ${fill}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

/** Read every stylesheet, including component CSS imported before the page tokens. */
function stylesheets(directory: string, extension = ".css"): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? stylesheets(path, extension) : entry.name.endsWith(extension) ? [path] : [];
  });
}

// Common :root tokens (type, spacing, motion) are available in both themes too.
const definedTokens = new Set(
  [...CSS.matchAll(/:root[^{}]*\{([^}]*)\}/g)].flatMap((block) =>
    [...block[1]!.matchAll(/--([\w-]+)\s*:/g)].map((token) => token[1]!),
  ),
);

function undefinedTokens(css: string, localVariables: ReadonlySet<string> = new Set()): string[] {
  const missing: string[] = [];
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of source.matchAll(/var\(\s*--([\w-]+)/g)) {
    let end = match.index + match[0].length;
    let depth = 1;
    for (; end < source.length && depth > 0; end++) {
      if (source[end] === "(") depth++;
      if (source[end] === ")") depth--;
    }
    const rest = source.slice(match.index + match[0].length, end - 1).trim();
    const fallback = rest.startsWith(",") ? rest.slice(1).trim() : "";
    const themeFallback = /^var\(\s*--([\w-]+)\s*\)$/.exec(fallback);
    if (
      !definedTokens.has(match[1]!) &&
      !localVariables.has(match[1]!) &&
      !(themeFallback && definedTokens.has(themeFallback[1]!))
    ) {
      missing.push(match[1]!);
    }
  }
  return [...new Set(missing)];
}

it("D1/D38 AC9: every Floor CSS variable exists in a theme or falls back to a theme token", () => {
  const floor = join(dirname(fileURLToPath(import.meta.url)), "..");
  const missing = stylesheets(floor).flatMap((path) =>
    undefinedTokens(readFileSync(path, "utf8")).map((token) => `${path.slice(floor.length + 1)}: --${token}`),
  );
  expect(missing).toEqual([]);
});

it("D1/D38 AC9: literal fallbacks do not conceal missing tokens", () => {
  expect(undefinedTokens("color: var(--missing, #ffffff); font: var(--absent, inherit)")).toEqual([
    "missing",
    "absent",
  ]);
  expect(undefinedTokens("color: var(--optional, var(--text)); color: var(--text)")).toEqual([]);
  expect(undefinedTokens("color: var(--optional, var(--unknown))")).toEqual(["optional", "unknown"]);
});

// Some Floor components adopt static template strings as constructed stylesheets.
// Their local geometry variables (tile sizes and the measured frame height) have
// explicit CSS declarations or setProperty producers; they are not theme tokens.
function constructedStyles(source: string): string[] {
  return [...source.matchAll(/(?:const|let)\s+\w*CSS\s*=\s*`([^`]*)`/g)].map((match) => match[1]!);
}

it("D1/D38 AC9: constructed Floor stylesheets also reject undefined theme tokens", () => {
  const floor = join(dirname(fileURLToPath(import.meta.url)), "..");
  const missing: string[] = [];
  for (const path of [...stylesheets(floor, ".tsx"), ...stylesheets(floor, ".ts")]) {
    if (/\.test\.tsx?$/.test(path)) continue;
    const source = readFileSync(path, "utf8");
    for (const css of constructedStyles(source)) {
      const localVariables = new Set([
        ...[...css.matchAll(/--([\w-]+)\s*:/g)].map((match) => match[1]!),
        ...[...source.matchAll(/\.setProperty\(["']--([\w-]+)["']/g)].map((match) => match[1]!),
      ]);
      missing.push(
        ...undefinedTokens(css, localVariables).map((token) => `${path.slice(floor.length + 1)}: --${token}`),
      );
    }
  }
  expect(missing).toEqual([]);
  const injected = constructedStyles("const EXAMPLE_CSS = `.label { color: var(--not-defined, #ffffff) }`;");
  expect(injected).toHaveLength(1);
  expect(undefinedTokens(injected[0]!)).toEqual(["not-defined"]);
});
