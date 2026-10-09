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
import type { PoolEvent } from "../../protocol/events.ts";
import type { ReplayHeader } from "../../protocol/replay.ts";

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

  it("ended: the ended controls take the play cluster's place; the chapter row keeps its caption (RY19, 8.5)", () => {
    const p = player();
    p.seek(p.duration);
    const html = bar(p);
    expect(html).toContain("replay-ended");
    expect(html).toContain("The recording has ended.");
    expect(html).toContain("Watch again");
    expect(html).toContain("Open the live Floor");
    // The position and the track keep their places; the rest of the transport row stood down.
    expect(html).toContain("replay-position");
    expect(html).toContain("replay-track");
    expect(html).not.toContain("replay-buttons");
    expect(html).not.toContain("replay-speed");
    expect(html).not.toContain("replay-close");
    // 8.5: "At any time the bar shows the caption of the current chapter" - the last one here.
    const last = p.chapters[p.chapters.length - 1]!;
    expect(html).toContain(`>${last.caption}</span>`);
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

it("D27 RY14 5.4: after a gap jump the bar says how much recorded time it skipped", () => {
  // A fake clock: timers fire in order as `advance` moves the time.
  let now = 0;
  let nextId = 1;
  const queue: Array<{ at: number; id: number; fn: () => void }> = [];
  const timers: PlayerTimers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      queue.push({ at: now + ms, id, fn });
      return id;
    },
    clearTimeout: (id) => {
      const at = queue.findIndex((entry) => entry.id === id);
      if (at >= 0) queue.splice(at, 1);
    },
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = queue[0];
      if (next === undefined || next.at > end) break;
      now = next.at;
      queue.shift();
      next.fn();
    }
    now = end;
  };
  const event = (n: number, ts: number, type = "metrics") =>
    ({ n, t: ts + 50, ts, pool: "tidepool", src: "trunk", type }) as unknown as PoolEvent;
  // 61 s of nothing between event 1 and event 2: RY14 lands the clock 2 s before event 2,
  // so the jump skips 59 s less the fraction of a second the clock had played.
  const p = new ReplayPlayer(
    { header: {} as ReplayHeader, events: [event(1, 0, "pool.state"), event(2, 61_000), event(3, 61_100)] },
    timers,
    { speed: 1 },
  );
  expect(bar(p)).not.toContain("replay-skipped");
  advance(500);
  expect(bar(p)).toContain("Skipped 59 s with no events.");
  advance(10_000); // the note leaves after its 3 s (RY14)
  expect(bar(p)).not.toContain("replay-skipped");
});
