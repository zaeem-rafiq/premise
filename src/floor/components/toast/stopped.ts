import { stopSentence } from "../../../copy/stops.ts";

const FAILURE_STOPS = new Set([
  "model_error",
  "tool_timeout",
  "stalled",
  "timeout",
  "budget",
  "spend_cap",
  "killed",
  "lost",
]);
/** FR4 names the stop reasons that need a toast as well as the attempt card. */
export function stoppedToast(reason: string | null): string | null {
  return reason !== null && FAILURE_STOPS.has(reason) ? stopSentence(reason) : null;
}
