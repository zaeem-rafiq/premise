// 03-floor 5.2 `changeName` on the page's own state (design review D19): the reducer keeps each
// premise's pin, so an attempt that created a file is named after that file, as beats 4 and 7 say.
import { describe, expect, it } from "vitest";
import type { PoolEvent } from "../protocol/events.ts";
import type { FloorState } from "../protocol/reducer/state.ts";
import { emptyFloorState } from "../protocol/reducer/state.ts";
import { reduce } from "../protocol/reducer/reduce.ts";
import { changeName } from "./names.ts";

let n = 0;
function ev(type: PoolEvent["type"], body: object, ts = 1_000): PoolEvent {
  n += 1;
  return { n, t: ts, ts, pool: "tidepool", src: "trunk", type, ...body } as PoolEvent;
}

const CRAB_REQUEST = "a crab that hides in its shell when its energy drops below 30";

function racedCrab(premise: { hash: string; edit: boolean }): FloorState {
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
  reduce(
    state,
    ev("intent.created", { intent_id: "i1", text: CRAB_REQUEST, requester: "owner", race: true, prewritten: true }),
  );
  reduce(
    state,
    ev("attempt.opened", {
      attempt_id: "a1",
      intent_id: "i1",
      change_id: "c_000001",
      agent: "real",
      model: "@cf/zai-org/glm-5.3-flash",
      race: true,
    }),
  );
  reduce(
    state,
    ev("premise.recorded", {
      attempt_id: "a1",
      tool: "write",
      premise: { kind: "file", key: "creatures/crab.js", seq: 0, read: false, derived: false, ...premise },
    }),
  );
  return state;
}

function nameOn(state: FloorState): string {
  const attempt = state.attempts["a1"]!;
  return changeName({
    intentText: state.intents[attempt.intent_id]!.text,
    race: attempt.race,
    model: attempt.model,
    premises: Object.values(attempt.premises),
  });
}

describe("5.2 changeName on reduced state (D19)", () => {
  it("names a raced attempt that created creatures/crab.js 'crab (glm-5.3-flash)'", () => {
    expect(nameOn(racedCrab({ hash: "absent", edit: true }))).toBe("crab (glm-5.3-flash)");
  });

  it("falls back to the quoted request when the file existed before the attempt wrote it", () => {
    const name = nameOn(racedCrab({ hash: "b1", edit: true }));
    expect(name.startsWith('"a crab that hides')).toBe(true);
    expect(name.endsWith('" (glm-5.3-flash)')).toBe(true);
  });
});
