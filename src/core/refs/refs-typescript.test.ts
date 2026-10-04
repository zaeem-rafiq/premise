// Language-aware references and specifier resolution: LG3's resolution order, identifiers in
// type positions (6.2 extended by LG2), JSX/TSX modules, opaque unparsable TypeScript, and the
// tide-pool behaviour every existing caller keeps by default.

import { describe, it } from "vitest";
import assert from "node:assert";
import { IMPORT_LANGUAGES } from "../keys/paths.ts";
import { analyse, isExternalSpecifier, resolveSpecifier } from "./refs.ts";
import { parseModule } from "../entities/entities.ts";

const R = (files: ReadonlySet<string>, from: string, specifier: string) =>
  resolveSpecifier(from, specifier, IMPORT_LANGUAGES, files);

describe("resolveSpecifier under IMPORT_LANGUAGES (LG3)", () => {
  it("step 1: the exact path wins when it exists", () => {
    const files = new Set(["real.js", "real.ts"]);
    assert.equal(R(files, "main.ts", "./real.js"), "real.js");
    assert.equal(R(files, "main.ts", "./real.ts"), "real.ts");
  });

  it("step 2: appends the language extensions in order .ts,.tsx,.mts,.cts,.js,.mjs", () => {
    assert.equal(R(new Set(["mod.ts", "mod.js"]), "main.ts", "./mod"), "mod.ts");
    assert.equal(R(new Set(["mod.tsx", "mod.js"]), "main.ts", "./mod"), "mod.tsx");
    assert.equal(R(new Set(["mod.mts", "mod.js"]), "main.ts", "./mod"), "mod.mts");
    assert.equal(R(new Set(["mod.cts", "mod.js"]), "main.ts", "./mod"), "mod.cts");
    assert.equal(R(new Set(["mod.js", "mod.mjs"]), "main.ts", "./mod"), "mod.js");
    assert.equal(R(new Set(["mod.mjs"]), "main.ts", "./mod"), "mod.mjs");
  });

  it("step 3: replaces a .js/.mjs/.cjs ending with .ts/.mts/.cts in order", () => {
    assert.equal(R(new Set(["mod.ts"]), "main.ts", "./mod.js"), "mod.ts");
    assert.equal(R(new Set(["mod.mts", "mod.ts"]), "main.ts", "./mod.js"), "mod.ts");
    assert.equal(R(new Set(["mod.mts"]), "main.ts", "./mod.mjs"), "mod.mts");
    assert.equal(R(new Set(["mod.cts"]), "main.ts", "./mod.cjs"), "mod.cts");
    assert.equal(R(new Set(["mod.mts", "mod.cts"]), "main.ts", "./mod.cjs"), "mod.mts");
  });

  it("step 4: treats the path as a directory of index.ts, index.tsx, index.js", () => {
    assert.equal(R(new Set(["dir/index.ts", "dir/index.js"]), "main.ts", "./dir"), "dir/index.ts");
    assert.equal(R(new Set(["dir/index.tsx", "dir/index.js"]), "main.ts", "./dir"), "dir/index.tsx");
    assert.equal(R(new Set(["dir/index.js"]), "main.ts", "./dir"), "dir/index.js");
  });

  it("the steps run in order: exact, then append, then replace, then index", () => {
    // exact beats append
    assert.equal(R(new Set(["a.js", "a.js.ts"]), "m.ts", "./a.js"), "a.js");
    // append beats replace: `b.js` gains `.ts` before its own ending is replaced
    assert.equal(R(new Set(["b.js.ts", "b.ts"]), "m.ts", "./b.js"), "b.js.ts");
    // replace beats index
    assert.equal(R(new Set(["c.ts", "c.js/index.ts"]), "m.ts", "./c.js"), "c.ts");
  });

  it("returns the joined path when nothing exists, and null for non-relative or non-path", () => {
    assert.equal(R(new Set(), "main.ts", "./missing"), "missing");
    assert.equal(R(new Set(), "main.ts", "react"), null);
    assert.equal(R(new Set(), "main.ts", "../../escape"), null);
    assert.equal(isExternalSpecifier("node:path"), true);
  });

  it("the default tide-pool set resolves only the joined path (6.1)", () => {
    const files = new Set(["mod.ts", "mod"]);
    assert.equal(resolveSpecifier("main.js", "./mod"), "mod");
    assert.equal(resolveSpecifier("main.js", "./mod", undefined, files), "mod");
    // a specifier naming a .ts file resolves to it only as an exact path
    assert.equal(resolveSpecifier("main.js", "./mod.ts", undefined, files), "mod.ts");
  });
});

