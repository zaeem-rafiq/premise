import { describe, expect, it } from "vitest";
import { searchScope } from "./tools-edit.ts";

// 4.6 `search` scopes as models write them (amended 2026-10-11): each names what the model meant.
describe("searchScope", () => {
  it.each([
    ["creatures/", "creatures/"],
    ["./creatures/", "creatures/"],
    ["/creatures/", "creatures/"],
    ["creatures/*", "creatures/"],
    ["creatures/**", "creatures/"],
    ["creatures/*.js", "creatures/"],
    ["creatures/**/*", "creatures/"],
    ["world/energy.js", "world/energy.js"],
    ["./world/energy.js", "world/energy.js"],
    ["/", "/"],
    ["", "/"],
    [".", "/"],
    ["*", "/"],
    ["*.js", "/"],
  ])("%j -> %j", (raw, want) => {
    expect(searchScope(raw)).toBe(want);
  });
});
