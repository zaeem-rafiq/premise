// The pool area's no-app branch (docs/spec/06-repos.md IR12): a pool made from a repository
// carries `pool.state.app: null` — the area then holds no frame at all and the file tiles
// take the frame's place. `renderToStaticMarkup` exercises the component tree React owns —
// the caption, the absent buttons, the tile cells — without a DOM.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PoolEvent } from "../../../protocol/events.ts";
import { emptyFloorState, reduce } from "../../../protocol/reducer/index.ts";
import type { FloorState } from "../../../protocol/reducer/index.ts";
import { PoolArea } from "./pool-area.tsx";

const NO_APP_CAPTION = "This repository has no live picture. Its files and the changes to them are below.";

/** The stream events the spec gives an imported pool: pool.state with `app: null` and the
 * repository as `source`, then its pool.files. Envelope fields match events.ts. */
function importedPoolState(): FloorState {
  const events = [
    {
      n: 1,
      t: 1001,
      ts: 1001,
      src: "trunk",
      pool: "octo-app",
      type: "pool.state",
      head_seq: 0,
      head_commit: "c-seed",
      green_seq: 0,
      landed_seq: 0,
      landed_commit: "c-seed",
      state: "ready",
      reason: null,
      epoch: 1,
      remote: "https://artifacts.invalid/octo-app",
      plain_remote: null,
      rebuild: null,
      unwitnessed: [],
      real_agents: 0,
      max_real_agents: 6,
      synthetic: false,
      summary_only: false,
      app: null,
      source: "octo/app",
    },
    {
      n: 2,
      t: 1002,
      ts: 1002,
      src: "trunk",
      pool: "octo-app",
      type: "pool.files",
      files: [
        { path: "README.md", tier: "auto" },
        { path: "src/index.ts", tier: "auto" },
        { path: "src/lib/util.ts", tier: "held" },
      ],
    },
  ];
  let state = emptyFloorState();
  for (const event of events) state = reduce(state, event as unknown as PoolEvent);
  return state;
}

function seedPoolState(): FloorState {
  // The imported-pool events minus `app` and `source`: a pre-IR8 stream, a seed pool.
  const events = [
    {
      n: 1,
      t: 1001,
      ts: 1001,
      src: "trunk",
      pool: "tidepool",
      type: "pool.state",
      head_seq: 0,
      head_commit: "c-seed",
      green_seq: 0,
      landed_seq: 0,
      landed_commit: "c-seed",
      state: "ready",
      reason: null,
      epoch: 1,
      remote: "https://artifacts.invalid/tidepool",
      plain_remote: null,
      rebuild: null,
      unwitnessed: [],
      real_agents: 0,
      max_real_agents: 6,
      synthetic: false,
      summary_only: false,
    },
  ];
  let state = emptyFloorState();
  for (const event of events) state = reduce(state, event as unknown as PoolEvent);
  return state;
}

function markup(state: FloorState, props: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(PoolArea, { pool: "octo-app", state, ...props }));
}

describe("IR12: a pool with app null", () => {
  it("before the first pool.state the caption is neutral — no seed caption a repository pool never owns", () => {
    const html = markup(emptyFloorState());
    expect(html).toContain("Loading the pool…");
    expect(html).not.toContain("the seed, before any landing");
    expect(html).not.toContain(NO_APP_CAPTION);
  });

  it("reads frame.no_app on the caption bar and holds no frame", () => {
    const html = markup(importedPoolState());
    expect(html).toContain(NO_APP_CAPTION);
    expect(html).toContain('<div class="pool-area" data-app="none"');
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain('class="pf-body"');
    expect(html).not.toContain(">Pause<");
    expect(html).not.toContain(">Play<");
    expect(html).not.toContain('class="pf-selftest"');
  });

  it("offers no Compare even when the stream carries a plain remote", () => {
    const state = importedPoolState();
    state.pool.plain_remote = "https://artifacts.invalid/octo-app-plain";
    const html = markup(state, { onCompare: () => undefined });
    expect(html).not.toContain(">Compare<");
  });

  it("shows the pool's files as tiles where the frame stood, extensions kept (3.7 amended)", () => {
    const html = markup(importedPoolState());
    expect(html).toContain('class="tiles"');
    for (const name of ["README.md", "index.ts", "util.ts"]) {
      expect(html).toContain(`>${name}<`);
    }
    expect(html).not.toContain(">index<");
  });

  it("a seed pool keeps its live picture: frame, Pause and no no-app caption", () => {
    const html = markup(seedPoolState());
    expect(html).toContain("Premise · main · the seed, before any landing");
    expect(html).toContain(">Pause<");
    expect(html).toContain('class="pf-body"');
    expect(html).not.toContain(NO_APP_CAPTION);
    expect(html).not.toContain('<div class="pool-area" data-app="none"');
  });
});

it("D39 CO25a/FL10: Floor never shows the Compare self-test badge", () => {
  const html = markup(seedPoolState(), { selftest: true });
  expect(html).toContain("Premise · main · the seed, before any landing");
  expect(html).not.toContain('class="pf-selftest"');
  expect(html).not.toContain("Self-test, run in this page");
});
