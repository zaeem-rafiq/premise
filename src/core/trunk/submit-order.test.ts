import { describe, expect, it } from "vitest";
import { changedPaths } from "./submit.ts";

describe("changed paths", () => {
  it("orders added, removed and modified files independently of map insertion order", () => {
    const before: [string, string][] = [
      ["z-removed.js", "removed"],
      ["_modified.js", "before"],
      ["unchanged.js", "same"],
      ["B-removed.js", "removed"],
    ];
    const after: [string, string][] = [
      ["z-added.js", "added"],
      ["unchanged.js", "same"],
      ["_modified.js", "after"],
      ["A-added.js", "added"],
    ];
    const expected = ["A-added.js", "B-removed.js", "_modified.js", "z-added.js", "z-removed.js"];

    expect(changedPaths(new Map(before), new Map(after))).toEqual(expected);
    expect(changedPaths(new Map([...before].reverse()), new Map([...after].reverse()))).toEqual(expected);
  });
});
