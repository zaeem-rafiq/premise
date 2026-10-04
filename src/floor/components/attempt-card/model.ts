// The view model of one attempt card (03-floor 3.2 anatomy, 3.3 lights, 5.3 words and shapes,
// 5.5–5.8 sentences, 7 rows FR1–FR3). Pure functions of `FloorState` and the page clock: every
// time is a difference of `ts` values (FL9), so a live page passes its stream clock and Replay
// passes its recorded clock unchanged.

import { LIGHTS_MAX, QUIET_NOTICE_MS, SLOW_NOTICE_MS } from "../../../protocol/constants.ts";
import type { AttemptState } from "../../../protocol/attempt.ts";
import type { AttemptView, FloorState, HeadsUpView, PremiseView } from "../../../protocol/reducer/state.ts";
import { premiseId } from "../../../protocol/reducer/state.ts";
import { activityError, activityLine, quietSuffix } from "../../../copy/activity.ts";
import { submitErrorSentence, submitResultLine } from "../../../copy/checks.ts";
import { duration } from "../../../copy/format.ts";
import { changeName, keyLabel, keyShort, modelName } from "../../../copy/names.ts";
import { headsupOneLine, tickSkipped } from "../../../copy/sentences.ts";
import { stopSentence } from "../../../copy/stops.ts";
import { REOPENED_CAUSE, text } from "../../../copy/strings.ts";

/** The status shapes of 03 5.3, as the card draws them. */
export type StatusShape =
  "ring-dotted" | "dot" | "diamond" | "triangle" | "half" | "ring" | "bars" | "circle-tick" | "cross";

/** The colour tokens of 03 6.3 a status or a light uses. */
export type Tone = "muted" | "accent" | "changed" | "confirm" | "checking" | "holds";

/** The status of an attempt card: its word, its shape and its colour token (03 5.3). */
export type StatusView = { word: string; shape: StatusShape; tone: Tone };

/** One premise light as the card draws it (03 3.3); `tip` is the accessible name (CO16, AX7). */
export type LightView = { id: string; light: PremiseView["light"]; edit: boolean; tip: string };

/** Line 4 of the card: the sentence it shows, whether it is a warning, whether it opens the card. */
export type LineView = { text: string; warning: boolean; opensCard: boolean };

/** Everything the collapsed attempt card shows (03 3.2). */
export type CardModel = {
  requester: string;
  tags: string[];
  model: string | null;
  elapsed: string;
  intent: string;
  status: StatusView;
  sentBack: string | null;
  relies: boolean;
  lights: LightView[];
  lightsMore: number;
  line4: LineView;
  cardId: string | null;
  note: string | null;
};

/** The attempt states `quietFor` is defined for (03 4.4). */
const QUIET_STATES: ReadonlySet<AttemptState> = new Set(["working", "going_around", "needs_confirm"]);

/** `quietFor(attempt)` (03 4.4): `clock − last_event_ts`, for the states it is defined on. */
export function quietFor(attempt: AttemptView, clock: number): number {
  return QUIET_STATES.has(attempt.state) ? Math.max(0, clock - attempt.last_event_ts) : 0;
}

/** FR26: an `opened` attempt waits for a free agent slot. */
export function queued(state: FloorState, attempt: AttemptView): boolean {
  return attempt.state === "opened" && state.pool.real_agents >= state.pool.max_real_agents;
}

/** Whether the attempt's landing has its `landing.landed` (FL3). */
export function landingConfirmed(state: FloorState, attempt: AttemptView): boolean {
  if (attempt.landed_seq === null) return false;
  const entry = state.landings[attempt.landed_seq];
  if (entry === undefined) return false;
  return entry.digest === true ? entry.landed_ts !== null : entry.landed !== null;
}

/** `sentBack(attempt)` (03 4.4, GA3): the number `attempt.sent_back_n` shows, or 0 to show nothing. */
export function sentBack(attempt: AttemptView): number {
  return attempt.go_arounds + attempt.pull_backs;
}

/** CO14: `changed`, `blind_spot`, `confirm`, `checking`, then `holds` in the order recorded. */
const LIGHT_ORDER: Readonly<Record<PremiseView["light"], number>> = {
  changed: 0,
  blind_spot: 1,
  confirm: 2,
  checking: 3,
  holds: 4,
};

