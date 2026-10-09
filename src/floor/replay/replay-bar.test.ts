// Render-time smoke of the Replay bar under react-dom/server: the RY19 end state puts the
// ended controls where the play cluster and the caption stood, keeping the position and the
// track (chapter marks are thinned by measured width - none is measurable under SSR, so only
// the first stands). Effects don't run under SSR; this exercises the pure render path only.

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeShell, ShellContext } from "../app/context.ts";
import { ReplayBar } from "./replay-bar.tsx";
import { ReplayPlayer, parseRecording, type PlayerTimers } from "./player.ts";

const STREAMS = join(dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures/streams");

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

const TIMERS: PlayerTimers = { now: () => 0, setTimeout: () => 0, clearTimeout: () => undefined };

function player(playing = true): ReplayPlayer {
  const parsed = parseRecording(readFileSync(join(STREAMS, "tracer.ndjson"), "utf8"));
  if (!parsed.ok) throw new Error("tracer fixture failed its own checks");
  return new ReplayPlayer(parsed.recording, TIMERS, { playing });
}

function bar(player: ReplayPlayer): string {
  return renderToString(
    createElement(
      ShellContext.Provider,
      { value: makeShell(SETTINGS, true, true) },
      createElement(ReplayBar, { player, onClose: () => undefined }),
    ),
  );
}

describe("ReplayBar render", () => {
  it("while playing shows the transport, the caption and the speed - no ended controls", () => {
    const html = bar(player());
    expect(html).toContain("replay-buttons");
    expect(html).toContain("replay-caption");
    expect(html).toContain("replay-speed");
    expect(html).toContain("replay-close");
    expect(html).not.toContain("replay-ended");
    expect(html).not.toContain("data-ended");
  });

  it("ended: ended controls take the play cluster's and the caption's place (RY19)", () => {
    const p = player();
    p.seek(p.duration);
    const html = bar(p);
    expect(html).toContain("replay-ended");
    expect(html).toContain("The recording has ended.");
    expect(html).toContain("Watch again");
    expect(html).toContain("Open the live Floor");
    // The position and the track keep their places; the rest of the row stood down.
    expect(html).toContain("replay-position");
    expect(html).toContain("replay-track");
    expect(html).not.toContain("replay-buttons");
    expect(html).not.toContain("replay-caption");
    expect(html).not.toContain("replay-speed");
    expect(html).not.toContain("replay-close");
    expect(html).toContain('data-ended="true"');
  });

  it("keeps only the marks that fit: with no measurable width the earliest stands", () => {
    const p = player();
    const html = bar(p);
    // No ResizeObserver under SSR: every mark lands on the same spot and all but the
    // first are thinned, so the rendered row can never overlap itself.
    expect((html.match(/replay-mark"/g) ?? []).length).toBe(1);
    expect(html).toContain("clamp(11px");
  });
});

it("D28 8.5 3.16: no future chapter caption appears before the first chapter", () => {
  const parsed = parseRecording(readFileSync(join(STREAMS, "tracer.ndjson"), "utf8"));
  if (!parsed.ok) throw new Error("invalid fixture");
  const recording = {
    ...parsed.recording,
    events: parsed.recording.events.map((event, i) => (i === 0 ? event : { ...event, ts: event.ts + 10_000 })),
  };
  const p = new ReplayPlayer(recording, TIMERS, { playing: false });
  expect(p.chapters[0]!.start).toBeGreaterThan(0);
  for (const chapter of p.chapters) expect(bar(p)).not.toContain(chapter.caption);
  for (const chapter of p.chapters) {
    p.seek(chapter.start);
    expect(bar(p)).toContain(chapter.caption);
  }
});

it("D42 2.7 3.16: every chapter has a visible named seek button", () => {
  const p = player(false);
  const html = bar(p);
  expect(html).toContain('class="replay-chapters"');
  for (const chapter of p.chapters) expect(html).toContain(`>${chapter.name}</button>`);
});
