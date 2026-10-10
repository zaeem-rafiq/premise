// One Clef request (01-core 7.3, 10.4, S6): the size check of TR7, the model gate of TR9, the
// call over the Workers AI binding with Trunk's own time-out, and the reading of `noul`
// answers. Every failure is an answer of `null` with an error code (SE5b): the 7.3 table maps
// it to `confirm` (`triage_unavailable`), RK3 to a held card. Shared by `ClefTriage` and
// `ClefRisk`.

import {
  CLEF_INPUT_TOKEN_LIMIT,
  CLEF_MAX_QUESTIONS,
  CLEF_STATE_MAX_CHARS,
  CLEF_TIMEOUT_MS,
} from "../../../protocol/constants.ts";
import type { GateReserveResponse, GateSettleResponse } from "../../../protocol/internal.ts";
import { callModel, type AiBinding } from "../model/workers-ai.ts";

/** The two gate calls a Clef request makes (SE6, SE6a). `GateCalls` of the Agent satisfies it. */
export interface ClefGate {
  reserve(request: {
    attempt_id: string;
    pool: string;
    model: string;
    request_bytes: number;
    max_tokens: number;
  }): Promise<GateReserveResponse>;
  settle(request: {
    reservation_id: string;
    usage: { tokens_in: number; tokens_out: number } | null;
  }): Promise<GateSettleResponse>;
}

export type ClefDeps = {
  ai: AiBinding;
  /** Null: no gate binding. Clef is never called un-gated (TR9), so every answer is unavailable. */
  gate: ClefGate | null;
  pool: string;
  /** `CLEF_TRIAGE_MODEL_ID` or `CLEF_RISK_MODEL_ID`, and the `model` selector the request names. */
  modelId: string;
  model: string;
  timeoutMs?: number;
  stateMaxChars?: number;
  inputTokenLimit?: number;
  now?: () => number;
};

export type ClefQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
};

export type ClefOutcome = {
  answers: Record<string, number | null>;
  model: string;
  ms: number;
  error?: string;
};

function unavailable(ids: string[], model: string, ms: number, error: string): ClefOutcome {
  return { answers: Object.fromEntries(ids.map((id) => [id, null])), model, ms, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The probability of a `noul` answer, or null when it is missing or not a number in [0, 1]. */
function noul(answer: unknown): number | null {
  const p = isRecord(answer) ? answer.noul : undefined;
  return typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1 ? p : null;
}

/** `usage.input_tokens` as the provider reported it, or null. */
function inputTokens(result: Record<string, unknown>): number | null {
  const usage = result.usage;
  if (!isRecord(usage)) return null;
  const n = usage.input_tokens ?? usage.prompt_tokens;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Ask `questions` about `state`. `attempt_id` names the gate reservation (Clef never takes an
 * agent slot, MG5). Questions beyond `CLEF_MAX_QUESTIONS` are not sent and answer null.
 */
export async function askClef(
  deps: ClefDeps,
  attempt_id: string,
  state: unknown,
  questions: Record<string, ClefQuestion>,
): Promise<ClefOutcome> {
  const now = deps.now ?? Date.now;
  const ids = Object.keys(questions);
  const sent = ids.slice(0, CLEF_MAX_QUESTIONS);
  const extra = ids.slice(CLEF_MAX_QUESTIONS);
  const withExtra = (outcome: ClefOutcome): ClefOutcome => {
    if (extra.length === 0) return outcome;
    for (const id of extra) outcome.answers[id] = null;
    return { ...outcome, error: outcome.error ?? "too_many_questions" };
  };
  if (sent.length === 0) return unavailable(ids, deps.model, 0, "no_questions");
  // TR7: a state that does not fit is never sent, and nothing is cut from it to make it fit.
  if (JSON.stringify(state).length > (deps.stateMaxChars ?? CLEF_STATE_MAX_CHARS)) {
    return unavailable(ids, deps.model, 0, "state_too_large");
  }
  if (deps.gate === null) return unavailable(ids, deps.model, 0, "gate_unavailable");
  const body = {
    model: deps.model,
    state,
    questions: Object.fromEntries(sent.map((id) => [id, questions[id]])),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(body)).length;
  // TR9: through the gate, with Clef's own bucket (the model id). Output tokens are not charged.
  let reserved: GateReserveResponse;
  try {
    reserved = await deps.gate.reserve({
      attempt_id,
      pool: deps.pool,
      model: deps.modelId,
      request_bytes: bytes,
      max_tokens: 0,
    });
  } catch {
    return unavailable(ids, deps.model, 0, "gate_unavailable");
  }
  if (!reserved.ok) {
    return unavailable(ids, deps.model, 0, "refused" in reserved ? reserved.refused : "rate_limited");
  }
  const started = now();
  const outcome = await callModel(deps.ai, deps.modelId, body, deps.timeoutMs ?? CLEF_TIMEOUT_MS);
  const ms = Math.max(0, now() - started);
  const result = outcome.kind === "answer" && isRecord(outcome.result) ? outcome.result : null;
  const tokens = result === null ? null : inputTokens(result);
  try {
    // SE6a: the reported usage settles the reservation; without one the full bound is charged.
    await deps.gate.settle({
      reservation_id: reserved.reservation_id,
      usage: tokens === null ? null : { tokens_in: tokens, tokens_out: 0 },
    });
  } catch {
    // The reservation expires at its TTL and is charged in full (SE6a): nothing is lost.
  }
  if (outcome.kind === "timeout") return withExtra(unavailable(ids, deps.model, ms, "timeout"));
  if (outcome.kind === "rate_limited") return withExtra(unavailable(ids, deps.model, ms, "rate_limited"));
  if (outcome.kind === "rejected") return withExtra(unavailable(ids, deps.model, ms, "model_rejected"));
  if (outcome.kind === "unavailable") return withExtra(unavailable(ids, deps.model, ms, "model_unavailable"));
  if (result === null || !isRecord(result.answers)) return withExtra(unavailable(ids, deps.model, ms, "malformed"));
  const model = typeof result.model === "string" && result.model !== "" ? result.model : deps.model;
  // TR7: at or above the limit the service may have truncated the state — discarded as unavailable.
  if (tokens !== null && tokens >= (deps.inputTokenLimit ?? CLEF_INPUT_TOKEN_LIMIT)) {
    return withExtra(unavailable(ids, model, ms, "truncated"));
  }
  const raw = result.answers;
  const answers: Record<string, number | null> = {};
  for (const id of sent) answers[id] = noul(raw[id]);
  const missing = sent.some((id) => answers[id] === null);
  return withExtra({ answers, model, ms, ...(missing ? { error: "malformed" } : {}) });
}
