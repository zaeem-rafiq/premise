/**
 * The Why card model (03-floor.md 3.9) and `whyTarget` (4.4), derived purely
 * from `FloorState`. A Why card reads a landing — its stream fields and its
 * parsed note — plus the intent and the attempt that produced it. Landings
 * older than `FLOOR_KEEP_LANDINGS` are digest entries (4.4) whose record the
 * component fetches from the note route; the model takes that fetched note as
 * an argument so it stays synchronous and pure.
 */

import type { Note } from "../note.ts";
import type { PremiseKind } from "../premise.ts";
import type { Check } from "../tools.ts";
import type { RiskAnswers } from "../cards.ts";
import type { FloorState, HeadsUpView, LandingView, PremiseView } from "./state.ts";

/** One premise/check key inside a go-around or a confirm, with its Clef rule. */
export type WhyItem = {
  kind: PremiseKind | "check";
  key: string;
  rule: string;
  reason: string | null;
  causeSeq: number | null; // the landing that changed this key, when the item says so
  scripted: boolean; // judgmentSentence's `scripted` flag (TR8)
  /** Entity keys of a query diff's `added` (QR sentences name them); [] when the item has none. */
  added: string[];
};

/** A resolved heads-up the landing went through: repair (a go-around) or confirm. */
export type WhyUnder = {
  result: "repair" | "confirm";
  n: number | null; // the go-around number; null for a confirm
  items: WhyItem[];
  causeType: "landing" | "submit" | "undo" | "revert" | null; // note confirms carry none
  causeSeq: number | null; // first landed seq of the cause, if any
  causeIntent: string | null; // the intent text behind that landing
  statement: string | null; // the agent's statement on `resolved`
};

/** How the landing landed, as one of the `why.landed.*` copy ids. */
export type WhyLandedHow = {
  id: "why.landed.auto" | "why.landed.owner" | "why.landed.owner_now" | "why.landed.owner_risk" | "why.landed.chosen";
  ts: number | null; // the approval time of day; null for `auto`
  n: number; // the race size for `chosen`; 1 otherwise
};

/** For an undo/revert landing: what it took back, what it reopened, what it kept. */
export type WhyUndo = {
  cause: "undo" | "revert";
  targetSeq: number;
  tookBack: number[]; // landing seqs reverted
  reopened: string[]; // attempt ids reopened
  kept: number[]; // landing seqs of kept readers
};

/** Everything the Why sheet shows for one landing (3.9). */
export type WhyCard = {
  seq: number;
  status: "seed" | "landing" | "loading" | "unwitnessed" | "live";
  undone: boolean; // `undone_by` is set: the card still shows, under `why.undone`
  partial: boolean; // the record could not be loaded: show `why.partial` after the fields
  kind: "change" | "undo" | "revert" | null;
  requester: string | null;
  intentText: string | null;
  race: boolean;
  agent: "real" | "synthetic" | null;
  model: string | null;
  /** Frozen lights (all "holds"), in premise order; empty for undo/revert landings. */
  premises: PremiseView[];
  under: WhyUnder[];
  checks: Check[];
  landedHow: WhyLandedHow | null;
  risk: RiskAnswers | null;
  paths: string[];
  writes: Note["writes"];
  // the git block
  commit: string | null;
  tree: string | null;
  parentCommit: string | null; // the commit of the previous landed landing; null for the first
  changeId: string | null;
  intentId: string | null;
  attemptId: string | null;
  landedTs: number | null;
  undoneBy: number | null;
  undo: WhyUndo | null;
  note: Note | null;
  /** True when the note is not in state and the component should fetch the note route. */
  needsNote: boolean;
};

function emptyCard(seq: number, status: WhyCard["status"]): WhyCard {
  return {
    seq,
    status,
    undone: false,
    partial: false,
    kind: null,
    requester: null,
    intentText: null,
    race: false,
    agent: null,
    model: null,
    premises: [],
    under: [],
    checks: [],
    landedHow: null,
    risk: null,
    paths: [],
    writes: [],
    commit: null,
    tree: null,
    parentCommit: null,
    changeId: null,
    intentId: null,
    attemptId: null,
    landedTs: null,
    undoneBy: null,
    undo: null,
    note: null,
    needsNote: false,
  };
}

function landed(entry: { digest?: boolean; landed?: { commit: string } | null; landed_ts?: number | null }): boolean {
  return entry.digest === true ? (entry.landed_ts ?? null) !== null : (entry.landed ?? null) !== null;
}

