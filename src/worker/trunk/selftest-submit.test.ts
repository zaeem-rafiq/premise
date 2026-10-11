// CK6c's Worker half (01-core 4.9): head's run once per head commit, GR3d against it, and fail open
// when a run gives no answer. The runs are stand-ins that answer by tree; the mapping is the harness's.

import { describe, expect, it } from "vitest";
import type { SelftestCandidate } from "../../core/trunk/selftest.ts";
import { failClosed, mapAnswer, type Run } from "../adapters/verifier/harness/selftest.ts";
import { SubmitSelftest } from "./selftest-submit.ts";

const NAMES = [
  "files",
  "no_errors",
  "in_bounds",
  "energy_range",
  "population",
  "not_exhausted",
  "state_is_data",
  "pen_rules",
  "visible",
  "within_reach",
  "draw_is_pure",
  "deterministic",
];

/** A run's answer whose `failed` list is `failed` (02-tidepool 5.3). */
function answer(failed: Array<{ name: string; kind: string }>): Run {
  const checks = NAMES.map((name) => ({ name, ok: !failed.some((f) => f.name === name) }));
  return mapAnswer(JSON.stringify({ verdict: { v: 1, ok: failed.length === 0, checks, failed } }));
}

const tree = (marker: string, kinds: string[] = []) =>
  new Map<string, string>([
    ["selftest/run.js", marker],
    ...kinds.map((k) => [`creatures/${k}.js`, k] as [string, string]),
  ]);

const candidate = (key: string, head: string, files: Map<string, string>): SelftestCandidate => ({
  key,
  head,
  headFiles: tree(`head:${head}`),
  files,
});

/** A run keyed by the tree's `selftest/run.js` text, counting the trees it was given. */
function runs(answers: Record<string, Run | "throw">) {
  const seen: string[] = [];
  const run = (files: ReadonlyMap<string, string>) => {
    const marker = files.get("selftest/run.js")!;
    seen.push(marker);
    const a = answers[marker];
    return a === "throw" || a === undefined ? Promise.reject(new Error("load failed")) : Promise.resolve(a);
  };
  return { run, seen };
}

describe("CK6c: the pre-landing self-test of a submit, Worker half", () => {
  it("lists a failure head lacks, and head's run is computed once per head commit", async () => {
    const { run, seen } = runs({
      "head:h1": answer([]),
      bad: answer([{ name: "no_errors", kind: "eel" }]),
      good: answer([]),
    });
    const st = new SubmitSelftest(run);
    expect(await st.verdict(candidate("k1", "h1", tree("bad", ["eel"])))).toEqual({
      key: "k1",
      failed: [{ name: "no_errors", code: "no_errors:failed", kind: "eel", means: expect.stringContaining("threw") }],
    });
    expect(await st.verdict(candidate("k2", "h1", tree("good", ["eel"])))).toEqual({ key: "k2", failed: [] });
    expect(seen.filter((m) => m === "head:h1")).toHaveLength(1);
  });

  it("GR3d: a pair head already fails does not count", async () => {
    const { run } = runs({
      "head:h1": answer([{ name: "pen_rules", kind: "jelly" }]),
      lily: answer([{ name: "pen_rules", kind: "jelly" }]),
    });
    expect(await new SubmitSelftest(run).verdict(candidate("k", "h1", tree("lily", ["jelly", "lily"])))).toEqual({
      key: "k",
      failed: [],
    });
  });

  it("a new head commit runs head again", async () => {
    const { run, seen } = runs({ "head:h1": answer([]), "head:h2": answer([]), c: answer([]) });
    const st = new SubmitSelftest(run);
    await st.verdict(candidate("k1", "h1", tree("c")));
    await st.verdict(candidate("k2", "h2", tree("c")));
    expect(seen.filter((m) => m.startsWith("head:"))).toEqual(["head:h1", "head:h2"]);
  });

  it("fail open: a run with no answer, or one that throws, gives no verdict; head is not kept then", async () => {
    const late = { ...failClosed("no_verdict", "no verdict within 10000 ms"), unanswered: true as const };
    const { run, seen } = runs({ "head:h1": late, c: answer([{ name: "visible", kind: "eel" }]), boom: "throw" });
    const st = new SubmitSelftest(run);
    expect(await st.verdict(candidate("k1", "h1", tree("c", ["eel"])))).toEqual({ key: "k1", failed: null });
    expect(await st.verdict(candidate("k2", "h1", tree("boom")))).toEqual({ key: "k2", failed: null });
    expect(seen.filter((m) => m === "head:h1")).toHaveLength(2);
  });

  it("two submits of the same tree at once share one run", async () => {
    const { run, seen } = runs({ "head:h1": answer([]), c: answer([]) });
    const st = new SubmitSelftest(run);
    const [a, b] = await Promise.all([
      st.verdict(candidate("k", "h1", tree("c"))),
      st.verdict(candidate("k", "h1", tree("c"))),
    ]);
    expect(a).toEqual({ key: "k", failed: [] });
    expect(b).toBe(a);
    expect(seen.filter((m) => m === "c")).toHaveLength(1);
  });
});
