// Render-time smoke of the undo sheet under react-dom/server (03-floor 3.12): the planning state
// is what SSR can reach — the plan arrives over `getJson` in an effect, which does not run here.
// Catches crashes a browser would only show as a blank page.

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PoolEvent } from "../../../protocol/events.ts";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import { emptyFloorState, reduce } from "../../../protocol/reducer/index.ts";
import { makeShell, ShellContext } from "../../app/context.ts";
import { UndoSheet } from "./undo-sheet.tsx";

let n = 0;
function ev(type: PoolEvent["type"], body: object = {}, ts = 1_000): PoolEvent {
  n += 1;
  return { n, t: ts, ts, pool: "tidepool", src: "trunk", type, ...body } as PoolEvent;
}

const SETTINGS = {
  default_pool: "tidepool",
  swarm_pool: "tidepool-swarm",
  features: { held: true, race: true, undo: true, green: "none", clef: true, attempt_repos: false },
  prewritten: [],
  swarm_defaults: { seed: 7, launch_per_second: 50, think_ms: [50, 400], rescale_every_s: 15 },
  models: {},
  limits: [],
  related: "",
} as never;

function landedFloor(): FloorState {
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
    ev("intent.created", {
      intent_id: "i_1",
      text: "a tracer fish",
      requester: "owner",
      race: false,
      prewritten: false,
    }),
  );
  reduce(
    state,
    ev("attempt.opened", {
      attempt_id: "a_1",
      intent_id: "i_1",
      change_id: "c_a_1",
      agent: "real",
      model: "m-1",
      race: false,
    }),
  );
  reduce(
    state,
    ev("landing.accepted", {
      seq: 1,
      batch_id: 1,
      kind: "change",
      attempt_id: "a_1",
      change_id: "c_a_1",
      intent_id: "i_1",
      request_id: null,
      paths: ["world/energy.js"],
      writes: [{ kind: "file", key: "world/energy.js", old: "h0", new: "h1" }],
    }),
  );
  reduce(
    state,
    ev("landing.landed", {
      seq: 1,
      batch_id: 1,
      commit: "commit-1",
      tree: "tree-1",
      note: "note-1",
      note_json: JSON.stringify({ v: 1, seq: 1, kind: "change", change_id: "c_a_1" }),
      time_to_land_ms: 100,
    }),
  );
  return state;
}

describe("UndoSheet render (3.12)", () => {
  it("renders the title of the target and the planning sentence while the plan is fetched", () => {
    const html = renderToString(
      createElement(
        ShellContext.Provider,
        { value: makeShell(SETTINGS, true, false) },
        createElement(UndoSheet, { floor: landedFloor(), seq: 1, onClose: () => undefined }),
      ),
    );
    expect(html).toContain("Undo landing 1: &quot;a tracer fish&quot;?");
    expect(html).toContain("Working out what this undo takes back");
  });
});
