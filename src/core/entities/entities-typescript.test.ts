// Language-aware parsing: the parser switch, the TypeScript rows of LG2, EN4 overloads and
// merged declarations, the regions of EN6, the normalized hash of 2.4 over TypeScript sources,
// and the signatures of 2.7 / 4.3.

import { describe, it } from "vitest";
import assert from "node:assert";
import { entitySource, entitySignature, moduleHash, outlineLines, parseModule } from "./entities.ts";

const hashOf = (source: string, name: string, language: "javascript" | "typescript" = "typescript") => {
  const info = parseModule(source, language);
  return info.entities.find((entity) => entity.name === name)?.hash;
};

const ts = (source: string) => parseModule(source, "typescript");

const entity = (source: string, name: string) => {
  const found = ts(source).entities.find((e) => e.name === name);
  assert.ok(found, `entity ${name} exists`);
  return found;
};

describe("the parser switch (LG2)", () => {
  it("parses each language parameter", () => {
    assert.equal(parseModule("const x = 1;", "javascript").entities.length, 1);
    assert.equal(parseModule("const x = 1;", "jsx").entities.length, 1);
    assert.equal(parseModule("const x = 1;", "typescript").entities.length, 1);
    assert.equal(parseModule("const x = 1;", "tsx").entities.length, 1);
  });

  it("parses JSX in jsx and tsx but not in javascript or typescript", () => {
    const view = "const V = <div><B /></div>;\n";
    assert.equal(parseModule(view, "jsx").entities[0]?.name, "V");
    assert.equal(parseModule(view, "tsx").entities[0]?.name, "V");
    assert.throws(() => parseModule(view, "javascript"));
    assert.throws(() => parseModule(view, "typescript"));
  });

  it("parses TypeScript syntax in typescript and tsx but not in javascript", () => {
    const code = "interface I { a: string }\n";
    assert.equal(parseModule(code, "typescript").entities[0]?.name, "I");
    assert.equal(parseModule(code, "tsx").entities[0]?.name, "I");
    assert.throws(() => parseModule(code, "javascript"));
  });
});

describe("the TypeScript entity rows of LG2", () => {
  it("`interface I { a: T }` is an `interface` (LG2)", () => {
    const e = entity("interface I { a: T }\n", "I");
    assert.equal(e.kind, "interface");
    assert.deepEqual(e.exports, []);
  });

  it("`export interface I` exports its name (LG2)", () => {
    const e = entity("export interface I { a: string }\n", "I");
    assert.equal(e.kind, "interface");
    assert.deepEqual(e.exports, ["I"]);
  });

  it("`type T = ...` is a `type`; `export type T` exports it (LG2)", () => {
    assert.equal(entity("type T = { a: number }\n", "T").kind, "type");
    assert.equal(entity("type T = A | B\n", "T").kind, "type");
    const e = entity("export type T = number\n", "T");
    assert.equal(e.kind, "type");
    assert.deepEqual(e.exports, ["T"]);
  });

  it("`enum E` is an `enum`; `const enum` too, members included (LG2)", () => {
    const e = entity("enum E { A, B = 2, C = 'x' }\n", "E");
    assert.equal(e.kind, "enum");
    const ce = entity("const enum CE { A, B }\n", "CE");
    assert.equal(ce.kind, "enum");
    const ex = entity("export enum E { A }\n", "E");
    assert.deepEqual(ex.exports, ["E"]);
  });

  it("`namespace N` and `module 'n'` are `namespace` (LG2)", () => {
    const n = entity("namespace N { const x = 1; interface I {} }\n", "N");
    assert.equal(n.kind, "namespace");
    const m = entity('module "name" { const x = 1; }\n', "name");
    assert.equal(m.kind, "namespace");
    assert.equal(entity("export namespace N { }\n", "N").exports[0], "N");
    // `global {}` and `declare module 'm'` are the ambient forms of the same row (LG2).
    assert.equal(entity("global {}\n", "global").kind, "namespace");
    assert.equal(entity("declare module 'm' { const x: T }\n", "m").kind, "namespace");
  });

  it("`declare` bindings are entities: `declare function`, `declare const`, `declare class` (LG2)", () => {
    assert.equal(entity("declare function f(x: number): void\n", "f").kind, "function");
    assert.equal(entity("declare const d: number\n", "d").kind, "const");
    assert.equal(entity("declare class K {}\n", "K").kind, "class");
    assert.equal(entity("declare let v: T\n", "v").kind, "let");
  });

  it("`abstract class` is a `class` (LG2)", () => {
    const e = entity("abstract class A { abstract m(): void }\n", "A");
    assert.equal(e.kind, "class");
  });

  it("`import type` is an `import` entity (LG2)", () => {
    const e = entity("import type { T } from './a.ts';\n", "(import ./a.ts)");
    assert.equal(e.kind, "import");
    const mixed = entity("import { x, type T } from './a.ts';\n", "(import ./a.ts)");
    assert.equal(mixed.kind, "import");
  });

  it("`export type { T }` adds an export name to `T` (LG2)", () => {
    const e = entity("type T = number;\nexport type { T };\n", "T");
    assert.deepEqual(e.exports, ["T"]);
    const e2 = entity("export type { T as U };\ntype T = number;\n", "T");
    assert.deepEqual(e2.exports, ["U"]);
  });

  it("type parameters and parameter types are part of the entity, not its name (LG2)", () => {
    const e = entity("function f<T extends object>(x: T, y?: number): T { return x }\n", "f");
    assert.equal(e.kind, "function");
    assert.equal(e.arity, 2);
    const v = entity("const v: T = x;\n", "v");
    assert.equal(v.kind, "const");
    const c = entity("class C<T> implements I { x: T; private y = 1; readonly z?: T }\n", "C");
    assert.equal(c.kind, "class");
  });

  it("an overloaded function is one entity (EN4)", () => {
    const e = entity(
      "function ov(a: string): void;\nfunction ov(a: number): void;\nfunction ov(a: unknown) {}\n",
      "ov",
    );
    assert.equal(e.kind, "function");
    assert.equal(e.nodes.length, 3);
    assert.equal(e.arity, 1);
    assert.deepEqual(entity("export function ov(a: string): void;\nexport function ov(a: number) {}\n", "ov").exports, [
      "ov",
    ]);
  });

  it("merged interfaces and namespaces are one entity (EN4)", () => {
    const merged = entity("interface M { a: 1 }\ninterface M { b: 2 }\n", "M");
    assert.equal(merged.kind, "interface");
    assert.equal(merged.nodes.length, 2);
    const ns = entity("namespace N { const a = 1 }\nnamespace N { const b = 2 }\n", "N");
    assert.equal(ns.nodes.length, 2);
    const info = ts("interface M { a: 1 }\ninterface M { b: 2 }\n");
    assert.equal(info.entities.filter((e) => e.name === "M").length, 1);
  });
});

