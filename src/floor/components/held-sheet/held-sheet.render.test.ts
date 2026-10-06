// Render-time smoke of the held sheet under react-dom/server (03-floor 3.13): catches crashes a
// browser would only show as a blank page. Effects do not run under SSR, so this exercises the
// pure render path — the frames row with its placeholder sentences, the grid, the option buttons.

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PoolEvent } from "../../../protocol/events.ts";
import type { Card } from "../../../protocol/cards.ts";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import { emptyFloorState, reduce } from "../../../protocol/reducer/index.ts";
import { makeShell, ShellContext } from "../../app/context.ts";
import { HeldSheet } from "./held-sheet.tsx";

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
  models: { "m-1": "m-1" },
  limits: [],
  related: "",
} as never;

function stateWith(card: Card): FloorState {
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
      text: "raise the limit",
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
  reduce(state, ev("card.opened", { card }));
  return state;
}

const HELD: Card = {
  card_id: "k_1",
  kind: "held",
  attempt_ids: ["a_1"],
  intent_ids: ["i_1"],
  submit_ids: { a_1: "s_1" },
  title: "This change touches shared rules. Land it?",
  body: ["It changes world/energy.js."],
  options: [
    { id: "land", label: "Land" },
    { id: "decline", label: "Decline" },
  ],
  paths: [{ path: "world/energy.js", tier: "held" }],
  blast_radius: {},
  preview: null,
  candidates: null,
  risk: null,
  reason: "held_path",
};

describe("HeldSheet render (3.13)", () => {
  it("renders title, body, intent, both frame cells building and the option buttons", () => {
    const html = renderToString(
      createElement(
        ShellContext.Provider,
        { value: makeShell(SETTINGS, true, false) },
        createElement(HeldSheet, { floor: stateWith(HELD), cardId: "k_1", onClose: () => undefined }),
      ),
    );
    expect(html).toContain("This change touches shared rules. Land it?");
    expect(html).toContain("It changes world/energy.js.");
    expect(html).toContain("owner: &quot;raise the limit&quot;");
    expect(html).toContain("Before");
    expect(html).toContain("After");
    expect(html).toContain("Building the preview");
    expect(html).toContain(">Land</button>");
    expect(html).toContain(">Decline</button>");
  });

  it("renders the after frame's iframe at the commit address (CO36, PV5)", () => {
    const card: Card = {
      ...HELD,
      preview: {
        before: { repo: "main", commit: "seed00" },
        after: { a_1: { repo: "plain", commit: "c_after" } },
        error: null,
      },
    };
    const html = renderToString(
      createElement(
        ShellContext.Provider,
        { value: makeShell(SETTINGS, true, false) },
        createElement(HeldSheet, { floor: stateWith(card), cardId: "k_1", onClose: () => undefined }),
      ),
    );
    expect(html).toContain("/pool/tidepool/seed00/?seed=");
    expect(html).toContain("/pool/tidepool/p-c_after/?seed=");
    expect(html).toContain('sandbox="allow-scripts"');
  });

  it("FR32: preview.error renders held.no_preview in place of the after frame", () => {
    const card: Card = {
      ...HELD,
      preview: { before: null, after: {}, error: "build failed" },
    };
    const html = renderToString(
      createElement(
        ShellContext.Provider,
        { value: makeShell(SETTINGS, true, false) },
        createElement(HeldSheet, { floor: stateWith(card), cardId: "k_1", onClose: () => undefined }),
      ),
    );
    expect(html).toContain("No preview is available for this change.");
    expect(html).not.toContain("iframe");
  });

  it("renders nothing for a card id the floor does not hold", () => {
    const html = renderToString(
      createElement(
        ShellContext.Provider,
        { value: makeShell(SETTINGS, true, false) },
        createElement(HeldSheet, { floor: stateWith(HELD), cardId: "k_nope", onClose: () => undefined }),
      ),
    );
    expect(html).toBe("");
  });
});
