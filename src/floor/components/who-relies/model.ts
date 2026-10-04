// Small display helpers for the Who relies panel (03-floor 3.11).

import { text } from "../../../copy/strings.ts";
import type { PremiseView } from "../../../protocol/reducer/state.ts";

/** The flags of the premise that matched, as words (5.3): read, edit, derived, in that order. */
export function lightFlagWords(premise: Pick<PremiseView, "read" | "edit" | "derived">): string {
  return [
    premise.read ? text("light.flag.read") : null,
    premise.edit ? text("light.flag.edit") : null,
    premise.derived ? text("light.flag.derived") : null,
  ]
    .filter((flag): flag is string => flag !== null)
    .join(", ");
}
