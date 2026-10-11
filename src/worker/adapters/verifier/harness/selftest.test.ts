// The harness's mapping of a verdict to `VerifyResult` (02-tidepool 5.4, ST4; 01-core GR7, GR8),
// and the entry module it generates. Expected values: 5.4's table and its thirteen-entry example.

import { describe, expect, it } from "vitest";
import { GREEN_LOG_MAX_CHARS } from "../../../../protocol/constants.ts";
import { ENTRY_MODULE, entrySource, isolateModules, mapAnswer, RANDOM_MODULE } from "./selftest.ts";

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

const verdict = (failed: string | null, extra: Record<string, unknown> = {}) => ({
  v: 1,
  ok: failed === null,
  seed: 7,
  ticks: 3600,
  kinds: ["crab", "shrimp"],
  checks: NAMES.map((name) =>
    name === failed ? { name, ok: false, detail: "shrimp: resting 82% of the time" } : { name, ok: true },
  ),
  failed: failed === null ? [] : [{ name: failed, kind: "shrimp" }],
  rest_share: { crab: 0, shrimp: 0.817 },
  creatures: 17,
  state_hash: "1552cf61",
  ...extra,
});

describe("02-tidepool 5.4: the verdict mapped by GR8", () => {
  it("a failed not_exhausted gives 5.4's thirteen entries exactly", () => {
    const mapped = mapAnswer(JSON.stringify({ verdict: verdict("not_exhausted") }));
    expect(mapped.ok).toBe(false);
    expect(mapped.checks).toEqual([
      { name: "selftest_ran", ok: true },
      { name: "files", ok: true },
      { name: "no_errors", ok: true },
      { name: "in_bounds", ok: true },
      { name: "energy_range", ok: true },
      { name: "population", ok: true },
      { name: "not_exhausted", ok: false, code: "not_exhausted:failed" },
      { name: "state_is_data", ok: true },
      { name: "pen_rules", ok: true },
      { name: "visible", ok: true },
      { name: "within_reach", ok: true },
      { name: "draw_is_pure", ok: true },
      { name: "deterministic", ok: true },
    ]);
  });

  it("GR7: the detail, failed and rest_share go to the log only, as JSON of { failed, rest_share, details }", () => {
    const mapped = mapAnswer(JSON.stringify({ verdict: verdict("not_exhausted") }));
    expect(JSON.stringify(mapped.checks)).not.toContain("resting");
    expect(JSON.parse(mapped.log)).toEqual({
      failed: [{ name: "not_exhausted", kind: "shrimp" }],
      rest_share: { crab: 0, shrimp: 0.817 },
      details: { not_exhausted: "shrimp: resting 82% of the time" },
    });
  });

  it("a passing verdict gives ok and thirteen passed checks with no code", () => {
    const mapped = mapAnswer(JSON.stringify({ verdict: verdict(null) }));
    expect(mapped.ok).toBe(true);
    expect(mapped.checks).toHaveLength(13);
    for (const c of mapped.checks) expect(c).toEqual({ name: c.name, ok: true });
  });

  it.each([
    ["not JSON", "{"],
    ["no verdict", JSON.stringify({})],
    ["a wrong version", JSON.stringify({ verdict: verdict(null, { v: 2 }) })],
    ["a check out of order", JSON.stringify({ verdict: { ...verdict(null), checks: [...verdict(null).checks].reverse() } })],
    ["eleven checks", JSON.stringify({ verdict: { ...verdict(null), checks: verdict(null).checks.slice(1) } })],
    ["ok that contradicts its checks", JSON.stringify({ verdict: { ...verdict("files"), ok: true } })],
  ])("ST4: %s is bad_verdict, the single check selftest_ran", (_label, body) => {
    expect(mapAnswer(body)).toMatchObject({
      ok: false,
      checks: [{ name: "selftest_ran", ok: false, code: "bad_verdict" }],
    });
  });

  it("ST4: an error the entry caught is harness_error; its text goes to the log, bounded", () => {
    const mapped = mapAnswer(JSON.stringify({ error: `TypeError: ${"x".repeat(GREEN_LOG_MAX_CHARS * 2)}` }));
    expect(mapped.checks).toEqual([{ name: "selftest_ran", ok: false, code: "harness_error" }]);
    expect(mapped.log.length).toBeLessThanOrEqual(GREEN_LOG_MAX_CHARS);
    expect(mapped.log).toContain("TypeError");
  });
});

describe("02-tidepool 5.4: the generated entry module", () => {
  const files = new Map([
    ["main.js", "export {}"],
    ["selftest/run.js", "export function runSelfTest() {}"],
    ["creatures/crab.js", ""],
    ["creatures/shrimp.js", ""],
    ["creatures/notes.md", ""],
    ["world/energy.js", ""],
    [".premise/policy.json", "{}"],
  ]);

  it("imports the generator first, then selftest/run.js, then each creature file statically", () => {
    const src = entrySource(files.keys());
    const order = [RANDOM_MODULE, "selftest/run.js", "creatures/crab.js", "creatures/shrimp.js"].map((m) =>
      src.indexOf(`"./${m}"`),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(src).toContain('"crab": k0, "shrimp": k1');
    expect(src).not.toContain("notes");
  });

  it("loads only the commit's .js files, plus the entry and the generator", () => {
    expect(Object.keys(isolateModules(files)).sort()).toEqual(
      [
        "creatures/crab.js",
        "creatures/shrimp.js",
        "main.js",
        "selftest/run.js",
        "world/energy.js",
        ENTRY_MODULE,
        RANDOM_MODULE,
      ].sort(),
    );
  });
});