describe("references in type positions (6.2, LG3)", () => {
  it("parameter, return and variable annotations are references", () => {
    const files = new Map<string, string>([
      [
        "types.ts",
        "export interface Creature { energy: number }\nexport type Kind = string;\nexport const MAX = 100;\n",
      ],
      [
        "use.ts",
        "import type { Creature, Kind } from './types.ts';\n" +
          "import { MAX } from './types.ts';\n" +
          "export function spawn(c: Creature, k: Kind): Creature { return { energy: MAX } }\n",
      ],
    ]);
    const refs = analyse(files, IMPORT_LANGUAGES).refs;
    assert.deepEqual([...(refs.get("use.ts#spawn") ?? [])].sort(), [
      "types.ts#Creature",
      "types.ts#Kind",
      "types.ts#MAX",
    ]);
  });

  it("type aliases, interfaces, extends/implements and type arguments are references", () => {
    const files = new Map<string, string>([
      ["types.ts", "export interface Base {}\nexport type A = number;\nexport class Box<T> {}\n"],
      [
        "use.ts",
        "import { Base, A, Box } from './types.ts';\n" +
          "export interface Pet extends Base { kind: A }\n" +
          "export class Kennel extends Box<A> implements Base {}\n" +
          "export const box: Box<A> | null = null;\n",
      ],
    ]);
    const refs = analyse(files, IMPORT_LANGUAGES).refs;
    assert.deepEqual([...(refs.get("use.ts#Pet") ?? [])].sort(), ["types.ts#A", "types.ts#Base"]);
    assert.deepEqual([...(refs.get("use.ts#Kennel") ?? [])].sort(), ["types.ts#A", "types.ts#Base", "types.ts#Box"]);
    assert.deepEqual([...(refs.get("use.ts#box") ?? [])].sort(), ["types.ts#A", "types.ts#Box"]);
  });

  it("a type name bound by a type parameter does not leak as a global", () => {
    const files = new Map<string, string>([["m.ts", "export function f<T extends object>(x: T): T { return x }\n"]]);
    const { globals, unresolved } = analyse(files, IMPORT_LANGUAGES);
    assert.deepEqual([...(globals.get("m.ts#f") ?? [])], []);
    assert.deepEqual(unresolved, []);
  });

  it("import() types and module-qualified types resolve", () => {
    const files = new Map<string, string>([
      ["lib.ts", "export interface Config { on: boolean }\n"],
      ["ns.ts", "export namespace Shapes { export interface Round { r: number } }\n"],
      [
        "m.ts",
        "import { Shapes } from './ns.ts';\n" +
          "export const cfg: import('./lib.ts').Config = { on: true };\n" +
          "export const ball: Shapes.Round = { r: 1 };\n",
      ],
    ]);
    const { refs } = analyse(files, IMPORT_LANGUAGES);
    assert.deepEqual([...(refs.get("m.ts#cfg") ?? [])], ["lib.ts#Config"]);
    // `Shapes.Round` reads member Round on the imported Shapes: the reference is the export (6.3)
    assert.deepEqual([...(refs.get("m.ts#ball") ?? [])], ["ns.ts#Shapes"]);
  });
});

describe("analyse under a language set (LG1, LG3)", () => {
  it("parses each imported extension and resolves TypeScript imports", () => {
    const files = new Map<string, string>([
      ["a.tsx", "export const V = <div className='x' />;\n"],
      ["b.jsx", "export const W = <B />;\n"],
      ["c.cjs", "export const n = 1;\n"],
      ["d.mts", "export const m = 2;\n"],
      ["e.cts", "export const k = 3;\n"],
      [
        "main.ts",
        "import { n } from './c.cjs';\nimport { m } from './d.mts';\nimport { k } from './e.cts';\nexport const all = n + m + k;\n",
      ],
    ]);
    const { modules, refs } = analyse(files, IMPORT_LANGUAGES);
    assert.deepEqual([...modules.keys()].sort(), ["a.tsx", "b.jsx", "c.cjs", "d.mts", "e.cts", "main.ts"]);
    assert.deepEqual([...(refs.get("main.ts#all") ?? [])].sort(), ["c.cjs#n", "d.mts#m", "e.cts#k"]);
    // JSX elements: the component in `b.jsx` is a global read of `B`
    const { globals } = analyse(files, IMPORT_LANGUAGES);
    assert.deepEqual([...(globals.get("b.jsx#W") ?? [])], ["B"]);
  });

  it("extensionless and .js specifiers find TypeScript modules (LG3)", () => {
    const files = new Map<string, string>([
      ["impl.ts", "export const go = () => 1;\n"],
      ["main.ts", "import { go } from './impl';\nexport const g = go;\n"],
      ["main2.ts", "import { go } from './impl.js';\nexport const g2 = go;\n"],
    ]);
    const { refs } = analyse(files, IMPORT_LANGUAGES);
    assert.deepEqual([...(refs.get("main.ts#g") ?? [])], ["impl.ts#go"]);
    assert.deepEqual([...(refs.get("main2.ts#g2") ?? [])], ["impl.ts#go"]);
  });

  it("a TypeScript module that does not parse is opaque (2.1)", () => {
    const files = new Map<string, string>([
      ["broken.ts", "export const x: = 1;;;\n"],
      ["main.ts", "import { x } from './broken.ts';\nexport const y = x;\n"],
    ]);
    const { modules, unresolved } = analyse(files, IMPORT_LANGUAGES);
    assert.deepEqual([...modules.keys()], ["main.ts"]);
    // both the import entity and the entity that consumes `x` are unresolved (6.2, 6.3)
    assert.deepEqual(unresolved, [
      { from: "main.ts#(import ./broken.ts)", to: "broken.ts#x" },
      { from: "main.ts#y", to: "broken.ts#x" },
    ]);
  });

  it("the default tide-pool set keeps .ts opaque and resolves only exact paths", () => {
    const files = new Map<string, string>([
      ["a.ts", "export const x = 1;\n"],
      ["b.js", "import { x } from './a.ts';\nexport const y = x;\n"],
    ]);
    const { modules, unresolved } = analyse(files);
    assert.deepEqual([...modules.keys()], ["b.js"]); // a.ts is not a tide-pool module
    assert.deepEqual(unresolved, [
      { from: "b.js#(import ./a.ts)", to: "a.ts#x" },
      { from: "b.js#y", to: "a.ts#x" },
    ]);
  });
});

describe("the tide-pool default every existing caller keeps (LG1)", () => {
  it("parseModule without a language is JavaScript: TypeScript source throws and is opaque", () => {
    assert.throws(() => parseModule("interface I { a: string }\n")); // the default is "javascript"
    assert.equal(parseModule("const x = 1;").entities[0]?.name, "x");
    assert.throws(() => parseModule("const V = <div />;")); // JSX is not in the default set
  });
});