/**
 * `whyTarget(path)` (4.4): the seq of the latest landed landing that wrote
 * `path`. Returns `null` when no landing wrote the path.
 */
export function whyTarget(state: FloorState, path: string): number | null {
  let best: number | null = null;
  for (const entry of Object.values(state.landings)) {
    if (!landed(entry)) continue;
    if (entry.paths.includes(path)) best = Math.max(best ?? 0, entry.seq);
  }
  return best;
}

/** The commit of the landing that landed right before `seq` (CM1's parent); null for the first. */
function previousCommit(state: FloorState, seq: number): string | null {
  let bestSeq = 0;
  let commit: string | null = null;
  for (const entry of Object.values(state.landings)) {
    if (entry.seq >= seq || !landed(entry)) continue;
    if (entry.seq > bestSeq) {
      bestSeq = entry.seq;
      commit = entry.digest === true ? entry.commit : (entry.landed?.commit ?? null);
    }
  }
  return commit;
}

/** The intent text a heads-up cause names (`cause.changes`), first landed seq first. */
function causeIntentOf(
  changes: Array<{ seq: number; change_id: string; intent_text: string | null }>,
  seq: number | null,
): string | null {
  if (seq !== null) {
    const match = changes.find((change) => change.seq === seq);
    if (match?.intent_text !== undefined && match?.intent_text !== null) return match.intent_text;
  }
  return changes.find((change) => change.intent_text !== null)?.intent_text ?? null;
}

function firstLandedSeq(seqs: number[]): number | null {
  return seqs.find((s) => s > 0) ?? null;
}

/** Items of a resolved heads-up, with each key's rule and the item's reason. */
function itemsOf(headsUp: HeadsUpView, scripted: boolean): WhyItem[] {
  return headsUp.keys.map((key) => {
    const item = headsUp.items?.find((i) => i.premise.kind === key.kind && i.premise.key === key.key);
    return {
      kind: key.kind,
      key: key.key,
      rule: item?.rule ?? key.rule,
      reason: item?.reason ?? null,
      causeSeq: item?.cause_seq ?? firstLandedSeq(headsUp.cause.seqs),
      scripted,
      added: item?.diff.kind === "query" ? item.diff.added.map((entry) => entry.key) : [],
    };
  });
}

/** Resolved repair/confirm heads-ups of a full landing, oldest first. */
function underOfLanding(landing: LandingView, scripted: boolean): WhyUnder[] {
  const rows: WhyUnder[] = [];
  for (const headsUp of landing.go_arounds) {
    rows.push({
      result: "repair",
      n: headsUp.go_around ?? null,
      items: itemsOf(headsUp, scripted),
      causeType: headsUp.cause.type,
      causeSeq: firstLandedSeq(headsUp.cause.seqs),
      causeIntent: causeIntentOf(headsUp.cause.changes, firstLandedSeq(headsUp.cause.seqs)),
      statement: headsUp.resolved?.statement ?? null,
    });
  }
  for (const headsUp of landing.confirms) {
    rows.push({
      result: "confirm",
      n: null,
      items: itemsOf(headsUp, scripted),
      causeType: headsUp.cause.type,
      causeSeq: firstLandedSeq(headsUp.cause.seqs),
      causeIntent: causeIntentOf(headsUp.cause.changes, firstLandedSeq(headsUp.cause.seqs)),
      statement: headsUp.resolved?.statement ?? null,
    });
  }
  return rows;
}

/** The same lists read from a fetched note (a digest landing's record). */
function underOfNote(note: Note, scripted: boolean): WhyUnder[] {
  // `landing.landed.note_json` is parsed with a bare JSON.parse (FE1), so a
  // field the type requires can be absent at runtime; guard every list.
  const judgments = note.judgments ?? [];
  const reasonOf = (kind: string, key: string): string | null =>
    judgments.find((j) => j.kind === kind && j.key === key)?.reason ?? null;
  const clefOf = (kind: string, key: string): boolean =>
    judgments.find((j) => j.kind === kind && j.key === key)?.clef?.model === "scripted";
  const rows: WhyUnder[] = [];
  for (const goAround of note.go_arounds ?? []) {
    const causeSeq = firstLandedSeq(goAround.cause_seqs);
    rows.push({
      result: "repair",
      n: goAround.n,
      items: goAround.keys.map((key) => ({
        kind: key.kind,
        key: key.key,
        rule: key.rule,
        reason: reasonOf(key.kind, key.key),
        causeSeq,
        scripted: scripted || clefOf(key.kind, key.key),
        added: [],
      })),
      causeType: goAround.cause,
      causeSeq,
      causeIntent: causeSeq !== null ? intentTextOfSeq(note, goAround.cause_seqs) : null,
      statement: goAround.statement,
    });
  }
  for (const confirm of note.confirms ?? []) {
    rows.push({
      result: "confirm",
      n: null,
      items: confirm.keys.map((key) => ({
        kind: key.kind,
        key: key.key,
        rule: key.rule,
        reason: reasonOf(key.kind, key.key),
        causeSeq: null,
        scripted: scripted || clefOf(key.kind, key.key),
        added: [],
      })),
      causeType: null,
      causeSeq: null,
      causeIntent: null,
      statement: confirm.statement,
    });
  }
  return rows;
}

