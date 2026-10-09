// The card sheet's view-model (03-floor 3.13, 3.14, 2.4): everything the sheet shows comes out of
// the `CardView` and the reducer state here, so the component carries no decisions and no text of
// its own. The sheet serves the three kinds of 2.4 (`held`, `choice`, `race`) in the no-frames
// form: `held.changes`, the blast sentences and relied-on counts (CO35), the checks and lights,
// the risk lines of 5.10, and for a race one column per candidate.

import type { AttemptView, CardView, FloorState, LandingEntry } from "../../../protocol/reducer/state.ts";
import { premiseId } from "../../../protocol/reducer/state.ts";
import type { Card, CardOption, FrameAddress } from "../../../protocol/cards.ts";
import { blastSentence, RISK_FOOTER, RISK_LINES, riskShare } from "../../../copy/cards.ts";
import { fill } from "../../../copy/fill.ts";
import { duration, money, share } from "../../../copy/format.ts";
import { changeName, keyLabel } from "../../../copy/names.ts";
import { stopSentence } from "../../../copy/stops.ts";
import { text } from "../../../copy/strings.ts";
import { inFlight } from "../../state/derive.ts";
import { checkRows, checksSummary, visibleLights } from "../attempt-card/model.ts";
import type { LightView } from "../attempt-card/model.ts";

/** What one "What it changes" row shows (03 3.13): path, tier tag and the entity keys it names. */
export type ChangeRow = { path: string; tier: "auto" | "held" | null; tierLabel: string | null; entities: string[] };

/** One candidate column of the race sheet (03 3.14), in `Card.attempt_ids` order. */
export type RaceColumn = {
  attemptId: string;
  /** `modelName` of the attempt's model, resolved against `/floor.json` by the caller. */
  modelId: string;
  /** The attempt's visible lights (CO14). Empty in a `summary_only` pool. */
  lights: LightView[];
  /** Holds omitted by CO14, shown as `light.more` after the lights. */
  lightsMore: number;
  /** The `why.checked.count` line of the column, or null with no submit yet. */
  checks: string | null;
  /** `race.took` or `race.unknown` when the card carries null (CO39). */
  took: string;
  /** `race.cost` or `race.unknown` (CO39). */
  cost: string;
  /** `race.blast` with the `repair` count of `Card.blast_radius[id]`. */
  blast: string;
  /** `can_choose` of `Card.candidates[id]`, the card open, and the reader the owner: the button
   * is only on offer while true (CO38; 3.14 held row gives a visitor no button). */
  canChoose: boolean;
  /** The column's preview frame address (`Card.preview.after[id]` of a candidate that can be
   * chosen, 3.14 live row); null while the candidate works or is stopped (3.14 loading row: "no
   * frame") and when no preview exists. */
  frameAddress: FrameAddress | null;
  /** `held.no_preview` for a choosable candidate the card has no preview for (3.14 error row —
   * `preview.error`, no `after` entry or `preview` itself null all count); null otherwise. */
  frameNote: string | null;
  /** The state line of a candidate that cannot be chosen: `race.working` with the status word and
   * step count while the attempt runs (3.14 loading row), or the stopped line (`race.stopped` +
   * `stop.<reason>`, `race.chosen`, `status.not_chosen`, `race.superseded`). Null for a candidate
   * that can be chosen. */
  stateLine: string | null;
};

