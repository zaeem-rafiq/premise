// The entities of 01-core.md 2.3 and the entity hash of 2.4, proved by the H01-H12 and H21-H23
// vectors of docs/spec/premise-cases.json and by the worked examples of 2.4, 2.7 and KH1.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../test/support/source.ts";
import {
  entityLines,
  entitySignature,
  entitySource,
  moduleHash,
  outlineLines,
  parseModule,
  regionTargets,
} from "./entities.ts";
import { membersHash } from "../keys/members.ts";

type HashCase =
  | { id: string; kind: "canonical"; source: string; entity: string; canonical: string; hash: string }
  | { id: string; kind: "entity"; entity: string; equal: boolean; a: string; b: string }
  | { id: string; kind: "members"; members: string[]; hash: string }
  | { id: string; kind: "blob"; content: string; hash: string };

type VectorFile = { hash_cases: HashCase[]; pools: { tidepool: { files: Record<string, string> } } };

const vectors = JSON.parse(readFileSync(join(REPO_ROOT, "docs/spec/premise-cases.json"), "utf8")) as VectorFile;
const cases = new Map(vectors.hash_cases.map((entry) => [entry.id, entry]));
const pool = vectors.pools.tidepool.files;

const hashOf = (source: string, name: string): string => {
  const entity = parseModule(source).entities.find((entry) => entry.name === name);
  if (entity === undefined) throw new Error(`no entity ${name}`);
  return entity.hash;
};

describe("the entity hash of 2.4", () => {
  for (const id of ["H01", "H02", "H03", "H21"]) {
    const entry = cases.get(id);
    if (entry === undefined || entry.kind !== "canonical") throw new Error(`missing vector ${id}`);
    it(`${id} (${entry.id}): the canonical form and hash of ${entry.entity}`, () => {
      const entity = parseModule(entry.source).entities.find((item) => item.name === entry.entity);
      expect(entity?.canonical).toBe(entry.canonical);
      expect(entity?.hash).toBe(entry.hash);
    });
  }

  for (const id of ["H04", "H05", "H06", "H07", "H08", "H09", "H10", "H11", "H12", "H22", "H23"]) {
    const entry = cases.get(id);
    if (entry === undefined || entry.kind !== "entity") throw new Error(`missing vector ${id}`);
    it(`${id} (${entry.id}): entity ${entry.entity} ${entry.equal ? "equals" : "differs"}`, () => {
      const a = hashOf(entry.a, entry.entity);
      const b = hashOf(entry.b, entry.entity);
      if (entry.equal) expect(b).toBe(a);
      else expect(b).not.toBe(a);
    });
  }

  it("2.4 worked example: world/energy.js#ENERGY_MAX hashes to 5149f012fe7cd2dfd8820a214ea41ff0", () => {
    // 01-core.md 2.4 walks this declaration and reports the hash 5149f012fe7cd2dfd8820a214ea41ff0.
    expect(hashOf("export const ENERGY_MAX = 100;\n", "ENERGY_MAX")).toBe("5149f012fe7cd2dfd8820a214ea41ff0");
  });
});

describe("the statements and entities of 2.3", () => {
  it("a module with no statements has exactly the entity (top), with no nodes (EN5)", () => {
    const info = parseModule("");
    expect(info.entities).toHaveLength(1);
    expect(info.entities[0]).toMatchObject({ name: "(top)", kind: "top", nodes: [], exports: [] });
  });

  it("import forms the entity (import <spec>) of kind import", () => {
    const info = parseModule('import { a } from "./m.js";\nimport * as ns from "./n.js";\n');
    expect(info.entities.map((entity) => entity.name)).toEqual(["(import ./m.js)", "(import ./n.js)"]);
    expect(info.entities.every((entity) => entity.kind === "import")).toBe(true);
  });

  it("re-export forms and names of 2.3", () => {
    const info = parseModule(
      'export { a as b } from "./m.js";\nexport * as ns from "./n.js";\nexport * from "./o.js";\n',
    );
    expect(info.entities.map((entity) => `${entity.name}:${entity.kind}`)).toEqual([
      "b:reexport",
      "ns:reexport",
      "*./o.js:reexport-all",
    ]);
  });

  it("export default forms of 2.3", () => {
    expect(parseModule("export default 42;\n").entities.map((entity) => `${entity.name}:${entity.kind}`)).toEqual([
      "default:value",
    ]);
    expect(
      parseModule("export default function run() {}\n").entities.map((entity) => `${entity.name}:${entity.kind}`),
    ).toEqual(["run:function"]);
    expect(
      parseModule("export default function () {}\n").entities.map((entity) => `${entity.name}:${entity.kind}`),
    ).toEqual(["default:function"]);
  });

  it("export { a, b as c } adds export names to existing entities (H08 shape)", () => {
    const info = parseModule("const a = 1, b = 2;\nexport { a, b as c };\n");
    const a = info.entities.find((entity) => entity.name === "a");
    const b = info.entities.find((entity) => entity.name === "b");
    expect(a?.exports).toEqual(["a"]);
    expect(b?.exports).toEqual(["c"]); // `b as c` adds the name `c`, not `b` (2.3)
  });

  it("an export of an import binding is the re-export of 2.3", () => {
    const info = parseModule('import { a } from "./m.js";\nexport { a as b };\n');
    const entity = info.entities.find((entry) => entry.name === "b");
    expect(entity?.kind).toBe("reexport");
    expect(entity?.nodes[0]).toMatchObject({ type: "ReExport", source: "./m.js", imported: "a" });
  });

  it("var a; var a; merges into one entity (2.3)", () => {
    const info = parseModule("var a = 1;\nvar a = 2;\n");
    expect(info.entities.filter((entity) => entity.name === "a")).toHaveLength(1);
    expect(info.entities[0]?.nodes).toHaveLength(2);
  });
});

