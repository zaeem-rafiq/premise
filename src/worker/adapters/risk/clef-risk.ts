// `ClefRisk`, the `RiskJudge` of S6 and 01-core 10.4: the three risk questions about one submit,
// asked of `@cf/cloudflare/clef`. The answers inform the owner (RK1); an unavailable answer is
// null with `error` set to a code (RK3, SE5b).

import type { RiskAnswers } from "../../../protocol/cards.ts";
import type { RiskInput, RiskJudge } from "../../../protocol/ports.ts";
import { askClef, type ClefDeps, type ClefQuestion } from "../triage/clef-call.ts";

/** The three questions of 10.4, in its order. */
export const RISK_QUESTIONS: Readonly<
  Record<"does_what_asked" | "changes_shared_meaning" | "unrelated_edits", ClefQuestion>
> = {
  does_what_asked: {
    type: "noul",
    instructions: "Do the changes in `files` do what `intent` asks for?",
  },
  changes_shared_meaning: {
    type: "noul",
    instructions:
      "Do the changes in `files` change the meaning of existing code under `held_paths` that other code may " +
      "rely on (a value, unit, range, signature or behaviour), as opposed to only adding new things?",
  },
  unrelated_edits: {
    type: "noul",
    instructions: "Do the changes in `files` include edits that `intent` did not ask for?",
  },
};

export class ClefRisk implements RiskJudge {
  readonly #deps: ClefDeps;
  readonly #attempt: string;

  /** `attempt_id` names the gate reservation of the submit being judged. */
  constructor(deps: ClefDeps, attempt_id: string) {
    this.#deps = deps;
    this.#attempt = attempt_id;
  }

  async judge(input: RiskInput): Promise<RiskAnswers> {
    const outcome = await askClef(this.#deps, this.#attempt, input, { ...RISK_QUESTIONS });
    return {
      model: outcome.model,
      does_what_asked: outcome.answers.does_what_asked ?? null,
      changes_shared_meaning: outcome.answers.changes_shared_meaning ?? null,
      unrelated_edits: outcome.answers.unrelated_edits ?? null,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    };
  }
}
