// The output file of 6.8: the `ModelMeasurement` of the plan's type built from `RunRecord`s.
// Percentiles are nearest-rank. Pure assembly: no I/O.

import {
  AGENT_SPEC,
  systemPrompt,
  TOOL_DEFINITIONS,
  AGENT_TEXTS,
  FIRST_USER_MESSAGE,
  RESUME_MESSAGE,
} from "../../../src/protocol/agent-prompt.ts";
import {
  ATTEMPT_TIMEOUT_MS,
  MAX_MODEL_CALLS,
  MAX_STEPS,
  MODEL_MAX_TOKENS,
  MODEL_TIMEOUT_MS,
} from "../../../src/protocol/constants.ts";
import { H } from "../../../src/core/sync/h.ts";
import { referencesEnergyMax } from "./score.ts";
import type { IntentSpec } from "./intents.ts";
import type { RunRecord } from "./run.ts";

/** Canonical JSON (sorted keys, no whitespace) — the form the published hashes are taken over. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function promptHash(): string {
  return H(systemPrompt());
}
export function toolsHash(): string {
  return H(canonical(JSON.parse(TOOL_DEFINITIONS)));
}
export function textsHash(): string {
  // 05-agent 2.4: H of the canonical JSON of { first_user, resume, texts }, blocks unfilled.
  return H(canonical({ first_user: FIRST_USER_MESSAGE, resume: RESUME_MESSAGE, texts: JSON.parse(AGENT_TEXTS) }));
}

/** Nearest-rank percentile: the value at position ⌈p × n⌉ of the sorted values. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] as number;
}

export type ModelMeasurement = {
  v: 1;
  mode: "early" | "engine";
  build: string;
  recorded_at: string;
  model: string;
  agent_spec: string;
  prompt_hash: string;
  tools_hash: string;
  texts_hash: string;
  request: { transport: "rest" | "binding"; max_tokens: number; options: object };
  limits: { max_steps: number; max_model_calls: number; attempt_timeout_ms: number; model_timeout_ms: number };
  intents: Array<{
    id: string;
    runs: number;
    landed: number;
    seconds: { p50: number; p90: number };
    tool_calls: number;
    tool_errors: number;
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
    model_calls: number;
    stops: Record<string, number>;
  }>;
  hero: {
    runs: number;
    references_energy_max: number;
    absolute_number: number;
    repaired_correctly: number;
    repair_ms: { p50: number; p90: number };
    relative: number;
    unclear: number;
    by_intent: Record<
      string,
      {
        runs: number;
        references_energy_max: number;
        absolute_number: number;
        repaired_correctly: number;
        relative: number;
        unclear: number;
      }
    >;
  };
  energy_creatures: { runs: number; references_energy_max: number };
  confirm: null;
  calls_per_agent_minute: { p50: number; p90: number };
  rate_limited: number;
  spend_usd: number;
  incomplete: boolean;
  runs: RunRecord[];
};

const HERO_COUNTING: Record<string, { references: boolean; absolute: boolean; repaired: boolean }> = {
  // ME8's "counts as" column.
  not_completed: { references: false, absolute: false, repaired: false },
  no_reference: { references: false, absolute: false, repaired: false },
  relative: { references: true, absolute: false, repaired: false },
  not_answered: { references: true, absolute: true, repaired: false },
  repaired: { references: true, absolute: true, repaired: true },
  not_repaired: { references: true, absolute: true, repaired: false },
  unclear: { references: true, absolute: true, repaired: false },
};

function stopKey(reason: string | null): string {
  if (reason === null) return "completed";
  return reason.split(":")[0] as string;
}

/**
 * Build the `ModelMeasurement` of 6.8 for one model and invocation. `intents` carries every intent
 * of the plan; `hero` the ME8 classes; `energy_creatures` the ENERGY_MAX references of A08, A09,
 * P1a and P1b.
 */
