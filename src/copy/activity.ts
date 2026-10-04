// 03-floor 5.5: the activity line, built from `attempt.step`. `{target}` goes through `keyLabel`
// when it is a key, and is shown as given when it is a path, a directory or a search text. Only an
// entity key carries `#`, and no path, directory or search scope may contain one (01-core 2.1, 2.2),
// so `activityTarget` sends a target with `#` through `keyLabel("entity", …)` and nothing else.

import { fill } from "./fill.ts";
import { keyLabel } from "./names.ts";

/** The activity line of a model turn (`tool: null`). */
export const ACTIVITY_MODEL_TURN = "Thinking";

/** The activity line per tool (03 5.5). */
export const ACTIVITY_BY_TOOL: Readonly<Record<string, string>> = {
  outline: "Looking at the outline of {target}",
  read: "Reading {target}",
  list: "Listing {target}",
  search: 'Searching for "{target}"',
  write: "Writing {target}",
  replace: "Editing {target}",
  submit: "Submitting",
};

/** The line of one `attempt.step`. */
export function activityLine(step: { tool: string | null; target: string | null }): string {
  if (step.tool === null) return ACTIVITY_MODEL_TURN;
  const template = ACTIVITY_BY_TOOL[step.tool];
  if (template === undefined) throw new Error(`copy: no activity line for tool "${step.tool}"`);
  return fill(template, { target: step.target === null ? "" : activityTarget(step.target) });
}

/** `{target}` of the activity line: `keyLabel` for a key, as given for a path, directory or needle. */
export function activityTarget(target: string): string {
  return target.includes("#") ? keyLabel("entity", target) : target;
}

/**
 * The " · {seconds} s" the line adds after `QUIET_NOTICE_MS` without a new event (03 5.5).
 * Returns the suffix appended to the activity line.
 */
export function quietSuffix(seconds: number): string {
  return ` · ${seconds} s`;
}

/** The reason words of a failed step, by the `error` code of `attempt.step` (03 5.5). */
export const STEP_ERROR_REASONS: Readonly<Record<string, string>> = {
  not_found: "it does not exist",
  not_a_module: "it is not a JavaScript module",
  read_first: "the agent must read the file first",
  no_match: "the text to replace was not found",
  ambiguous: "the text to replace appears more than once",
  no_change: "it changes nothing",
  parse_error: "the result does not parse",
  heads_up_first: "the agent must read its heads-up first",
  too_large: "it is over a size limit",
  limit_reached: "it is over a size limit",
  pool_not_ready: "the pool is paused",
  timeout: "Trunk did not answer in time",
  invalid_path: "the call was not valid ({error})",
  invalid_args: "the call was not valid ({error})",
  binary: "the call was not valid ({error})",
  attempt_unknown: "the call was not valid ({error})",
  attempt_closed: "the call was not valid ({error})",
};

/** The reason of a failed step, or undefined when 5.5 gives none for the code (model-turn codes). */
export function stepErrorReason(error: string): string | undefined {
  const reason = STEP_ERROR_REASONS[error];
  return reason === undefined ? undefined : fill(reason, { error });
}

/**
 * A failed step reads "{line} did not work: {reason}. The agent tries another way." (03 5.5, FR2).
 * `line` is the activity line of the step (e.g. the result of `activityLine`). A code the table
 * does not name — the model-turn codes of `05-agent.md` TL12, which 5.5 leaves without a reason
 * (05 O10) — shows as the code itself.
 */
export function activityError(line: string, error: string): string {
  return `${line} did not work: ${stepErrorReason(error) ?? error}. The agent tries another way.`;
}
