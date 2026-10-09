// 03-floor 5.10: the card texts Trunk fills `Card.title`, `Card.body` and `Card.options[].label`
// from (01-core CD5). The Floor shows them as sent; the route accepts the option id, never the
// label. Templates keep their `{braces}` — Trunk fills them with `fill` (03 5.1 CP5).
//
// Also here: the blast sentences, the risk sentences and risk lines of a held card, the race
// title while not all candidates are ready, and the chapter names and captions of 8.5, which
// "are part of the `copy` module".

import type { BlastRadius, CardOption, RiskAnswers } from "../protocol/cards.ts";
import { T_INTENT_MIN, T_SHARED_MAX, T_UNRELATED_MAX } from "../protocol/constants.ts";
import { fill } from "./fill.ts";

export type CardTemplate = {
  readonly title: string;
  readonly body: string;
  readonly options: ReadonlyArray<{ id: CardOption; label: string }>;
};

const HELD_OPTIONS: ReadonlyArray<{ id: CardOption; label: string }> = [
  { id: "land", label: "Land" },
  { id: "land_now", label: "Land now" },
  { id: "decline", label: "Decline" },
];

/** The (`kind`, `reason`) pairs a card may carry: the rows of the 5.10 table. No other exists. */
export type CardTemplateId =
  | "held:held_path"
  | "held:risk"
  | "race:race"
  | "choice:go_around_limit"
  | "choice:contradiction"
  | "choice:revert_limit"
  | "choice:reopen_failed";

/**
 * The template of a card, keyed `kind:reason` (03 5.10). The options of each card are those of
 * rule CD4, in order — `land_now` is in `Card.options` only while the blast radius lists an
 * attempt with right of way and `features.held` is true; the Floor never adds an option.
 */
export const CARD_TEMPLATES: Readonly<Record<CardTemplateId, CardTemplate>> = {
  "held:held_path": {
    title: "This change touches shared rules. Land it?",
    body: "It changes {paths}. {blast sentence}",
    options: HELD_OPTIONS,
  },
  "held:risk": {
    title: "Clef flagged this change. Land it?",
    body: "{risk sentence} {blast sentence}",
    options: HELD_OPTIONS,
  },
  "race:race": {
    title: '{ready} of {n} attempts at "{intent text}" are ready. Choose one.',
    body: "Each ran on a different model. The one you choose lands through the same gate.",
    options: [{ id: "choose", label: "Choose this one" }],
  },
  "choice:go_around_limit": {
    title: "This change was sent back {GO_AROUND_LIMIT} times. Try again?",
    body: "The {changeName} change was sent back {GO_AROUND_LIMIT} times because {keyShort} kept changing. Try once more with right of way, or stop?",
    options: [
      { id: "retry", label: "Try again" },
      { id: "stop", label: "Stop" },
    ],
  },
  "choice:contradiction": {
    title: "Two requests change the same thing. Which one stands?",
    body: '{requester A} asked: "{intent A}". {requester B} asked: "{intent B}". Both change {keyShort}.',
    options: [
      { id: "keep_landed", label: "Keep what landed" },
      { id: "retry", label: "Adapt the other on top" },
    ],
  },
  "choice:revert_limit": {
    title: "This change was taken back {MAX_REVISIONS} times. Try again?",
    body: "The {changeName} change landed and was taken back {MAX_REVISIONS} times. Let its agent try once more, or stop?",
    options: [
      { id: "retry", label: "Try again" },
      { id: "stop", label: "Stop" },
    ],
  },
  "choice:reopen_failed": {
    title: "The agent could not be reopened. Start a new attempt?",
    body: "The agent that wrote {changeName} is not available. A new agent would start from the request text.",
    options: [
      { id: "new_attempt", label: "Start a new attempt" },
      { id: "stop", label: "Leave it stopped" },
    ],
  },
};

/**
 * The body of a held card in the minimal form (`features.held` is false, `01-core.md` HD1): Trunk
 * computes no blast radius there, so the card makes no statement about one.
 */
export const HELD_BODY_MINIMAL = "It changes {paths}.";

/** The race title by how many candidates are ready (03 5.10, last note). */
export function raceTitle(ready: number, n: number, intentText: string): string {
  const vars = { ready, n, "intent text": intentText };
  if (n === 1) {
    return fill(
      ready === 0
        ? '1 attempt at "{intent text}" is still working.'
        : '1 of 1 attempt at "{intent text}" is ready. Choose it.',
      vars,
    );
  }
  if (ready === 0) return fill('{n} attempts at "{intent text}" are still working.', vars);
  if (ready === 1)
    return fill('1 of {n} attempts at "{intent text}" is ready. Choose it, or wait for the others.', vars);
  return fill(CARD_TEMPLATES["race:race"].title, vars);
}

/**
 * The blast sentences of 03 5.10. `names` are the `changeName`s of the listed attempts. A
 * `BlastRadius` lists attempt ids; the caller maps them to names. `right_of_way` names the one
 * attempt under `repair` that holds right of way (CO35a): a blast with a right-of-way row uses
 * that sentence alone.
 */
