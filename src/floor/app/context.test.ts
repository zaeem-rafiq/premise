// The copy-variant lookup of `Shell.t` (5.4, CP7): the caller keeps the base id and the
// reader's kind picks the `*.visitor`/`*.replay` id the copy table holds. Replay wins
// over visitor - `rail.empty.working.replay` is the rail's empty Working text in Replay.

import { describe, expect, it } from "vitest";
import { makeShell } from "./context.ts";

const SETTINGS = {
  default_pool: "tidepool",
  swarm_pool: "tidepool-swarm",
  features: { held: true, race: true, undo: true, green: "full", clef: true, attempt_repos: true },
  prewritten: [],
  swarm_defaults: { seed: 7, launch_per_second: 50, think_ms: [50, 400], rescale_every_s: 15 },
  models: {},
  limits: [],
  related: "",
} as never;

describe("Shell.t copy variants (5.4)", () => {
  it("an owner reads rail.empty.working", () => {
    expect(makeShell(SETTINGS, true, false).t("rail.empty.working")).toBe(
      "No change is in flight. Type a request above.",
    );
  });

  it("a visitor reads rail.empty.working.visitor", () => {
    expect(makeShell(SETTINGS, false, false).t("rail.empty.working")).toBe(
      "No change is in flight. Press Replay to watch a recorded run.",
    );
  });

  it("everyone in Replay reads rail.empty.working.replay - owner and visitor alike", () => {
    expect(makeShell(SETTINGS, true, true).t("rail.empty.working")).toBe(
      "No change is in flight at this point of the recording.",
    );
    expect(makeShell(SETTINGS, false, true).t("rail.empty.working")).toBe(
      "No change is in flight at this point of the recording.",
    );
  });

  it("an id the table holds no variant of keeps its text", () => {
    expect(makeShell(SETTINGS, false, true).t("rail.tab.working", { n: 2 })).toBe("Working 2");
  });

  it("a caller's `visitor: false` still pins the owner's sentence", () => {
    expect(makeShell(SETTINGS, false, false).t("rail.empty.working", { visitor: false })).toBe(
      "No change is in flight. Type a request above.",
    );
  });
});
