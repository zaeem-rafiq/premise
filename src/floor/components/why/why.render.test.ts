// Render-time smoke of the Why sheet and its drawer under react-dom/server: catches crashes
// that a browser would only show as a blank page. (Effects don't run under SSR; this exercises
// the pure render path only.)

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyFloorState, reduce } from "../../../protocol/reducer/index.ts";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import { makeShell, ShellContext } from "../../app/context.ts";
import { WhySheet } from "./why.tsx";
import { WhoSheet } from "../who-relies/who-relies.tsx";

function stateOf(name: string): FloorState {
  const lines = readFileSync(join(__dirname, "../../../../test/fixtures/streams", name), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  let state = emptyFloorState();
  for (const event of lines) if (typeof event.type === "string") state = reduce(state, event as never);
  return state;
}

const SETTINGS = {
  default_pool: "tidepool",
  swarm_pool: "tidepool-swarm",
  features: { held: true, race: true, undo: true, green: "full", clef: true, attempt_repos: true },
  prewritten: [],
  swarm_defaults: { seed: 7, launch_per_second: 50, think_ms: [50, 400], rescale_every_s: 15 },
  models: { "model-a": "model-a" },
  limits: [],
  related: "",
} as never;

function shell() {
  return makeShell(SETTINGS, true, false);
}

describe("WhySheet render", () => {
  it("renders the live card of hero-c04 seq 2", () => {
    const floor = stateOf("hero-c04.ndjson");
    const html = renderToString(
      createElement(
        ShellContext.Provider,
        { value: shell() },
        createElement(WhySheet, { floor, seq: 2, onClose: () => undefined }),
      ),
    );
    expect(html).toContain("Why is this here?");
    expect(html).toContain("a crab that hides when its energy is low");
  });

  it.each([
    { role: "owner", owner: true, replay: false, canUndo: true },
    { role: "visitor", owner: false, replay: false, canUndo: false },
    { role: "owner in Replay", owner: true, replay: true, canUndo: false },
    { role: "visitor in Replay", owner: false, replay: true, canUndo: false },
  ])("FL7 / 3.12: $role has Undo visibility $canUndo", ({ owner, replay, canUndo }) => {
    const html = renderToString(
      createElement(
        ShellContext.Provider,
        { value: makeShell(SETTINGS, owner, replay) },
        createElement(WhySheet, {
          floor: stateOf("hero-c04.ndjson"),
          seq: 2,
          mode: replay ? "replay" : "live",
          onClose: () => undefined,
          onOpenUndo: () => undefined,
        }),
      ),
    );
    expect(html).toContain('data-status="live"');
    expect(html).toContain("Why is this here?");
    expect(html).toContain("Show the git");
    const undoButtons = html.match(/<button\b[^>]*>Undo<\/button>/g) ?? [];
    expect(undoButtons).toHaveLength(canUndo ? 1 : 0);
    if (canUndo) expect(undoButtons[0]).not.toContain("disabled");
  });
});

describe("WhoSheet render", () => {
  it("renders the ENERGY_MAX lists of hero-c04", () => {
    const floor = stateOf("hero-c04.ndjson");
    const html = renderToString(
      createElement(
        ShellContext.Provider,
        { value: shell() },
        createElement(WhoSheet, {
          floor,
          kind_: "entity",
          whoKey: "world/energy.js#ENERGY_MAX",
          onClose: () => undefined,
        }),
      ),
    );
    expect(html).toContain("Who relies on");
  });
});