/** What the sheet renders, already resolved to sentences. */
export type CardSheetModel = {
  cardId: string;
  kind: CardView["card"]["kind"];
  title: string;
  body: string[];
  /** `why.asked.line` of the card's one intent, or null when it names several. */
  intentLine: string | null;
  /** The closed-state sentence (3.13 stopped rows), or null while the card is open. */
  closedSentence: string | null;
  closedByOwner: boolean;
  /** `features.held` false (HD1): no frames, no `held.affects`, no risk lines. */
  minimal: boolean;
  /** The held sheet's two commit frames of the state table (3.13, CO36): the `FrameAddress`es to
   * play, with the in-place sentence each cell carries when it has no address
   * (`held.preview_building` while the preview commit is being built, `held.no_preview` when none
   * exists — FR32). Null in the minimal form (HD1), for `choice` and `race` cards and for a closed
   * card. */
  frames: {
    before: FrameAddress | null;
    beforeNote: string | null;
    after: FrameAddress | null;
    afterNote: string | null;
  } | null;
  changes: ChangeRow[] | null;
  /** `held.affects` lines: the blast sentence, then `held.relied_inflight`, `held.relied_landed`. */
  affects: string[] | null;
  /** `held.checked`: summary, the attempt's lights, `held.blind` when blind spots confirmed. */
  checked: {
    summary: string | null;
    checks: { label: string; ok: boolean; error: string | null }[] | null;
    lights: LightView[];
    lightsMore: number;
    blind: string | null;
  } | null;
  /** The risk block: three `RISK_LINES` and `RISK_FOOTER`, or the waiting/unavailable sentence. */
  risk: { kind: "lines"; lines: string[]; footer: string } | { kind: "note"; note: string } | null;
  race: RaceColumn[] | null;
  /** The reason field's label; null for a visitor (3.13 held row). */
  reasonLabel: string | null;
  /** `Card.options` as sent, in order (CD4, CD5). The first is the primary button (2.4). */
  options: { id: CardOption; label: string; tip: string | null }[];
  /** The `submit_ids` of the card, sent back verbatim with the action (CO35). */
  submitIds: Record<string, string>;
};

/** `changeName` of an attempt, or of the intent when the attempt is already gone. */
function attemptName(state: FloorState, attemptId: string | null): string {
  const attempt = attemptId === null ? undefined : state.attempts[attemptId];
  if (attempt !== undefined) {
    const intent = state.intents[attempt.intent_id];
    return changeName({
      intentText: intent?.text ?? "",
      race: attempt.race,
      model: attempt.model,
      premises: Object.values(attempt.premises).map((p) => ({ kind: p.kind, key: p.key, edit: p.edit, hash: p.hash })),
    });
  }
  return "";
}

/** The premise ids (`kind + " " + key`) the card's change alters: the `edit` premises of its
 * attempts (03 3.13: "the keys the change alters", for `whoRelies`). */
export function alteredKeys(state: FloorState, view: CardView): Set<string> {
  const keys = new Set<string>();
  for (const id of view.card.attempt_ids) {
    const attempt = state.attempts[id];
    if (attempt === undefined) continue;
    for (const premise of Object.values(attempt.premises)) {
      if (premise.edit) keys.add(premiseId(premise.kind, premise.key));
    }
  }
  return keys;
}

/** `held.relied_inflight`, computed live: the attempts in flight with a premise on an altered key. */
export function reliedInflight(state: FloorState, view: CardView): { n: number; names: string[] } {
  const keys = alteredKeys(state, view);
  const names: string[] = [];
  for (const attempt of Object.values(state.attempts)) {
    if (!inFlight(attempt) || view.card.attempt_ids.includes(attempt.id)) continue;
    if (Object.values(attempt.premises).some((p) => keys.has(premiseId(p.kind, p.key)))) {
      names.push(attemptName(state, attempt.id));
    }
  }
  return { n: names.length, names: names.sort() };
}

/** `held.relied_landed`: the kept landings (`FLOOR_KEEP_LANDINGS` full or digest) that hold a
 * premise key the change alters. */
export function reliedLanded(state: FloorState, view: CardView): number {
  const keys = alteredKeys(state, view);
  let n = 0;
  for (const seq of state.landed_order) {
    const landing: LandingEntry | undefined = state.landings[seq];
    if (landing === undefined) continue;
    const hits =
      landing.digest === true
        ? landing.premise_keys.some((k) => keys.has(premiseId(k.kind, k.key)))
        : landing.premises.some((p) => keys.has(premiseId(p.kind, p.key)));
    if (hits) n++;
  }
  return n;
}

