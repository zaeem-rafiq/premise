// Reading the repository's source files for the architecture tests (docs/spec/04-build-plan.md 1.3).
//
// The parser is the one Vite ships (`parseSync`): it reads TypeScript and JSX, and a file it cannot parse
// fails the test that asked for it. Nothing is guessed from text.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "vite";

/** The repository root, as an absolute path. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** File extensions that hold code. */
const CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Directory names that never hold source. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".git", ".wrangler", "coverage"]);

export function isCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

export function isTestFile(path: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(path);
}

/**
 * Every code file under `directory` (a path relative to `root`), as paths relative to `root` with `/`
 * separators, sorted. A directory that does not exist holds no files.
 */
export function codeFilesUnder(root: string, directory: string): string[] {
  const found: string[] = [];
  const visit = (relative: string): void => {
    let entries;
    try {
      entries = readdirSync(join(root, relative), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) visit(path);
      } else if (entry.isFile() && isCodeFile(path)) {
        found.push(path);
      }
    }
  };
  visit(directory);
  return found.sort();
}

export function readText(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

/** A syntax node. Every node has a `type` and the offsets of its first and one-past-last character. */
export type Node = { type: string; start: number; end: number; [key: string]: unknown };

// A comment. `value` is its text without the `//` of a line comment, or without the `/*` and `*/` of a block.
export type Comment = { type: "Line" | "Block"; value: string; start: number; end: number };

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

/** The syntax tree and the comments of one file. Throws, naming the file, when the parser reports an error. */
export function parseSource(path: string, text: string): { program: Node; comments: Comment[] } {
  // Every file of this repository is an ES module (package.json "type": "module"), except .cjs and .cts.
  const sourceType = /\.c[jt]s$/.test(path) ? "script" : "module";
  const result = parseSync(path, text, { sourceType });
  const first = result.errors[0];
  if (first !== undefined) {
    throw new Error(`${path}: cannot be parsed: ${first.message}`);
  }
  return { program: result.program as unknown as Node, comments: result.comments };
}

/** The syntax tree of one file. Throws, naming the file, when the parser reports an error. */
export function parse(path: string, text: string): Node {
  return parseSource(path, text).program;
}

/** Calls `visit` for every node of the tree, parents before children. */
export function walk(node: Node, visit: (node: Node, parent: Node | null) => void): void {
  const descend = (current: Node, parent: Node | null): void => {
    visit(current, parent);
    for (const value of Object.values(current)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isNode(item)) descend(item, current);
        }
      } else if (isNode(value)) {
        descend(value, current);
      }
    }
  };
  descend(node, null);
}

/** The 1-based line of a character offset. */
export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

/** The name of an `Identifier` node, or null for any other node. */
export function identifierName(node: unknown): string | null {
  if (!isNode(node) || node.type !== "Identifier") return null;
  return typeof node.name === "string" ? node.name : null;
}

/** The value of a string `Literal` node (or a template with no `${}`), or null for any other node. */
export function stringValue(node: unknown): string | null {
  if (!isNode(node)) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && Array.isArray(node.expressions) && node.expressions.length === 0) {
    const only = (node.quasis as Array<{ value: { cooked: string | null } }>)[0];
    return only?.value.cooked ?? null;
  }
  return null;
}

/**
 * The name a member access reads: `a.b` gives "b", `a["b"]` gives "b". Null when the name is computed
 * from something that is not a string.
 */
export function memberName(node: Node): string | null {
  if (node.type !== "MemberExpression") return null;
  if (node.computed === true) return stringValue(node.property);
  return identifierName(node.property);
}
