// Installs the tree-sitter parsers of Python and Go for tests that run in Node (06-repos.md LG1).
// The Worker loads the same three WebAssembly files as compiled modules
// (`src/worker/parsers/tree-sitter.ts`); Node may compile WebAssembly from bytes, so here they are
// read from node_modules. Call `installTreeSitter()` in a `beforeAll`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Language, Parser } from "web-tree-sitter";
import { setSyntaxParser, type SyntaxLanguage, type SyntaxParser } from "../../src/core/entities/syntax.ts";
import { REPO_ROOT } from "./source.ts";

const GRAMMARS: Readonly<Record<SyntaxLanguage, string>> = {
  python: "node_modules/tree-sitter-python/tree-sitter-python.wasm",
  go: "node_modules/tree-sitter-go/tree-sitter-go.wasm",
};

let loading: Promise<SyntaxParser> | null = null;

async function load(): Promise<SyntaxParser> {
  await Parser.init();
  const parsers = new Map<SyntaxLanguage, Parser>();
  for (const language of Object.keys(GRAMMARS) as SyntaxLanguage[]) {
    const parser = new Parser();
    parser.setLanguage(await Language.load(readFileSync(join(REPO_ROOT, GRAMMARS[language]))));
    parsers.set(language, parser);
  }
  return (language, source, use) => {
    const parser = parsers.get(language);
    if (parser === undefined) throw new Error(`no tree-sitter parser for ${String(language)}`);
    const tree = parser.parse(source);
    if (tree === null) throw new Error(`tree-sitter returned no tree for ${language}`);
    try {
      return use(tree.rootNode);
    } finally {
      tree.delete();
    }
  };
}

/**
 * Loads the parsers once per test file and installs them in core. It returns nothing on purpose:
 * vitest runs a function that `beforeAll` returns as the teardown.
 */
export async function installTreeSitter(): Promise<void> {
  loading ??= load();
  setSyntaxParser(await loading);
}
