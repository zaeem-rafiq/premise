// The undo sheet's view-model (03-floor 3.12, the card rows of 5.10): the plan sentences —
// `undo.title`, `undo.also`/`undo.also.none`, `undo.kept`, `undo.in_flight` — resolved from the
// `UndoPlan` and the stream, so the component carries no decisions of its own.

import type { FloorState } from "../../../protocol/reducer/state.ts";
import type { UndoPlan } from "../../../protocol/undo.ts";
import { landingLabel } from "../../../copy/format.ts";
import { text } from "../../../copy/strings.ts";
import { whyCard } from "../../../protocol/reducer/why.ts";
import { attemptChangeName, landingChangeName } from "../why/model.ts";

/** What the sheet shows once a plan is on screen (3.12 live row). */
export type UndoPlanModel = {
  /** `undo.title`: 'Undo {landing}: "{intent text}"?' — the target's own name and ask. */
  title: string;
  /** `undo.also` — the landings of `plan.reverted` other than the target, each with its change
   * name — or `undo.also.none` when the target is the only one. */
  also: string;
  /** `undo.kept` — the readers of `plan.kept_readers` — or null when there are none (the spec
   * gives no "keeps nothing" sentence, so the line is absent). */
  kept: string | null;
  /** `undo.in_flight` — the in-flight attempts of `plan.repairs` that would receive `repair` —
   * or null when there are none. */
  inFlight: string | null;
};

/** Resolve the plan to its 5.10 sentences. `reverted` other than the target lists landings by
 * `landingChangeName` ("landing N {change name}"); `reopened`/`repairs` name attempts by
 * `attemptChangeName`. */
export function undoPlanModel(floor: FloorState, plan: UndoPlan, modelLabel: (id: string) => string): UndoPlanModel {
  const intentText = whyCard(floor, plan.target_seq).intentText ?? "";
  const others = plan.reverted.filter((seq) => seq !== plan.target_seq);
  return {
    title: text("undo.title", { landing: landingLabel(plan.target_seq), "intent text": intentText }),
    also:
      others.length === 0
        ? text("undo.also.none")
        : text("undo.also", {
            n: others.length,
            names: others.map((seq) => landingChangeName(floor, seq, modelLabel)).join(", "),
          }),
    kept:
      plan.kept_readers.length === 0
        ? null
        : text("undo.kept", {
            n: plan.kept_readers.length,
            names: plan.kept_readers.map((seq) => landingChangeName(floor, seq, modelLabel)).join(", "),
          }),
    inFlight:
      plan.repairs.length === 0
        ? null
        : text("undo.in_flight", {
            n: plan.repairs.length,
            names: plan.repairs.map((id) => attemptChangeName(floor, id, modelLabel)).join(", "),
          }),
  };
}
