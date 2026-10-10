// The tree-sitter parsers of Python and Go in the Worker (06-repos.md LG1). web-tree-sitter runs
// tree-sitter compiled to WebAssembly; each grammar is one more WebAssembly module. The Workers
// runtime refuses to compile WebAssembly from bytes, so all three arrive as `.wasm` imports, which
// wrangler bundles as compiled modules.
//
// `initParsers()` runs once per isolate and must finish before the first parse. `parse()` is
// synchronous, so the pure core can call it through the port of `src/core/entities/syntax.ts`.

import { Language, Parser, type Tree } from "web-tree-sitter";
import coreWasm from "web-tree-sitter/web-tree-sitter.wasm";
import goWasm from "tree-sitter-go/tree-sitter-go.wasm";
import pythonWasm from "tree-sitter-python/tree-sitter-python.wasm";
import type { SyntaxLanguage, SyntaxParser } from "../../core/entities/syntax.ts";

let ready: Promise<void> | null = null;
const parsers = new Map<SyntaxLanguage, Parser>();

/** Loads web-tree-sitter and both grammars, once per isolate. A failed load is retried on the next call. */
export function initParsers(): Promise<void> {
  ready ??= load().catch((error: unknown) => {
    ready = null;
    throw error;
  });
  return ready;
}

async function load(): Promise<void> {
  // Under `nodejs_compat` workerd reports `process.versions.node`, so web-tree-sitter would take its
  // Node path and fail on `createRequire(import.meta.url)`. Its test is
  // `process.versions?.node && process.type != "renderer"`; "renderer" makes it take the browser
  // path. `tree-sitter.test.ts` pins this, so an upgrade that changes the detection fails loudly.
  (process as { type?: string }).type = "renderer";
  await Parser.init({
    instantiateWasm(
      imports: WebAssembly.Imports,
      done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ) {
      done(new WebAssembly.Instance(coreWasm, imports), coreWasm);
      return {};
    },
  } as unknown as Parameters<typeof Parser.init>[0]);
  for (const [language, module] of [
    ["python", pythonWasm],
    ["go", goWasm],
  ] as const) {
    const parser = new Parser();
    parser.setLanguage(Language.loadSync(module));
    parsers.set(language, parser);
  }
}

/**
 * Parses `source` and hands the tree's root to `use`. The tree is deleted straight after:
 * WebAssembly memory is not garbage-collected, and the isolate has 128 MB in all.
 */
export const parse: SyntaxParser = (language, source, use) => {
  const parser = parsers.get(language);
  if (parser === undefined) throw new Error(`tree-sitter is not initialised for ${language}`);
  const tree: Tree | null = parser.parse(source);
  if (tree === null) throw new Error(`tree-sitter returned no tree for ${language}`);
  try {
    return use(tree.rootNode);
  } finally {
    tree.delete();
  }
};
