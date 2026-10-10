// References by name for Python and Go (06-repos.md LG4, LG9), through `analyse` under the imported
// language set. Expected references are worked by hand from LG9.

import { beforeAll, describe, expect, it } from "vitest";
import { installTreeSitter } from "../support/tree-sitter.ts";
import { analyse, refsMembers } from "../../src/core/refs/refs.ts";
import { IMPORT_LANGUAGES } from "../../src/core/keys/paths.ts";

beforeAll(installTreeSitter);

const refsOf = (files: Record<string, string>, key: string) =>
  [...(analyse(new Map(Object.entries(files)), IMPORT_LANGUAGES).refs.get(key) ?? new Set())].sort();

describe("LG9: Python references by name", () => {
  it("LG9: an identifier naming a definition of the same module is a reference, never to itself", () => {
    const files = { "m.py": "LIMIT = 3\n\ndef check(x):\n    return x < LIMIT and check(x - 1)\n" };
    expect(refsOf(files, "m.py#check")).toEqual(["m.py#LIMIT"]);
  });

  it("LG9: from m import n refers to n of m", () => {
    const files = {
      "pkg/consts.py": "LIMIT = 3\n",
      "app.py": "from pkg.consts import LIMIT\n\ndef run():\n    return LIMIT\n",
    };
    expect(refsOf(files, "app.py#run")).toEqual(["pkg/consts.py#LIMIT"]);
    // The import statement itself refers to what it imports.
    expect(refsOf(files, "app.py#(import pkg.consts)")).toEqual(["pkg/consts.py#LIMIT"]);
  });

  it("LG9: from m import n as a refers to n of m through a", () => {
    const files = {
      "consts.py": "LIMIT = 3\n",
      "app.py": "from consts import LIMIT as L\n\ndef run():\n    return L\n",
    };
    expect(refsOf(files, "app.py#run")).toEqual(["consts.py#LIMIT"]);
  });

  it("LG9: import m as a, then a.x, refers to x of m; a package resolves to its __init__.py", () => {
    const files = {
      "lib/__init__.py": "VERSION = 1\n",
      "lib/util.py": "def helper():\n    pass\n",
      "app.py": "import lib.util as u\nimport lib\n\ndef run():\n    return u.helper() + lib.VERSION\n",
    };
    expect(refsOf(files, "app.py#run")).toEqual(["lib/__init__.py#VERSION", "lib/util.py#helper"]);
  });

  it("LG9: a relative import resolves against the importing file's directory", () => {
    const files = {
      "pkg/a.py": "X = 1\n",
      "pkg/sub/b.py": "from ..a import X\nfrom . import c\n\ndef f():\n    return X + c.Y\n",
      "pkg/sub/c.py": "Y = 2\n",
    };
    expect(refsOf(files, "pkg/sub/b.py#f")).toEqual(["pkg/a.py#X", "pkg/sub/c.py#Y"]);
  });

  it("LG9: from p import n, where p defines no n but p/n.py exists, refers to that whole module", () => {
    const files = {
      "p/__init__.py": "",
      "p/n.py": "Z = 1\n",
      "app.py": "from p import n\n\ndef f():\n    return n\n",
    };
    expect(refsOf(files, "app.py#f")).toEqual(["p/n.py"]);
  });

  it("LG9: a name with two matches gives both; a name with none gives no reference", () => {
    const files = {
      "m.py": "X = 1\nX = 2\n\ndef f():\n    return X + unknown_name\n",
    };
    // EN4 merges both bindings of X into one entity, so both matches are the one key.
    expect(refsOf(files, "m.py#f")).toEqual(["m.py#X"]);
  });

  it("LG9: an external import gives no premise and no check failure", () => {
    const files = {
      "app.py": "import os\nfrom collections import deque\n\ndef f():\n    return os.path.join(deque())\n",
    };
    const analysis = analyse(new Map(Object.entries(files)), IMPORT_LANGUAGES);
    expect([...analysis.refs.get("app.py#f")!]).toEqual([]);
    expect(analysis.unresolved).toEqual([]);
    expect(analysis.banned).toEqual([]);
  });

  it("LG9: a refs: query lists the Python referrers", () => {
    const files = {
      "consts.py": "LIMIT = 3\n",
      "a.py": "from consts import LIMIT\n\ndef f():\n    return LIMIT\n",
    };
    const analysis = analyse(new Map(Object.entries(files)), IMPORT_LANGUAGES);
    const members = refsMembers("consts.py#LIMIT", analysis);
    expect(members.filter((member) => !member.includes("@"))).toEqual(["a.py#(import consts)", "a.py#f"]);
  });
});

