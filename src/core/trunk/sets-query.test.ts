import { describe, expect, it } from "vitest";
import { keyHash, textCounts } from "./sets.ts";

describe("cached text query regions (2.6 / EN6)", () => {
  const files = new Map([
    ["code.js", 'export const word = "aaaa";\n'],
    ["nested/note.txt", "aaaaa"],
    ["nested/broken.js", "??? aaaa"],
  ]);

  it.each([
    { scope: "/", members: ["code.js#word*2", "nested/broken.js*2", "nested/note.txt*3"] },
    { scope: "nested/", members: ["nested/broken.js*2", "nested/note.txt*3"] },
    { scope: "code.js", members: ["code.js#word*2"] },
  ])("counts overlapping matches in modules and opaque files under $scope", ({ scope, members }) => {
    expect(keyHash(files, "query", `text:${scope}:aaa`).members).toEqual(members);
    expect([...textCounts(files, scope, "aaa")].map(([key, count]) => `${key}*${count}`).sort()).toEqual(members);
  });

  it("keeps an empty needle and an absent scope empty", () => {
    expect(keyHash(files, "query", "text:/:").members).toEqual([]);
    expect(keyHash(files, "query", "text:missing/:aaa").members).toEqual([]);
  });
});
