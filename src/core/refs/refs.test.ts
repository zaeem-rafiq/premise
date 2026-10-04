// The derived references of 01-core.md 6.1-6.3: the worked example of 6.2 (the creatures/fish.js
// table), the `refs:` members of 2.5 (H15 end to end), specifiers, re-export hops and negative
// lookups (D1). Expected values come from the specification text and docs/spec/premise-cases.json.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../test/support/source.ts";
import { REEXPORT_DEPTH } from "../../protocol/constants.ts";
import { membersHash } from "../keys/members.ts";
import { analyse, referencesIn, referrersOf, refsMembers, resolveSpecifier } from "./refs.ts";

type VectorFile = {
  hash_cases: Array<Record<string, unknown>>;
  pools: { tidepool: { files: Record<string, string> } };
};

const vectors = JSON.parse(readFileSync(join(REPO_ROOT, "docs/spec/premise-cases.json"), "utf8")) as VectorFile;
const pool = vectors.pools.tidepool.files;
const tree = new Map(Object.entries(pool));

describe("module specifiers (6.1)", () => {
  it("a relative specifier resolves on the importing module's directory", () => {
    expect(resolveSpecifier("creatures/fish.js", "../world/energy.js")).toBe("world/energy.js");
    expect(resolveSpecifier("creatures/fish.js", "./snail.js")).toBe("creatures/snail.js");
    expect(resolveSpecifier("a/b/c.js", ".././x.js")).toBe("a/x.js");
  });

  it("a specifier that escapes the root or is not a path resolves to null", () => {
    expect(resolveSpecifier("main.js", "../x.js")).toBeNull();
    expect(resolveSpecifier("a/b.js", "../../x.js")).toBeNull();
    expect(resolveSpecifier("a/b.js", "../a/../x.js")).toBe("x.js");
    expect(resolveSpecifier("a.js", "./x y.js")).toBeNull();
  });

  it("a bare or URL specifier resolves to null (CK5 banned_import territory)", () => {
    expect(resolveSpecifier("a.js", "lib")).toBeNull();
    expect(resolveSpecifier("a.js", "https://x.test/m.js")).toBeNull();
  });
});

describe("the worked example of 6.2: the creatures/fish.js table", () => {
  it("R(E) of the vector pool is exactly the table of 6.2", () => {
    // 01-core.md 6.2 lists this table for the vector pool; premise-cases.json pools.tidepool holds it.
    const analysis = analyse(tree);
    const expected = new Map([
      ["creatures/fish.js#(import ../world/energy.js)", ["world/energy.js#ENERGY_MAX", "world/energy.js#drain"]],
      ["creatures/fish.js#(import ../world/movement.js)", ["world/movement.js#step"]],
      ["creatures/fish.js#spawn", ["world/energy.js#ENERGY_MAX"]],
      ["creatures/fish.js#update", ["world/energy.js#drain", "world/movement.js#step"]],
    ]);
    for (const [from, keys] of expected) {
      expect([...(analysis.refs.get(from) ?? [])].sort(), from).toEqual(keys);
    }
  });

  it("the free globals of the pool (G of 6.2): only Math, in energy.js#drain", () => {
    const analysis = analyse(tree);
    const used = [...analysis.globals.entries()].filter(([, names]) => names.size > 0);
    expect(used).toEqual([["world/energy.js#drain", new Set(["Math"])]]);
  });

  it("H15 (2.5): refs:world/energy.js#ENERGY_MAX has the six members, hash ff47aaea...", () => {
    // 01-core.md 2.5: four referrer keys plus the module entries of fish.js and snail.js.
    const analysis = analyse(tree);
    const members = refsMembers("world/energy.js#ENERGY_MAX", analysis);
    const entry = vectors.hash_cases.find((item) => item.id === "H15");
    expect(members).toEqual([...(entry?.members as string[])].sort());
    expect(membersHash(members)).toBe("ff47aaea471d570878c4fe52260ff79a");
    expect(referrersOf("world/energy.js#ENERGY_MAX", analysis.refs)).toEqual([
      "creatures/fish.js#(import ../world/energy.js)",
      "creatures/fish.js#spawn",
      "creatures/snail.js#(import ../world/energy.js)",
      "creatures/snail.js#spawn",
    ]);
  });

  it("a whole-module reference makes every entity of the module a referrer target", () => {
    const files = new Map([
      ["a.js", 'import * as ns from "./m.js";\nexport function f() { return ns.x + ns; }\n'],
      ["m.js", "export const x = 1;\nexport const y = 2;\n"],
    ]);
    const analysis = analyse(files);
    // `ns.x` names `x`; `ns` alone references the whole module `m.js`.
    expect([...analysis.refs.get("a.js#f")!].sort()).toEqual(["m.js", "m.js#x"]);
    // R of the namespace import entity holds the module path too: it is a referrer (2.5).
    expect(referrersOf("m.js#x", analysis.refs)).toEqual(["a.js#(import ./m.js)", "a.js#f"]);
    expect(referrersOf("m.js#y", analysis.refs)).toEqual(["a.js#(import ./m.js)", "a.js#f"]);
  });
});

