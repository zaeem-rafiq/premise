// The arithmetic of `calibrate:clef`: the 7.3 mapping from a probability to a result, the confusion
// table, the best thresholds RR7 asks for, nearest-rank latency percentiles, and RR7's verdict
// (04-build-plan RR7; 01-core S6, S6b). Pure functions: no clock, no I/O.

import type { Label } from "./cases.ts";

export type Outcome = "repair" | "confirm" | "holds" | "unavailable";
export const OUTCOMES: readonly Outcome[] = ["repair", "confirm", "holds", "unavailable"];

export type Thresholds = { T_REPAIR: number; T_CONFIRM: number };

/** One case's answer from one model: the probability (null = unavailable) and the call's latency. */
export type Answer = { id: string; label: Label; p: number | null; ms: number; error?: string };

/** The mapping table of 01-core 7.3. */
export function outcomeOf(p: number | null, t: Thresholds): Outcome {
  if (p === null) return "unavailable";
  if (p >= t.T_REPAIR) return "repair";
  if (p >= t.T_CONFIRM) return "confirm";
  return "holds";
}

export type Confusion = Record<Label, Record<Outcome, number>>;

/** Rows: the true label. Columns: the result the 7.3 table gives at `t`. */
export function confusion(answers: readonly Answer[], t: Thresholds): Confusion {
  const empty = (): Record<Outcome, number> => ({ repair: 0, confirm: 0, holds: 0, unavailable: 0 });
  const table: Confusion = { dependent: empty(), independent: empty() };
  for (const a of answers) table[a.label][outcomeOf(a.p, t)] += 1;
  return table;
}

const MILLI = 1000;
const floorMilli = (x: number): number => Math.floor(x * MILLI + 1e-9) / MILLI;

/**
 * The thresholds RR7 calls "the best": no truly dependent case gets `holds`, and as many independent
 * cases as possible do. `T_CONFIRM` is therefore at most the lowest probability of a dependent case;
 * it is placed halfway between that and the highest independent probability below it (rounded down to
 * a thousandth), for a margin, while every such independent case still holds. `T_REPAIR` keeps its
 * starting value unless an independent case reaches it; then it rises to the next thousandth above
 * every independent probability, so no independent case is sent around (capped at 1). `T_CONFIRM <
 * T_REPAIR` always (7.3). Null when no dependent case was answered: there is nothing to calibrate on.
 */
export function bestThresholds(answers: readonly Answer[], start: Thresholds): Thresholds | null {
  const dep = answers.filter((a) => a.label === "dependent" && a.p !== null).map((a) => a.p as number);
  const ind = answers.filter((a) => a.label === "independent" && a.p !== null).map((a) => a.p as number);
  if (dep.length === 0) return null;
  const minDep = Math.min(...dep);
  const below = ind.filter((p) => p < minDep);
  let tConfirm = floorMilli(minDep);
  if (below.length > 0) {
    const top = Math.max(...below);
    const mid = floorMilli((top + minDep) / 2);
    tConfirm = mid > top ? mid : minDep;
  }
  const highest = Math.max(tConfirm, ...ind);
  const above = Math.min(1, floorMilli(highest) + 1 / MILLI);
  const tRepair = Math.max(start.T_REPAIR, Math.round(above * MILLI) / MILLI);
  return { T_REPAIR: Math.min(1, tRepair), T_CONFIRM: tConfirm };
}

/** Nearest-rank percentile: the smallest value with at least `q` of the values at or below it. */
export function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}

export type Rr7 = {
  thresholds: Thresholds | null;
  dependent_holds: string[];
  independent_holds: number;
  independent_total: number;
  p95_ms: number | null;
  accuracy_ok: boolean;
  latency_ok: boolean;
  pass: boolean;
  reasons: string[];
};

/**
 * RR7 (04-build-plan): Clef stays off when, with the best thresholds, any truly dependent case gets
 * `holds`; or fewer than half of the independent cases get `holds`; or p95 latency is above
 * `CLEF_TIMEOUT_MS`. An unavailable answer is not `holds` (it maps to `confirm`, 7.3).
 */
export function rr7(answers: readonly Answer[], start: Thresholds, timeoutMs: number): Rr7 {
  const thresholds = bestThresholds(answers, start);
  const reasons: string[] = [];
  const outcome = (a: Answer): Outcome => (thresholds === null ? "unavailable" : outcomeOf(a.p, thresholds));
  const dependentHolds = answers.filter((a) => a.label === "dependent" && outcome(a) === "holds").map((a) => a.id);
  const independent = answers.filter((a) => a.label === "independent");
  const independentHolds = independent.filter((a) => outcome(a) === "holds").length;
  if (thresholds === null) reasons.push("no truly dependent case was answered, so no threshold can be set");
  if (dependentHolds.length > 0) reasons.push(`truly dependent cases judged holds: ${dependentHolds.join(", ")}`);
  if (independentHolds * 2 < independent.length) {
    reasons.push(
      `fewer than half of the independent cases judged holds (${independentHolds} of ${independent.length})`,
    );
  }
  const p95 = percentile(
    answers.map((a) => a.ms),
    0.95,
  );
  const latencyOk = p95 !== null && p95 <= timeoutMs;
  if (!latencyOk) reasons.push(`p95 latency ${p95 ?? "unmeasured"} ms is above CLEF_TIMEOUT_MS ${timeoutMs} ms`);
  const accuracyOk = thresholds !== null && dependentHolds.length === 0 && independentHolds * 2 >= independent.length;
  return {
    thresholds,
    dependent_holds: dependentHolds,
    independent_holds: independentHolds,
    independent_total: independent.length,
    p95_ms: p95,
    accuracy_ok: accuracyOk,
    latency_ok: latencyOk,
    pass: accuracyOk && latencyOk,
    reasons,
  };
}

export type Decision =
  | { decision: "on"; model: "clef"; why: string }
  | { decision: "fallback"; model: "clef-flash"; why: string }
  | { decision: "off"; model: null; why: string };

/**
 * RR7's mitigation and S6's fallback order: `clef` when it passes; when only its latency fails,
 * `clef-flash` with its own thresholds if that passes; otherwise option C, off.
 */
export function decide(clef: Rr7 | null, flash: Rr7 | null): Decision {
  if (clef?.pass) return { decision: "on", model: "clef", why: "clef passes RR7 on the labelled set" };
  if (clef !== null && clef.accuracy_ok && !clef.latency_ok && flash?.pass) {
    return {
      decision: "fallback",
      model: "clef-flash",
      why: "only clef's latency fails RR7, and clef-flash passes with its own thresholds (S6 fallback A)",
    };
  }
  const failing = [
    ...(clef === null ? ["clef was not measured"] : clef.reasons.map((r) => `clef: ${r}`)),
    ...(flash === null ? [] : flash.reasons.map((r) => `clef-flash: ${r}`)),
  ];
  return { decision: "off", model: null, why: failing.join("; ") || "RR7 fails" };
}
