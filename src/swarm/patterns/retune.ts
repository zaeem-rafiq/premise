// The `retune` canned pattern (02-tidepool.md 10.3): draw one of four world constants, `read`
// the entity, `replace` its current value with the next in the cycle, `submit`. `edit-creature`
// is the same shape on `creatures/s000<k>.js#SPEED` (the row's "as `retune`"), so both are made
// by `makeCycleEdit`.
//
// The pick is the agent's first `rand` draw, so `truthOf` on a fresh stream returns the same
// entity the attempt will edit (SW1): `entity:<path>#<name>` as the row gives.
//
// A `repair` (E1, with OP1) — the same constant was landed by another change: `read` the entity
// again, `replace` from the new current value, acknowledge (the row; the QR1m item that rides
// beside the E1 of a same-target retune is acknowledged with it). An `info` (X0) whose `after`
// carries the entity's new source re-derives the pending `replace` from the new current value —
// the refused or unwritten step is decided again, not replayed (TA3, SW6). `confirm` and any
// other `repair` acknowledge "not affected" (SW6). A `replace` or `submit` that cannot apply —
// `no_match`, `ambiguous`, `limit_reached` — or a current value outside the cycle ends the
// attempt with `stop` `withdrawn` (SW6, TA9a); a held agent waits before its first `submit`
// (SW8, SWR3).

import type { AgentStopReason } from "../../protocol/attempt.ts";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { Pattern, PatternStep, PatternTurn } from "../pattern.ts";
import { sourceOf, submitFields, submitStatus } from "../scripted.ts";

/** One entity whose declared value steps around a fixed cycle (10.3). */
export type CycleTarget = {
  /** The file the entity lives in, for example `world/energy.js`. */
  path: string;
  /** The entity name, for example `REST_TICKS`. */
  entity: string;
  /** The row's cycle in order; the `replace` writes the value after the current one. */
  values: readonly number[];
};

const MAX_SPEED = { path: "world/movement.js", entity: "MAX_SPEED", values: [3, 3.5, 4] } as const;
const FOOD_EVERY = { path: "world/food.js", entity: "FOOD_EVERY", values: [30, 20, 40] } as const;
const REST_TICKS = { path: "world/energy.js", entity: "REST_TICKS", values: [300, 240, 360] } as const;
const DAY_TICKS = { path: "world/time.js", entity: "DAY_TICKS", values: [3600, 2400, 4800] } as const;

/** Script positions: 0 `read`, 1 `replace`, 2 `submit`. A repair's re-read rides `reread`. */
const STEP_READ = 0;
const STEP_REPLACE = 1;
const STEP_SUBMIT = 2;

/** What the pattern asked with its last issued call, so the next turn can consume the answer. */
type Issued = "none" | "script" | "reread" | "repair" | "submit";

type CycleState = {
  issued: Issued;
  step: number;
  pick: number | null; // the row's drawn target (the first `rand` draw)
  decl: { text: string; value: number } | null; // the declaration as last seen
  seen_hns: number[]; // heads-ups already answered (re-pushes arrive again, HU5)
  reread: boolean; // the E1 + OP1 repair's `read` is in flight
  repairs: Array<{ old: string; new: string }>; // queued `replace`s on the entity; the head is in flight
  acks: Array<{ hn: number; statement: string }>; // pending `acknowledge` entries for the submit
  released: boolean;
  withdrawn: boolean;
  done: boolean;
};

function initialState(): CycleState {
  return {
    issued: "none",
    step: STEP_READ,
    pick: null,
    decl: null,
    seen_hns: [],
    reread: false,
    repairs: [],
    acks: [],
    released: false,
    withdrawn: false,
    done: false,
  };
}

/** The `(export) const <entity> = <number>;` declaration of `entity` in `source`, verbatim. */
function declOf(source: string | null, entity: string): { text: string; value: number } | null {
  const re = new RegExp(`\\b(?:export\\s+)?const\\s+${entity}\\s*=\\s*(\\d+(?:\\.\\d+)?)\\s*;`);
  const match = re.exec(source ?? "");
  return match === null ? null : { text: match[0], value: Number(match[1]) };
}

/** The `replace` that writes the value after `decl.value` in `target.values`, or null when the
 * current value is not in the cycle (the pattern then has nothing to apply — SW6 `withdrawn`). */
function editOf(target: CycleTarget, decl: { text: string; value: number }): { old: string; new: string } | null {
  const at = target.values.indexOf(decl.value);
  if (at < 0) return null;
  const next = target.values[(at + 1) % target.values.length] as number;
  return { old: decl.text, new: decl.text.replace(String(decl.value), String(next)) };
}

function entityKeyOf(target: CycleTarget): string {
  return `${target.path}#${target.entity}`;
}

/**
 * The heads-up answers of the row and SW6.
 * `info` (X0) on the picked entity: the fresh `after` re-derives the pending `replace` from the
 * new current value — the step is re-decided, never replayed (TA3).
 * `repair` with the recorded `replace` dropped (E1 + OP1): `read` the entity again, then
 * `replace` from the new current value, then acknowledge "retuned from the new value".
 * `confirm` and any other `repair`: acknowledge "not affected".
 */
function answerHeadsUp(state: CycleState, target: CycleTarget, headsUp: HeadsUp): void {
  if (state.seen_hns.includes(headsUp.hn)) return;
  state.seen_hns.push(headsUp.hn);
  if (headsUp.result === "info") {
    for (const item of headsUp.items) {
      if (item.premise.kind === "entity" && item.premise.key === entityKeyOf(target) && item.diff.kind === "entity") {
        const decl = declOf(item.diff.after, target.entity);
        if (decl !== null) state.decl = decl;
      }
    }
    return;
  }
  let statement = "not affected";
  if (headsUp.result === "repair" && headsUp.dropped_ops.length > 0) {
    // The dropped op is the `replace` on the entity (the only edit the pattern makes): read it
    // again and replace from the new current value, as the row's repair says.
    state.reread = true;
    statement = "retuned from the new value";
  }
  state.acks.push({ hn: headsUp.hn, statement });
}

