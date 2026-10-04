// `ScriptedTriage` (01-core TR8, S6a; 02-tidepool.md 10.1 SW5): the `SyncTriage` of a synthetic
// attempt. `judgeNow` is `scriptedAnswer` over the pending premises: p = 1 for a premise of the
// attempt's truth list, 0 for any other, null when there is no list (unavailable -> `confirm`).
// It is pure and answers inside the accept transaction (TR5): no promise, no `await`, no Clef
// call. For row QR4 the input's `truth` is the landed change's list and the premise the landed
// change's frozen premise on E (TR8); the same membership check answers it.

import type { SyncTriage, TriageAnswers, TriageInput } from "../protocol/ports.ts";

type ScriptedPremise = {
  kind: string;
  key: string;
  changed: readonly string[]; // for a `file` premise: the entity keys of D (7.2); else []
};

/**
 * `scriptedAnswer(truth, premise, changed)` of TR8: 1 when the premise's `<kind>:<key>` is in the
 * truth list — and, for a `file` premise, when an entity of that file whose hash changed (D) is
 * in the list; 0 in every other case; `null` (unavailable) when there is no list.
 */
export function scriptedAnswer(truth: readonly string[] | null, premise: ScriptedPremise): number | null {
  if (truth === null) return null;
  if (truth.includes(`${premise.kind}:${premise.key}`)) return 1;
  if (premise.kind === "file" && premise.changed.some((key) => truth.includes(`entity:${key}`))) {
    return 1;
  }
  return 0;
}

export const ScriptedTriage: SyncTriage = {
  judgeNow(input: TriageInput): TriageAnswers {
    const answers: Record<string, number | null> = {};
    for (const [question, premise] of Object.entries(input.premises)) {
      answers[question] = scriptedAnswer(input.truth, premise);
    }
    // TR8 records the judgment with `clef_model = "scripted"`.
    return { answers, model: "scripted" };
  },
};
