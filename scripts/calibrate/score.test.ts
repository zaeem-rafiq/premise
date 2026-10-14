// The arithmetic of calibrate:clef. Expected values are worked by hand from the 7.3 mapping table and
// from RR7's text (04-build-plan): off when, with the best thresholds, any truly dependent case gets
// holds, or fewer than half of the independent cases get holds, or p95 latency is above CLEF_TIMEOUT_MS.

import { describe, expect, it } from "vitest";
import type { Label } from "./cases.ts";
import { bestThresholds, confusion, decide, outcomeOf, percentile, rr7, type Answer, type Rr7 } from "./score.ts";

const START = { T_REPAIR: 0.7, T_CONFIRM: 0.2 };
const TIMEOUT = 2_000;

function answers(label: Label, ps: Array<number | null>, ms = 400): Answer[] {
  return ps.map((p, i) => ({ id: `${label[0]}${i + 1}`, label, p, ms }));
}

describe("7.3 mapping and the confusion table", () => {
  it("7.3: p >= T_REPAIR repair; T_CONFIRM <= p < T_REPAIR confirm; p < T_CONFIRM holds; unavailable", () => {
    expect(outcomeOf(0.7, START)).toBe("repair");
    expect(outcomeOf(0.69, START)).toBe("confirm");
    expect(outcomeOf(0.2, START)).toBe("confirm");
    expect(outcomeOf(0.19, START)).toBe("holds");
    expect(outcomeOf(null, START)).toBe("unavailable");
  });

  it("confusion: rows are the truth, columns the 7.3 result", () => {
    const set = [...answers("dependent", [0.95, 0.5, 0.1, null]), ...answers("independent", [0.05, 0.3, 0.8])];
    expect(confusion(set, START)).toEqual({
      dependent: { repair: 1, confirm: 1, holds: 1, unavailable: 1 },
      independent: { repair: 1, confirm: 1, holds: 1, unavailable: 0 },
    });
  });
});

describe("percentile (nearest rank)", () => {
  it("p50 and p95 of 1..20 x 100 ms are 1000 and 1900; nothing measured is null", () => {
    const ms = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    expect(percentile(ms, 0.5)).toBe(1000);
    expect(percentile(ms, 0.95)).toBe(1900);
    expect(percentile([], 0.95)).toBeNull();
  });
});

