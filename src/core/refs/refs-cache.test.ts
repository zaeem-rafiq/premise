// 01-core.md 2.1 and 2.5: sharing a parse must not share path resolution or query membership.
// The reference keys below follow 6.2 directly; uncached runs additionally check every hash.
import { describe, expect, it, vi } from "vitest";
import * as entities from "../entities/entities.ts";
import type { ModuleInfo } from "../entities/entities.ts";
import { IMPORT_LANGUAGES } from "../keys/paths.ts";
import { analyse, refsMembers } from "./refs.ts";
import type { Analysis } from "./refs.ts";

const sharedParse = entities.parseModule;
const sharedFiles = new Map([
  ["bridge/named.js", 'export { ENERGY_MAX as MAX } from "../world/energy.js";\n'],
  ["bridge/star.js", 'export * from "../world/energy.js";\n'],
  [
    "actors/fish.js",
    'import { MAX } from "../bridge/named.js";\n' +
      'import { ENERGY_MAX } from "../bridge/star.js";\n' +
      "export function swim() { return MAX + ENERGY_MAX; }\n",
  ],
  ["left/user.js", 'import { value } from "./provider.js";\nexport function read() { return value; }\n'],
  ["right/user.js", 'import { value } from "./provider.js";\nexport function read() { return value; }\n'],
]);

const trees = {
  missing: new Map([
    ...sharedFiles,
    ["world/energy.js", "export const RATE = 1;\n"],
    ["left/provider.js", "export const value = 1;\n"],
    ["right/provider.js", "export const other = 2;\n"],
  ]),
  repaired: new Map([
    ...sharedFiles,
    ["world/energy.js", "export const RATE = 1;\nexport const ENERGY_MAX = 100;\n"],
    ["left/provider.js", "export const other = 1;\n"],
    ["right/provider.js", "export const value = 2;\n"],
  ]),
};

type TreeName = keyof typeof trees;
const queryKeys = ["world/energy.js#ENERGY_MAX", "left/provider.js#value", "right/provider.js#value"];

function snapshot(info: ModuleInfo): string {
  return JSON.stringify({ ...info, imports: [...info.imports] });
}

function allMembers(analysis: Analysis): string[][] {
  return queryKeys.map((key) => refsMembers(key, analysis));
}

function isolatedMembers(name: TreeName): string[][] {
  const spy = vi.spyOn(entities, "parseModule").mockImplementation(entities.createModuleParser(0));
  try {
    return allMembers(analyse(trees[name]));
  } finally {
    spy.mockRestore();
  }
}

function expectMembers(analysis: Analysis, key: string, expectedReferrers: string[]): void {
  const members = refsMembers(key, analysis);
  expect(members.filter((member) => member.includes("#"))).toEqual(expectedReferrers);
  // 2.5 and KH3 require exactly one module entry for each module with a referrer.
  expect(members.filter((member) => !member.includes("#")).map((member) => member.split("@")[0])).toEqual(
    [...new Set(expectedReferrers.map((referrer) => referrer.split("#")[0]))].sort(),
  );
}

describe("shared parse reference analysis", () => {
  it.each<[TreeName, TreeName]>([
    ["missing", "repaired"],
    ["repaired", "missing"],
  ])("keeps members and module objects unchanged in %s then %s order", (first, second) => {
    const isolated = { missing: isolatedMembers("missing"), repaired: isolatedMembers("repaired") };
    const originalModules = new Map([...sharedFiles].map(([path, source]) => [path, sharedParse(source)]));
    const originals = new Map([...originalModules].map(([path, info]) => [path, snapshot(info)]));
    const results = new Map<TreeName, Analysis>();

    for (const name of [first, second]) {
      const analysis = analyse(trees[name]);
      results.set(name, analysis);
      expect(allMembers(analysis)).toEqual(isolated[name]);
      for (const [path, info] of originalModules) {
        expect(analysis.modules.get(path)).toBe(info);
        expect(snapshot(info)).toBe(originals.get(path));
      }
      // Identical bytes at different paths share syntax, but resolve against different providers.
      expect(analysis.modules.get("left/user.js")).toBe(analysis.modules.get("right/user.js"));
    }

    const missing = results.get("missing")!;
    const repaired = results.get("repaired")!;
    expectMembers(missing, queryKeys[0]!, ["bridge/star.js#*../world/energy.js"]);
    expectMembers(repaired, queryKeys[0]!, [
      "actors/fish.js#(import ../bridge/named.js)",
      "actors/fish.js#(import ../bridge/star.js)",
      "actors/fish.js#swim",
      "bridge/named.js#MAX",
      "bridge/star.js#*../world/energy.js",
    ]);
    expectMembers(missing, queryKeys[1]!, ["left/user.js#(import ./provider.js)", "left/user.js#read"]);
    expectMembers(repaired, queryKeys[1]!, []);
    expectMembers(missing, queryKeys[2]!, []);
    expectMembers(repaired, queryKeys[2]!, ["right/user.js#(import ./provider.js)", "right/user.js#read"]);

    // A later analysis cannot retroactively change the first tree's members or module data.
    expect(allMembers(results.get(first)!)).toEqual(isolated[first]);
    for (const [path, info] of originalModules) expect(snapshot(info)).toBe(originals.get(path));
  });

  it("keeps repeated invalid modules opaque across trees and accepts repaired bytes (2.1)", () => {
    const importer = 'import { value } from "./broken.js";\n';
    const invalid = "export const value = ;\n";
    for (const extra of ["export const a = 1;\n", "export const b = 2;\n", "export const a = 1;\n"]) {
      const analysis = analyse(
        new Map([
          ["broken.js", invalid],
          ["user.js", importer],
          ["other.js", extra],
        ]),
      );
      expect(analysis.modules.has("broken.js")).toBe(false);
      expect(refsMembers("broken.js#value", analysis)).toEqual([]);
      expect(analysis.unresolved).toEqual([{ from: "user.js#(import ./broken.js)", to: "broken.js#value" }]);
    }
    const repaired = analyse(
      new Map([
        ["broken.js", "export const value = 1;\n"],
        ["user.js", importer],
      ]),
    );
    expect(repaired.modules.has("broken.js")).toBe(true);
    expect(repaired.unresolved).toEqual([]);
    expectMembers(repaired, "broken.js#value", ["user.js#(import ./broken.js)"]);
  });

  it("does not reuse a successful TypeScript parse for identical opaque JavaScript bytes", () => {
    const source = "export const value: number = 1;\n";
    for (const paths of [
      ["typed.ts", "plain.js"],
      ["plain.js", "typed.ts"],
    ]) {
      const files = new Map(paths.map((path) => [path, source]));
      files.set("user.js", 'import { value } from "./plain.js";\n');
      const analysis = analyse(files, IMPORT_LANGUAGES);
      expect(analysis.modules.has("typed.ts")).toBe(true);
      expect(analysis.modules.has("plain.js")).toBe(false);
      expect(refsMembers("plain.js#value", analysis)).toEqual([]);
      expect(analysis.unresolved).toEqual([{ from: "user.js#(import ./plain.js)", to: "plain.js#value" }]);
    }
  });
});
