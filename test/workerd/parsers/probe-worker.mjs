// A probe Worker for the tree-sitter adapter (06-repos.md LG1). The test bundles it with wrangler,
// exactly as the production build bundles `src/worker/parsers/tree-sitter.ts`, and runs it in local
// workerd. POST /parse with `{ language, source }` answers the root's top-level node types.

import { initParsers, parse } from "../../../src/worker/parsers/tree-sitter.ts";

export default {
  async fetch(request) {
    const { language, source } = await request.json();
    const started = performance.now();
    await initParsers();
    const answer = parse(language, source, (root) => ({
      types: root.children.map((child) => child.type),
      hasError: root.hasError,
      processType: process.type,
    }));
    return Response.json({ ...answer, ms: performance.now() - started });
  },
};
