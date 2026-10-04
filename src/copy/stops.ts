// 03-floor 5.8: one sentence for each of the 17 stop reasons of `01-core.md` 9.1. Reasons are the
// `stop_reason` values: `go_around_limit`, `contradiction`, `revert_limit`, `reopen_failed`,
// `declined`, `not_chosen`, `undone`, `lost` are set by Trunk; `budget`, `spend_cap`, `timeout`,
// `model_error`, `tool_timeout`, `stalled`, `killed`, `cancelled`, `withdrawn` come from the
// Agent's `stop` call (TA9, `AgentStopReason`).

import { fill } from "./fill.ts";

/** The stop sentences of 03 5.8, verbatim; `{braces}` are constants or constant expressions (CP5). */
export const STOP_SENTENCES: Readonly<Record<string, string>> = {
  go_around_limit: "Stopped after it was sent back {GO_AROUND_LIMIT} times. A card asks the owner what to do.",
  contradiction: "Stopped: two requests change the same thing in different ways. A card asks the owner to choose.",
  revert_limit:
    "Stopped: this change landed and was taken back {MAX_REVISIONS} times. A card asks the owner what to do.",
  reopen_failed: "The agent that wrote this could not be reopened. A card offers a new attempt.",
  declined: "The owner declined this change. It is kept, not landed.",
  not_chosen: "Another attempt was chosen. This one is kept.",
  undone: "The owner undid this change.",
  lost: "Stopped: its agent could not be reached after the pool was rebuilt.",
  budget: "Stopped: it used up its budget of steps or tokens.",
  spend_cap: "Stopped: the spend cap is reached.",
  timeout: "Stopped: it ran longer than {ATTEMPT_TIMEOUT_MS as duration}.",
  model_error: "Stopped: the model failed {MODEL_RETRIES + 1} times in a row.",
  tool_timeout: "Stopped: Trunk did not answer a tool call.",
  stalled: "Stopped: it made no progress for {AGENT_WATCHDOG_MS as duration}.",
  killed: "Stopped by the kill switch.",
  cancelled: "The owner stopped this agent.",
  withdrawn:
    "The agent withdrew this change. Another change had already done the same work, or the change was no longer wanted.",
};

/** The "any other" form of 03 5.8 for a `stop_reason` the table does not name. */
export const STOP_FALLBACK = "Stopped ({stop_reason}).";

/**
 * The reasons whose sentence is NOT followed by "Its work so far is kept." (03 5.8, last line):
 * `declined`, `not_chosen`, `undone`, `lost` and `withdrawn`.
 */
export const STOP_NO_KEPT_SUFFIX = new Set(["declined", "not_chosen", "undone", "lost", "withdrawn"]);

/** The sentence that follows a stop sentence unless the reason is in `STOP_NO_KEPT_SUFFIX`. */
export const STOP_KEPT_SUFFIX = "Its work so far is kept.";

/** The full line a stopped attempt shows: the 5.8 sentence plus `STOP_KEPT_SUFFIX` where due. */
export function stopSentence(reason: string): string {
  const template = STOP_SENTENCES[reason];
  const sentence = template === undefined ? fill(STOP_FALLBACK, { stop_reason: reason }) : fill(template);
  return STOP_NO_KEPT_SUFFIX.has(reason) ? sentence : `${sentence} ${STOP_KEPT_SUFFIX}`;
}
