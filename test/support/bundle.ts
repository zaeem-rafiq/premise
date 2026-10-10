// The Worker bundle that `npm run build:worker` writes, as Miniflare modules. Besides `index.js`,
// wrangler writes one `<sha1>-<name>.wasm` file per WebAssembly import (the tree-sitter parsers of
// 06-repos.md LG1), and `index.js` imports them by those names. A harness that loaded only `index.js`
// would fail to start with `No such module "<sha1>-web-tree-sitter.wasm"`.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./source.ts";

export const WORKER_DIR = join(REPO_ROOT, "dist/worker");
export const WORKER_BUNDLE = join(WORKER_DIR, "index.js");

type Module = { type: "ESModule" | "CompiledWasm"; path: string; contents?: string };

/** The modules of the built Worker, `index.js` first; `contents` replaces the text of `index.js`. */
export function workerModules(contents?: string): { modulesRoot: string; modules: Module[] } {
  const wasm = readdirSync(WORKER_DIR)
    .filter((file) => file.endsWith(".wasm"))
    .sort()
    .map((file): Module => ({ type: "CompiledWasm", path: join(WORKER_DIR, file) }));
  const main: Module = { type: "ESModule", path: WORKER_BUNDLE, ...(contents === undefined ? {} : { contents }) };
  return { modulesRoot: WORKER_DIR, modules: [main, ...wasm] };
}
