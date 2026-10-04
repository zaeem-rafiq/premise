// The pool frame's rendered output against 03-floor 3.5's state table and section 5's copy, on
// the real tracer fixture. `renderToStaticMarkup` exercises everything React owns — the caption,
// the chips, the buttons, the sandbox contract — without a DOM.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PoolEvent } from "../../../protocol/events.ts";
import { emptyFloorState, reduce } from "../../../protocol/reducer/index.ts";
import type { FloorState } from "../../../protocol/reducer/index.ts";
import { iframeAttrs } from "./frame-plan.ts";
import { PoolFrame } from "./pool-frame.tsx";

const ROOT = join(fileURLToPath(import.meta.url), "../../../../..");

function tracerState(count?: number): FloorState {
  const text = readFileSync(join(ROOT, "test/fixtures/streams/tracer.ndjson"), "utf8");
  const events = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => typeof line.type === "string")
    .map((line) => line as unknown as PoolEvent);
  let state = emptyFloorState();
  for (const event of events.slice(0, count)) state = reduce(state, event);
  return state;
}

function markup(state: FloorState, props: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(PoolFrame, { pool: "tidepool", state, ...props }));
}

describe("the iframe contract (CO20, SE16a)", () => {
  it("the pool frame's only sandbox token is allow-scripts", () => {
    const attrs = iframeAttrs("/pool/tidepool/main/?seed=7", "title");
    expect(attrs.sandbox).toBe("allow-scripts");
    expect(attrs.sandbox.split(" ")).toHaveLength(1);
  });
});

describe("the caption bar (3.5, AC3)", () => {
  it("before any landing the caption is the seed caption", () => {
    expect(markup(tracerState(1))).toContain("Premise · main · the seed, before any landing");
  });

  it("with landings the caption names the landed seq", () => {
    expect(markup(tracerState())).toContain("Premise · main · landing 2");
  });

  it("AC3: a landing accepted but not landed shows the frame.landing chip", () => {
    // Tracer: landing.accepted is event index 22; landing.landed is index 25.
    const html = markup(tracerState(24));
    expect(html).toContain("1 landing…");
  });

  it("nothing is pending once the landing lands", () => {
    const html = markup(tracerState());
    expect(html).not.toContain("landing…");
  });

  it("a paused or rebuilding pool adds the frame.pool_paused chip", () => {
    // Tracer event 47 is pool.paused (reason owner); the stream's own pool.state snapshot that
    // follows it reports "ready" again — the chip mirrors state.pool.state exactly.
    expect(markup(tracerState(47))).toContain("The pool is paused. This is the last landed state.");
    expect(markup(tracerState())).not.toContain("The pool is paused.");
  });

  it("in Replay the caption is frame.replay (RY21)", () => {
    expect(markup(tracerState(), { mode: "replay" })).toContain("Recorded code at landing 2, running now.");
  });
});

describe("the caption buttons (CO23a, CO24)", () => {
  it("always offers frame.pause", () => {
    expect(markup(tracerState(1))).toContain(">Pause<");
  });

  it("offers frame.compare only when the pool has a plain-merge repository (3.6)", () => {
    // The tracer pool has a plain remote; an empty state does not.
    expect(markup(tracerState(), { onCompare: () => undefined })).toContain(">Compare<");
    expect(markup(emptyFloorState(), { onCompare: () => undefined })).not.toContain(">Compare<");
  });

  it("a paused frame reads frame.play", () => {
    expect(markup(tracerState(1), { paused: true })).toContain(">Play<");
  });
});

describe("the frame's not-live states (3.5)", () => {
  it("before the driver loads a src the body shows frame.loading", () => {
    expect(markup(tracerState(1))).toContain("Loading the pool…");
  });
});
