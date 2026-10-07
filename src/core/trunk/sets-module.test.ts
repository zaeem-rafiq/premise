import { describe, expect, it } from "vitest";
import { IMPORT_LANGUAGES, TIDEPOOL_LANGUAGES } from "../keys/paths.ts";
import {
  entityAt,
  entityKeysOf,
  moduleHashOf,
  outlineMembersOf,
  replayOps,
  sourceOf,
  targetsOf,
  type Op,
} from "./sets.ts";

describe("module-only lookups during replay (EN6 / OP3)", () => {
  it("does not traverse unrelated files to find syntax in one module", () => {
    const source = "export const value = 1;\n";
    const files = new Map([["one.js", source]]);
    // A syntax lookup must remain local even in a pool with many unrelated modules.
    Object.defineProperty(files, Symbol.iterator, {
      value: () => {
        throw new Error("traversed the entire pool");
      },
    });
    expect(entityKeysOf(files, "one.js")).toEqual(["one.js#value"]);
    expect(entityAt(files, "one.js#value")?.name).toBe("value");
    // EN6/EN7: the last statement's region extends to the end of the file.
    expect(sourceOf(files, "one.js#value")).toBe(source);
    expect(targetsOf(files, "one.js", source.indexOf("1"), source.indexOf("1") + 1)).toEqual(["one.js#value"]);
    expect(outlineMembersOf(files, "one.js")).toHaveLength(1);
    expect(moduleHashOf(files, "one.js")).not.toBe("");
  });

  it("reads current regions after the same input map changes between replays", () => {
    const files = new Map([["one.js", "export const first = 1;\n"]]);
    const replace = (old: string, targets: string[]): Op => ({
      op_seq: 1,
      op: "replace",
      path: "one.js",
      old,
      new: "2",
      targets,
      dropped: false,
    });
    expect(replayOps([replace("1", ["one.js#first"])], files).failed).toEqual([]);
    expect(files.get("one.js")).toBe("export const first = 1;\n");
    files.set("one.js", "export const second = 1;\n");
    const replayed = replayOps([replace("1", ["one.js#second"])], files);
    expect(replayed.failed).toEqual([]);
    expect(replayed.files.get("one.js")).toBe("export const second = 2;\n");
    expect(entityAt(files, "one.js#first")).toBeNull();
    expect(entityKeysOf(files, "one.js")).toEqual(["one.js#second"]);
    expect(replayOps([replace("1", ["one.js#first"])], files).failed).toEqual([
      { op_seq: 1, path: "one.js", rule: "OP3" },
    ]);
  });

  it("preserves opaque and absent module behavior", () => {
    const files = new Map([
      ["broken.js", "???"],
      ["opaque.txt", "export const value = 1;"],
    ]);
    for (const path of ["broken.js", "opaque.txt", "missing.js"]) {
      expect(entityAt(files, `${path}#value`)).toBeNull();
      expect(entityKeysOf(files, path)).toBeNull();
      expect(moduleHashOf(files, path)).toBe("");
      expect(sourceOf(files, `${path}#value`)).toBeNull();
      expect(targetsOf(files, path, 0, 1)).toEqual([path]);
      expect(outlineMembersOf(files, path)).toEqual(path === "missing.js" ? null : []);
    }
  });

  it("uses the pool language set for TypeScript and JSX syntax", () => {
    const files = new Map([
      ["one.ts", "export const value: number = 1;\n"],
      ["view.jsx", "export const view = <div />;\n"],
    ]);
    for (const [path, name] of [
      ["one.ts", "value"],
      ["view.jsx", "view"],
    ] as const) {
      expect(entityKeysOf(files, path, TIDEPOOL_LANGUAGES)).toBeNull();
      expect(entityKeysOf(files, path, IMPORT_LANGUAGES)).toEqual([`${path}#${name}`]);
      expect(entityAt(files, `${path}#${name}`, IMPORT_LANGUAGES)?.name).toBe(name);
    }
  });
});
