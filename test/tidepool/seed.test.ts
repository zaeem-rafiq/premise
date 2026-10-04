// The seed tree against 02-tidepool.md: the file list of 2.1, the five fixed files byte for byte,
// the size and text rules TP5 and TP6, and the policy of section 6. Every expected value is read
// from the specification text, never from the seed's own output.

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { SEED_DIR, seedFiles, seedTreePaths, specBlock, specNumber } from "./spec.ts";
import { crowdedLines, exportedNames, numericExports, parseModule } from "./modules.ts";

/** The five files the specification pins character for character, and how to find each block. */
const FIXED_FILES: Array<{ path: string; anchor: string; fence: string }> = [
  {
    path: "world/energy.js",
    anchor: "`world/energy.js`** is given in full",
    fence: "```js",
  },
  {
    path: "creatures/fish.js",
    anchor: "The seed's `creatures/fish.js` is the example every agent is pointed to",
    fence: "```js",
  },
  {
    path: "GUIDE.md",
    anchor: "Every agent reads this file first",
    fence: "````md",
  },
  {
    path: "index.html",
    anchor: "It contains no words and no inline script",
    fence: "```html",
  },
  {
    path: ".premise/policy.json",
    anchor: "`.premise/policy.json` in the seed MUST be exactly this",
    fence: "```json",
  },
];

