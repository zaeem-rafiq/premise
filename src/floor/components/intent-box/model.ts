// The intent box's state decision (03-floor 3.1): the table's rows are matched top to bottom
// (CO1) and the model answers which row applies, by copy id. The component owns only the
// mechanics — draft, request phases, timers — and the copy lookup; the order below is the
// spec's and a unit test reads the rows off it (BP1).

import type { FloorState } from "../../../protocol/reducer/state.ts";

/** One row of the 3.1 state table, named by what controls the box leaves usable. */
export type IntentBoxState =
  | { kind: "replay"; id: "intent.replay" } // the sentence replaces the field
  | { kind: "blocked"; id: string } // field disabled, the sentence says why (FL7)
  | { kind: "sending" } // a create request is in flight (`intent.sending`)
  | { kind: "sent" } // answered, still inside SENT_WAIT_MS (shows `intent.sending`)
  | { kind: "waiting" } // answered and past SENT_WAIT_MS (`intent.sent_waiting`, field only)
  | { kind: "error"; sentence: string } // the last request failed; the draft is kept
  | { kind: "live" }; // empty or live row: field, count, buttons

export type IntentBoxInputs = {
  floor: FloorState;
  mode: "live" | "replay";
  owner: boolean;
  capReached: boolean;
  /** The box's request phase: a send in flight, or answered and waiting on `intent.created`. */
  phase: "idle" | "sending" | "sent";
  /** `phase` `sent` and `SENT_WAIT_MS` has passed without the event (03 3.1 loading row). */
  waited: boolean;
  /** The 5.9 sentence of the last failed request, or null. */
  error: string | null;
};

/**
 * The box's state (03 3.1, CO1). The queue of CO6 is not a row of the table — the box stays
 * enabled and carries `intent.queue` as a note — so the model reports it separately.
 */
export function intentBoxState(inputs: IntentBoxInputs): IntentBoxState {
  const { floor, mode, owner, capReached: cap, phase, waited, error } = inputs;
  if (mode === "replay") return { kind: "replay", id: "intent.replay" };
  if (!owner) return { kind: "blocked", id: "intent.visitor" };
  if (floor.limits?.killed === true) return { kind: "blocked", id: "intent.killed" };
  if (floor.pool.state === "paused") return { kind: "blocked", id: "intent.paused" };
  if (floor.pool.state === "rebuilding") return { kind: "blocked", id: "intent.rebuilding" };
  if (cap) return { kind: "blocked", id: "intent.cap" };
  if (phase === "sending") return { kind: "sending" };
  if (phase === "sent") return waited ? { kind: "waiting" } : { kind: "sent" };
  if (error !== null) return { kind: "error", sentence: error };
  return { kind: "live" };
}

/** CO6: every agent slot is busy — the box stays enabled and carries the `intent.queue` note. */
export function queueNote(floor: FloorState, state: IntentBoxState): boolean {
  return (
    state.kind === "live" &&
    floor.pool.max_real_agents > 0 &&
    floor.pool.real_agents >= floor.pool.max_real_agents
  );
}