describe("RR7 on scripted answers", () => {
  it("RR7: the best thresholds give no dependent case holds and every independent case below the lowest dependent p holds", () => {
    const set = [
      ...answers("dependent", [0.95, 0.62, 0.3, null]),
      ...answers("independent", [0.02, 0.1, 0.25, 0.31, 0.8, null]),
    ];
    const t = bestThresholds(set, START)!;
    // RR7's two accuracy conditions decide the band: holds below the lowest dependent p (0.3), above 0.25.
    expect(t.T_CONFIRM).toBeGreaterThan(0.25);
    expect(t.T_CONFIRM).toBeLessThanOrEqual(0.3);
    // 7.3: T_CONFIRM < T_REPAIR; no independent case is sent around; T_REPAIR is not lowered.
    expect(t.T_REPAIR).toBeGreaterThan(0.8);
    expect(t.T_REPAIR).toBeGreaterThanOrEqual(START.T_REPAIR);
    expect(t.T_CONFIRM).toBeLessThan(t.T_REPAIR);
    expect(confusion(set, t)).toEqual({
      dependent: { repair: 1, confirm: 2, holds: 0, unavailable: 1 },
      independent: { repair: 0, confirm: 2, holds: 3, unavailable: 1 },
    });
  });

  it("RR7: passes when no dependent case holds, half of the independent cases hold (3 of 6 is not fewer than half) and p95 <= CLEF_TIMEOUT_MS", () => {
    const set = [
      ...answers("dependent", [0.95, 0.62, 0.3, null]),
      ...answers("independent", [0.02, 0.1, 0.25, 0.31, 0.8, null]),
    ];
    const r = rr7(set, START, TIMEOUT);
    expect(r).toMatchObject({ dependent_holds: [], independent_holds: 3, independent_total: 6, p95_ms: 400 });
    expect(r.pass).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("RR7: fewer than half of the independent cases judged holds (2 of 6) keeps Clef off", () => {
    const set = [
      ...answers("dependent", [0.95, 0.62, 0.3]),
      ...answers("independent", [0.02, 0.1, 0.31, 0.4, 0.8, null]),
    ];
    const r = rr7(set, START, TIMEOUT);
    expect(r.independent_holds).toBe(2);
    expect(r.accuracy_ok).toBe(false);
    expect(r.pass).toBe(false);
    expect(r.reasons.join(" ")).toContain("fewer than half of the independent cases judged holds (2 of 6)");
  });

  it("RR7: a dependent case answered 0 leaves no threshold under which an independent case holds", () => {
    const set = [...answers("dependent", [0, 0.9]), ...answers("independent", [0.01, 0.02])];
    const r = rr7(set, START, TIMEOUT);
    expect(r.dependent_holds).toEqual([]);
    expect(r.independent_holds).toBe(0);
    expect(r.pass).toBe(false);
  });

  it("RR7: at the starting thresholds a dependent case under T_CONFIRM is judged holds", () => {
    // The confusion at the starting values shows what RR7's first condition counts.
    const set = answers("dependent", [0.1]);
    expect(confusion(set, START).dependent.holds).toBe(1);
  });

  it("RR7: p95 latency above CLEF_TIMEOUT_MS keeps Clef off; exactly at it passes", () => {
    const fast = [...answers("dependent", [0.9]), ...answers("independent", [0.05])];
    const over = Array.from({ length: 20 }, (_, i): Answer => ({
      id: `i${i}`,
      label: "independent",
      p: 0.05,
      ms: i >= 18 ? 2_001 : 300,
    }));
    const r = rr7([...fast, ...over], START, TIMEOUT);
    // 22 calls: nearest rank ceil(0.95 * 22) = 21st value = 2001 ms.
    expect(r.p95_ms).toBe(2_001);
    expect(r.latency_ok).toBe(false);
    expect(r.accuracy_ok).toBe(true);
    expect(r.pass).toBe(false);
    const at = over.map((a) => (a.ms > 300 ? { ...a, ms: 2_000 } : a));
    expect(rr7([...fast, ...at], START, TIMEOUT).pass).toBe(true);
  });

  it("RR7: with no dependent case answered nothing can be calibrated", () => {
    const r = rr7([...answers("dependent", [null, null]), ...answers("independent", [0.01])], START, TIMEOUT);
    expect(r.thresholds).toBeNull();
    expect(r.pass).toBe(false);
  });
});

describe("decide: RR7's mitigation and the S6 fallback", () => {
  const verdict = (accuracy_ok: boolean, latency_ok: boolean): Rr7 => ({
    thresholds: START,
    dependent_holds: [],
    independent_holds: 0,
    independent_total: 0,
    p95_ms: 0,
    accuracy_ok,
    latency_ok,
    pass: accuracy_ok && latency_ok,
    reasons: [...(accuracy_ok ? [] : ["accuracy"]), ...(latency_ok ? [] : ["latency"])],
  });

  it("S6 option B: clef passes, so clef answers triage", () => {
    expect(decide(verdict(true, true), verdict(false, false))).toMatchObject({ decision: "on", model: "clef" });
  });

  it("S6 fallback A: only clef's latency fails and clef-flash passes", () => {
    expect(decide(verdict(true, false), verdict(true, true))).toMatchObject({
      decision: "fallback",
      model: "clef-flash",
    });
  });

  it("option C: clef's accuracy fails, so a passing clef-flash does not switch Clef on", () => {
    expect(decide(verdict(false, true), verdict(true, true))).toMatchObject({ decision: "off", model: null });
  });

  it("option C: only latency fails and clef-flash fails too", () => {
    expect(decide(verdict(true, false), verdict(true, false))).toMatchObject({ decision: "off", model: null });
  });
});