export function blastSentence(
  radius: Pick<BlastRadius, "repair" | "confirm" | "triage" | "right_of_way">,
  names: {
    repair: readonly string[];
    confirm: readonly string[];
    triage: readonly string[];
    rightOfWay?: string;
  },
): string {
  if (radius.right_of_way.length > 0) {
    return fill("Landing this sends {name} around again. It will wait until that change has landed.", {
      name: names.rightOfWay ?? "{name}",
    });
  }
  if (radius.repair.length > 0) {
    return radius.repair.length === 1
      ? fill("Landing this sends 1 change back to its agent: {name}.", { name: names.repair[0] ?? "{name}" })
      : fill("Landing this sends {n} changes back to their agents: {names}.", {
          n: radius.repair.length,
          names: names.repair.join(", "),
        });
  }
  if (radius.confirm.length > 0) {
    return fill(
      radius.confirm.length === 1 ? "{n} change must confirm: {names}." : "{n} changes must confirm: {names}.",
      {
        n: radius.confirm.length,
        names: names.confirm.join(", "),
      },
    );
  }
  if (radius.triage.length > 0) {
    return fill(
      radius.triage.length === 1
        ? "Clef will judge {n} change that reads it: {names}."
        : "Clef will judge {n} changes that read it: {names}.",
      {
        n: radius.triage.length,
        names: names.triage.join(", "),
      },
    );
  }
  return "No change in flight relies on what this changes.";
}

/**
 * The risk sentence of a `held`, `risk` card (03 5.10): the low/high flags of `Card.risk` that
 * 01-core 10.4 names, or the "not available" sentence when `Card.risk` is null or `error` is set.
 * `share` is each answer as a whole percent.
 */
export function riskSentence(risk: RiskAnswers | null, share: (x: number) => string): string {
  if (risk === null || risk.error !== undefined) {
    return "Clef's answers were not available, so this waits for you.";
  }
  // "low" and "high" are the same calibrated bounds RK2 routes on (01-core 10.4).
  if (risk.does_what_asked !== null && risk.does_what_asked < T_INTENT_MIN) {
    return fill("Clef doubts that it does what was asked ({share}).", {
      share: share(risk.does_what_asked),
    });
  }
  if (risk.unrelated_edits !== null && risk.unrelated_edits > T_UNRELATED_MAX) {
    return fill("Clef sees edits that nobody asked for ({share}).", {
      share: share(risk.unrelated_edits),
    });
  }
  if (risk.changes_shared_meaning !== null && risk.changes_shared_meaning > T_SHARED_MAX) {
    return fill("Clef sees a change to the meaning of shared code ({share}).", {
      share: share(risk.changes_shared_meaning),
    });
  }
  return "Clef's answers were not available, so this waits for you.";
}

/** The risk lines of the held card (03 5.10), in order; `{share}` is a whole percent or
 *  "not available". The footer is `RISK_FOOTER` with `{model}` filled. */
export const RISK_LINES: Readonly<Record<"does_what_asked" | "changes_shared_meaning" | "unrelated_edits", string>> = {
  does_what_asked: "Does what was asked: {share}",
  changes_shared_meaning: "Changes the meaning of shared code: {share}",
  unrelated_edits: "Includes edits nobody asked for: {share}",
};

export const RISK_FOOTER = "Judged by Clef ({model}). These numbers inform you. They never land or decline a change.";

/** The share of a risk line: a whole percent, or "not available" (03 5.10). */
export function riskShare(x: number | null, shareFn: (x: number) => string): string {
  return x === null ? "not available" : shareFn(x);
}

// ---- 8.5 Chapters: names and captions are part of the copy module ----

export type ChapterCaption = {
  readonly name: string;
  readonly caption: string;
};

/**
 * The chapters of 8.5 in the table's order: when two would start at the same event, only the one
 * that comes first is kept. Which event each starts at lives in the Replay code; the copy module
 * holds only the names and captions.
 */
export const CHAPTERS: readonly ChapterCaption[] = [
  { name: "Requests", caption: "Each attempt card is one agent. Each light is something it read." },
  {
    name: "Held change",
    caption: "A change to shared rules waits for the owner. The card shows the pool before and after.",
  },
  {
    name: "Conflict",
    caption: "A change landed. Agents that relied on the old version get the exact diff and adapt.",
  },
  {
    name: "Second catch",
    caption: "A search or a file list gained a match. The agent that was sweeping it is told.",
  },
  { name: "Choice", caption: "The owner decides in plain words." },
  {
    name: "Undo",
    caption: "Undo takes back the change and the later changes built on it. Their agents reopen.",
  },
  { name: "Race", caption: "Three models tried the same request. The owner chooses one." },
  {
    name: "Green line",
    caption: "A check failed twice after landing. Trunk takes the landings back and reopens their agents.",
  },
  {
    name: "Swarm",
    caption: "Scripted agents on the same landing path. The numbers are measured in this run.",
  },
];

/** The suffix the Conflict chapter's caption gains when the recording has a plain-merge pool (8.5). */
export const CHAPTER_CONFLICT_COMPARE = "Press C to compare with a plain git merge.";
