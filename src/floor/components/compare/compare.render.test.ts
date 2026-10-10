// CO25 item 4 under both values of `features.text_merge` (03-floor.md; 01-core.md PM3, PM3a):
// the count of text conflicts says "(approximated)" only while the switch is off. Rendered with
// react-dom/server, so the pure render path runs; the expected words are the spec's copy rows.

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyFloorState, reduce } from "../../../protocol/reducer/index.ts";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import { makeShell, ShellContext } from "../../app/context.ts";
import { Compare } from "./compare.tsx";

const base = (n: number, fields: Record<string, unknown>) => ({
  n,
  t: 1_000 + n,
  ts: 1_000 + n,
  src: "trunk",
  pool: "testpool",
  ...fields,
});

/** A pool whose plain-merge pool counted landings 1 and 2 as text conflicts. */
function stateWithTwoConflicts(): FloorState {
  const events = [
    base(1, {
      type: "pool.state",
      head_seq: 0,
      head_commit: "c-seed",
      green_seq: 0,
      landed_seq: 0,
      landed_commit: "c-seed",
      state: "ready",
      reason: null,
      epoch: 1,
      remote: "https://artifacts.invalid/testpool",
      plain_remote: "https://artifacts.invalid/testpool-plain",
      rebuild: null,
      unwitnessed: [],
      real_agents: 0,
      max_real_agents: 6,
      synthetic: false,
      summary_only: false,
    }),
    base(2, {
      type: "plain.updated",
      commit: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      tree: "tree-plain-1",
      through_seq: 2,
      skipped: [1, 2],
      interrupted: [],
    }),
  ];
  let state = emptyFloorState();
  for (const event of events) state = reduce(state, event as never);
  return state;
}

function render(textMerge: boolean): string {
  const settings = {
    default_pool: "testpool",
    swarm_pool: "testpool-swarm",
    features: {
      held: true,
      race: true,
      undo: true,
      green: "none",
      clef: false,
      attempt_repos: false,
      text_merge: textMerge,
    },
    prewritten: [],
    swarm_defaults: { seed: 7, launch_per_second: 50, think_ms: [50, 400], rescale_every_s: 15 },
    models: {},
    limits: [],
    related: "",
  } as never;
  return renderToString(
    createElement(
      ShellContext.Provider,
      { value: makeShell(settings, true, false) },
      createElement(Compare, { pool: "testpool", state: stateWithTwoConflicts() }),
    ),
  );
}

describe("Compare view: the count of text conflicts (CO25 item 4)", () => {
  it("PM3: with features.text_merge off the count says (approximated), with plain.conflicts.tip", () => {
    const html = render(false);
    expect(html).toContain("Text conflicts in the plain merge: 2 (approximated)");
    expect(html).toContain("The count is approximated");
  });

  it("PM3a: with features.text_merge on the count has no (approximated), with plain.conflicts.merged.tip", () => {
    const html = render(true);
    expect(html).toContain("Text conflicts in the plain merge: 2");
    expect(html).not.toContain("approximated");
    expect(html).toContain("as git merge-file does");
  });
});