/** The number of lines of a file's text, as the specification's line counts mean them. */
function lineCount(text: string): number {
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

/** True when `line` opens a `//` comment (the comment TP6 asks for above an exported number). */
function isCommentLine(line: string | undefined): boolean {
  return line !== undefined && line.trimStart().startsWith("//");
}

/** True when `line` is a one-line `export const` declaration (a member of a TP6 group). */
function isExportConstLine(line: string | undefined): boolean {
  return line !== undefined && /^\s*export const [A-Za-z_$][\w$]* = [^;]+;\s*$/.test(line);
}

describe("the seed file tree (02-tidepool.md 2.1)", () => {
  it("holds exactly the files the specification tree lists", () => {
    const expected = [...seedTreePaths()].sort();
    const actual = [...seedFiles().keys()].sort();
    expect(actual).toEqual(expected);
  });

  it("holds as many files as the text that follows the tree says", () => {
    const stated = specNumber(/(\d+) files\. The seed commit/);
    expect(stated).toBe(seedTreePaths().length);
    expect(seedFiles().size).toBe(stated);
  });
});

describe("the fixed files of 02-tidepool.md", () => {
  for (const { path, anchor, fence } of FIXED_FILES) {
    it(`${path} equals its specification block byte for byte`, () => {
      const expected = specBlock(anchor, fence);
      const actual = seedFiles().get(path);
      expect(actual, `${path} is missing from the seed`).toBe(expected);
    });
  }

  it("there are five fixed files and the specification fixes each of them", () => {
    expect(FIXED_FILES.length).toBe(5);
  });
});

describe("TP5 (small files)", () => {
  const files = seedFiles();
  const jsFiles = [...files.keys()].filter((path) => path.endsWith(".js")).sort();
  const creatureLines = specNumber(/creature file has at most (\d+) lines/);
  const sharedLines = specNumber(/shared module has at most (\d+) lines/);
  const sharedExports = specNumber(/at most (\d+) exported names/);
  const penLines = specNumber(/`pen\.js` has at most (\d+) lines/);
  const lineChars = specNumber(/longer than (\d+) characters/);

  it("the specification names the limits this test applies", () => {
    expect([creatureLines, sharedLines, sharedExports, penLines, lineChars]).toEqual([60, 120, 12, 200, 125]);
  });

  it("a creature file has at most the stated number of lines", () => {
    for (const path of jsFiles.filter((name) => name.startsWith("creatures/"))) {
      expect(
        lineCount(files.get(path) as string),
        `${path} has ${lineCount(files.get(path) as string)} lines (limit ${creatureLines})`,
      ).toBeLessThanOrEqual(creatureLines);
    }
  });

  it("a shared module has at most the stated number of lines", () => {
    const shared = jsFiles.filter((name) => !name.startsWith("creatures/") && name !== "pen.js");
    expect(shared.length).toBeGreaterThan(0);
    for (const path of shared) {
      expect(
        lineCount(files.get(path) as string),
        `${path} has ${lineCount(files.get(path) as string)} lines (limit ${sharedLines})`,
      ).toBeLessThanOrEqual(sharedLines);
    }
  });

  it("a shared module exports at most the stated number of names", () => {
    const shared = jsFiles.filter((name) => !name.startsWith("creatures/") && name !== "pen.js");
    for (const path of shared) {
      const names = exportedNames(parseModule(path, files.get(path) as string));
      expect(names.length, `${path} exports ${names.length} names: ${names.join(", ")}`).toBeLessThanOrEqual(
        sharedExports,
      );
    }
  });

  it("pen.js has at most the stated number of lines", () => {
    expect(lineCount(files.get("pen.js") as string)).toBeLessThanOrEqual(penLines);
  });

  it("no line of a .js file is longer than the stated number of characters", () => {
    for (const path of jsFiles) {
      const text = files.get(path) as string;
      text.split("\n").forEach((line, index) => {
        expect(
          line.length,
          `${path}:${index + 1} is ${line.length} characters (limit ${lineChars}): ${line.slice(0, 60)}`,
        ).toBeLessThanOrEqual(lineChars);
      });
    }
  });
});

describe("TP6 (easy to edit with replace)", () => {
  const files = seedFiles();
  const jsFiles = [...files.keys()].filter((path) => path.endsWith(".js")).sort();

  it("every exported number is one line of the form `export const NAME = value;`", () => {
    for (const path of jsFiles) {
      const text = files.get(path) as string;
      const program = parseModule(path, text);
      const lines = text.split("\n");
      for (const exported of numericExports(program)) {
        expect(
          exported.startLine,
          `${path}: ${exported.name} spans lines ${exported.startLine}-${exported.endLine}`,
        ).toBe(exported.endLine);
        expect(
          isExportConstLine(lines[exported.startLine - 1]),
          `${path}:${exported.startLine} is not one line 'export const NAME = value;': ${lines[exported.startLine - 1]}`,
        ).toBe(true);
      }
    }
  });

  it("a comment above each exported number (or its group) says what it means", () => {
    for (const path of jsFiles) {
      const text = files.get(path) as string;
      const program = parseModule(path, text);
      const lines = text.split("\n");
      for (const exported of numericExports(program)) {
        const above = exported.startLine - 2;
        if (isCommentLine(lines[above])) continue;
        let top = exported.startLine - 1;
        while (top > 0 && isExportConstLine(lines[top - 1])) top -= 1;
        expect(
          isCommentLine(lines[top - 1]),
          `${path}: ${exported.name} at line ${exported.startLine} has no comment above it or its group`,
        ).toBe(true);
      }
    }
  });

  it("every .js file keeps one statement per line", () => {
    for (const path of jsFiles) {
      const crowded = crowdedLines(parseModule(path, files.get(path) as string));
      expect(crowded, `${path} has statements sharing a line: lines ${crowded.join(", ")}`).toEqual([]);
    }
  });

  it("no constant declaration line appears twice in a file", () => {
    for (const path of jsFiles) {
      const declarations = (files.get(path) as string)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^(export )?const [A-Za-z_$][\w$]* =/.test(line));
      const seen = new Set<string>();
      const repeated = new Set<string>();
      for (const line of declarations) {
        if (seen.has(line)) repeated.add(line);
        seen.add(line);
      }
      expect([...repeated], `${path} repeats a constant line: ${[...repeated].join(" | ")}`).toEqual([]);
    }
  });
});

describe("the seed policy (02-tidepool.md section 6, as reconciled)", () => {
  const policy = JSON.parse(readFileSync(join(SEED_DIR, ".premise/policy.json"), "utf8")) as {
    limits?: { max_paths?: number; max_change_bytes?: number };
    globals?: string[];
  };

  it("equals the specification's policy block byte for byte", () => {
    const expected = specBlock("`.premise/policy.json` in the seed MUST be exactly this", "```json");
    expect(seedFiles().get(".premise/policy.json")).toBe(expected);
    expect(JSON.parse(expected)).toEqual(policy);
  });

  it("carries the reconciled limit of 01-core F31: max_paths is 64", () => {
    const limit = specNumber(/`max_paths` is (\d+)/);
    expect(limit, "section 6 names the limit this test applies").toBe(64);
    expect(policy.limits?.max_paths).toBe(limit);
  });

  it("carries the 16 globals of section 6 and no more", () => {
    const block = specBlock("`.premise/policy.json` in the seed MUST be exactly this", "```json");
    const expected = (JSON.parse(block) as { globals: string[] }).globals;
    expect(policy.globals).toEqual(expected);
    expect(expected.length).toBe(16);
  });
});
