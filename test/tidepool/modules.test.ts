// Appendix A, row A8, for the seed modules: every module parses (CK5), every import resolves to a
// file of the seed (CK5), and every global a module uses is in the policy's `globals` list (CK6).
// Parsing is acorn's; the globals are found in the syntax tree, not by running the code.

import { describe, expect, it } from "vitest";
import { posix } from "node:path";
import { seedFiles, specBlock } from "./spec.ts";
import { importSpecifiers, parseModule, usedGlobals } from "./modules.ts";

const files = seedFiles();
const modules = [...files.keys()].filter((path) => path.endsWith(".js")).sort();
const policy = JSON.parse(files.get(".premise/policy.json") as string) as { globals: string[] };

/** The path an import specifier names, relative to the seed, or null when it leaves the seed. */
function resolves(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const target = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  return target.startsWith("../") ? null : target;
}

describe("Appendix A, row A8 (the seed's modules)", () => {
  it("every seed module parses with acorn", () => {
    expect(modules.length).toBeGreaterThan(0);
    for (const path of modules) {
      expect(() => parseModule(path, files.get(path) as string), `${path} does not parse`).not.toThrow();
    }
  });

  it("every import resolves to a file of the seed", () => {
    const unresolved: string[] = [];
    for (const path of modules) {
      const program = parseModule(path, files.get(path) as string);
      for (const entry of importSpecifiers(program)) {
        const target = resolves(path, entry.specifier);
        if (target === null || !files.has(target)) {
          unresolved.push(`${path}:${entry.line} imports "${entry.specifier}"`);
        }
      }
    }
    expect(unresolved).toEqual([]);
  });

  it("every global a module uses is in the policy's globals list", () => {
    const allowed = new Set(policy.globals);
    const outside: string[] = [];
    for (const path of modules) {
      const program = parseModule(path, files.get(path) as string);
      for (const name of usedGlobals(program)) {
        if (!allowed.has(name)) outside.push(`${path}: ${name}`);
      }
    }
    expect(outside).toEqual([]);
  });

  it("the policy's globals are the 16 names section 6 lists", () => {
    const block = specBlock("`.premise/policy.json` in the seed MUST be exactly this", "```json");
    const expected = (JSON.parse(block) as { globals: string[] }).globals;
    expect(policy.globals).toEqual(expected);
  });
});
