// PM3a's three-way merge (01-core.md 11.7) against real git (BP1). Every case states its expected
// result, worked by hand from git's documented merge behaviour: a change of one side is taken; changes
// of both sides that overlap or touch conflict unless they are the same; a file added by both sides
// with different contents, or removed by one and changed by the other, conflicts. Each case then
// checks that `git merge-file -p` on the same three versions agrees, so the hand-worked value and
// git's own answer both hold. A generated set over the tide pool's source lines checks the rest.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createScratchRepo } from "../../../test/support/git.ts";
import { diffLines, mergeFile, splitLines, type Content } from "./merge3.ts";

const repo = createScratchRepo("premise-merge3-");
afterAll(() => repo.remove());

/** `git merge-file -p ours base theirs`: the merged text, or null when git reports a conflict. */
function gitMerge(base: string, ours: string, theirs: string): string | null {
  writeFileSync(join(repo.directory, "base"), base);
  writeFileSync(join(repo.directory, "ours"), ours);
  writeFileSync(join(repo.directory, "theirs"), theirs);
  const r = spawnSync("git", ["merge-file", "-p", "ours", "base", "theirs"], {
    cwd: repo.directory,
    env: repo.env,
    encoding: "utf8",
  });
  if (r.error) throw r.error;
  if (r.status === null || r.status < 0) throw new Error(`git merge-file failed: ${r.stderr}`);
  return r.status === 0 ? r.stdout : null;
}

const L = (...lines: string[]): string => lines.map((l) => `${l}\n`).join("");

/** The hand-worked expectation, then git's agreement on the same three versions. */
function expectMerge(base: string, ours: string, theirs: string, expected: string | null): void {
  const mine = mergeFile(base, ours, theirs);
  expect(mine.ok ? mine.content : null).toBe(expected);
  expect(gitMerge(base, ours, theirs)).toBe(expected);
}

describe("PM3a: lines", () => {
  it("PM3a: a line ends with its \\n, a \\r belongs to the line, a last run without \\n is a line", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a\nb")).toEqual(["a\n", "b"]);
    expect(splitLines("a\r\nb\r\n")).toEqual(["a\r\n", "b\r\n"]);
    expect(splitLines("\n\n")).toEqual(["\n", "\n"]);
  });

  it("PM3a: a shortest edit script, each hunk over a half-open range of base lines", () => {
    expect(diffLines(["a\n", "b\n", "c\n"], ["a\n", "B\n", "c\n"])).toEqual([{ start: 1, end: 2, lines: ["B\n"] }]);
    expect(diffLines(["a\n", "c\n"], ["a\n", "b\n", "c\n"])).toEqual([{ start: 1, end: 1, lines: ["b\n"] }]);
    expect(diffLines(["a\n", "b\n", "c\n"], ["a\n", "c\n"])).toEqual([{ start: 1, end: 2, lines: [] }]);
    expect(diffLines([], [])).toEqual([]);
  });
});

describe("PM3a: clean merges", () => {
  it("PM3a: changes of the two sides in different places both land", () => {
    expectMerge(
      L("a", "b", "c", "d", "e"),
      L("a", "B", "c", "d", "e"),
      L("a", "b", "c", "D", "e"),
      L("a", "B", "c", "D", "e"),
    );
  });

  it("PM3a: a change of one side only is taken whole", () => {
    expectMerge(L("a", "b", "c"), L("a", "b", "c"), L("a", "x", "y", "c"), L("a", "x", "y", "c"));
    expectMerge(L("a", "b", "c"), L("x", "b", "c", "d"), L("a", "b", "c"), L("x", "b", "c", "d"));
  });

  it("PM3a: the same change made by both sides is taken once", () => {
    expectMerge(L("a", "b", "c"), L("a", "B", "c"), L("a", "B", "c"), L("a", "B", "c"));
  });

  it("PM3a: an insertion and a deletion one line apart both land", () => {
    expectMerge(
      L("a", "b", "c", "d", "e"),
      L("new", "a", "b", "c", "d", "e"),
      L("a", "b", "c", "e"),
      L("new", "a", "b", "c", "e"),
    );
  });

  it("PM3a: lines deleted by one side and kept by the other are deleted", () => {
    expectMerge(
      L("a", "b", "c", "d", "e", "f"),
      L("a", "d", "e", "f"),
      L("a", "b", "c", "d", "e", "F"),
      L("a", "d", "e", "F"),
    );
  });

  it("PM3a: a whole-file rewrite merges cleanly when the other side left the file alone", () => {
    expectMerge(L("a", "b", "c"), L("a", "b", "c"), L("x", "y"), L("x", "y"));
  });

  it("PM3a: CRLF lines keep their line ends through a clean merge", () => {
    const base = "a\r\nb\r\nc\r\nd\r\n";
    expectMerge(base, "A\r\nb\r\nc\r\nd\r\n", "a\r\nb\r\nc\r\nD\r\n", "A\r\nb\r\nc\r\nD\r\n");
  });
});

