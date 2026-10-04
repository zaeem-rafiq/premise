// The intent box's state rows (03-floor 3.1, CO1). The ids each row answers are the spec's own
// copy ids; the order is the table's top-to-bottom order.

import { describe, expect, it } from "vitest";
import { emptyFloorState } from "../../../protocol/reducer/state.ts";
import { intentBoxState, queueNote, type IntentBoxInputs } from "./model.ts";

function inputs(over: Partial<IntentBoxInputs> = {}): IntentBoxInputs {
  return {
    floor: emptyFloorState(),
    mode: "live",
    owner: true,
    capReached: false,
    phase: "idle",
    waited: false,
    error: null,
    ...over,
  };
}

describe("intentBoxState (03 3.1, the rows in order)", () => {
  it("Replay replaces the field with intent.replay, even for the owner", () => {
    expect(intentBoxState(inputs({ mode: "replay" }))).toEqual({ kind: "replay", id: "intent.replay" });
  });
  it("a visitor sees intent.visitor (FL7)", () => {
    expect(intentBoxState(inputs({ owner: false }))).toEqual({ kind: "blocked", id: "intent.visitor" });
  });
  it("a killed pool shows intent.killed", () => {
    const floor = emptyFloorState();
    floor.limits = { spend_usd: 0, reserved_usd: 0, cap_usd: 10, killed: true, refusing: false, ts: 0, models: [] };
    expect(intentBoxState(inputs({ floor }))).toEqual({ kind: "blocked", id: "intent.killed" });
  });
  it("a paused pool shows intent.paused, a rebuilding one intent.rebuilding", () => {
    const paused = emptyFloorState();
    paused.pool.state = "paused";
    expect(intentBoxState(inputs({ floor: paused }))).toEqual({ kind: "blocked", id: "intent.paused" });
    const rebuilding = emptyFloorState();
    rebuilding.pool.state = "rebuilding";
    expect(intentBoxState(inputs({ floor: rebuilding }))).toEqual({
      kind: "blocked",
      id: "intent.rebuilding",
    });
  });
  it("the spend cap shows intent.cap", () => {
    expect(intentBoxState(inputs({ capReached: true }))).toEqual({ kind: "blocked", id: "intent.cap" });
  });
  it("a create request in flight reads sending; a sent one waits inside SENT_WAIT_MS", () => {
    expect(intentBoxState(inputs({ phase: "sending" })).kind).toBe("sending");
    expect(intentBoxState(inputs({ phase: "sent" })).kind).toBe("sent");
    expect(intentBoxState(inputs({ phase: "sent", waited: true })).kind).toBe("waiting");
  });
  it("a failed request shows its 5.9 sentence and keeps the draft", () => {
    expect(intentBoxState(inputs({ error: "boom" }))).toEqual({ kind: "error", sentence: "boom" });
  });
  it("otherwise the box is live", () => {
    expect(intentBoxState(inputs()).kind).toBe("live");
  });
});

describe("queueNote (CO6)", () => {
  it("shows intent.queue while every agent slot is busy, and the box stays live", () => {
    const floor = emptyFloorState();
    floor.pool.real_agents = 6;
    floor.pool.max_real_agents = 6;
    const state = intentBoxState(inputs({ floor }));
    expect(state.kind).toBe("live");
    expect(queueNote(floor, state)).toBe(true);
  });
  it("is quiet while a slot is free, or before the pool's numbers arrive", () => {
    const floor = emptyFloorState();
    floor.pool.real_agents = 5;
    floor.pool.max_real_agents = 6;
    expect(queueNote(floor, intentBoxState(inputs({ floor })))).toBe(false);
    // 0 of 0 must not read as "all slots busy".
    expect(queueNote(emptyFloorState(), intentBoxState(inputs()))).toBe(false);
  });
});
