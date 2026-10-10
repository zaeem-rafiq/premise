// Python entities, regions, outline forms and hashes (06-repos.md LG6, LG8), through the real
// tree-sitter-python grammar. Expected values are worked by hand from the rules.

import { beforeAll, describe, expect, it } from "vitest";
import { installTreeSitter } from "../support/tree-sitter.ts";
import {
  entitySignature,
  entitySource,
  outlineLines,
  parseModule,
  regionTargets,
} from "../../src/core/entities/entities.ts";

beforeAll(installTreeSitter);

const py = (source: string) => parseModule(source, "python");
const names = (source: string) => py(source).entities.map((entity) => entity.name);
const hashOf = (source: string, name: string) => py(source).entities.find((entity) => entity.name === name)!.hash;

describe("LG6: Python entities", () => {
  it("LG6: def and async def give a function, class gives a class", () => {
    const info = py("def f(a, b):\n    return a\n\nasync def g():\n    pass\n\nclass C:\n    pass\n");
    expect(outlineLines(info)).toEqual(["f|function||2", "g|function||0", "C|class||"]);
  });

  it("LG6: a decorated definition is one entity with its decorators", () => {
    const source = "import functools\n\n@functools.cache\n@other\ndef f(x):\n    return x\n";
    const info = py(source);
    expect(info.entities.map((entity) => entity.name)).toEqual(["(import functools)", "f"]);
    expect(entitySource(source, info, "f")).toBe("@functools.cache\n@other\ndef f(x):\n    return x\n");
  });

  it("LG6: an assignment gives one var entity per bound name, sharing the statement", () => {
    const source = "a, b = 1, 2\nc = d = 3\ne: int = 4\nf += 1\n";
    const info = py(source);
    expect(outlineLines(info)).toEqual(["a|var||", "b|var||", "c|var||", "d|var||", "e|var||", "f|var||"]);
    expect(regionTargets(info, 0, 1)).toEqual(["a", "b"]);
    expect(entitySource(source, info, "b")).toBe("a, b = 1, 2");
  });

  it("LG6: an assignment to an attribute or a subscript belongs to (top)", () => {
    expect(names("obj.x = 1\nitems[0] = 2\n")).toEqual(["(top)"]);
  });

  it("LG6: type X = … gives X of kind type", () => {
    expect(outlineLines(py("type Pair = tuple[int, int]\n"))).toEqual(["Pair|type||"]);
  });

  it("LG6: each imported module is one (import <module as written>) entity, shared across statements (EN4)", () => {
    const source =
      "import os.path as op, sys\nfrom . import x\nfrom .m import a as b, c\nfrom ..p.q import *\nimport sys\n";
    const info = py(source);
    expect(outlineLines(info)).toEqual([
      "(import os.path)|import||",
      "(import sys)|import||",
      "(import .)|import||",
      "(import .m)|import||",
      "(import ..p.q)|import||",
    ]);
    expect(info.entities.find((entity) => entity.name === "(import sys)")!.nodes).toHaveLength(2);
  });

  it("LG6: every other statement belongs to (top), nested imports included", () => {
    const source = '"""Docstring."""\nif DEBUG:\n    import pdb\nprint("hi")\nfor i in range(3):\n    pass\n';
    expect(names(source)).toEqual(["(top)"]);
  });

  it("LG6: a name bound twice at the top level is one entity with several nodes (EN4)", () => {
    const info = py("X = 1\ndef X():\n    pass\n");
    expect(info.entities).toHaveLength(1);
    expect(info.entities[0]!.name).toBe("X");
    expect(info.entities[0]!.nodes).toHaveLength(2);
  });

  it("LG6: exports is [] and arity counts the parameters as written, self included", () => {
    const info = py(
      "class K:\n    pass\n\ndef m(self, a, *args, b=1, c: int = 2, **kw):\n    pass\n\ndef k(a, /, b, *, c):\n    pass\n",
    );
    expect(info.entities.map((entity) => [entity.name, entity.exports, entity.arity])).toEqual([
      ["K", [], null],
      ["m", [], 6],
      ["k", [], 3],
    ]);
  });

  it("LG6: every character belongs to exactly one region (EN6)", () => {
    const source = "# head\nimport os\n\nX = 1  # tail\n\ndef f():\n    pass\n";
    const info = py(source);
    expect(info.regions.map((region) => source.slice(region.start, region.end)).join("")).toBe(source);
    expect(info.regions.map((region) => region.names)).toEqual([["(import os)"], ["X"], ["f"]]);
  });

  it("LG6: an empty module has exactly (top) (EN5)", () => {
    expect(names("")).toEqual(["(top)"]);
    expect(names("# only a comment\n")).toEqual(["(top)"]);
  });

  it("LG1: a Python file that does not parse throws with a 1-based line and 0-based column", () => {
    expect(() => py("x = 1\ndef f(:\n    pass\n")).toThrow(expect.objectContaining({ loc: { line: 2, column: 6 } }));
  });
});

describe("LG6: Python outline signatures (4.3)", () => {
  it("LG6: outline shows def, async def, class, assignment, type and import forms", () => {
    const source =
      "import a.b\nX = 1\ntype T = int\nclass C:\n    pass\ndef f(a, b):\n    pass\nasync def g(*xs, **kw):\n    pass\n";
    const info = py(source);
    expect(info.entities.map((entity) => entitySignature(source, info, entity.name))).toEqual([
      "import a.b",
      "X = …",
      "type T",
      "class C",
      "def f(a, b)",
      "async def g(*xs, **kw)",
    ]);
  });
});

describe("LG8: Python canonical form and hash", () => {
  it("LG8: a comment change leaves the hash equal", () => {
    expect(hashOf("def f(a):\n    # one\n    return a\n", "f")).toBe(
      hashOf("def f(a):\n    # two\n    return a\n", "f"),
    );
  });

  it("LG8: a whitespace change leaves the hash equal", () => {
    expect(hashOf("X = [1, 2]\n", "X")).toBe(hashOf("X  =  [1,2]\n", "X"));
  });

  it("LG8: a token change makes the hash differ", () => {
    expect(hashOf("X = 1\n", "X")).not.toBe(hashOf("X = 2\n", "X"));
    expect(hashOf("def f(a):\n    return a\n", "f")).not.toBe(hashOf("def f(a):\n    return -a\n", "f"));
  });

  it("LG8: a change tree-sitter represents (parentheses, a trailing comma) makes the hash differ", () => {
    expect(hashOf("X = 1 + 2\n", "X")).not.toBe(hashOf("X = (1 + 2)\n", "X"));
    expect(hashOf("X = [1, 2]\n", "X")).not.toBe(hashOf("X = [1, 2,]\n", "X"));
  });

  it("LG8: the text inside a string with an escape sequence is part of the form", () => {
    expect(hashOf('X = "a\\nb"\n', "X")).not.toBe(hashOf('X = "c\\nd"\n', "X"));
    expect(hashOf('X = " \\n "\n', "X")).not.toBe(hashOf('X = "  \\n  "\n', "X"));
  });

  it("LG8: the canonical form is {type, children} and {type, text}, without positions", () => {
    const info = py("X = 1\n");
    expect(info.entities[0]!.canonical).toBe(
      '{"exports":[],"nodes":[{"children":[{"children":[{"text":"X","type":"identifier"},{"text":"=","type":"="},{"text":"1","type":"integer"}],"type":"assignment"}],"type":"expression_statement"}]}',
    );
  });
});
