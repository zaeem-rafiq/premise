// 03-floor 5.6: the judgment sentences, one per rule of `01-core.md` 7.2; the scripted answers a
// SYNTHETIC attempt uses instead of the ones that name Clef (TR8); the one-line forms of a
// collapsed attempt card; and the `tick.skipped` sentences. `{thing}` is `keyLabel`; in the QR4
// rows `{entity}` is the `keyLabel` of the entity the `refs:` premise is about.

import { fill } from "./fill.ts";

type Rule = string;
type Reason = string;

type SentenceRow = {
  readonly rules: readonly Rule[] | "any";
  /** The `reason` values that select this row; `"any"` matches every reason, `""` none recorded. */
  readonly reasons: readonly Reason[] | "any";
  readonly text: string;
};

/** The judgment sentences of 03 5.6, in the table's order; the earliest matching row decides. */
export const JUDGMENT_SENTENCES: readonly SentenceRow[] = [
  {
    rules: ["E1"],
    reasons: ["edited_entity_changed"],
    text: "Another change edited {thing}, and this change edits it too.",
  },
  {
    rules: ["E2"],
    reasons: ["referenced_entity_changed"],
    text: "{thing} changed, and this change uses it.",
  },
  {
    rules: ["E2m", "F3m"],
    reasons: ["module_reference_changed"],
    text: "{thing} changed, and other code in a file this change edits uses it. The agent must confirm.",
  },
  {
    rules: ["E3", "F4", "F6"],
    reasons: ["triage_depends"],
    text: "{thing} changed. Clef put the chance that this change depends on the old version at {share}. The agent must adapt.",
  },
  {
    rules: ["E3", "F4", "F6"],
    reasons: ["triage_unsure"],
    text: "{thing} changed. Clef put the chance that this change depends on the old version at {share}. The agent must confirm.",
  },
  {
    rules: ["E3", "F4", "F6"],
    reasons: ["reaffirmed"],
    text: "{thing} changed. Clef put the chance that this change depends on the old version at {share}. The agent was told.",
  },
  {
    rules: ["E3", "F4", "F6", "QT2"],
    reasons: ["triage_unavailable"],
    text: "{thing} changed. Clef was not available, so the agent must confirm.",
  },
  {
    // Pending: "no result yet; the reasons `read_not_referenced` and `search_gained_match`".
    rules: ["E3", "F4", "F6", "QT2"],
    reasons: ["read_not_referenced", "search_gained_match"],
    text: "{thing} changed. Clef is judging whether this change depends on it.",
  },
  {
    rules: ["E4", "F7"],
    reasons: ["reference_gone"],
    text: "This change no longer uses {thing}.",
  },
  {
    rules: "any",
    reasons: ["premise_gone"],
    text: "This change no longer relies on {thing}.",
  },
  {
    rules: ["F1"],
    reasons: ["write_base_changed"],
    text: "{thing} changed under a whole-file write.",
  },
  {
    rules: ["F2"],
    reasons: ["cosmetic"],
    text: "Only comments or spacing changed in {thing}. Nothing to do.",
  },
  {
    rules: ["F3"],
    reasons: ["referenced_entity_changed"],
    text: "{thing} changed in a part this change uses.",
  },
  {
    rules: ["F3", "F5"],
    reasons: ["referenced_file_changed"],
    text: "{thing} changed, and this change uses it.",
  },
  {
    rules: ["L1"],
    reasons: ["sweep_incomplete"],
    text: "{thing} gained a file while this change was editing the files there.",
  },
  {
    rules: ["L2"],
    reasons: ["listing_named"],
    text: "{thing} changed, and this change names one of those files.",
  },
  {
    rules: ["L3"],
    reasons: ["listing_unused"],
    text: "{thing} changed. This change does not depend on it.",
  },
  {
    rules: ["QT1"],
    reasons: ["sweep_incomplete"],
    text: "{thing} has a new match, and this change had edited the earlier matches.",
  },
  {
    rules: ["QT2"],
    reasons: ["triage_depends"],
    text: "{thing} has a new match. Clef put the chance that this change depends on it at {share}. The agent must adapt.",
  },
  {
    rules: ["QT2"],
    reasons: ["triage_unsure"],
    text: "{thing} has a new match. Clef put the chance that this change depends on it at {share}. The agent must confirm.",
  },
  {
    rules: ["QT2"],
    reasons: ["reaffirmed"],
    text: "{thing} has a new match. Clef put the chance that this change depends on it at {share}. The agent was told.",
  },
  {
    rules: ["QT3", "QR2"],
    reasons: ["match_lost"],
    text: "{thing} lost a match. Nothing to do.",
  },
  {
    rules: ["QR1"],
    reasons: ["new_reference_to_altered_entity"],
    text: "Another change now uses what this change alters: {added}.",
  },
  {
    rules: ["QR1m"],
    reasons: ["referrer_module_changed"],
    text: "A file that uses what this change alters was changed. The agent must confirm.",
  },
  {
    // Pending: "the reason `reader_landed`".
    rules: ["QR4"],
    reasons: ["reader_landed"],
    text: "A change whose agent had read {entity} landed. Clef is judging whether it depends on the version this change replaces.",
  },
  {
    rules: ["QR4"],
    reasons: ["triage_depends"],
    text: "A change whose agent had read {entity} landed. Clef put the chance that it depends on the old version at {share}. The agent must adapt.",
  },
  {
    rules: ["QR4"],
    reasons: ["triage_unsure"],
    text: "A change whose agent had read {entity} landed. Clef put the chance that it depends on the old version at {share}. The agent must confirm.",
  },
  {
    rules: ["QR4"],
    reasons: ["reaffirmed"],
    text: "A change whose agent had read {entity} landed. Clef put the chance that it depends on the old version at {share}. The agent was told.",
  },
  {
    rules: ["QR4"],
    reasons: ["triage_unavailable"],
    text: "A change whose agent had read {entity} landed. Clef was not available, so the agent must confirm.",
  },
  {
    rules: ["QO1"],
    reasons: ["outlined_entity_changed"],
    text: "{thing} changed in a part this change uses.",
  },
  {
    rules: ["QO2"],
    reasons: ["outline_unused"],
    text: "{thing} changed in a part this change does not use.",
  },
  {
    rules: ["B1"],
    reasons: ["blind_spot"],
    text: "The new code uses {thing}, and the agent never read it. Trunk showed it the current version.",
  },
  {
    rules: ["X0"],
    reasons: ["no_patch_yet"],
    text: "{thing} changed before this change wrote anything. The agent was told.",
  },
  {
    rules: ["Z1"],
    reasons: ["unclassified"],
    text: "{thing} changed in a way that no rule covers. The agent must confirm.",
  },
  // OP1 to OP5 come with an `op.dropped`, which carries a rule but no reason.
  { rules: ["OP1"], reasons: "any", text: "The text an edit replaced is gone from {path}." },
  {
    rules: ["OP2"],
    reasons: "any",
    text: "The text an edit replaced now appears more than once in {path}.",
  },
  {
    rules: ["OP3"],
    reasons: "any",
    text: "The text an edit replaced moved to another part of {path}.",
  },
  { rules: ["OP4"], reasons: "any", text: "{path} no longer exists." },
  { rules: ["OP5"], reasons: "any", text: "{path} changed under a whole-file write." },
  {
    rules: ["CKL"],
    reasons: ["checks_failed_at_landing"],
    text: "The checks failed on the newest code when this change was about to land.",
  },
  {
    rules: "any",
    reasons: ["push_lost"],
    text: "The push for this landing was lost when the pool was rebuilt. The change lands again.",
  },
  {
    rules: "any",
    reasons: "any",
    text: "{thing} changed ({rule}, {reason}).",
  },
];

