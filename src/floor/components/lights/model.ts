// The premise rows of the expanded attempt card (03-floor 3.3, CO17): one row per premise with
// its light, keyLabel, word, flags, the newest judgment sentence (5.6) and the `who.open` link.
// Pure functions of `FloorState` — the sentences come from `src/copy`, never the component.

import type { HeadsUpItem } from "../../../protocol/headsup.ts";
import type { AttemptView, FloorState, PremiseView } from "../../../protocol/reducer/state.ts";
import { premiseId } from "../../../protocol/reducer/state.ts";
import { fill } from "../../../copy/fill.ts";
import { share } from "../../../copy/format.ts";
import { keyLabel, keyShort } from "../../../copy/names.ts";
import { judgmentSentence } from "../../../copy/sentences.ts";
import { text } from "../../../copy/strings.ts";

/** One row of the expanded card's "Relies on" list (CO17). */
export type PremiseRow = {
  id: string;
  light: PremiseView["light"];
  edit: boolean;
  label: string;
  word: string;
  flags: string;
  /** The newest judgment sentence of 5.6, or null while the premise has no judgment yet. */
  sentence: string | null;
};

/** The flags of a premise row as words (5.3): read, edit, derived, in that order. */
export function premiseFlags(premise: PremiseView): string {
  return [
    premise.read ? text("light.flag.read") : null,
    premise.edit ? text("light.flag.edit") : null,
    premise.derived ? text("light.flag.derived") : null,
  ]
    .filter((flag): flag is string => flag !== null)
    .join(", ");
}

/** The newest heads-up item that judges `kind`/`key`, or null (the items carry the detail). */
function newestItem(attempt: AttemptView, kind: PremiseView["kind"], key: string): HeadsUpItem | null {
  let found: HeadsUpItem | null = null;
  let hn = -1;
  for (const headsup of Object.values(attempt.heads_ups)) {
    if (headsup.hn <= hn || headsup.items === null) continue;
    const item = headsup.items.find((entry) => entry.premise.kind === kind && entry.premise.key === key);
    if (item !== undefined) {
      found = item;
      hn = headsup.hn;
    }
  }
  return found;
}

/**
 * The judgment sentence of a premise row (03 5.6): the copy row for (`rule`, `reason`), filled
 * with the premise's own `keyLabel`, Clef's share, and for the QR rows the `refs:` entity or the
 * added referrers of its heads-up item.
 */
export function judgmentLine(attempt: AttemptView, premise: PremiseView): string | null {
  const judgment = premise.judgment;
  if (judgment === null) return null;
  const scripted = judgment.clef?.model === "scripted" || attempt.agent === "synthetic";
  const sentence = judgmentSentence(judgment.rule, judgment.reason, scripted);
  const item = newestItem(attempt, premise.kind, premise.key);
  const entity =
    premise.kind === "query" && premise.key.startsWith("refs:")
      ? keyLabel("entity", premise.key.slice(5))
      : keyLabel(premise.kind, premise.key);
  const added =
    item !== null && item.diff.kind === "query"
      ? item.diff.added.map((entry) => keyLabel("entity", entry.key)).join(", ")
      : keyShort(premise.kind, premise.key);
  return fill(sentence, {
    thing: keyLabel(premise.kind, premise.key),
    share: share(judgment.clef?.p ?? null),
    path: premise.key,
    entity,
    added,
    rule: judgment.rule,
    reason: judgment.reason,
  });
}

/** The rows of CO17, in the lights' order (CO14): non-`holds` first, then `holds` recorded order. */
export function premiseRows(floor: FloorState, attempt: AttemptView, ordered: PremiseView[]): PremiseRow[] {
  if (floor.pool.summary_only) return [];
  return ordered.map((premise) => ({
    id: premiseId(premise.kind, premise.key),
    light: premise.light,
    edit: premise.edit,
    label: keyLabel(premise.kind, premise.key),
    word: text(`light.${premise.light}`),
    flags: premiseFlags(premise),
    sentence: judgmentLine(attempt, premise),
  }));
}