/** `lightsInOrder(attempt)` (03 4.4, CO14). */
export function lightsInOrder(attempt: AttemptView): PremiseView[] {
  const premises = Object.values(attempt.premises);
  const nonHolds = premises
    .filter((premise) => premise.light !== "holds")
    .sort((a, b) => LIGHT_ORDER[a.light] - LIGHT_ORDER[b.light]);
  return [...nonHolds, ...premises.filter((premise) => premise.light === "holds")];
}

/** The accessible name of one light (CO16, AX7): `light.tip`, or `light.blind_spot.tip` for B1. */
function lightTip(premise: PremiseView): string {
  const label = keyLabel(premise.kind, premise.key);
  if (premise.light === "blind_spot") {
    return text("light.blind_spot.tip", { keyLabel: label });
  }
  const flags = [
    premise.read ? text("light.flag.read") : null,
    premise.edit ? text("light.flag.edit") : null,
    premise.derived ? text("light.flag.derived") : null,
  ].filter((flag): flag is string => flag !== null);
  if (flags.length === 0) return `${label}: ${text(`light.${premise.light}`)}.`;
  return text("light.tip", {
    keyLabel: label,
    "light word": text(`light.${premise.light}`),
    flags: flags.join(", "),
  });
}

/**
 * The lights a collapsed card shows (CO14): at most `LIGHTS_MAX`, and lights that are not `holds`
 * are never hidden behind `light.more`. A `summary_only` pool shows no lights (CO13a).
 */
export function visibleLights(state: FloorState, attempt: AttemptView): { lights: LightView[]; more: number } {
  if (state.pool.summary_only) return { lights: [], more: 0 };
  const ordered = lightsInOrder(attempt);
  const nonHolds = ordered.filter((premise) => premise.light !== "holds");
  const holdSlots = Math.max(0, LIGHTS_MAX - nonHolds.length);
  const shown = [...nonHolds, ...ordered.filter((premise) => premise.light === "holds").slice(0, holdSlots)];
  return {
    lights: shown.map((premise) => ({
      id: premiseId(premise.kind, premise.key),
      light: premise.light,
      edit: premise.edit,
      tip: lightTip(premise),
    })),
    more: ordered.length - shown.length,
  };
}

/** The newest heads-up of the attempt that has no resolution yet, or null. */
export function newestUnresolvedHeadsUp(attempt: AttemptView): HeadsUpView | null {
  let newest: HeadsUpView | null = null;
  for (const headsup of Object.values(attempt.heads_ups)) {
    if (headsup.resolved === null && (newest === null || headsup.hn > newest.hn)) newest = headsup;
  }
  return newest;
}

/** The premise key a collapsed heads-up line names: the first key that is not a check. */
function headsUpKey(
  headsup: HeadsUpView,
): { kind: "entity" | "file" | "listing" | "query" | "check"; key: string } | null {
  return headsup.keys.find((entry) => entry.kind !== "check") ?? headsup.keys[0] ?? null;
}

/** The one-line form of an unresolved heads-up (03 5.6), or null when it names no key. */
function headsUpLine(headsup: HeadsUpView): string | null {
  const key = headsUpKey(headsup);
  if (key === null) return null;
  return headsupOneLine(headsup.result, keyShort(key.kind, key.key));
}

/** The 5.7 line of the attempt's submit, or null when its status has no line. */
function submitLine(attempt: AttemptView, visitor: boolean): { text: string; ts: number; warning: boolean } | null {
  const submit = attempt.submit;
  if (submit === null) return null;
  const failed = submit.checks.find((check) => check.ok === false);
  const line = submitResultLine(submit.status, {
    visitor,
    error: failed === undefined ? undefined : submitErrorSentence(failed),
  });
  if (line === null) return null;
  return { text: line, ts: submit.ts, warning: submit.status === "rejected" };
}

/** The `changeName` of the attempt a `right_of_way` skip waits behind (03 5.2). */
function behindName(state: FloorState, attempt: AttemptView): string | undefined {
  const behind = attempt.skipped?.behind;
  if (behind === null || behind === undefined) return undefined;
  const other = state.attempts[behind];
  if (other === undefined) return behind;
  return changeName({
    intentText: state.intents[other.intent_id]?.text ?? "",
    race: other.race,
    model: other.model,
    premises: Object.values(other.premises).map((premise) => ({
      kind: premise.kind,
      key: premise.key,
      edit: premise.edit,
    })),
  });
}

