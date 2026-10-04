// The expectations of the tidepool tests, read from docs/spec/02-tidepool.md (BP1: expected values
// come from the specification, never from the seed's own output).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../support/source.ts";

export const SPEC_FILE = join(REPO_ROOT, "docs/spec/02-tidepool.md");
export const SEED_DIR = join(REPO_ROOT, "seeds/tidepool");

/** The whole specification file. */
export function specText(): string {
  return readFileSync(SPEC_FILE, "utf8");
}

/**
 * The content of the first fenced block after `anchor`, including its last line break. `anchor`
 * must appear exactly once in the specification. `fence` is the block's opening line (for example
 * "```js"), possibly indented inside a list; the block ends at the next line that is its backtick
 * run alone.
 */
export function specBlock(anchor: string, fence: string): string {
  const text = specText();
  const at = text.indexOf(anchor);
  if (at === -1 || text.indexOf(anchor, at + 1) !== -1) {
    throw new Error(`anchor is not unique in 02-tidepool.md: ${anchor}`);
  }
  const lines = text.slice(at).split("\n");
  const open = lines.findIndex((line) => line.trim() === fence);
  if (open === -1) throw new Error(`02-tidepool.md has no block ${fence} after: ${anchor}`);
  const closing = fence.replace(/[^`]/g, "");
  const end = lines.findIndex((line, index) => index > open && line.trim() === closing);
  if (end === -1) throw new Error(`02-tidepool.md has an unclosed block ${fence} after: ${anchor}`);
  return `${lines.slice(open + 1, end).join("\n")}\n`;
}

/** The file paths of the seed tree of 02-tidepool.md 2.1, in the order the tree lists them. */
export function seedTreePaths(): string[] {
  return specBlock("### 2.1 File tree (the seed)", "```")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => line.split(/\s+/)[0] as string);
}

/** Every file of the stored seed on disk: `path -> contents`. */
export function seedFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(SEED_DIR, relative), { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.set(path, readFileSync(join(SEED_DIR, path), "utf8"));
    }
  };
  visit("");
  return files;
}

/** The one number that `anchor` names in the specification text (for example "at most 60 lines"). */
export function specNumber(pattern: RegExp): number {
  const found = specText().match(pattern);
  if (found === null || found[1] === undefined) {
    throw new Error(`02-tidepool.md holds no number for ${pattern}`);
  }
  return Number(found[1].replaceAll(",", ""));
}