describe("regions, sources and lines (EN6, EN7, 4.3, 4.4)", () => {
  const energy = pool["world/energy.js"]!;

  it("EN6: every character of a module belongs to exactly one region", () => {
    const info = parseModule(energy);
    let cursor = 0;
    for (const region of info.regions) {
      expect(region.start).toBe(cursor);
      expect(region.end).toBeGreaterThanOrEqual(region.start);
      cursor = region.end;
    }
    expect(cursor).toBe(energy.length);
    for (let index = 0; index < energy.length; index += 1) {
      expect(regionTargets(info, index, index + 1).length).toBeGreaterThan(0);
    }
  });

  it("EN6: the targets of a span are the entities of every intersecting region", () => {
    const info = parseModule(energy);
    const comment = energy.indexOf("Remove energy");
    expect(regionTargets(info, comment, comment + 4)).toEqual(["drain"]);
    expect(regionTargets(info, 0, energy.indexOf("drain"))).toEqual(["ENERGY_MAX", "drain"]);
  });

  it("EN7: an entity's source is its regions' text with leading blank lines removed", () => {
    const info = parseModule(energy);
    // The `read` examples of 01-core.md 4.4 for world/energy.js.
    expect(entitySource(energy, info, "ENERGY_MAX")).toBe(
      "// Energy is counted in points, from 0 to ENERGY_MAX.\nexport const ENERGY_MAX = 100;",
    );
    expect(entitySource(energy, info, "drain")).toBe(
      "// Remove energy from a creature. `amount` is in points per tick.\nexport function drain(creature, amount) {\n  creature.energy = Math.max(0, creature.energy - amount);\n}\n",
    );
  });

  it("the line spans of 4.3 and 4.4: [1,2] for ENERGY_MAX, [4,7] for drain", () => {
    const info = parseModule(energy);
    expect(entityLines(energy, info, "ENERGY_MAX")).toEqual([1, 2]);
    expect(entityLines(energy, info, "drain")).toEqual([4, 7]);
  });

  it("the signatures of 4.3 for the energy module", () => {
    const info = parseModule(energy);
    expect(entitySignature(energy, info, "ENERGY_MAX")).toBe("export const ENERGY_MAX");
    expect(entitySignature(energy, info, "drain")).toBe("export function drain(creature, amount)");
  });
});

describe("outline lines (2.7) and the module hash (KH1)", () => {
  it("H16 (2.7): the outline lines of world/energy.js hash to b7d16f9836653b62fda3cc5d25d0ccea", () => {
    const info = parseModule(pool["world/energy.js"]!);
    expect(outlineLines(info)).toEqual(["ENERGY_MAX|const|ENERGY_MAX|", "drain|function|drain|2"]);
    expect(membersHash(outlineLines(info))).toBe("b7d16f9836653b62fda3cc5d25d0ccea");
  });

  it("H19 (2.5): the module hash of creatures/fish.js is 854043e6f224188840f8df611e97e6db", () => {
    const info = parseModule(pool["creatures/fish.js"]!);
    expect(moduleHash(info)).toBe("854043e6f224188840f8df611e97e6db");
  });

  it("H19 members: the sorted <name> <hash> strings of creatures/fish.js", () => {
    const entry = cases.get("H19");
    if (entry === undefined || entry.kind !== "members") throw new Error("missing H19");
    const info = parseModule(pool["creatures/fish.js"]!);
    const members = info.entities.map((entity) => `${entity.name} ${entity.hash}`).sort();
    expect(members).toEqual(entry.members);
  });
});
