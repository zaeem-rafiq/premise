// The Why card's display derivations (03-floor 3.9): names, sentences and lists, built from the
// pure `WhyCard` of `src/protocol/reducer/why.ts` and the copy of `src/copy`. The page adds no
// judgment of its own (CO32) — every line below formats stream or note fields with copy ids.

import { fill } from "../../../copy/fill.ts";
import { DASH, landingLabel, share, timeOfDay } from "../../../copy/format.ts";
import { changeName, keyLabel } from "../../../copy/names.ts";
import { judgmentSentence } from "../../../copy/sentences.ts";
import { submitCheckLabel } from "../../../copy/checks.ts";
import { RISK_FOOTER, RISK_LINES, riskShare } from "../../../copy/cards.ts";
import { text } from "../../../copy/strings.ts";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import type { WhyCard, WhyItem, WhyUnder } from "../../../protocol/reducer/why.ts";

/** The card's `{changeName}`: from the note's premises when it carries them (they hold `hash`,
 * which the created-file case needs), else the frozen premise views. */
export function whyName(card: WhyCard, modelLabel: (id: string) => string): string {
  const notePremises = card.note?.premises;
  return changeName({
    intentText: card.intentText ?? "",
    race: card.race,
    model: card.model,
    premises:
      notePremises !== undefined && notePremises !== null && notePremises.length > 0
        ? notePremises.map((p) => ({ kind: p.kind, key: p.key, edit: p.edit, hash: p.hash ?? undefined }))
        : card.premises.map((p) => ({ kind: p.kind, key: p.key, edit: p.edit })),
  });
}

/** `why.head`: "{changeName} · {landing} · {time of day}". */
export function whyHeadline(card: WhyCard, modelLabel: (id: string) => string): string {
  return text("why.head", {
    changeName: whyName(card, modelLabel),
    landing: landingLabel(card.seq),
    time: card.landedTs !== null ? timeOfDay(card.landedTs) : DASH,
  });
}

/** The sheet's accessible title (CO31): undo/revert landings name what they took back. */
export function whyTitle(state: FloorState, card: WhyCard): string {
  if (card.kind === "undo" && card.undo !== null) return text("why.undo.title", { landing: landingLabel(card.undo.targetSeq) });
  if (card.kind === "revert" && card.undo !== null)
    return text("why.revert.title", { landings: card.undo.tookBack.map(landingLabel).join(", ") });
  if (card.kind === "undo") return text("why.undo.title", { landing: landingLabel(0) });
  if (card.kind === "revert") return text("why.revert.title", { landings: "" });
  return text("why.title");
}

/** The rule sentence of one `why.under` row (5.6), filled like a heads-up item's. */
export function itemSentence(item: WhyItem): string {
  const isRefs = item.kind === "query" && item.key.startsWith("refs:");
  return fill(judgmentSentence(item.rule, item.reason, item.scripted), {
    thing: keyLabel(item.kind, item.key),
    share: DASH,
    path: item.key,
    entity: isRefs ? keyLabel("entity", item.key.slice(5)) : keyLabel(item.kind, item.key),
    added: item.added.length > 0 ? item.added.map((key) => keyLabel("entity", key)).join(", ") : keyLabel(item.kind, item.key),
    rule: item.rule,
    reason: item.reason ?? "",
  });
}

/** One row of "What changed under it": `why.under.goaround` or `why.under.confirm`. */
export function underLine(under: WhyUnder, item: WhyItem): string {
  const sentence = itemSentence(item);
  if (under.result === "confirm") return text("why.under.confirm", { "rule sentence": sentence });
  return text("why.under.goaround", {
    n: under.n ?? 0,
    "rule sentence": sentence,
    landing: item.causeSeq !== null ? landingLabel(item.causeSeq) : (under.causeSeq !== null ? landingLabel(under.causeSeq) : DASH),
    "intent text": under.causeIntent ?? "",
  });
}

/** The agent's own words after the row (the `headsup.said` line of 3.4). */
export function saidLine(statement: string): string {
  return text("headsup.said", { statement });
}

/** `why.landed.*` filled (3.9): `{time of day}` and `{n}` of `chosen`. */
export function landedLine(card: WhyCard): string | null {
  const how = card.landedHow;
  if (how === null) return null;
  return text(how.id, { time: how.ts !== null ? timeOfDay(how.ts) : DASH, n: how.n });
}

