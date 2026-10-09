// Render-time smoke of the race sheet under react-dom/server (03-floor 3.14): one column per
// candidate with its preview frame or state line, and the Choose button only where `can_choose`.
// Effects do not run under SSR; this exercises the pure render path.

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PoolEvent } from "../../../protocol/events.ts";
import type { Card } from "../../../protocol/cards.ts";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import { emptyFloorState, reduce } from "../../../protocol/reducer/index.ts";
import { makeShell, ShellContext } from "../../app/context.ts";
import { RaceSheet } from "./race-sheet.tsx";

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
  models: { "m-fast": "m-fast", "m-slow": "m-slow" },
  limits: [],
  related: "",
} as never;

function raceState(): FloorState {
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
      text: "a faster fish",
      requester: "owner",
      race: true,
      prewritten: false,
    }),
  );
  for (const [id, model] of [
    ["a_1", "m-fast"],
    ["a_2", "m-slow"],
  ] as const) {
    reduce(
      state,
      ev("attempt.opened", {
        attempt_id: id,
        intent_id: "i_1",
        change_id: `c_${id}`,
        agent: "real",
        model,
        race: true,
      }),
    );
    reduce(
      state,
      ev("attempt.state", {
        attempt_id: id,
        from: "opened",
        to: "working",
        transition: "T1",
        reason: null,
        go_arounds: 0,
        pull_backs: 0,
        right_of_way: false,
      }),
    );
  }
  reduce(
    state,
    ev("card.opened", {
      card: {
        card_id: "k_r",
        kind: "race",
        attempt_ids: ["a_1", "a_2"],
        intent_ids: ["i_1"],
        submit_ids: { a_1: "s_1", a_2: "s_2" },
        title: "Two attempts landed their work. Choose one.",
        body: ["Both passed their checks."],
        options: [{ id: "choose", label: "Choose" }],
        paths: [{ path: "world/energy.js", tier: "auto" }],
        blast_radius: {
          a_1: { repair: [], confirm: [], triage: [], right_of_way: [] },
          a_2: { repair: ["a_9"], confirm: [], triage: [], right_of_way: [] },
        },
        preview: {
          before: { repo: "main", commit: "seed00" },
          after: { a_1: { repo: "main", commit: "c_a1" } },
          error: null,
        },
        candidates: {
          a_1: { state: "submitted", can_choose: true, seconds: 42, cost_usd: 0.12 },
          a_2: { state: "working", can_choose: false, seconds: null, cost_usd: null },
        },
        risk: null,
        reason: "race",
      } satisfies Card,
    }),
  );
  return state;
}

describe("RaceSheet render (3.14)", () => {
  it("CO14: each dense candidate renders its count and keeps the changed lights visible", () => {
    const state = raceState();
    for (const id of ["a_1", "a_2"]) {
      for (let index = 0; index < (id === "a_2" ? 32 : 30); index += 1) {
        const key = `facts/${index}.js`;
        state.attempts[id]!.premises[`file ${key}`] = {
          kind: "file",
          key,
          read: true,
          edit: false,
          derived: false,
          light: index >= 30 ? "changed" : "holds",
          judgment: null,
        };
      }
    }
    const html = renderToString(
      createElement(
        ShellContext.Provider,
        { value: makeShell(SETTINGS, true, false) },
        createElement(RaceSheet, { floor: state, cardId: "k_r", onClose: () => undefined }),
      ),
    );
    expect(html.match(/class="light light--changed"/g)).toHaveLength(2);
    expect(html.match(/class="light light--holds"/g)).toHaveLength(26);
    expect(html).toContain('<span class="card-sheet__more">+16</span>');
    expect(html).toContain('<span class="card-sheet__more">+18</span>');
    const second = html.slice(html.indexOf('data-attempt-id="a_2"'));
    expect(second).toContain('aria-label="the file facts/30.js: Changed. the agent read it."');
    expect(second).toContain('aria-label="the file facts/31.js: Changed. the agent read it."');
    expect(second.indexOf('class="light light--changed"')).toBeLessThan(second.indexOf('class="light light--holds"'));
    expect(second.lastIndexOf('class="light light--holds"')).toBeLessThan(second.indexOf('class="card-sheet__more"'));
  });

  it("renders one column per candidate: preview frame, facts, state line, one Choose", () => {
    const html = renderToString(
      createElement(
        ShellContext.Provider,
        { value: makeShell(SETTINGS, true, false) },
        createElement(RaceSheet, { floor: raceState(), cardId: "k_r", onClose: () => undefined }),
      ),
    );
    expect(html).toContain("Two attempts landed their work. Choose one.");
    expect(html).toContain('data-attempt-id="a_1"');
    expect(html).toContain('data-attempt-id="a_2"');
    // The choosable column plays its preview at the commit address.
    expect(html).toContain("/pool/tidepool/c_a1/?seed=");
    // The working column carries no frame; its line is race.working + status word + steps.
    expect(html).toContain("Still working");
    // CO39: null seconds/cost read race.unknown ("not recorded"), never zero.
    expect(html).toContain("not recorded");
    expect(html).toContain("Took 42 s");
    expect(html).toContain("Cost $0.12");
    expect(html).toContain("Would send back: 0 changes");
    expect(html).toContain("Would send back: 1 change<");
    // Only the choosable column's Choose renders.
    expect((html.match(/>Choose</g) ?? []).length).toBe(1);
  });
});
