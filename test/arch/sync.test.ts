// docs/spec/04-build-plan.md 1.3, mechanism 3: no waits, no clock, no chance (SY1, SY2, FE2).
// The token list is the plan's. Expected results come from that list (BP1).

import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../support/source.ts";
import { findingsIn, findingsUnder, format } from "./sync-rules.ts";

/** The forbidden tokens found in a file of the engine with this source text. */
function tokens(text: string, file = "src/core/trunk/tick.ts"): string[] {
  return findingsIn(file, text).map((finding) => finding.token);
}

describe("no waits, no clock, no chance: the repository", () => {
  it("src/core/**, src/swarm/** and src/protocol/reducer/** hold none of the forbidden tokens", () => {
    expect(format(findingsUnder(REPO_ROOT))).toBe("");
  });
});

describe("no waits, no clock, no chance: each forbidden token is found", () => {
  it("async", () => {
    expect(tokens(`async function f() {}`)).toEqual(["async"]);
    expect(tokens(`const f = async () => 1;`)).toEqual(["async"]);
    expect(tokens(`const f = async function () {};`)).toEqual(["async"]);
    expect(tokens(`class C { async m() {} }`)).toEqual(["async"]);
    expect(tokens(`const o = { async m() {} };`)).toEqual(["async"]);
  });

  it("await", () => {
    expect(tokens(`const x = await y;`)).toEqual(["await"]);
    expect(tokens(`for await (const x of y) {}`)).toEqual(["await"]);
  });

  it("Promise", () => {
    expect(tokens(`const p = new Promise(() => {});`)).toEqual(["Promise"]);
    expect(tokens(`function f(): Promise<void> { return g(); }`)).toEqual(["Promise"]);
    expect(tokens(`const all = Promise.all([]);`)).toEqual(["Promise"]);
    expect(tokens(`type Later = Promise<number>;`)).toEqual(["Promise"]);
  });

  it(".then(", () => {
    expect(tokens(`x.then(() => 1);`)).toEqual([".then("]);
    expect(tokens(`x?.then(() => 1);`)).toEqual([".then("]);
    expect(tokens(`x["then"](() => 1);`)).toEqual([".then("]);
  });

  it("fetch(", () => {
    expect(tokens(`fetch("https://example.com");`)).toEqual(["fetch("]);
    expect(tokens(`globalThis.fetch("https://example.com");`)).toEqual(["fetch("]);
    expect(tokens(`env.ASSETS.fetch(request);`)).toEqual(["fetch("]);
  });

  it("crypto.subtle", () => {
    expect(tokens(`const s = crypto.subtle;`)).toEqual(["crypto.subtle"]);
    expect(tokens(`const s = globalThis.crypto.subtle;`)).toEqual(["crypto.subtle"]);
  });

  it("CompressionStream", () => {
    expect(tokens(`const c = new CompressionStream("deflate");`)).toEqual(["CompressionStream"]);
    expect(tokens(`const d = new DecompressionStream("deflate");`)).toEqual(["DecompressionStream"]);
  });

  it("setTimeout", () => {
    expect(tokens(`setTimeout(() => {}, 1);`)).toEqual(["setTimeout"]);
    expect(tokens(`const later = globalThis.setTimeout;`)).toEqual(["setTimeout"]);
  });

  it("Date.now(", () => {
    expect(tokens(`const t = Date.now();`)).toEqual(["Date.now("]);
    expect(tokens(`const t = Date["now"]();`)).toEqual(["Date.now("]);
  });

  it("new Date() with no argument", () => {
    expect(tokens(`const d = new Date();`)).toEqual(["new Date()"]);
    expect(tokens(`const d = new Date;`)).toEqual(["new Date()"]);
  });

  it("Math.random(", () => {
    expect(tokens(`const r = Math.random();`)).toEqual(["Math.random("]);
  });

  it("the rule holds in test files of these directories too", () => {
    expect(tokens(`it("lands", async () => {});`, "src/core/trunk/tick.test.ts")).toEqual(["async"]);
  });

  it("the rule holds in .tsx and .js files too", () => {
    expect(tokens(`const t = Date.now();`, "src/swarm/pattern.js")).toEqual(["Date.now("]);
  });
});

describe("no waits, no clock, no chance: what is not a finding", () => {
  it("time, ids and random numbers that arrive as arguments", () => {
    expect(
      tokens(`export function tick(now: number, nextId: () => string, random: () => number) { return now; }`),
    ).toEqual([]);
  });

  it("a date built from a given time", () => {
    expect(tokens(`const d = new Date(ts);`)).toEqual([]);
    expect(tokens(`const s = new Date(ts).toISOString();`)).toEqual([]);
  });

  it("a forbidden word in a comment or in a string", () => {
    expect(tokens(`// No Promise, no await: the engine is synchronous.\nexport const x = 1;`)).toEqual([]);
    expect(tokens(`export const note = "async await Promise fetch( setTimeout Date.now( Math.random(";`)).toEqual([]);
  });

  it("names that only contain a forbidden word", () => {
    expect(tokens(`const thenable = 1; prefetch(); const promised = 2; const mathRandom = 3;`)).toEqual([]);
    expect(tokens(`const m = Math.max(1, 2); const p = Date.parse("2026-10-04");`)).toEqual([]);
  });
});