describe("PM3a: text conflicts", () => {
  it("PM3a: both sides change the same line differently", () => {
    expectMerge(L("a", "b", "c"), L("a", "ours", "c"), L("a", "theirs", "c"), null);
  });

  it("PM3a: changes of the two sides on adjacent lines touch, so they conflict", () => {
    expectMerge(L("a", "b", "c", "d"), L("a", "B", "c", "d"), L("a", "b", "C", "d"), null);
  });

  it("PM3a: two different insertions at one place conflict", () => {
    expectMerge(L("a", "b"), L("a", "x", "b"), L("a", "y", "b"), null);
  });

  it("PM3a: a deletion overlapping the other side's change conflicts", () => {
    expectMerge(L("a", "b", "c", "d"), L("a", "d"), L("a", "b", "C", "d"), null);
  });

  it("PM3a: a whole-file rewrite against a change of the other side conflicts", () => {
    expectMerge(L("a", "b", "c"), L("a", "B", "c"), L("x", "y", "z"), null);
  });

  it("PM3a: a line-end change of every line against a change of one line conflicts", () => {
    expectMerge(L("a", "b", "c"), "a\r\nb\r\nc\r\n", L("a", "B", "c"), null);
  });

  it("PM3a: the last line without \\n is a line: adding after it touches a change before it", () => {
    expectMerge("a\nb", "a\nb\nc", "A\nb", null);
  });
});

describe("PM3a: whole files", () => {
  /** The whole-file rules have no line merge to run: the expectation is the rule's own text. */
  const file = (base: Content, ours: Content, theirs: Content) => mergeFile(base, ours, theirs);

  it("PM3a: both sides add the same path with different contents (add/add)", () => {
    expect(file(null, L("crab", "one"), L("crab", "two"))).toEqual({ ok: false, kind: "add_add" });
    // git merge-file over an empty base agrees: the two additions overlap.
    expect(gitMerge("", L("crab", "one"), L("crab", "two"))).toBeNull();
  });

  it("PM3a: both sides add the same path with the same contents", () => {
    expect(file(null, L("crab"), L("crab"))).toEqual({ ok: true, content: L("crab") });
  });

  it("PM3a: one side adds a path the other never had", () => {
    expect(file(null, null, L("crab"))).toEqual({ ok: true, content: L("crab") });
    expect(file(null, L("crab"), null)).toEqual({ ok: true, content: L("crab") });
  });

  it("PM3a: one side removes the path and the other changed it (modify/delete)", () => {
    expect(file(L("a", "b"), null, L("a", "B"))).toEqual({ ok: false, kind: "modify_delete" });
    expect(file(L("a", "b"), L("a", "B"), null)).toEqual({ ok: false, kind: "modify_delete" });
  });

  it("PM3a: one side removes the path and the other left it alone", () => {
    expect(file(L("a", "b"), null, L("a", "b"))).toEqual({ ok: true, content: null });
    expect(file(L("a", "b"), L("a", "b"), null)).toEqual({ ok: true, content: null });
  });
});

describe("PM3a: generated merges over the tide pool's source lines agree with git merge-file", () => {
  // A fixed generator (mulberry32): the same cases on every run. The lines are those of the tide
  // pool's world modules, so the files look like the ones agents edit.
  const source = ["bounds", "energy", "food", "movement", "rules", "scene", "spawning", "time"]
    .flatMap((name) =>
      splitLines(readFileSync(new URL(`../../../seeds/tidepool/world/${name}.js`, import.meta.url), "utf8")),
    )
    .filter((line) => line.endsWith("\n"));

  function generator(seed: number): () => number {
    let s = seed | 0;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("PM3a: 300 generated three-version cases give git's result, conflicts included", { timeout: 120_000 }, () => {
    const next = generator(20261010);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
    const edit = (lines: readonly string[]): string[] => {
      const out = [...lines];
      const edits = 1 + Math.floor(next() * 4);
      for (let k = 0; k < edits; k++) {
        const at = Math.floor(next() * (out.length + 1));
        const r = next();
        if (r < 0.3 && out.length > 0) out.splice(Math.min(at, out.length - 1), 1 + Math.floor(next() * 3));
        else if (r < 0.6) out.splice(at, 0, pick(source));
        else if (out.length > 0) out[Math.min(at, out.length - 1)] = pick(source);
      }
      return out;
    };
    let conflicts = 0;
    for (let n = 0; n < 300; n++) {
      const start = Math.floor(next() * (source.length - 40));
      const base = source.slice(start, start + 10 + Math.floor(next() * 30));
      const b = base.join("");
      const o = edit(base).join("");
      const t = edit(base).join("");
      const expected = gitMerge(b, o, t);
      if (expected === null) conflicts++;
      const mine = mergeFile(b, o, t);
      expect({ n, result: mine.ok ? mine.content : null }).toEqual({ n, result: expected });
    }
    // The set exercises both outcomes.
    expect(conflicts).toBeGreaterThan(30);
    expect(conflicts).toBeLessThan(270);
  });
});