/** The closed-state sentence of 3.13's stopped rows and 3.14's (5.10). */
export function closedSentence(state: FloorState, view: CardView): string {
  const closed = view.closed;
  if (closed === null) return "";
  const { action } = closed;
  if (action === "stale") return text("held.stale");
  if (action === "superseded") {
    return view.card.kind === "race" ? text("race.superseded") : text("held.stale");
  }
  if (view.card.kind === "race") {
    return text("race.closed", { changeName: attemptName(state, closed.attempt_id) });
  }
  if (view.card.kind === "choice") {
    const label = view.card.options.find((o) => o.id === action)?.label ?? action;
    return text("choice.closed", { "option label": label });
  }
  // held: the three owner actions each have their sentence (5.4).
  if (action === "land" || action === "land_now" || action === "decline") {
    return text(`held.closed.${action}`);
  }
  const label = view.card.options.find((o) => o.id === action)?.label ?? action;
  return text("choice.closed", { "option label": label });
}

/** The intent line of the sheet (`owner: "…"`), shown when the card names exactly one intent. */
function intentLine(state: FloorState, view: CardView): string | null {
  if (view.card.intent_ids.length !== 1) return null;
  const intent = state.intents[view.card.intent_ids[0]!];
  if (intent === undefined) return null;
  return text("why.asked.line", { requester: intent.requester, "intent text": intent.text });
}

/** The `held.changes` rows: `Card.paths` with the tier tag and the attempt's entities per path. */
function changeRows(state: FloorState, view: CardView): ChangeRow[] {
  return view.card.paths.map((entry) => {
    const entities = new Set<string>();
    for (const id of view.card.attempt_ids) {
      const attempt = state.attempts[id];
      if (attempt === undefined) continue;
      for (const op of attempt.ops) {
        if (op.path !== entry.path || op.dropped) continue;
        for (const key of [...op.altered, ...op.added, ...op.removed]) entities.add(keyLabel("entity", key));
      }
      for (const premise of Object.values(attempt.premises)) {
        if (premise.kind === "entity" && premise.key.startsWith(`${entry.path}#`) && premise.edit) {
          entities.add(keyLabel("entity", premise.key));
        }
      }
    }
    return {
      path: entry.path,
      tier: entry.tier,
      tierLabel: entry.tier === "held" ? text("tile.held") : null,
      entities: [...entities].sort(),
    };
  });
}

/** `held.affects`: the blast sentence of `Card.blast_radius[attempt_id]` (CO35), then the two
 * live whoRelies counts. */
function affectsRows(state: FloorState, view: CardView): string[] {
  const lines: string[] = [];
  const id = view.card.attempt_ids[0];
  const radius = id === undefined ? undefined : view.card.blast_radius[id];
  if (radius !== undefined) {
    const names = (ids: string[]) => ids.map((a) => attemptName(state, a));
    lines.push(
      blastSentence(radius, {
        repair: names(radius.repair),
        confirm: names(radius.confirm),
        triage: names(radius.triage),
        rightOfWay: radius.right_of_way.length > 0 ? attemptName(state, radius.right_of_way[0]!) : undefined,
      }),
    );
  }
  const inflight = reliedInflight(state, view);
  if (inflight.n > 0) {
    lines.push(text("held.relied_inflight", { n: inflight.n, names: inflight.names.join(", ") }));
  }
  const landed = reliedLanded(state, view);
  if (landed > 0) lines.push(text("held.relied_landed", { n: landed }));
  return lines;
}

/** `held.checked`: the checks summary and rows, the lights row and the blind-spot count. A
 * blind spot "confirmed by the agent" is a premise whose judgment came back under B1. */
