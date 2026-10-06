// The pure pool-frame decisions against the spec's rules and the real tracer fixture
// (test/fixtures/streams/tracer.ndjson). Every expected address and copy id is the spec's, not
// this module's output.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PoolEvent } from "../../../protocol/events.ts";
import { emptyFloorState, reduce } from "../../../protocol/reducer/index.ts";
import type { FloorState } from "../../../protocol/reducer/index.ts";
import { HOST_SEED } from "../../../protocol/constants.ts";
import {
  commitSrc,
  expectedVersion,
  highlightKinds,
  isKindName,
  landingPending,
  liveSrc,
  loadFailureId,
  mainCaption,
  mainReplayAddress,
  moveMessage,
  parsePoolMessage,
  plainVersion,
  stallFallback,
} from "./frame-plan.ts";

const ROOT = join(fileURLToPath(import.meta.url), "../../../../..");

/** The tracer recording's event lines (the first line is the recording header, not an event). */
function tracerEvents(): PoolEvent[] {
  const text = readFileSync(join(ROOT, "test/fixtures/streams/tracer.ndjson"), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => typeof line.type === "string")
    .map((line) => line as unknown as PoolEvent);
}

/** The FloorState after the first `count` tracer events — the Replay position of 8.6. */
function stateAt(count: number): FloorState {
  let state = emptyFloorState();
  for (const event of tracerEvents().slice(0, count)) state = reduce(state, event);
  return state;
}

const SEED_COMMIT = "seed0000seed0000seed0000seed0000seed0000"; // tracer event 1 pool.state
const LANDED_1 = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0"; // tracer event ~26 landing.landed seq 1
const LANDED_2 = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0d1"; // tracer event ~45 landing.landed seq 2
const PLAIN_COMMIT = "p-plain-1"; // tracer plain.updated

describe("pool frame page addresses (02-tidepool 4.2/4.5, AS12)", () => {
  it("CO20/SE16a: the live main frame loads /pool/{pool}/main/?seed=<n>, a moving source", () => {
    expect(liveSrc("tidepool", "main")).toBe(`/pool/tidepool/main/?seed=${HOST_SEED}`);
  });

  it("the frame's {pool} is the pool of the page (FE7/13.6): /p/it-tracer shows that pool", () => {
    expect(liveSrc("it-tracer", "main")).toBe(`/pool/it-tracer/main/?seed=${HOST_SEED}`);
  });

  it("AS7/6.4: a paused-at-load frame carries the paused page parameter", () => {
    expect(liveSrc("tidepool", "main", HOST_SEED, true)).toBe(`/pool/tidepool/main/?seed=${HOST_SEED}&paused=1`);
  });

  it("PV5: a commit frame is a fixed FrameAddress — /pool/{pool}/{commit}/", () => {
    expect(commitSrc("tidepool", { repo: "main", commit: LANDED_1 })).toBe(
      `/pool/tidepool/${LANDED_1}/?seed=${HOST_SEED}`,
    );
  });

  it("PV5: a plain-merge commit address uses the p-{commit} source (AC24)", () => {
    expect(commitSrc("tidepool", { repo: "plain", commit: PLAIN_COMMIT })).toBe(
      `/pool/tidepool/p-${PLAIN_COMMIT}/?seed=${HOST_SEED}`,
    );
  });
});

describe("the frame's position in Replay (8.6 row 1, RY16)", () => {
  it("the replay frame shows the newest landing.landed commit at the position", () => {
    expect(mainReplayAddress(stateAt(tracerEvents().length))).toEqual({
      repo: "main",
      commit: LANDED_2,
    });
  });

  it("before the first landing it shows the landed_commit of the first pool.state (the seed)", () => {
    expect(mainReplayAddress(stateAt(1))).toEqual({ repo: "main", commit: SEED_COMMIT });
  });

  it("CO21: the expected version token is c-<landed_commit> (PV5)", () => {
    expect(expectedVersion(stateAt(1))).toBe(`c-${SEED_COMMIT}`);
    expect(expectedVersion(stateAt(tracerEvents().length))).toBe(`c-${LANDED_2}`);
  });

  it("AC24: the plain frame's expected version is p-<plain.commit>", () => {
    expect(plainVersion(stateAt(tracerEvents().length))).toBe(`p-${PLAIN_COMMIT}`);
  });
});

describe("accepted without landed (AC3, FL3, CO23)", () => {
  // Tracer: landing.accepted seq 1 is the event at index 22; landing.landed seq 1 is index 25.
  it("between landing.accepted and landing.landed, landingPending is 1", () => {
    const events = tracerEvents();
    const accepted = events.findIndex((e) => e.type === "landing.accepted");
    const landed = events.findIndex((e) => e.type === "landing.landed");
    expect(accepted).toBeGreaterThanOrEqual(0);
    expect(landed).toBeGreaterThan(accepted);
    expect(landingPending(stateAt(accepted + 1))).toBe(1);
    expect(landingPending(stateAt(landed))).toBe(1);
  });

  it("once the landing lands, the pending count and the frame's commit move together", () => {
    const events = tracerEvents();
    const landed = events.findIndex((e) => e.type === "landing.landed");
    expect(landingPending(stateAt(landed + 1))).toBe(0);
    expect(expectedVersion(stateAt(landed + 1))).toBe(`c-${LANDED_1}`);
  });
});

