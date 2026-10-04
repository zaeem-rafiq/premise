// 03-floor 5.9: what a failed request shows next to the control that sent it, and as a toast.
// The cases are HTTP statuses plus the refusals Trunk reports in the response body; the five undo
// reasons are the values of `UndoRefusal` (01-core 11.3) and fill `{reason}` of `undo.refused`.

import { fill } from "./fill.ts";
import { STRINGS } from "./strings.ts";

/** The undo-refusal sentences of 03 5.9 — the `UndoRefusal` values of `01-core.md` 11.3. */
export const UNDO_REFUSAL_REASONS: Readonly<Record<string, string>> = {
  not_a_change: "that landing is an undo or a revert, and those cannot be undone",
  already_undone: "that landing is already undone",
  too_old: "that landing is too far back",
  too_many: "it would take back more than {MAX_BATCH} changes at once",
  plan_changed: "the pool changed while the plan was open (the sheet then shows the new plan, 3.12)",
};

/** The `{reason}` of `undo.refused` for an `UndoRefusal`. */
export function undoRefusalReason(reason: string): string {
  const template = UNDO_REFUSAL_REASONS[reason];
  if (template === undefined) throw new Error(`copy: no undo refusal for "${reason}"`);
  return fill(template);
}

/** The 5.9 cases that are an HTTP status: status -> sentence, `feature_off` kept separate. */
export const REQUEST_ERRORS: Readonly<Record<number, string>> = {
  401: "The owner key is needed for this. Unlock, then try again.",
  403: "The server refused this request. Reload the page and try again.",
  404: "That no longer exists. The page shows the newest state.",
  409: "This was already answered. The page shows the newest state.",
  413: "Use {MAX_INTENT_CHARS} characters or fewer.",
  429: "Too many requests. Wait a moment, then try again.",
};

/** `404` with the code `feature_off` (03 5.9). */
export const REQUEST_ERROR_FEATURE_OFF = "This build does not have that feature.";
/** `503` with no owner key configured: the `owner.not_configured` string (03 5.9). */
export const REQUEST_ERROR_NO_OWNER_KEY = "owner.not_configured";
/** `503`, pool not ready (03 5.9). */
export const REQUEST_ERROR_POOL_NOT_READY = "The pool is paused. Nothing new can start.";
/** Refused: kill switch (03 5.9). */
export const REQUEST_ERROR_KILLED = "All agents are stopped. Allow agents again first.";
/** Refused: spend cap (03 5.9). */
export const REQUEST_ERROR_SPEND_CAP = "The spend cap is reached. No model call can start.";
/** No answer (network) (03 5.9). */
export const REQUEST_ERROR_NETWORK = "The request did not reach the server. Check the connection and try again.";
/** Any other status (03 5.9); `{status}` is the HTTP status. */
export const REQUEST_ERROR_OTHER = "Something went wrong (status {status}). Nothing was changed. Try again.";

/**
 * The sentence a failed request shows (03 5.9). `status` is the HTTP status, or null when the
 * request never reached the server. `code` is a refusal code the response carries
 * (`feature_off`, `killed`, `spend_cap`, `owner_not_configured` — a code of the SE5b list).
 */
export function errorSentence(status: number | null, code?: string): string {
  if (status === null) return REQUEST_ERROR_NETWORK;
  if (code === "killed") return REQUEST_ERROR_KILLED;
  if (code === "spend_cap") return REQUEST_ERROR_SPEND_CAP;
  if (status === 404 && code === "feature_off") return REQUEST_ERROR_FEATURE_OFF;
  if (status === 503) {
    if (code === "owner_not_configured") return STRINGS["owner.not_configured"]!.text;
    return REQUEST_ERROR_POOL_NOT_READY;
  }
  const template = REQUEST_ERRORS[status];
  return template === undefined ? fill(REQUEST_ERROR_OTHER, { status }) : fill(template);
}