function checkedBlock(state: FloorState, view: CardView): CardSheetModel["checked"] {
  const id = view.card.attempt_ids[0];
  const attempt = id === undefined ? undefined : state.attempts[id];
  if (attempt === undefined) return null;
  const blind = Object.values(attempt.premises).filter(
    (premise) => premise.light === "blind_spot" || premise.judgment?.rule === "B1",
  ).length;
  const { lights, more } = visibleLights(state, attempt);
  return {
    summary: checksSummary(attempt),
    checks: checkRows(attempt),
    lights,
    lightsMore: more,
    blind: blind > 0 ? text("held.blind", { n: blind }) : null,
  };
}

/** The risk block of 5.10: the three lines and footer, `held.risk_waiting` while Clef has not
 * answered, `held.risk_unavailable` on `Card.risk.error`. */
function riskBlock(view: CardView, clef: boolean): CardSheetModel["risk"] {
  const risk = view.card.risk;
  if (risk === null) return clef ? { kind: "note", note: text("held.risk_waiting") } : null;
  if (risk.error !== undefined) return { kind: "note", note: text("held.risk_unavailable") };
  return {
    kind: "lines",
    lines: [
      fill(RISK_LINES.does_what_asked, { share: riskShare(risk.does_what_asked, share) }),
      fill(RISK_LINES.changes_shared_meaning, { share: riskShare(risk.changes_shared_meaning, share) }),
      fill(RISK_LINES.unrelated_edits, { share: riskShare(risk.unrelated_edits, share) }),
    ],
    footer: fill(RISK_FOOTER, { model: risk.model }),
  };
}

/** The held sheet's frame cells (3.13's state table): `before` is `Card.preview.before`, `after`
 * is `Card.preview.after[attempt_id]` of the card's attempt (CO36). While the preview commit is
 * being built (PV1) the cell carries `held.preview_building`; a `preview.error` reads
 * `held.no_preview` in the after frame only (FR32 — the spec gives no `before`-missing row, so a
 * null `before` keeps the building sentence). */
function heldFrames(card: Card): NonNullable<CardSheetModel["frames"]> {
  const preview = card.preview;
  if (preview === null) {
    const building = text("held.preview_building");
    return { before: null, beforeNote: building, after: null, afterNote: building };
  }
  const id = card.attempt_ids[0];
  const after = id === undefined ? undefined : preview.after[id];
  return {
    before: preview.before,
    beforeNote: preview.before === null ? text("held.preview_building") : null,
    after: after ?? null,
    afterNote:
      preview.error !== null ? text("held.no_preview") : after === undefined ? text("held.preview_building") : null,
  };
}

/** One race column (03 3.14's table): facts from `Card.candidates`, `Card.blast_radius` and the
 * attempt; the state line from the candidate and the card's own `closed`. */