describe("re-export hops and negative lookups (6.2, D1)", () => {
  const files = new Map([
    ["a.js", 'export { x } from "./b.js";\nexport * from "./c.js";\nexport * from "./d.js";\n'],
    ["b.js", 'export { y as x } from "./c.js";\n'],
    ["c.js", "export const y = 1;\nexport const z = 2;\n"],
    ["d.js", "export const z = 3;\n"],
    ["user.js", 'import { x, z } from "./a.js";\nexport function f() { return x + z; }\n'],
  ]);
  const analysis = analyse(files);

  it("a re-export hop contributes the hop key and the result", () => {
    // user.js#import -> a.js#x (the hop) -> b.js#x (hop) -> c.js#y
    expect([...analysis.refs.get("user.js#(import ./a.js)")!].sort()).toEqual([
      "a.js#*./c.js",
      "a.js#x",
      "b.js#x",
      "c.js#y",
      "c.js#z",
    ]);
  });

  it("export * resolves through the module's own export names first", () => {
    expect(analysis.refs.get("user.js#f")).toEqual(new Set(["a.js#*./c.js", "a.js#x", "b.js#x", "c.js#y", "c.js#z"]));
    expect(analysis.unresolved).toEqual([]);
  });

  it("a resolved star contributes T#x as a negative lookup (D1)", () => {
    expect(analysis.negatives.get("user.js#(import ./a.js)")).toEqual(new Set(["a.js#z"]));
  });

  it("an export name nothing resolves is an unresolved reference", () => {
    const broken = analyse(
      new Map([
        ["u.js", 'import { nope } from "./c.js";\n'],
        ["c.js", "export const y = 1;\n"],
      ]),
    );
    expect(broken.unresolved).toEqual([{ from: "u.js#(import ./c.js)", to: "c.js#nope" }]);
  });

  it("a re-export cycle stops: the seen set ends it", () => {
    const cycle = analyse(
      new Map([
        ["a.js", 'export * from "./b.js";\nexport const a = 1;\n'],
        ["b.js", 'export * from "./a.js";\nexport const b = 2;\n'],
        ["u.js", 'import { q } from "./a.js";\n'],
      ]),
    );
    // q exists nowhere: every star tried, nothing crashes. A negative lookup is recorded only
    // on the way to a result (6.2), and q has none, so there are no negatives.
    expect(cycle.unresolved).toEqual([{ from: "u.js#(import ./a.js)", to: "a.js#q" }]);
    expect([...cycle.negatives.get("u.js#(import ./a.js)")!].sort()).toEqual([]);
  });

  it("a chain deeper than REEXPORT_DEPTH is unresolved", () => {
    const chain = new Map<string, string>();
    for (let index = 0; index <= REEXPORT_DEPTH + 1; index += 1) {
      chain.set(`m${index}.js`, `export { x } from "./m${index + 1}.js";\n`);
    }
    chain.set(`m${REEXPORT_DEPTH + 1}.js`, "export const x = 1;\n");
    chain.set("u.js", 'import { x } from "./m0.js";\n');
    const deep = analyse(chain);
    expect(deep.unresolved).toEqual([{ from: "u.js#(import ./m0.js)", to: "m0.js#x" }]);
    // One hop shorter resolves.
    const shallow = new Map(chain);
    shallow.set("u.js", 'import { x } from "./m1.js";\n');
    expect([...analyse(shallow).refs.get("u.js#(import ./m1.js)")!].sort().at(-1)).toBe(`m${REEXPORT_DEPTH + 1}.js#x`);
  });
});

