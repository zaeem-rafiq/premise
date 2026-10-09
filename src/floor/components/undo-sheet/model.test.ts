// The undo sheet's plan sentences of 03-floor 3.12 / 5.10: `undo.title`, `undo.also` /
// `undo.also.none`, `undo.kept`, `undo.in_flight` — resolved from an `UndoPlan` against the
// stream, so the owner reads which landings go back, which reopen and which stay (CO34a). Expected
// text comes from the copy table, never from the implementation (BP1).

import { describe, expect, it } from "vitest";
import type { PoolEvent } from "../../../protocol/events.ts";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import { emptyFloorState, reduce } from "../../../protocol/reducer/index.ts";
import { modelName } from "../../../copy/names.ts";
import { text } from "../../../copy/strings.ts";
import { undoPlanModel } from "./model.ts";

let n = 0;
function ev(type: PoolEvent["type"], body: object = {}, ts = 1_000): PoolEvent {
  n += 1;
  return { n, t: ts, ts, pool: "tidepool", src: "trunk", type, ...body } as PoolEvent;
}

function baseState(): FloorState {
  const state = emptyFloorState();
  reduce(
    state,
    ev("pool.state", {
      head_seq: 0,
      head_commit: "seed00",
      green_seq: 0,
      landed_seq: 0,
      landed_commit: "seed00",
      state: "ready",
      reason: null,
      epoch: 1,
      remote: "https://pool/tidepool",
      plain_remote: null,
      rebuild: null,
      unwitnessed: [],
      real_agents: 1,
      max_real_agents: 6,
      synthetic: false,
      summary_only: false,
    }),
  );
  return state;
}

/** An intent, its attempt, one created-file premise and the landing it lands as `seq`. The
 * created file gives the landing its 5.2 change name (the file's basename, minus extension). */
function landChange(state: FloorState, seq: number, attemptId: string, file: string): void {
  const intentId = `i_${attemptId}`;
  reduce(
    state,
    ev("intent.created", {
      intent_id: intentId,
      text: `text of ${intentId}`,
      requester: "owner",
      race: false,
      prewritten: false,
    }),
  );
  reduce(
    state,
    ev("attempt.opened", {
      attempt_id: attemptId,
      intent_id: intentId,
      change_id: `c_${attemptId}`,
      agent: "real",
      model: "m-1",
      race: false,
    }),
  );
  reduce(
    state,
    ev("premise.recorded", {
      attempt_id: attemptId,
      tool: "write",
      premise: { kind: "file", key: file, hash: "absent", seq: 0, read: false, edit: true, derived: false },
    }),
  );
  reduce(
    state,
    ev("landing.accepted", {
      seq,
      batch_id: seq,
      kind: "change",
      attempt_id: attemptId,
      change_id: `c_${attemptId}`,
      intent_id: intentId,
      request_id: null,
      paths: [file],
      writes: [{ kind: "file", key: file, old: "absent", new: `h${seq}` }],
    }),
  );
  reduce(
    state,
    ev("landing.landed", {
      seq,
      batch_id: seq,
      commit: `commit-${seq}`,
      tree: `tree-${seq}`,
      note: `note-${seq}`,
      note_json: JSON.stringify({ v: 1, seq, kind: "change", change_id: `c_${attemptId}` }),
      time_to_land_ms: 100,
    }),
  );
}

const modelLabel = (id: string) => modelName(id);

describe("undoPlanModel (3.12, 5.10)", () => {
  it("names the target and its intent in undo.title", () => {
    const state = baseState();
    landChange(state, 1, "a_1", "world/energy.js");
    const model = undoPlanModel(
      state,
      { target_seq: 1, reverted: [1], reopened: [], kept_readers: [], repairs: [] },
      modelLabel,
    );
    expect(model.title).toBe(text("undo.title", { landing: "landing 1", "intent text": "text of i_a_1" }));
  });

  it("undo.also.none when the target is the only reverted landing", () => {
    const state = baseState();
    landChange(state, 1, "a_1", "world/energy.js");
    const model = undoPlanModel(
      state,
      { target_seq: 1, reverted: [1], reopened: [], kept_readers: [], repairs: [] },
      modelLabel,
    );
    expect(model.also).toBe(text("undo.also.none"));
    expect(model.kept).toBeNull();
    expect(model.inFlight).toBeNull();
  });

  it("undo.also lists the other reverted landings with their change names (n = 1 form)", () => {
    const state = baseState();
    landChange(state, 1, "a_1", "world/energy.js");
    landChange(state, 2, "a_2", "world/movement.js");
    const model = undoPlanModel(
      state,
      { target_seq: 1, reverted: [1, 2], reopened: ["a_2"], kept_readers: [], repairs: [] },
      modelLabel,
    );
    // The one-form of undo.also (03 5.10): singular "change", "Its agent", not "Their agents".
    expect(model.also).toBe(text("undo.also", { n: 1, names: "landing 2 movement" }));
  });

  it("undo.also plural form for two later landings", () => {
    const state = baseState();
    landChange(state, 1, "a_1", "world/energy.js");
    landChange(state, 2, "a_2", "world/movement.js");
    landChange(state, 3, "a_3", "creatures/fish.js");
    const model = undoPlanModel(
      state,
      { target_seq: 1, reverted: [1, 2, 3], reopened: [], kept_readers: [], repairs: [] },
      modelLabel,
    );
    expect(model.also).toBe(text("undo.also", { n: 2, names: "landing 2 movement, landing 3 fish" }));
  });

  it("undo.kept names the kept readers; undo.in_flight names the repairs", () => {
    const state = baseState();
    landChange(state, 1, "a_1", "world/energy.js");
    landChange(state, 4, "a_4", "creatures/snail.js");
    reduce(
      state,
      ev("intent.created", {
        intent_id: "i_9",
        text: "text of i_9",
        requester: "owner",
        race: false,
        prewritten: false,
      }),
    );
    reduce(
      state,
      ev("attempt.opened", {
        attempt_id: "a_9",
        intent_id: "i_9",
        change_id: "c_a_9",
        agent: "real",
        model: "m-2",
        race: false,
      }),
    );
    const model = undoPlanModel(
      state,
      { target_seq: 1, reverted: [1], reopened: [], kept_readers: [4], repairs: ["a_9"] },
      modelLabel,
    );
    expect(model.kept).toBe(text("undo.kept", { n: 1, names: "landing 4 snail" }));
    expect(model.inFlight).toBe(text("undo.in_flight", { n: 1, names: '"text of i_9"' }));
  });
});
