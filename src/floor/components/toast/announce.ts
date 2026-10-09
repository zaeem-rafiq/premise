// The screen-reader lines of 03-floor 5.13 (AX8): each event maps to a line or to none,
// and each id's `urgent` flag (set in STRINGS) picks the assertive region. The lines are
// made from the event and the state after it reduced, so a name is filled from the stream.

import type { PoolEvent } from "../../../protocol/events.ts";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import { STRINGS, text } from "../../../copy/strings.ts";
import type { CopyVars } from "../../../copy/fill.ts";
import { changeName } from "../../../copy/names.ts";
import { landingLabel } from "../../../copy/format.ts";
import { REOPENED_CAUSE } from "../../../copy/strings.ts";
import { whyOffered } from "../../state/derive.ts";

export type AnnouncedLine = { text: string; urgent: boolean };

function line(id: string, vars: CopyVars = {}): AnnouncedLine {
  const entry = STRINGS[id];
  const urgent = entry?.urgent === true;
  const template = vars["alt"] === true && entry?.alt !== undefined ? undefined : undefined;
  void template;
  return { text: vars["alt"] === true && entry?.alt !== undefined ? fillAlt(entry.alt, vars) : text(id, vars), urgent };
}

function fillAlt(template: string, vars: CopyVars): string {
  return template.replace(/\{([a-z_ ]+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}

function nameOf(state: FloorState, attemptId: string | null | undefined): string {
  const attempt = attemptId == null ? undefined : state.attempts[attemptId];
  const intent = attempt === undefined ? undefined : state.intents[attempt.intent_id];
  if (attempt === undefined || intent === undefined) return attemptId ?? "";
  return changeName({
    intentText: intent.text,
    race: attempt.race,
    model: attempt.model,
    premises: Object.values(attempt.premises).map((p) => ({ kind: p.kind, key: p.key, edit: p.edit, hash: p.hash })),
  });
}

const STATUS_WORD: Record<string, string> = {
  going_around: "status.going_around",
  needs_confirm: "status.needs_confirm",
  held: "status.held",
  stopped: "status.stopped",
};

/**
 * The line or lines one applied event speaks (4.3 "Said"). `before` is the state just
 * before the event; some lines need it (a first answerable race card, cap crossing).
 */
/** The before-event fields a line needs; made by the session (it owns the state). */
export type BeforeBits = {
  poolState: string | null;
  killed: boolean;
  spendAtCap: boolean;
  swarmRunning: boolean;
  cardAnswerable: (cardId: string) => boolean;
};

export function linesForEvent(event: PoolEvent, state: FloorState, before: BeforeBits): AnnouncedLine[] {
  switch (event.type) {
    case "pool.state":
      if (event.state === before.poolState) return [];
      return [line("sr.pool_state", { "ready or rebuilding or paused": event.state })];
    case "pool.paused":
      return [line("sr.paused", { "banner sentence": "" })];
    case "intent.created": {
      const intent = state.intents[event.intent_id];
      return intent === undefined
        ? []
        : [line("sr.intent", { requester: event.requester, "intent text": intent.text })];
    }
    case "attempt.state": {
      const id = STATUS_WORD[event.to];
      if (id === undefined) return [];
      return [line("sr.state", { changeName: nameOf(state, event.attempt_id), "status word": text(id) })];
    }
    case "attempt.reopened":
      return [
        line("sr.reopened", {
          changeName: nameOf(state, event.attempt_id),
          cause: REOPENED_CAUSE[event.cause] ?? event.cause,
        }),
      ];
    case "headsup.sent":
      return [line("sr.headsup", { changeName: nameOf(state, event.attempt_id), "one-line form of 5.6": "" })];
    case "headsup.resolved":
      return [line("sr.resolved", { changeName: nameOf(state, event.attempt_id) })];
    case "card.opened": {
      const card = state.cards[event.card.card_id]?.card;
      if (card === undefined || card.options.length === 0) return [];
      return [line("sr.card", { title: card.title })];
    }
    case "card.updated": {
      const card = state.cards[event.card.card_id]?.card;
      if (card === undefined || card.kind !== "race") return [];
      if (card.options.length > 0 && !before.cardAnswerable(event.card.card_id)) {
        return [line("sr.card", { title: card.title })];
      }
      return [];
    }
    case "card.closed": {
      const card = state.cards[event.card_id]?.card;
      return [line("sr.card_closed", { title: card?.title ?? event.card_id })];
    }
    case "landing.landed": {
      const landing = state.landings[event.seq];
      if (landing === undefined || !whyOffered(landing)) return [];
      return [
        line("sr.landed", {
          changeName: nameOf(state, landing.attempt_id),
          landing: landingLabel(event.seq),
        }),
      ];
    }
    case "undo.planned":
      return [
        line("sr.undo", {
          landing: landingLabel(event.target_seq),
          n: event.reverted.length + event.reopened.length,
        }),
      ];
    case "push.retry":
      return [line("sr.push")];
    case "green.verified":
      if (event.ok) return [];
      return event.confirmed
        ? [line("sr.green_red", { landing: landingLabel(event.seq) })]
        : [line("sr.green_checking", { landing: landingLabel(event.seq) })];
    case "limits": {
      const killed = event.killed && !before.killed;
      const allowed = !event.killed && before.killed;
      const capped = event.spend_usd >= event.cap_usd && event.cap_usd > 0 && !before.spendAtCap;
      const lines: AnnouncedLine[] = [];
      if (killed) lines.push(line("sr.killed"));
      else if (allowed) lines.push({ text: STRINGS["sr.killed"]!.alt!, urgent: true });
      if (capped) lines.push(line("sr.cap"));
      return lines;
    }
    case "swarm.state": {
      const was = before.swarmRunning;
      if (event.running && !was) return [line("sr.swarm", { n: event.agents })];
      if (!event.running && was) return [{ text: STRINGS["sr.swarm"]!.alt!, urgent: false }];
      return [];
    }
    default:
      return [];
  }
}