describe("reference position (6.3)", () => {
  const analyse1 = (source: string) => analyse(new Map([["m.js", source]]));

  it("a namespace member resolves by name; ns[...] references the whole module", () => {
    const files = new Map([
      ["u.js", 'import * as ns from "./m.js";\nexport function f() { return ns.a + ns["b"]; }\n'],
      ["m.js", "export const a = 1;\nexport const b = 2;\n"],
    ]);
    const analysis = analyse(files);
    expect([...analysis.refs.get("u.js#f")!].sort()).toEqual(["m.js", "m.js#a"]);
  });

  it("a dynamic import with a string literal references the module", () => {
    const files = new Map([
      ["u.js", 'export function f() { return import("./lazy.js"); }\n'],
      ["lazy.js", "export const x = 1;\n"],
    ]);
    const analysis = analyse(files);
    expect(analysis.refs.get("u.js#f")).toEqual(new Set(["lazy.js"]));
  });

  it("locally bound names are not references: params, vars, lets, catch, shadowing", () => {
    const source = `export function f(a, b) {
  const c = a + b;
  var d = c;
  { let e = d; }
  try { d(); } catch (g) { g.h; }
  for (let i = 0; i < d; i += 1) { d; }
  for (const j of [d]) { j; }
  const [k, { l }] = [d, { l: d }];
  return () => a + c + d;
}
`;
    const analysis = analyse1(source);
    expect(analysis.globals.get("m.js#f")).toEqual(new Set());
    expect(analysis.refs.get("m.js#f")).toEqual(new Set());
  });

  it("arguments binds inside a non-arrow function but not inside an arrow (6.3)", () => {
    const source = "export function f() { const g = () => arguments; return arguments; }\n";
    const analysis = analyse1(source);
    // `arguments` in the arrow resolves outward to f's binding; the one in f is bound too.
    expect(analysis.globals.get("m.js#f")).toEqual(new Set());
    const arrow = analyse1("export const f = () => arguments;\n");
    expect(arrow.globals.get("m.js#f")).toEqual(new Set(["arguments"]));
  });

  it("object keys and member names are not references; shorthand and computed are", () => {
    const source = "export function f(a) { return { k: a, [a]: 1, a }.x[a]; }\n";
    const analysis = analyse1(source);
    expect(analysis.globals.get("m.js#f")).toEqual(new Set());
    const { names } = referencesIn([]);
    expect(names).toEqual([]);
  });

  it("an entity never refers to itself; a sibling is a reference", () => {
    const source =
      "function g() { return h(); }\nfunction h() { return 1; }\nexport function f() { return g() + f.length; }\n";
    const analysis = analyse1(source);
    expect(analysis.refs.get("m.js#f")).toEqual(new Set(["m.js#g"]));
    expect(analysis.refs.get("m.js#g")).toEqual(new Set(["m.js#h"]));
  });

  it("a destructuring declaration binds every pattern name, none is a reference", () => {
    const source =
      "const obj = { x: 1, y: 2 };\nconst { x, y: z = obj.x } = obj;\nconst [w = obj.y] = [] ;\nexport function f() { return z + w; }\n";
    const analysis = analyse1(source);
    // `x`'s nodes hold the whole declarator; its pattern binds x and z, reads only obj and obj.x.
    expect(analysis.refs.get("m.js#x")).toEqual(new Set(["m.js#obj"]));
    expect(analysis.refs.get("m.js#z")).toEqual(new Set(["m.js#obj"]));
    expect(analysis.refs.get("m.js#w")).toEqual(new Set(["m.js#obj"]));
    expect(analysis.globals.get("m.js#x")).toEqual(new Set());
    expect(analysis.refs.get("m.js#f")).toEqual(new Set(["m.js#w", "m.js#z"]));
  });

  it("a var hoisted inside a nested block is bound everywhere in the function", () => {
    const source = "export function f(c) {\n  if (c) { { var x = 1; } }\n  return x;\n}\n";
    const analysis = analyse1(source);
    expect(analysis.globals.get("m.js#f")).toEqual(new Set());
    expect(analysis.refs.get("m.js#f")).toEqual(new Set());
  });

  it("the left side of an assignment is a reference, including patterns (6.3)", () => {
    const source =
      "export function f() {\n  let a, arr;\n  [a, arr[0]] = [1, 2];\n  ({ p: b } = { p: a });\n  return a + b;\n}\n";
    const analysis = analyse1(source);
    // `a`, `arr` and `b` on the left are references: `a`, `arr`, `b` are bound, `b` is a global.
    expect(analysis.refs.get("m.js#f")).toEqual(new Set());
    expect(analysis.globals.get("m.js#f")).toEqual(new Set(["b"]));
  });

  it("a function declaration inside a block binds in the block, not outside it", () => {
    const source =
      "export function f(c) {\n  if (c) {\n    function g() { return 1; }\n    return g();\n  }\n  return g();\n}\n";
    const analysis = analyse1(source);
    // `g()` inside the block resolves to the block's g; `g()` after it sees nothing.
    expect(analysis.refs.get("m.js#f")).toEqual(new Set());
    expect(analysis.globals.get("m.js#f")).toEqual(new Set(["g"]));
  });

  it("a named function expression binds its own name; a class binds its name inside", () => {
    const source =
      "const g = function inner() { return inner === g; };\nconst C = class { m() { return C; } };\nexport { g, C };\n";
    const analysis = analyse1(source);
    expect(analysis.refs.get("m.js#g")).toEqual(new Set()); // `inner` binds inside itself
    expect(analysis.refs.get("m.js#C")).toEqual(new Set()); // `C` binds in class scope
    expect(analysis.globals.get("m.js#C")).toEqual(new Set());
  });

  it("labels, break and continue are not references", () => {
    const source =
      "export function f(list) {\n  outer: for (const item of list) {\n    inner: for (const x of item) {\n      if (x) break outer;\n      continue inner;\n    }\n  }\n}\n";
    const analysis = analyse1(source);
    expect(analysis.globals.get("m.js#f")).toEqual(new Set());
    expect(analysis.refs.get("m.js#f")).toEqual(new Set());
  });

  it("a for-of on an existing name or member references it", () => {
    const source =
      "const store = { a: [] };\nexport function f(items) {\n  for (store.a of items) { store.a; }\n  for (g of items) { g; }\n}\n";
    const analysis = analyse1(source);
    expect(analysis.refs.get("m.js#f")).toEqual(new Set(["m.js#store"]));
    expect(analysis.globals.get("m.js#f")).toEqual(new Set(["g"]));
  });

  it("class fields and methods: names and non-computed keys are not references", () => {
    const source =
      "const BASE = 1;\nclass C extends BASE {\n  static s = BASE;\n  #p = BASE;\n  m() { return BASE + this.#p; }\n}\nexport { C };\n";
    const analysis = analyse1(source);
    expect(analysis.refs.get("m.js#C")).toEqual(new Set(["m.js#BASE"]));
    expect(analysis.globals.get("m.js#C")).toEqual(new Set());
  });

  it("a switch's case tests see the names bound in its cases", () => {
    const source =
      "export function f(a) {\n  switch (a) {\n    case 1: let y = 2; return y;\n    case y: return 1;\n  }\n}\n";
    const analysis = analyse1(source);
    // `case y` reads the switch-scope `y` (TDZ in real code, bound for the table).
    expect(analysis.globals.get("m.js#f")).toEqual(new Set());
  });

  it("a top-level statement's free name resolves at module level ((top) refers)", () => {
    const source = "const a = 1;\nfoo(a);\n";
    const analysis = analyse1(source);
    expect(analysis.refs.get("m.js#(top)")).toEqual(new Set(["m.js#a"]));
    expect(analysis.globals.get("m.js#(top)")).toEqual(new Set(["foo"]));
  });

  it("a bare specifier is a banned import, a missing module an unresolved one", () => {
    const files = new Map([["u.js", 'import a from "lib";\nimport { b } from "./nope.js";\n']]);
    const analysis = analyse(files);
    expect(analysis.banned).toEqual([{ from: "u.js#(import lib)", specifier: "lib" }]);
    expect(analysis.unresolved).toEqual([{ from: "u.js#(import ./nope.js)", to: "nope.js#b" }]);
  });

  it("an opaque module exports nothing and keeps no table (2.1)", () => {
    const files = new Map([
      ["broken.js", "export const {"],
      ["u.js", 'import { x } from "./broken.js";\n'],
    ]);
    const analysis = analyse(files);
    expect(analysis.modules.has("broken.js")).toBe(false);
    expect(analysis.unresolved).toEqual([{ from: "u.js#(import ./broken.js)", to: "broken.js#x" }]);
  });
});
