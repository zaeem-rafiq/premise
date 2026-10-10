// Pins the environment test that `tree-sitter.ts` works around (06-repos.md LG1). Under
// `nodejs_compat` workerd reports `process.versions.node`; the adapter sets `process.type` to
// "renderer" so that web-tree-sitter takes its browser path. If an upgrade of web-tree-sitter
// changes that test, this fails before the Worker does.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const LIBRARY = new URL("../../../node_modules/web-tree-sitter/web-tree-sitter.js", import.meta.url);

describe("LG1: web-tree-sitter's environment test", () => {
  it('LG1: web-tree-sitter treats process.type "renderer" as not Node', () => {
    const text = readFileSync(LIBRARY, "utf8");
    expect(text).toContain(
      'var ENVIRONMENT_IS_NODE = typeof process == "object" && process.versions?.node && process.type != "renderer";',
    );
  });

  it("LG1: the adapter sets process.type before Parser.init", () => {
    const adapter = readFileSync(new URL("./tree-sitter.ts", import.meta.url), "utf8");
    expect(adapter.indexOf('(process as { type?: string }).type = "renderer";')).toBeGreaterThan(-1);
    expect(adapter.indexOf('(process as { type?: string }).type = "renderer";')).toBeLessThan(
      adapter.indexOf("await Parser.init("),
    );
  });
});