/** A note names no intent texts for its causes; leave it null. */
function intentTextOfSeq(_note: Note, _seqs: number[]): string | null {
  return null;
}

function howItLanded(state: FloorState, landing: LandingView): WhyLandedHow | null {
  const approved = landing.approved;
  if (approved === null) return { id: "why.landed.auto", ts: null, n: 1 };
  if (approved.option === "land_now") return { id: "why.landed.owner_now", ts: approved.ts, n: 1 };
  if (approved.option === "choose") {
    let n = 1;
    if (landing.attempt_id !== null) {
      const cardId = state.attempts[landing.attempt_id]?.card_id ?? null;
      const card = cardId !== null ? state.cards[cardId] : undefined;
      if (card?.card.kind === "race") n = card.card.attempt_ids.length;
      else if (landing.intent_id !== null) n = Math.max(1, state.intents[landing.intent_id]?.attempt_ids.length ?? 1);
    }
    return { id: "why.landed.chosen", ts: approved.ts, n };
  }
  if (landing.risk !== null) return { id: "why.landed.owner_risk", ts: approved.ts, n: 1 };
  return { id: "why.landed.owner", ts: approved.ts, n: 1 };
}

function undoOf(state: FloorState, landing: LandingView | null, note: Note | null): WhyUndo | null {
  const requestId = landing?.request_id ?? null;
  if (requestId !== null) {
    const undo = state.undo[requestId];
    if (undo !== undefined) {
      return {
        cause: undo.cause,
        targetSeq: undo.target_seq,
        tookBack: undo.reverted,
        reopened: undo.reopened,
        kept: undo.kept_readers,
      };
    }
  }
  if (note?.undo !== undefined) {
    return {
      cause: note.kind === "revert" ? "revert" : "undo",
      targetSeq: note.undo.undoes[0] ?? 0,
      tookBack: note.undo.undoes,
      reopened: note.undo.reopened,
      kept: note.undo.kept_readers,
    };
  }
  if (landing !== null && landing.kind !== "change") {
    return { cause: landing.kind, targetSeq: 0, tookBack: [], reopened: [], kept: [] };
  }
  return null;
}

/**
 * The Why card for landing `seq` (3.9). `fetched` is the note the component got
 * from `GET /api/pools/{pool}/landings/{seq}/note`: leave it `undefined` while
 * the request is in flight, pass `null` when it failed or answered 404.
 */