function raceColumn(state: FloorState, view: CardView, attemptId: string, visitor: boolean): RaceColumn {
  const card = view.card;
  const attempt = state.attempts[attemptId];
  const candidate = card.candidates?.[attemptId];
  const radius = card.blast_radius[attemptId];
  const chosen = view.closed?.action === "choose" ? view.closed.attempt_id : null;
  let stopped: string | null = null;
  if (chosen !== null) {
    stopped = chosen === attemptId ? text("race.chosen") : text("status.not_chosen");
  } else if (candidate !== undefined && !candidate.can_choose && attempt !== undefined && !inFlight(attempt)) {
    stopped =
      attempt.stop_reason === null
        ? text("race.stopped")
        : `${text("race.stopped")} ${stopSentence(attempt.stop_reason)}`;
  } else if (view.closed?.action === "superseded") {
    stopped = text("race.superseded");
  }
  const working =
    stopped === null && candidate !== undefined && !candidate.can_choose && attempt !== undefined && inFlight(attempt)
      ? { word: attemptStatusWord(attempt), steps: attempt.steps }
      : null;
  const preview = card.preview;
  const choosable = candidate?.can_choose === true;
  let frameAddress: FrameAddress | null = null;
  let frameNote: string | null = null;
  let stateLine: string | null = null;
  if (choosable && view.closed === null) {
    // 3.14 error row: the card has no preview for a choosable candidate — `preview.error`, no
    // `after` entry or `preview` itself null — reads `held.no_preview`. (3.14 names no
    // preview_building state; `held.no_preview` stands in for the still-building case.)
    const address = preview !== null && preview.error === null ? preview.after[attemptId] : undefined;
    if (address === undefined) frameNote = text("held.no_preview");
    else frameAddress = address;
  } else {
    // 3.14 loading/stopped rows: the state line, no frame. An attempt gone from `floor.attempts`
    // with no stop reason reads `race.stopped` — the spec gives no closer sentence.
    stateLine =
      stopped ??
      (working !== null ? `${text("race.working")} · ${working.word} · step ${working.steps}` : text("race.stopped"));
  }
  const { lights, more } = attempt === undefined ? { lights: [], more: 0 } : visibleLights(state, attempt);
  return {
    attemptId,
    modelId: attempt?.model ?? "",
    lights,
    lightsMore: more,
    checks: attempt === undefined ? null : checksSummary(attempt),
    took:
      candidate?.seconds === null || candidate?.seconds === undefined
        ? text("race.took", { duration: text("race.unknown") })
        : text("race.took", { duration: duration(candidate.seconds * 1000) }),
    cost:
      candidate?.cost_usd === null || candidate?.cost_usd === undefined
        ? text("race.cost", { money: text("race.unknown") })
        : text("race.cost", { money: money(candidate.cost_usd) }),
    blast: text("race.blast", { n: radius?.repair.length ?? 0 }),
    canChoose: choosable && view.closed === null && !visitor,
    frameAddress,
    frameNote,
    stateLine,
  };
}

/** The status word of a still-working race candidate (`Working` unless a later state applies). */
function attemptStatusWord(attempt: AttemptView): string {
  const word = `status.${attempt.state}`;
  try {
    return text(word);
  } catch {
    return text("status.working");
  }
}

/**
 * The sheet's model (3.13, 3.14). `features` is `floor.json`'s: `held` gates the frames,
 * `held.affects` and the risk block (the minimal form of HD1); `clef` gates `held.risk_waiting`.
 */
export function cardSheetModel(
  state: FloorState,
  view: CardView,
  opts: { features: { held: boolean; clef: boolean }; visitor: boolean },
): CardSheetModel {
  const card = view.card;
  const minimal = card.kind === "race" ? false : !opts.features.held;
  const closed = view.closed;
  const frames = card.kind === "held" && !minimal && closed === null ? heldFrames(card) : null;
  return {
    cardId: card.card_id,
    kind: card.kind,
    title: card.title,
    body: card.kind === "choice" ? card.body.slice(0, 2) : card.body,
    intentLine: card.kind === "choice" ? null : intentLine(state, view),
    closedSentence: closed === null ? null : closedSentence(state, view),
    closedByOwner: closed?.by === "owner",
    minimal,
    frames,
    changes: card.kind !== "held" ? null : changeRows(state, view),
    affects: minimal || card.kind !== "held" ? null : affectsRows(state, view),
    checked: card.kind !== "held" ? null : checkedBlock(state, view),
    risk: minimal || card.kind !== "held" ? null : riskBlock(view, opts.features.clef),
    race: card.kind === "race" ? card.attempt_ids.map((id) => raceColumn(state, view, id, opts.visitor)) : null,
    reasonLabel: opts.visitor || card.kind === "choice" ? null : text("held.reason"),
    options: card.options.map((option) => ({
      id: option.id,
      label: option.label,
      tip: option.id === "land_now" ? text("held.land_now.tip") : null,
    })),
    submitIds: card.submit_ids,
  };
}