describe("the TypeScript hash (2.4)", () => {
  it("a change to a type annotation changes the entity hash", () => {
    assert.notEqual(
      hashOf("export function f(x: number): number { return x }\n", "f"),
      hashOf("export function f(x: string): number { return x }\n", "f"),
    );
    assert.notEqual(hashOf("export const v: number = 1;\n", "v"), hashOf("export const v: string = 1;\n", "v"));
    assert.notEqual(hashOf("interface I { a: number }\n", "I"), hashOf("interface I { a: string }\n", "I"));
  });

  it("a change to whitespace or comments does not change the entity hash", () => {
    const a = ts("export function f(x: number): number { return x }\n");
    const b = ts("// hi\nexport   function   f (\n  x : number ) : number {\n  return x /* in */\n}\n");
    assert.equal(
      hashOf("export function f(x: number): number { return x }\n", "f"),
      b.entities.find((e) => e.name === "f")?.hash,
    );
    assert.equal(moduleHash(a), moduleHash(b));
  });

  it("source identical as JavaScript and type-free TypeScript hashes the same", () => {
    const source = "export function f(x) { return x }\nexport const y = 1;\n";
    const js = parseModule(source, "javascript");
    const t = parseModule(source, "typescript");
    assert.equal(hashOf(source, "f", "javascript"), hashOf(source, "f"));
    assert.equal(hashOf(source, "y", "javascript"), hashOf(source, "y"));
    assert.equal(moduleHash(js), moduleHash(t));
  });
});

describe("TypeScript signatures (2.7, 4.3)", () => {
  it("interface, type, enum, function and class signatures", () => {
    const source = `export interface I { a: string }
export type T = number | string
export enum E { A, B }
export function f(x: number, y: string): void {}
export class C<T> extends B<T> implements I {}
`;
    const info = ts(source);
    assert.equal(entitySignature(source, info, "I"), "export interface I");
    assert.equal(entitySignature(source, info, "T"), "export type T");
    assert.equal(entitySignature(source, info, "E"), "export enum E");
    assert.equal(entitySignature(source, info, "f"), "export function f(x, y)");
    assert.equal(entitySignature(source, info, "C"), "export class C");
  });

  it("outline lines carry TypeScript entities (LG5)", () => {
    const lines = outlineLines(ts("export interface I { a: string }\nexport function f(x: number) {}\n"));
    assert.deepEqual(lines, ["I|interface|I|", "f|function|f|1"]);
  });
});

describe("regions and entity source for TypeScript (EN6, EN7)", () => {
  it("every statement is in a region and entitySource returns the statement text", () => {
    const source = "export interface I { a: string }\ntype T = number;\ndeclare function d(x: T): void;\n";
    const info = ts(source);
    assert.equal(info.regions.length, 3);
    assert.deepEqual(
      info.regions.map((r) => r.names),
      [["I"], ["T"], ["d"]],
    );
    assert.equal(entitySource(source, ts(source), "I"), "export interface I { a: string }");
    // the last region runs to end of file, keeping the statement's trailing newline (EN6)
    assert.equal(entitySource(source, ts(source), "d"), "declare function d(x: T): void;\n");
  });
});