/** The change name another landing carries (for the undo lists of CO31). */
export function landingChangeName(state: FloorState, seq: number, modelLabel: (id: string) => string): string {
  const entry = state.landings[seq];
  if (entry === undefined) return landingLabel(seq);
  const intent = entry.intent_id !== null ? state.intents[entry.intent_id] : undefined;
  const attempt = entry.attempt_id !== null ? state.attempts[entry.attempt_id] : undefined;
  const name = changeName({
    intentText: intent?.text ?? "",
    race: intent?.race ?? attempt?.race ?? false,
    model: attempt?.model ?? null,
    premises: entry.digest === true ? [] : entry.premises,
  });
  return `${landingLabel(seq)} ${name}`;
}

/** The change name an attempt carries (for `why.undo.reopened`). */
export function attemptChangeName(state: FloorState, attemptId: string, modelLabel: (id: string) => string): string {
  const attempt = state.attempts[attemptId];
  if (attempt === undefined) return attemptId;
  const intent = state.intents[attempt.intent_id];
  return changeName({
    intentText: intent?.text ?? "",
    race: intent?.race ?? attempt.race,
    model: attempt.model,
    premises: Object.values(attempt.premises),
  });
}

/** `why.undo.took_back`, `why.undo.reopened`, `why.undo.kept` — the three CO31 lines. */
export function undoLines(
  state: FloorState,
  card: WhyCard,
  modelLabel: (id: string) => string,
): { tookBack: string | null; reopened: string | null; kept: string | null } {
  const undo = card.undo;
  if (undo === null) return { tookBack: null, reopened: null, kept: null };
  return {
    tookBack:
      undo.tookBack.length > 0
        ? text("why.undo.took_back", {
            "list of landings with change names": undo.tookBack.map((seq) => landingChangeName(state, seq, modelLabel)).join(", "),
          })
        : null,
    reopened:
      undo.reopened.length > 0
        ? text("why.undo.reopened", { list: undo.reopened.map((id) => attemptChangeName(state, id, modelLabel)).join(", ") })
        : null,
    kept:
      undo.kept.length > 0
        ? text("why.undo.kept", { list: undo.kept.map((seq) => landingChangeName(state, seq, modelLabel)).join(", ") })
        : null,
  };
}

/** `why.checked.count` and the check labels of `why.checked.all` (3.9). */
export function checkLines(card: WhyCard): { count: string; labels: string[] } | null {
  return {
    count: text("why.checked.count", { ok: card.checks.filter((check) => check.ok).length, all: card.checks.length }),
    labels: card.checks.map((check) => submitCheckLabel(check.name, check.detail)),
  };
}

/** The `why.relied` rows: light, keyLabel and flags per frozen premise. */
export function reliedRows(card: WhyCard): Array<{ id: string; label: string; flags: string[]; light: WhyCard["premises"][number]["light"]; edit: boolean }> {
  return card.premises.map((premise) => ({
    id: `${premise.kind} ${premise.key}`,
    label: keyLabel(premise.kind, premise.key),
    flags: [
      premise.read ? text("light.flag.read") : null,
      premise.edit ? text("light.flag.edit") : null,
      premise.derived ? text("light.flag.derived") : null,
    ].filter((flag): flag is string => flag !== null),
    light: premise.light,
    edit: premise.edit,
  }));
}

/** The Clef risk lines of `why.landed_how` (5.10's RISK_LINES + footer), when the card has them. */
export function riskLines(card: WhyCard): { lines: string[]; footer: string } | null {
  const risk = card.risk;
  if (risk === null || risk === undefined) return null;
  return {
    lines: [
      fill(RISK_LINES.does_what_asked, { share: riskShareText(risk.does_what_asked) }),
      fill(RISK_LINES.changes_shared_meaning, { share: riskShareText(risk.changes_shared_meaning) }),
      fill(RISK_LINES.unrelated_edits, { share: riskShareText(risk.unrelated_edits) }),
    ],
    footer: fill(RISK_FOOTER, { model: risk.model }),
  };
}

function riskShareText(x: number | null): string {
  return riskShare(x, share);
}
