// Go entities, regions, outline forms and hashes (06-repos.md LG7, LG8), through the real
// tree-sitter-go grammar. Expected values are worked by hand from the rules.

import { beforeAll, describe, expect, it } from "vitest";
import { installTreeSitter } from "../support/tree-sitter.ts";
import { entitySignature, entitySource, outlineLines, parseModule } from "../../src/core/entities/entities.ts";

beforeAll(installTreeSitter);

const go = (body: string) => parseModule(`package m\n\n${body}`, "go");
const hashOf = (body: string, name: string) => go(body).entities.find((entity) => entity.name === name)!.hash;

describe("LG7: Go entities", () => {
  it("LG7: the package clause belongs to (top)", () => {
    expect(outlineLines(parseModule("package m\n", "go"))).toEqual(["(top)|top||"]);
  });

  it("LG7: func F gives a function; methods on T, *T and T[K] give T.M of kind method", () => {
    const info = go(
      "func F(a, b int, c string) {}\nfunc (r T) M() {}\nfunc (r *T) P(x int) {}\nfunc (g G[K]) N(k K) {}\n",
    );
    expect(outlineLines(info)).toEqual([
      "(top)|top||",
      "F|function||3",
      "T.M|method||0",
      "T.P|method||1",
      "G.N|method||1",
    ]);
  });

  it("LG7: func init belongs to (top), however many a file has", () => {
    const info = go("func init() {}\nfunc init() {}\n");
    expect(info.entities.map((entity) => entity.name)).toEqual(["(top)"]);
    expect(info.entities[0]!.nodes).toHaveLength(3);
  });

  it("LG7: type, const and var give one entity per bound name; grouped specs share their statement", () => {
    const body = "type (\n\tT struct{}\n\tU = T\n)\nconst C = 1\nvar (\n\tV, W = 2, 3\n\tX int\n)\n";
    const source = `package m\n\n${body}`;
    const info = go(body);
    expect(outlineLines(info)).toEqual([
      "(top)|top||",
      "T|type||",
      "U|type||",
      "C|const||",
      "V|var||",
      "W|var||",
      "X|var||",
    ]);
    expect(entitySource(source, info, "U")).toBe("type (\n\tT struct{}\n\tU = T\n)");
  });

  it("LG7: a spec that binds only _ belongs to (top)", () => {
    const info = go("var _ = fmt.Sprintf\nconst (\n\tA = iota\n\t_\n)\n");
    expect(info.entities.map((entity) => entity.name)).toEqual(["(top)", "A"]);
  });

  it("LG7: an implicit const repeats the last explicit type and value with its iota index", () => {
    // B repeats `Kind = iota` at index 1. Changing A's value changes B, because B repeats it.
    const before = "const (\n\tA Kind = iota\n\tB\n)\n";
    const after = "const (\n\tA Kind = iota + 1\n\tB\n)\n";
    expect(hashOf(before, "B")).not.toBe(hashOf(after, "B"));
    // The same spec text at another index is another value of iota.
    expect(hashOf("const (\n\tA = iota\n\tB\n)\n", "B")).not.toBe(hashOf("const (\n\tA = iota\n\tZ\n\tB\n)\n", "B"));
    // A change to C, which B does not repeat, leaves B equal.
    expect(hashOf("const (\n\tA = iota\n\tB\n\tC = 9\n)\n", "B")).toBe(
      hashOf("const (\n\tA = iota\n\tB\n\tC = 8\n)\n", "B"),
    );
  });

  it("LG7: each import path gives (import p), shared across specs and statements (EN4)", () => {
    const info = go('import (\n\t"fmt"\n\tal "example.com/m/sub"\n)\nimport "fmt"\n');
    expect(outlineLines(info)).toEqual(["(top)|top||", "(import fmt)|import||", "(import example.com/m/sub)|import||"]);
    expect(info.entities.find((entity) => entity.name === "(import fmt)")!.nodes).toHaveLength(2);
  });

  it("LG7: exports is [] and the receiver does not count in arity", () => {
    const info = go("func (t T) M(a, b int, rest ...string) {}\nfunc Exported() {}\n");
    expect(info.entities.slice(1).map((entity) => [entity.name, entity.exports, entity.arity])).toEqual([
      ["T.M", [], 3],
      ["Exported", [], 0],
    ]);
  });

  it("LG1: a Go file that does not parse throws with a 1-based line and 0-based column", () => {
    expect(() => parseModule("package m\n\nfunc F( {\n}\n", "go")).toThrow(
      expect.objectContaining({ loc: expect.objectContaining({ line: 3 }) }),
    );
  });
});

describe("LG7: Go outline signatures (4.3)", () => {
  it("LG7: outline shows func, method, type, const, var and import forms", () => {
    const body =
      'import "fmt"\nconst C = 1\nvar V = 2\ntype T struct{}\nfunc F(a, b int) {}\nfunc (t *T) M(x int) {}\n';
    const source = `package m\n\n${body}`;
    const info = go(body);
    expect(info.entities.map((entity) => entitySignature(source, info, entity.name))).toEqual([
      "(top)",
      'import "fmt"',
      "const C",
      "var V",
      "type T",
      "func F(a, b)",
      "func (T) M(x)",
    ]);
  });
});

describe("LG8: Go canonical form and hash", () => {
  it("LG8: a comment change leaves the hash equal", () => {
    expect(hashOf("// one\nfunc F() { /* a */ }\n", "F")).toBe(hashOf("// two\nfunc F() { /* b */ }\n", "F"));
  });

  it("LG8: a whitespace change leaves the hash equal", () => {
    expect(hashOf("func F(a int) int { return a + 1 }\n", "F")).toBe(
      hashOf("func F(a int) int {\n\treturn a+1\n}\n", "F"),
    );
  });

  it("LG8: a token change makes the hash differ", () => {
    expect(hashOf("const C = 1\n", "C")).not.toBe(hashOf("const C = 2\n", "C"));
    expect(hashOf('const S = "a\\nb"\n', "S")).not.toBe(hashOf('const S = "a\\nc"\n', "S"));
  });

  it("LG8: a change tree-sitter represents (parentheses) makes the hash differ", () => {
    expect(hashOf("const C = 1 + 2\n", "C")).not.toBe(hashOf("const C = (1 + 2)\n", "C"));
  });
});
