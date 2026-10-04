// The acorn pass of the early pool (ME3), tested against the entity table of 01-core 2.3 and the
// normalized entity hash of 2.4 — including the two hash values the spec prints for ENERGY_MAX.

import { describe, it, expect } from "vitest";
import { parseModule, entityByName, importsOf, resolveSpecifier } from "./entities.ts";

const mod = (src: string) => {
  const m = parseModule("x.js", src);
  if (!m.ok) throw new Error(`parse failed: ${m.error.message}`);
  return m;
};

describe("the entity table of 01-core 2.3", () => {
  it("one entity per bound identifier of a declarator list (EN4)", () => {
    const m = mod("const a = 1, b = 2;\n");
    expect(m.entities.map((e) => [e.name, e.kind])).toEqual([
      ["a", "const"],
      ["b", "const"],
    ]);
  });

  it("one entity per bound identifier of a destructuring declarator", () => {
    const m = mod("const { p, q } = obj;\n");
    expect(m.entities.map((e) => e.name).sort()).toEqual(["p", "q"]);
  });

  it("`export { a, b as c }` adds export names to entities a and b, creating none", () => {
    const m = mod("const a = 1;\nconst b = 2;\nexport { a, b as c };\n");
    const a = entityByName(m, "a");
    const b = entityByName(m, "b");
    expect(a?.exports).toEqual(["a"]);
    expect(b?.exports).toEqual(["c"]);
    expect(m.entities.some((e) => e.name === "c")).toBe(false);
    // EN6: the export statement's region belongs to the entities it contributes to.
    expect(b?.regions.length).toBe(2);
    expect(m.exports.sort()).toEqual(["a", "c"]);
  });

  it('`export { a as b } from "./m.js"` makes entity `b`, kind reexport', () => {
    const m = mod('export { a as b } from "./m.js";\n');
    expect(m.entities.map((e) => [e.name, e.kind, e.exports])).toEqual([["b", "reexport", ["b"]]]);
  });

  it("`export * as ns` makes entity `ns`, kind reexport; `export * from` makes `*./m.js`", () => {
    const m = mod('export * as ns from "./m.js";\nexport * from "./n.js";\n');
    expect(entityByName(m, "ns")?.kind).toBe("reexport");
    const star = entityByName(m, "*./n.js");
    expect(star?.kind).toBe("reexport-all");
    expect(star?.exports).toEqual(["*"]);
  });

  it("`export default function f` names `f`; the anonymous form names `default`", () => {
    expect(entityByName(mod("export default function f() {}\n"), "f")?.exports).toEqual(["default"]);
    const anon = mod("export default function () {}\n");
    expect(entityByName(anon, "default")?.kind).toBe("function");
    const value = mod("export default 42;\n");
    const d = entityByName(value, "default");
    expect(d?.kind).toBe("value");
    expect(d?.exports).toEqual(["default"]);
  });

  it("imports of one specifier share the entity `(import ./m.js)` (EN4)", () => {
    const m = mod('import { a } from "./m.js";\nimport { b } from "./m.js";\nimport { c } from "./n.js";\n');
    const imp = entityByName(m, "(import ./m.js)");
    expect(imp?.kind).toBe("import");
    expect(imp?.regions.length).toBe(2);
    expect(entityByName(m, "(import ./n.js)")?.regions.length).toBe(1);
  });

  it("every other top-level statement shares `(top)` (EN4)", () => {
    const m = mod("const a = 1;\nrun();\nlog(a);\n");
    const top = entityByName(m, "(top)");
    expect(top?.kind).toBe("top");
    expect(top?.regions.length).toBe(2);
    expect(m.entities.map((e) => e.name)).toEqual(["a", "(top)"]);
  });

  it("a module with no statements has exactly one entity `(top)` with no nodes (EN5)", () => {
    const m = mod("// only a comment\n");
    expect(m.entities.map((e) => e.name)).toEqual(["(top)"]);
    expect(m.entities[0]?.source).toBe("");
  });
});

describe("regions and source (EN6, EN7)", () => {
  it("a comment folds into the region of the statement that follows it", () => {
    const m = mod("// hello\nexport const X = 1;\n");
    const e = entityByName(m, "X");
    expect(e?.lines).toEqual([1, 2]);
    // EN6: the last region runs to the end of the file, so the final newline is part of it.
    expect(e?.source).toBe("// hello\nexport const X = 1;\n");
  });

  it("blank lines between statements belong to the following statement's region", () => {
    const m = mod("const a = 1;\n\n// doc\nconst b = 2;\n");
    const b = entityByName(m, "b");
    expect(b?.lines).toEqual([3, 4]);
    expect(b?.source).toBe("// doc\nconst b = 2;\n");
    expect(entityByName(m, "a")?.lines).toEqual([1, 1]);
  });
});

describe("the normalized entity hash of 01-core 2.4", () => {
  it("matches the two hashes the spec prints for ENERGY_MAX", () => {
    const before = mod(
      "// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 100;\n",
    );
    const after = mod("// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 1;\n");
    expect(entityByName(before, "ENERGY_MAX")?.hash).toBe("5149f012fe7cd2dfd8820a214ea41ff0");
    expect(entityByName(after, "ENERGY_MAX")?.hash).toBe("f52fdb40e9972b45534f0361ecb65cea");
  });

  it("ignores comments, whitespace and quote style but not names or values", () => {
    const a = mod("const X = 'a';\n");
    const b = mod('const  X   =   "a";\n');
    const c = mod("const X = 'b';\n");
    const h = (m: ReturnType<typeof mod>) => entityByName(m, "X")?.hash;
    expect(h(a)).toBe(h(b));
    expect(h(a)).not.toBe(h(c));
  });
});

describe("importsOf and resolveSpecifier (CK5, 6.2)", () => {
  it("names the imported names for import declarations", () => {
    const imps = importsOf(
      "x.js",
      'import def from "./a.js";\nimport * as ns from "./b.js";\nimport { x, y as z } from "./c.js";\n',
    );
    expect(imps).toEqual([
      { specifier: "./a.js", names: ["default"] },
      { specifier: "./b.js", names: ["*"] },
      { specifier: "./c.js", names: ["x", "y"] }, // imported names, not the local aliases
    ]);
  });

  it("names the local name of a re-export (`export { a as b }` needs `a` on the target)", () => {
    const imps = importsOf("x.js", 'export { a as b } from "./m.js";\n');
    expect(imps).toEqual([{ specifier: "./m.js", names: ["a"] }]);
  });

  it("resolves only ./ and ../ specifiers", () => {
    expect(resolveSpecifier("creatures/crab.js", "../world/energy.js")).toBe("world/energy.js");
    expect(resolveSpecifier("creatures/crab.js", "./x.js")).toBe("creatures/x.js");
    expect(resolveSpecifier("x.js", "acorn")).toBeNull();
    expect(resolveSpecifier("x.js", "https://example.com/m.js")).toBeNull();
  });
});
