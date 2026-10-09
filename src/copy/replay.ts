// 03-floor 8.3: the sentences `replay.error` shows for the check that failed when a recording is
// loaded. `replay.error`'s text is `{reason}`; the reason is one of these, filled.

import { fill } from "./fill.ts";

/** The "When it fails, `replay.error` reads" column of the 8.3 check table, in order. */
export const REPLAY_ERRORS: Readonly<Record<string, string>> = {
  download: "This recording could not be downloaded. Check the connection and try again.",
  too_large: "This recording is too large to play here.",
  not_a_recording: "This file is not a Premise recording that this page can play.",
  incomplete: "This recording is incomplete: it has {a} events and should have {b}.",
  damaged_line: "This recording is damaged at line {line}.",
  damaged_gap: "This recording is damaged: event {n} is missing.",
  damaged_time: "This recording is damaged: its times go backwards at event {n}.",
};

/** The `replay.error` reason for one failed check of 8.3. */
export function replayError(check: keyof typeof REPLAY_ERRORS, vars: Record<string, string | number> = {}): string {
  const template = REPLAY_ERRORS[check];
  if (template === undefined) throw new Error(`copy: no replay error for check "${check}"`);
  const counted =
    check === "incomplete" && vars.a === 1
      ? "This recording is incomplete: it has {a} event and should have {b}."
      : template;
  return fill(counted, vars);
}