type Candidate = { text: string; ts: number; warning: boolean };

/**
 * The sentences of line 4 that events have put there (03 4.3): the step's activity or error line
 * (5.5, FR2), the submit sentence (5.7, FR3), the newest unresolved heads-up sentence (5.6) and the
 * skip sentence (5.6). `skipped` has no `ts` of its own, so it wins line 4 exactly when no producer
 * carries the attempt's `last_event_ts`: it stays the line while only non-producer events followed.
 * The submit sentence is a producer only while the agent is active; on `submitted`, `validated`,
 * `accepted` and `landed` the state row already holds its line, and a stale submit must not
 * outlive them (a `held` submit's line would otherwise cover `attempt.landing` on `accepted`).
 */
function line4Candidates(state: FloorState, attempt: AttemptView, visitor: boolean): Candidate[] {
  const out: Candidate[] = [];
  const active = QUIET_STATES.has(attempt.state);
  const step = attempt.step;
  if (step !== null && (active || !step.ok)) {
    out.push({
      text: step.ok ? activityLine(step) : activityError(activityLine(step), step.error ?? ""),
      ts: step.ts,
      warning: !step.ok,
    });
  }
  if (active) {
    const submit = submitLine(attempt, visitor);
    if (submit !== null) out.push(submit);
  }
  const headsup = newestUnresolvedHeadsUp(attempt);
  if (headsup !== null) {
    const line = headsUpLine(headsup);
    if (line !== null) out.push({ text: line, ts: headsup.ts, warning: false });
  }
  if (attempt.skipped !== null && out.every((candidate) => candidate.ts < attempt.last_event_ts)) {
    out.push({
      text: tickSkipped(attempt.skipped.why, behindName(state, attempt)),
      ts: attempt.last_event_ts,
      warning: false,
    });
  }
  return out;
}

/** Whether the attempt is on a `live` row of the 3.2 state table (the error overlay applies). */
function liveRow(state: FloorState, attempt: AttemptView): boolean {
  switch (attempt.state) {
    case "working":
    case "going_around":
    case "needs_confirm":
    case "submitted":
    case "validated":
    case "accepted":
      return true;
    case "landed":
      return !landingConfirmed(state, attempt);
    default:
      return false;
  }
}

/**
 * Line 4 of the attempt card (03 3.2): the row's own sentence, overlaid by the newest producer's
 * sentence on a live row, and by `attempt.slow` once the model has been quiet `SLOW_NOTICE_MS`.
 */
export function line4Of(state: FloorState, attempt: AttemptView, clock: number, visitor: boolean): LineView {
  const quiet = quietFor(attempt, clock);
  if (quiet >= SLOW_NOTICE_MS) {
    return {
      text: text("attempt.slow", { seconds: Math.floor(quiet / 1_000) }),
      warning: true,
      opensCard: false,
    };
  }
  if (liveRow(state, attempt)) {
    let best: Candidate | null = null;
    for (const candidate of line4Candidates(state, attempt, visitor)) {
      if (best === null || candidate.ts >= best.ts) best = candidate;
    }
    if (best !== null) return { text: best.text, warning: best.warning, opensCard: false };
    if (QUIET_STATES.has(attempt.state)) {
      const line = attempt.step === null ? activityLine({ tool: null, target: null }) : activityLine(attempt.step);
      const suffix = quiet >= QUIET_NOTICE_MS ? quietSuffix(Math.floor(quiet / 1_000)) : "";
      return { text: `${line}${suffix}`, warning: false, opensCard: false };
    }
  }
  switch (attempt.state) {
    case "opened":
      return {
        text: queued(state, attempt)
          ? text("attempt.queue", { max: state.pool.max_real_agents })
          : text("attempt.starting"),
        warning: false,
        opensCard: false,
      };
    case "submitted":
      return { text: text("attempt.waiting_clef"), warning: false, opensCard: false };
    case "validated":
      return { text: text("attempt.next_batch"), warning: false, opensCard: false };
    case "held":
      return { text: text("attempt.open_card"), warning: false, opensCard: true };
    case "landed":
      return {
        text:
          attempt.landed_seq !== null && landingConfirmed(state, attempt)
            ? text("attempt.landed_as", { seq: attempt.landed_seq })
            : text("attempt.landing"),
        warning: false,
        opensCard: false,
      };
    case "stopped":
      return {
        text: stopSentence(attempt.stop_reason ?? "stopped"),
        warning: false,
        opensCard: false,
      };
    default:
      // `accepted`, or `landed` before its `landing.landed` (FL3): recorded, not on main yet.
      return { text: text("attempt.landing"), warning: false, opensCard: false };
  }
}