describe("the caption bar (03-floor 3.5, RY21)", () => {
  it("a live frame at the seed shows frame.main.seed (landed_seq 0)", () => {
    expect(mainCaption(stateAt(1), "live")).toEqual({ id: "frame.main.seed", vars: {} });
  });

  it("a live frame shows frame.main.caption with the landed seq", () => {
    expect(mainCaption(stateAt(tracerEvents().length), "live")).toEqual({
      id: "frame.main.caption",
      vars: { landing: "landing 2" },
    });
  });

  it("before the first pool.state the caption is the neutral frame.loading (IR12)", () => {
    // `pool.state` has not arrived — the kind is undecided, so no seed caption may show:
    // a repository pool's caption is `frame.no_app`, never the seed's.
    expect(mainCaption(emptyFloorState(), "live")).toEqual({ id: "frame.loading", vars: {} });
    // Replay is decided by the position itself, not the stream — it stays frame.replay.
    expect(mainCaption(emptyFloorState(), "replay")).toEqual({
      id: "frame.replay",
      vars: { landing: "the seed" },
    });
  });

  it("a replay frame's caption is frame.replay — recorded code at the landing (RY21)", () => {
    expect(mainCaption(stateAt(tracerEvents().length), "replay")).toEqual({
      id: "frame.replay",
      vars: { landing: "landing 2" },
    });
  });
});

describe("the stall fallback (FR28)", () => {
  it("a first stall with a green commit reloads the main frame on source green", () => {
    expect(stallFallback({ kind: "main", replay: false, stalls: 0, greenCommit: "abc" })).toEqual({
      action: "reload",
      onGreen: true,
      caption: "frame.stalled.green",
    });
  });

  it("a first stall without green reloads main once, captioned frame.stalled.reloaded", () => {
    expect(stallFallback({ kind: "main", replay: false, stalls: 0, greenCommit: null })).toEqual({
      action: "reload",
      onGreen: false,
      caption: "frame.stalled.reloaded",
    });
  });

  it("a second stall of the main frame only shows frame.stalled — no more reloads", () => {
    expect(stallFallback({ kind: "main", replay: false, stalls: 1, greenCommit: "abc" })).toEqual({
      action: "hold",
      caption: "frame.stalled",
    });
  });

  it("any other frame (a Replay frame) reloads once at its own address, then frame.stalled", () => {
    expect(stallFallback({ kind: "other", replay: true, stalls: 0, greenCommit: "abc" })).toEqual({
      action: "reload-silent",
    });
    expect(stallFallback({ kind: "other", replay: true, stalls: 1, greenCommit: "abc" })).toEqual({
      action: "hold",
      caption: "frame.stalled",
    });
  });
});

describe("which messages a mode allows (SE16a, AC23)", () => {
  it("live frames get probe; commit frames in Replay get advance, never probe (RY17)", () => {
    expect(moveMessage("live")).toBe("probe");
    expect(moveMessage("replay")).toBe("advance");
  });

  it("FR20/RY22: a failed live frame is frame.error; a failed replay frame is frame.replay_gone", () => {
    expect(loadFailureId("live")).toBe("frame.error");
    expect(loadFailureId("replay")).toBe("frame.replay_gone");
  });
});

describe("frame messages (CO22, SE16, HO15)", () => {
  const stats = {
    type: "stats",
    source: "main",
    version: `c-${LANDED_1}`,
    seq: 1,
    tick: 4,
    paused: false,
    kinds: { "ring-a": { count: 2, resting: 1, errors: 0, benched: false } },
    shown: 2,
    total: 3,
    swap: null,
    selftest: null,
  };

  it("a well-formed stats message validates", () => {
    expect(parsePoolMessage(stats)).toEqual(stats);
  });

  it("a tapped message validates and stays text", () => {
    expect(parsePoolMessage({ type: "tapped", creature: "ring-a", path: "src/a.ts" })).toEqual({
      type: "tapped",
      creature: "ring-a",
      path: "src/a.ts",
    });
  });

  it.each([
    ["not an object", 42],
    ["null", null],
    ["an unknown type", { type: "exec", code: "alert(1)" }],
    ["stats missing fields", { type: "stats", source: "main" }],
    ["stats with a wrong field type", { ...stats, tick: "4" }],
    ["stats with kinds malformed", { ...stats, kinds: { a: { count: 1 } } }],
    ["tapped without a path", { type: "tapped", creature: "ring-a" }],
  ])("CO22: %s is dropped", (_name, data) => {
    expect(parsePoolMessage(data)).toBeNull();
  });

  it("HO15: kind names for highlight are [a-z][a-z0-9-]{0,30} and never 'constructor'", () => {
    expect(isKindName("ring-a")).toBe(true);
    expect(isKindName("constructor")).toBe(false);
    expect(isKindName("Ring")).toBe(false);
    expect(isKindName("a".repeat(32))).toBe(false);
    expect(highlightKinds(["a", "a", "bad kind", "b"])).toEqual(["a", "b"]);
  });
});