describe("LG9: Go references by name", () => {
  const goMod = "module example.com/app\n\ngo 1.22\n";

  it("LG9: an identifier naming a definition of the same package, in any file of the directory, is a reference", () => {
    const files = {
      "go.mod": goMod,
      "store/limits.go": "package store\n\nconst Limit = 3\n",
      "store/check.go": "package store\n\nfunc Check(n int) bool { return n < Limit }\n",
    };
    expect(refsOf(files, "store/check.go#Check")).toEqual(["store/limits.go#Limit"]);
  });

  it("LG9: a Go import without an alias binds the imported package's own name", () => {
    const files = {
      "go.mod": goMod,
      "internal/limits/limits.go": "package limits\n\nconst Max = 3\n",
      "main.go": 'package main\n\nimport "example.com/app/internal/limits"\n\nfunc main() { _ = limits.Max }\n',
    };
    expect(refsOf(files, "main.go#main")).toEqual(["internal/limits/limits.go#Max"]);
  });

  it("LG9: a Go import with an alias binds the alias; x also refers to every method named x there", () => {
    const files = {
      "go.mod": goMod,
      "kv/kv.go":
        "package kv\n\ntype Store struct{}\n\nfunc (s *Store) Get() int { return 0 }\n\nfunc Get() int { return 1 }\n",
      "main.go": 'package main\n\nimport store "example.com/app/kv"\n\nfunc main() { _ = store.Get() }\n',
    };
    expect(refsOf(files, "main.go#main")).toEqual(["kv/kv.go#Get", "kv/kv.go#Store.Get"]);
  });

  it("LG9: a name with two matches in the package gives both", () => {
    const files = {
      "go.mod": goMod,
      "a/one.go": "package a\n\nvar Mode = 1\n",
      "a/two.go": "package a\n\nvar Mode = 2\n",
      "a/use.go": "package a\n\nfunc Use() int { return Mode }\n",
    };
    expect(refsOf(files, "a/use.go#Use")).toEqual(["a/one.go#Mode", "a/two.go#Mode"]);
  });

  it("LG9: a _test.go file of package <name>_test is its own package", () => {
    const files = {
      "go.mod": goMod,
      "a/a.go": "package a\n\nconst X = 1\n",
      "a/a_test.go": "package a_test\n\nconst Y = X\n",
    };
    expect(refsOf(files, "a/a_test.go#Y")).toEqual([]);
  });

  it("LG9: without a root go.mod every import is external", () => {
    const files = {
      "lib/lib.go": "package lib\n\nconst X = 1\n",
      "main.go": 'package main\n\nimport "example.com/app/lib"\n\nfunc main() { _ = lib.X }\n',
    };
    const analysis = analyse(new Map(Object.entries(files)), IMPORT_LANGUAGES);
    expect([...analysis.refs.get("main.go#main")!]).toEqual([]);
    expect(analysis.unresolved).toEqual([]);
  });

  it("LG9: an external import gives no premise and no check failure", () => {
    const files = { "go.mod": goMod, "main.go": 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println() }\n' };
    const analysis = analyse(new Map(Object.entries(files)), IMPORT_LANGUAGES);
    expect([...analysis.refs.get("main.go#main")!]).toEqual([]);
    expect(analysis.unresolved).toEqual([]);
    expect(analysis.banned).toEqual([]);
  });
});