/** The status word, shape and colour of the attempt (03 3.2 state table and 5.3). */
export function statusOf(state: FloorState, attempt: AttemptView, visitor: boolean): StatusView {
  switch (attempt.state) {
    case "opened":
      return queued(state, attempt)
        ? { word: text("status.queued"), shape: "ring-dotted", tone: "muted" }
        : { word: text("status.opened"), shape: "ring-dotted", tone: "muted" };
    case "working":
      return { word: text("status.working"), shape: "dot", tone: "accent" };
    case "going_around":
      return { word: text("status.going_around"), shape: "diamond", tone: "changed" };
    case "needs_confirm":
      return { word: text("status.needs_confirm"), shape: "triangle", tone: "confirm" };
    case "submitted":
      return { word: text("status.submitted"), shape: "half", tone: "checking" };
    case "validated":
      return { word: text("status.validated"), shape: "ring", tone: "holds" };
    case "held":
      return { word: text("status.held", { visitor }), shape: "bars", tone: "confirm" };
    case "accepted":
      return { word: text("status.accepted"), shape: "half", tone: "holds" };
    case "landed":
      return landingConfirmed(state, attempt)
        ? { word: text("status.landed"), shape: "circle-tick", tone: "holds" }
        : { word: text("status.accepted"), shape: "half", tone: "holds" };
    case "stopped":
      switch (attempt.stop_reason) {
        case "undone":
          return { word: text("status.undone"), shape: "cross", tone: "muted" };
        case "not_chosen":
          return { word: text("status.not_chosen"), shape: "cross", tone: "muted" };
        case "declined":
          return { word: text("status.declined"), shape: "cross", tone: "muted" };
        default:
          return { word: text("status.stopped"), shape: "cross", tone: "changed" };
      }
  }
}

/** The tags of line 1, in the order 3.2 lists them (CO13, FL4). */
export function tagsOf(state: FloorState, attempt: AttemptView): string[] {
  const tags: string[] = [];
  const intent = state.intents[attempt.intent_id];
  if (intent?.prewritten === true) tags.push(text("attempt.tag.prewritten"));
  if (attempt.agent === "synthetic") tags.push(text("attempt.tag.synthetic"));
  if (attempt.reopened_by !== null) {
    tags.push(text("attempt.tag.reopened", { cause: REOPENED_CAUSE[attempt.reopened_by] ?? attempt.reopened_by }));
  }
  if (attempt.right_of_way) tags.push(text("attempt.tag.right_of_way"));
  return tags;
}

/**
 * The note of a reopened attempt (CO13): `attempt.same_agent`, or `attempt.model_changed` when
 * another model took over, until the attempt lands or stops.
 */
export function reopenedNote(attempt: AttemptView): string | null {
  if (attempt.reopened_by === null || attempt.state === "landed" || attempt.state === "stopped") return null;
  return attempt.model_changed ? text("attempt.model_changed") : text("attempt.same_agent");
}

/** The whole view model of one collapsed attempt card (03 3.2). */
export function cardModel(state: FloorState, attempt: AttemptView, clock: number, visitor: boolean): CardModel {
  const intent = state.intents[attempt.intent_id];
  const { lights, more } = visibleLights(state, attempt);
  const back = sentBack(attempt);
  return {
    requester: intent?.requester ?? "owner",
    tags: tagsOf(state, attempt),
    model: attempt.model === null ? null : modelName(attempt.model),
    elapsed: duration(Math.max(0, clock - attempt.opened_ts)),
    intent: intent?.text ?? "",
    status: statusOf(state, attempt, visitor),
    sentBack: back > 0 ? text("attempt.sent_back_n", { n: back }) : null,
    relies: lights.length > 0,
    lights,
    lightsMore: more,
    line4: line4Of(state, attempt, clock, visitor),
    cardId: attempt.card_id,
    note: reopenedNote(attempt),
  };
}
