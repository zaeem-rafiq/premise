// `ClefTriage`, the asynchronous `Triage` of S6/S6a: one Clef request per attempt per batch with
// one `noul` question per pending premise, in the shape of 01-core 7.3. The question ids Clef
// accepts are letters, digits, `_`, `.` and `-`, so the premises travel as `p1`, `p2`, … and the
// answers come back under the engine's `<kind>:<key>` ids.

import type { Triage, TriageAnswers, TriageInput } from "../../../protocol/ports.ts";
import { askClef, type ClefDeps, type ClefQuestion } from "./clef-call.ts";

/** The question of 7.3, for the premise whose state entry is `premises.<id>`. */
export function triageQuestion(id: string): ClefQuestion {
  return {
    type: "noul",
    instructions:
      `\`patch\` was written by an agent that had read \`premises.${id}.read_then\`. That code has since changed to ` +
      `\`premises.${id}.is_now\`. Does \`patch\` rely on the old meaning in \`read_then\`, so that \`patch\` would behave ` +
      "differently than its `intent` wants now that the code is `is_now`?",
    criteria: {
      true: "patch uses a value, unit, range, name, order or behaviour that held under read_then and no longer holds under is_now",
      false: "patch behaves as intended under is_now, or does not depend on this code",
    },
  };
}

/** The `state` and `questions` of one request, and the map from Clef's ids back to the engine's. */
export function triageRequest(input: TriageInput): {
  state: Record<string, unknown>;
  questions: Record<string, ClefQuestion>;
  ids: Record<string, string>;
} {
  const premises: Record<string, unknown> = {};
  const questions: Record<string, ClefQuestion> = {};
  const ids: Record<string, string> = {};
  Object.entries(input.premises).forEach(([qid, q], i) => {
    const id = `p${i + 1}`;
    ids[id] = qid;
    premises[id] = {
      kind: q.kind,
      key: q.key,
      read_then: q.read_then,
      is_now: q.is_now,
      changed_by_intent: q.changed_by_intent,
      ...(q.added !== undefined ? { added: q.added } : {}),
    };
    questions[id] = triageQuestion(id);
  });
  return { state: { intent: input.intent, patch: input.patch, premises }, questions, ids };
}

export class ClefTriage implements Triage {
  readonly #deps: ClefDeps;

  constructor(deps: ClefDeps) {
    this.#deps = deps;
  }

  async judge(input: TriageInput): Promise<TriageAnswers & { ms: number; error?: string }> {
    const { state, questions, ids } = triageRequest(input);
    const outcome = await askClef(this.#deps, input.attempt_id, state, questions);
    const answers: Record<string, number | null> = {};
    for (const [id, qid] of Object.entries(ids)) answers[qid] = outcome.answers[id] ?? null;
    return {
      answers,
      model: outcome.model,
      ms: outcome.ms,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    };
  }
}