export function whyCard(state: FloorState, seq: number, fetched?: Note | null): WhyCard {
  if (seq <= 0) return emptyCard(seq, "seed");
  const entry = state.landings[seq];
  if (entry === undefined) return emptyCard(seq, "seed");

  const unwitnessed = state.pool.unwitnessed.includes(seq);

  if (entry.digest === true) {
    const card = emptyCard(seq, entry.landed_ts === null ? "landing" : "live");
    card.kind = entry.kind;
    card.paths = entry.paths;
    card.commit = entry.commit;
    card.tree = entry.tree;
    card.changeId = entry.change_id;
    card.intentId = entry.intent_id;
    card.attemptId = entry.attempt_id;
    card.landedTs = entry.landed_ts;
    card.undoneBy = entry.undone_by;
    card.parentCommit = previousCommit(state, seq);
    if (entry.landed_ts === null) return card; // why.landing: accepted, not yet landed
    if (unwitnessed) {
      card.status = "unwitnessed";
      return card;
    }
    card.undone = entry.undone_by !== null;
    if (fetched === undefined) {
      card.status = "loading"; // why.loading while the note route answers
      card.needsNote = true;
      return card;
    }
    if (fetched === null) {
      card.partial = true; // the stream's sparse fields, then why.partial
      return card;
    }
    fillFromNote(card, fetched);
    return card;
  }

  const landing: LandingView = entry;
  const card = emptyCard(seq, "live");
  card.kind = landing.kind;
  card.paths = landing.paths;
  card.writes = landing.writes;
  card.landedTs = landing.landed?.ts ?? null;
  card.undoneBy = landing.undone_by;
  card.risk = landing.risk;
  card.checks = landing.checks;
  card.premises = landing.premises;
  card.changeId = landing.change_id;
  card.intentId = landing.intent_id;
  card.attemptId = landing.attempt_id;

  const intent = landing.intent_id !== null ? state.intents[landing.intent_id] : undefined;
  card.requester = intent?.requester ?? null;
  card.intentText = intent?.text ?? null;
  card.race =
    intent?.race ?? (landing.attempt_id !== null ? (state.attempts[landing.attempt_id]?.race ?? false) : false);

  const attempt = landing.attempt_id !== null ? state.attempts[landing.attempt_id] : undefined;
  card.agent = attempt?.agent ?? null;
  card.model = attempt?.model ?? null;

  card.undo = undoOf(state, landing, landing.note);
  card.under = underOfLanding(landing, attempt?.agent === "synthetic");
  card.landedHow = landing.kind === "change" ? howItLanded(state, landing) : null;

  if (landing.landed === null) {
    card.status = "landing"; // accepted, not yet landed: why.landing only
    return card;
  }
  card.commit = landing.landed.commit;
  card.tree = landing.landed.tree;
  card.parentCommit = previousCommit(state, seq);
  if (unwitnessed) {
    card.status = "unwitnessed";
    card.note = landing.note;
    return card;
  }
  card.undone = landing.undone_by !== null;
  if (landing.note !== null) {
    card.note = landing.note;
    if (card.intentText === null) card.intentText = landing.note.intent?.text ?? null;
    if (card.requester === null) card.requester = landing.note.intent?.requester ?? null;
    if (card.agent === null) card.agent = landing.note.attempt?.agent ?? null;
    if (card.model === null) card.model = landing.note.attempt?.model ?? null;
    return card;
  }
  // The stream has no note_json (a summary_only pool, EV6, whose note route
  // answers 404). Elsewhere the component fetches the note route; while it is
  // in flight the card shows the stream fields, on failure `why.partial`.
  card.needsNote = !state.pool.summary_only;
  if (fetched !== undefined && fetched !== null) {
    fillFromNote(card, fetched);
  } else if (fetched === null || state.pool.summary_only) {
    card.partial = true;
  }
  return card;
}

/** Fill the card fields that only the note carries (a digest's record or a fetched note). */
function fillFromNote(card: WhyCard, note: Note): void {
  card.note = note;
  card.needsNote = false;
  card.kind = note.kind;
  card.requester = note.intent?.requester ?? null;
  card.intentText = note.intent?.text ?? null;
  card.agent = note.attempt?.agent ?? null;
  card.model = note.attempt?.model ?? null;
  card.changeId = note.change_id;
  card.intentId = note.intent?.id ?? card.intentId;
  card.attemptId = note.attempt?.id ?? card.attemptId;
  card.checks = note.checks ?? [];
  card.writes = note.writes ?? [];
  card.premises = (note.premises ?? []).map((premise) => ({
    kind: premise.kind,
    key: premise.key,
    hash: premise.hash,
    read: premise.read,
    edit: premise.edit,
    derived: premise.derived,
    light: "holds" as const,
    judgment: null,
  }));
  card.under = underOfNote(note, note.attempt?.agent === "synthetic");
  if (note.kind === "change" && note.policy !== undefined) {
    const option = note.policy.option;
    const ts = note.policy.approved_at !== null ? Date.parse(note.policy.approved_at) : null;
    card.landedHow =
      option === "land_now"
        ? { id: "why.landed.owner_now", ts, n: 1 }
        : option === "choose"
          ? { id: "why.landed.chosen", ts, n: 1 }
          : option === "land"
            ? note.policy.risk !== null
              ? { id: "why.landed.owner_risk", ts, n: 1 }
              : { id: "why.landed.owner", ts, n: 1 }
            : { id: "why.landed.auto", ts: null, n: 1 };
  }
  if (note.undo !== undefined) {
    card.undo = {
      cause: note.kind === "revert" ? "revert" : "undo",
      targetSeq: note.undo.undoes[0] ?? 0,
      tookBack: note.undo.undoes,
      reopened: note.undo.reopened,
      kept: note.undo.kept_readers,
    };
  }
}