/** What the answer to the last issued call changes. */
function consumeLast(state: CycleState, target: CycleTarget, turn: PatternTurn): void {
  const last = turn.last;
  if (last === null || state.issued === "none") return;
  const issued = state.issued;
  state.issued = "none";
  if (last.error !== undefined) {
    const code = last.error.code;
    if (code === "attempt_closed" || code === "attempt_unknown") {
      state.done = true;
    } else if (code === "heads_up_first") {
      // TA3: refused without being recorded; the heads-ups ride this answer and the step is
      // decided again below, never replayed.
    } else {
      // SW6: a call answering `limit_reached`, `no_match` or `ambiguous`, and any other failure
      // the script cannot fix, ends the attempt with `stop` `withdrawn`.
      state.withdrawn = true;
    }
    return;
  }
  if (issued === "script") {
    if (state.step === STEP_READ) {
      state.decl = declOf(sourceOf(last.result), target.entity);
      const own = state.decl === null ? null : editOf(target, state.decl);
      if (own === null) {
        state.withdrawn = true; // nothing in the cycle applies: the entity is not as the row expects
        return;
      }
    }
    state.step += 1;
    return;
  }
  if (issued === "reread") {
    state.reread = false;
    const decl = declOf(sourceOf(last.result), target.entity);
    const own = decl === null ? null : editOf(target, decl);
    if (decl === null || own === null) {
      state.withdrawn = true; // the new source holds no declaration the cycle can step
      return;
    }
    state.decl = decl;
    state.repairs.push(own);
    return;
  }
  if (issued === "repair") {
    state.repairs.shift(); // the confirmed `replace` leaves the queue
    return;
  }
  if (issued === "submit") {
    const status = submitStatus(last.result);
    if (
      status === "validated" ||
      status === "submitted" ||
      status === "held" ||
      status === "accepted" ||
      status === "landed"
    ) {
      state.acks = [];
      state.done = true;
    } else if (status === "needs_confirm" || status === "go_around") {
      state.step = STEP_SUBMIT; // answer the waiting heads-ups, then submit again
    } else if (status === "rejected") {
      state.withdrawn = true; // the script cannot fix a rejected change
    } else if (status === "stopped") {
      state.done = true;
    }
  }
}

/** A `retune`-shaped pattern over the rows' targets. The entity is drawn from the first `rand`
 * draw, so `truthOf` on a fresh stream names the same entity the script will touch. */
export function makeCycleEdit(id: string, intent: string, targets: readonly CycleTarget[]): Pattern {
  return {
    id,
    intent,
    truth: [], // the entity is drawn; `truthOf` names it (10.3: `entity:<path>#<name>`)
    truthOf(rand) {
      const target = targets[Math.floor(rand() * targets.length)] as CycleTarget;
      return [`entity:${entityKeyOf(target)}`];
    },

    next(turn: PatternTurn): PatternStep {
      const state: CycleState = turn.state === null ? initialState() : { ...(turn.state as CycleState) };
      state.released ||= turn.released;
      if (state.pick === null) state.pick = Math.floor(turn.rand() * targets.length);
      const target = targets[state.pick] as CycleTarget;

      consumeLast(state, target, turn);
      for (const headsUp of turn.heads_ups) answerHeadsUp(state, target, headsUp);

      // A pull-back (GA3) or a landed-time answer reopens work after a successful submit.
      if (state.done && (state.acks.length > 0 || state.repairs.length > 0 || state.reread)) {
        state.done = false;
        state.step = STEP_SUBMIT;
      }

      if (state.withdrawn) {
        const reason: AgentStopReason = "withdrawn";
        return { kind: "stop", reason, state };
      }
      if (state.reread) {
        state.issued = "reread";
        return {
          kind: "tool",
          tool: "read",
          args: { path: target.path, entity: target.entity },
          state,
        };
      }
      if (state.repairs.length > 0) {
        const repair = state.repairs[0] as { old: string; new: string };
        state.issued = "repair";
        return { kind: "tool", tool: "replace", args: { path: target.path, ...repair }, state };
      }
      if (state.done) return { kind: "wait", state };

      if (state.step === STEP_READ) {
        state.issued = "script";
        return {
          kind: "tool",
          tool: "read",
          args: { path: target.path, entity: target.entity },
          state,
        };
      }
      if (state.step === STEP_REPLACE && state.decl !== null) {
        const own = editOf(target, state.decl);
        if (own === null) {
          const reason: AgentStopReason = "withdrawn";
          return { kind: "stop", reason, state };
        }
        state.issued = "script";
        return { kind: "tool", tool: "replace", args: { path: target.path, ...own }, state };
      }

      // STEP_SUBMIT. SW8/SWR3: a held agent waits before its first submit until released.
      if (turn.hold && !state.released) return { kind: "wait", state };
      state.issued = "submit";
      return {
        kind: "tool",
        tool: "submit",
        args: { summary: intent, ...submitFields(state.acks) },
        state,
      };
    },
  };
}

/** The `retune` row's four targets, in table order (10.3). */
export const RETUNE: Pattern = makeCycleEdit("retune", "retune a world constant", [
  MAX_SPEED,
  FOOD_EVERY,
  REST_TICKS,
  DAY_TICKS,
]);