export function summarize(opts: {
  model: string;
  build: string;
  recordedAt: string;
  intents: IntentSpec[];
  results: Array<{ record: RunRecord; rate_limited: number; incomplete: boolean }>;
  options: object;
  spendUsd: number;
  incomplete: boolean;
  energyRefs: Map<string, boolean>; // "<intent>:<run>" -> references ENERGY_MAX (final writes file)
}): ModelMeasurement {
  const records = opts.results.map((r) => r.record);
  const rateLimited = opts.results.reduce((s, r) => s + r.rate_limited, 0);

  const intents = opts.intents.map((spec) => {
    const runs = records.filter((r) => r.intent === spec.id);
    const done = runs.filter((r) => r.outcome === "completed" || r.outcome === "landed");
    const stops: Record<string, number> = {};
    for (const r of runs) {
      const key = stopKey(r.stop_reason);
      stops[key] = (stops[key] ?? 0) + 1;
    }
    return {
      id: spec.id,
      runs: runs.length,
      landed: done.length,
      seconds: {
        p50: percentile(
          done.map((r) => r.seconds ?? 0),
          0.5,
        ),
        p90: percentile(
          done.map((r) => r.seconds ?? 0),
          0.9,
        ),
      },
      tool_calls: runs.reduce((s, r) => s + r.tool_calls, 0),
      tool_errors: runs.reduce((s, r) => s + r.tool_errors, 0),
      tokens_in: runs.reduce((s, r) => s + r.tokens_in, 0),
      tokens_out: runs.reduce((s, r) => s + r.tokens_out, 0),
      cost_usd: runs.reduce((s, r) => s + r.cost_usd, 0),
      model_calls: runs.reduce((s, r) => s + r.model_calls, 0),
      stops,
    };
  });

  const heroRuns = records.filter((r) => r.hero !== null);
  const heroFor = (runs: RunRecord[]) => {
    const counts = { references: 0, absolute: 0, repaired: 0, relative: 0, unclear: 0 };
    for (const r of runs) {
      const cls = (r.hero?.class ?? "not_completed") as keyof typeof HERO_COUNTING;
      const rule =
        HERO_COUNTING[cls] ??
        (HERO_COUNTING.not_completed as { references: boolean; absolute: boolean; repaired: boolean });
      if (rule.references) counts.references++;
      if (rule.absolute) counts.absolute++;
      if (rule.repaired) counts.repaired++;
      if (cls === "relative") counts.relative++;
      if (cls === "unclear") counts.unclear++;
    }
    return counts;
  };
  const heroAll = heroFor(heroRuns);
  const repairTimes = heroRuns.map((r) => r.hero?.repair_ms).filter((n): n is number => n !== null && n !== undefined);
  const byIntent: ModelMeasurement["hero"]["by_intent"] = {};
  for (const id of ["P1a", "P1b"]) {
    const runs = heroRuns.filter((r) => r.intent === id);
    const counts = heroFor(runs);
    byIntent[id] = {
      runs: runs.length,
      references_energy_max: counts.references,
      absolute_number: counts.absolute,
      repaired_correctly: counts.repaired,
      relative: counts.relative,
      unclear: counts.unclear,
    };
  }

  const energyIds = new Set(["A08", "A09", "P1a", "P1b"]);
  const energyRuns = records.filter(
    (r) => energyIds.has(r.intent) && (r.outcome === "completed" || r.outcome === "landed"),
  );
  const energyRefs = energyRuns.filter((r) => opts.energyRefs.get(`${r.intent}:${r.run}`) === true).length;

  const callsPerMinute = records
    .filter((r) => ((r.seconds ?? 0) + r.waited_ms / 1000) / 60 > 0)
    .map((r) => r.model_calls / (((r.seconds ?? 0) + r.waited_ms / 1000) / 60));

  return {
    v: 1,
    mode: "early",
    build: opts.build,
    recorded_at: opts.recordedAt,
    model: opts.model,
    agent_spec: AGENT_SPEC,
    prompt_hash: promptHash(),
    tools_hash: toolsHash(),
    texts_hash: textsHash(),
    request: { transport: "rest", max_tokens: MODEL_MAX_TOKENS, options: opts.options },
    limits: {
      max_steps: MAX_STEPS,
      max_model_calls: MAX_MODEL_CALLS,
      attempt_timeout_ms: ATTEMPT_TIMEOUT_MS,
      model_timeout_ms: MODEL_TIMEOUT_MS,
    },
    intents,
    hero: {
      runs: heroRuns.length,
      references_energy_max: heroAll.references,
      absolute_number: heroAll.absolute,
      repaired_correctly: heroAll.repaired,
      repair_ms: { p50: percentile(repairTimes, 0.5), p90: percentile(repairTimes, 0.9) },
      relative: heroAll.relative,
      unclear: heroAll.unclear,
      by_intent: byIntent,
    },
    energy_creatures: { runs: energyRuns.length, references_energy_max: energyRefs },
    confirm: null,
    calls_per_agent_minute: { p50: percentile(callsPerMinute, 0.5), p90: percentile(callsPerMinute, 0.9) },
    rate_limited: rateLimited,
    spend_usd: opts.spendUsd,
    incomplete: opts.incomplete,
    runs: records,
  };
}
