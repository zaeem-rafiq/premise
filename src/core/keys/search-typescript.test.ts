// The language set threads into module detection for search containers; existing callers keep
// the tide-pool set, so a `.ts` path is opaque there exactly as before (LG1, 2.1).

import { describe, it } from "vitest";
import assert from "node:assert";
import { IMPORT_LANGUAGES } from "./paths.ts";
import { matchContainers, textMembers } from "./search.ts";

const source = "export interface I { a: string }\nexport const v: I = { a: 'x' };\n";

describe("matchContainers under a language set (LG1)", () => {
  it("a .ts path contributes entity containers under IMPORT_LANGUAGES", () => {
    const counts = matchContainers("m.ts", source, "a: string", IMPORT_LANGUAGES);
    assert.equal(counts.get("m.ts#I"), 1); // the needle's span sits inside the interface's region
  });

  it("a .ts path is opaque under the default tide-pool set: the file is its own container", () => {
    const counts = matchContainers("m.ts", source, "a");
    assert.deepEqual([...counts.keys()], ["m.ts"]);
    assert.ok(![...counts.keys()].some((key) => key.includes("#")));
  });

  it("an unparsable TypeScript module is opaque under IMPORT_LANGUAGES", () => {
    const counts = matchContainers("m.ts", "export const x: = 1;;;", "x", IMPORT_LANGUAGES);
    assert.deepEqual([...counts.keys()], ["m.ts"]);
  });
});

describe("textMembers under a language set", () => {
  it("finds members in .ts files only when the set includes them", () => {
    const tree = new Map([
      ["m.ts", source],
      ["n.js", "export const w = 1;\n"],
    ]);
    const imported = textMembers(tree, "/", "a: string", IMPORT_LANGUAGES);
    assert.ok(imported.some((member) => member.startsWith("m.ts#I*")));
    const tidepool = textMembers(tree, "/", "a: string");
    assert.ok(!tidepool.some((member) => member.startsWith("m.ts#I*")));
    assert.ok(tidepool.some((member) => member.startsWith("m.ts*"))); // opaque: the file itself
  });
});