/**
 * The scripted answers of 03 5.6: a synthetic attempt never calls Clef (`clef.model` is
 * `"scripted"`, `01-core.md` TR8), so these sentences replace the ones that name Clef, and no
 * share is shown.
 */
export const SCRIPTED_SENTENCES: Readonly<Record<string, string>> = {
  triage_depends: "{thing} changed. The script lists it as something this change depends on. The agent must adapt.",
  reaffirmed: "{thing} changed. The script does not list it as something this change depends on. The agent was told.",
  triage_unavailable: "{thing} changed. No answer was available, so the agent must confirm.",
};

/**
 * The judgment sentence for one (`rule`, `reason`) pair, with its placeholders kept (03 5.6).
 * `scripted` is `judgment.clef.model === "scripted"`. The last row of the table is the
 * "{thing} changed ({rule}, {reason})." form for any other pair.
 */
export function judgmentSentence(rule: Rule, reason: Reason | null, scripted = false): string {
  if (scripted) {
    const sentence = SCRIPTED_SENTENCES[reason ?? ""];
    if (sentence !== undefined) return sentence;
  }
  for (const row of JUDGMENT_SENTENCES) {
    if (row.rules !== "any" && !row.rules.includes(rule)) continue;
    if (row.reasons !== "any" && !row.reasons.includes(reason ?? "")) continue;
    return row.text;
  }
  throw new Error("copy: the catch-all judgment row is missing");
}

/** The one-line forms on a collapsed attempt card (03 5.6), by heads-up result. */
export const HEADSUP_ONE_LINE: Readonly<Record<"repair" | "confirm" | "info", string>> = {
  repair: "{keyShort} changed. The diff was sent to the agent.",
  confirm: "{keyShort} changed. The agent must confirm.",
  info: "{keyShort} changed. The agent was told.",
};

/** The one-line form on a collapsed attempt card (03 5.6); `key` is the premise's `keyShort`. */
export function headsupOneLine(result: "repair" | "confirm" | "info", key: string): string {
  return fill(HEADSUP_ONE_LINE[result], { keyShort: key });
}

/** The `tick.skipped` sentences by `why` (03 5.6); `behind` is a `changeName` for `right_of_way`. */
export const TICK_SKIPPED: Readonly<Record<string, string>> = {
  not_disjoint: "It overlaps a change in this batch. Trunk checks it against the new code next.",
  right_of_way: "Waiting behind {changeName of `behind`}, which has right of way.",
  checks_failed: "The checks failed on the newest code. The agent gets the reason and adapts.",
  held: "Under the newest policy this change touches a held path. A card asks the owner.",
};

/** The line a skipped attempt shows (03 5.6); `behind` is the `changeName` of `skipped.behind`. */
export function tickSkipped(why: string, behind?: string): string {
  const template = TICK_SKIPPED[why];
  if (template === undefined) throw new Error(`copy: no tick.skipped sentence for "${why}"`);
  // The spec names the placeholder `changeName of `behind``; its varName is `changeName`.
  return fill(template, { changeName: behind ?? "{behind}" });
}
