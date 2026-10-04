// Fixture replay (AC2, FE3, BP1): the three streams of test/fixtures/streams/ are replayed through
// the shared reducer. Expected values are read off the `final` blocks of vectors C04 and C05 and off
// the mapping of 03-floor 4.3 — never off the reducer's own output.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PoolEvent } from "../events.ts";
import type { ReplayHeader } from "../replay.ts";
import type { FloorState } from "./state.ts";
import { emptyFloorState, premiseId } from "./state.ts";
import { reduce } from "./reduce.ts";

const STREAMS = join(__dirname, "../../../test/fixtures/streams");

/** Parses a Replay file (01-core 12.3): header on line 1, then `events` PoolEvent lines. */
function replayFile(name: string): { header: ReplayHeader; events: PoolEvent[] } {
  const text = readFileSync(join(STREAMS, name), "utf8");
  const lines = text.split("\n").filter((line) => line !== "");
  const header = JSON.parse(lines[0] ?? "") as ReplayHeader;
  const events = lines.slice(1).map((line) => JSON.parse(line) as PoolEvent);
  return { header, events };
}

function replay(events: PoolEvent[]): FloorState {
  const state = emptyFloorState();
  for (const event of events) reduce(state, event);
  return state;
}

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected a defined value");
  return value;
}

describe("fixture files (01-core 12.3)", () => {
  it.each(["tracer.ndjson", "hero-c04.ndjson", "hero-c05.ndjson"])(
    "%s: a premise_replay 2 header, then contiguous events from n = 1",
    (name) => {
      const { header, events } = replayFile(name);
      expect(header.premise_replay).toBe(2);
      expect(header.events).toBe(events.length);
      expect(header.pool).toBe("tidepool");
      events.forEach((event, index) => expect(event.n).toBe(index + 1));
    },
  );
});

describe("C04-hero-shared-rule-lands-first", () => {
  const { events } = replayFile("hero-c04.ndjson");
  const state = replay(events);

  it("C04 final: seq 1 is the shared rule (S), seq 2 the crab (A), head_seq 2", () => {
    expect(state.pool.head_seq).toBe(2);
    expect(state.pool.landed_seq).toBe(2);
    expect(state.counters.landed_changes).toBe(2);
    expect(state.landed_order).toEqual([2, 1]);
    expect(must(state.landings[1])).toMatchObject({
      kind: "change",
      attempt_id: "a_S",
      landed: { commit: "c044aaaa04c04c04c04c04c04c04c04c04c04c04" },
    });
    expect(must(state.landings[2])).toMatchObject({
      kind: "change",
      attempt_id: "a_A",
      landed: { commit: "c044bbbb04c04c04c04c04c04c04c04c04c04c04" },
    });
  });

  it("C04 final: both attempts landed; the crab went around once, the rule not at all", () => {
    expect(must(state.attempts.a_A)).toMatchObject({ state: "landed", go_arounds: 1, landed_seq: 2 });
    expect(must(state.attempts.a_S)).toMatchObject({ state: "landed", go_arounds: 0, landed_seq: 1 });
    expect(state.working_order).toEqual([]);
  });

  it("C04: the crab's ENERGY_MAX premise was judged repair by E2 and its heads-up resolved", () => {
    const attempt = must(state.attempts.a_A);
    const premise = must(attempt.premises[premiseId("entity", "world/energy.js#ENERGY_MAX")]);
    expect(premise.judgment).toMatchObject({ rule: "E2", result: "repair", cause_seq: 1 });
    expect(must(attempt.heads_ups[1])).toMatchObject({ result: "repair", go_around: 1 });
    expect(must(attempt.heads_ups[1]).resolved).toMatchObject({ changed: true });
    expect(premise.light).toBe("holds"); // the resolved heads-up returns warning lights to holds
  });

  it("C04: FS2 — the last landing that changed each path", () => {
    expect(must(state.files["world/energy.js"]).last_landed_seq).toBe(1);
    expect(must(state.files["creatures/crab.js"]).last_landed_seq).toBe(2);
  });
});

describe("C05-hero-creature-lands-first", () => {
  const { events } = replayFile("hero-c05.ndjson");
  const state = replay(events);

  it("C05 final: seq 1 is the crab (A), seq 2 the shared rule (S), head_seq 2", () => {
    expect(state.pool.head_seq).toBe(2);
    expect(state.counters.landed_changes).toBe(2);
    expect(must(state.landings[1])).toMatchObject({ kind: "change", attempt_id: "a_A" });
    expect(must(state.landings[2])).toMatchObject({ kind: "change", attempt_id: "a_S" });
  });

  it("C05 final: both attempts landed; the rule went around once, the crab not at all", () => {
    expect(must(state.attempts.a_A)).toMatchObject({ state: "landed", go_arounds: 0 });
    expect(must(state.attempts.a_S)).toMatchObject({ state: "landed", go_arounds: 1 });
  });

  it("C05: S's refs query premise was judged repair by QR1, with the crab's entities added", () => {
    const attempt = must(state.attempts.a_S);
    const premise = must(attempt.premises[premiseId("query", "refs:world/energy.js#ENERGY_MAX")]);
    expect(premise.judgment).toMatchObject({ rule: "QR1", result: "repair", cause_seq: 1 });
    const item = must(must(attempt.heads_ups[1]).items?.[0]);
    expect(item.diff.kind).toBe("query");
    if (item.diff.kind === "query") {
      expect(item.diff.added.map((added) => added.key)).toEqual([
        "creatures/crab.js#(import ../world/energy.js)",
        "creatures/crab.js#spawn",
      ]);
      expect(item.diff.context.map((entry) => entry.key)).toEqual(["creatures/crab.js#update"]);
    }
  });
});

describe("tracer.ndjson", () => {
  const { events } = replayFile("tracer.ndjson");
  const state = replay(events);

  it("reduces every event type without an unknown_events count", () => {
    expect(state.unknown_events).toBe(0);
    expect(state.n).toBe(events.length);
  });

  it("the held card was opened and landed; undo then reverted seq 1", () => {
    expect(must(state.cards.k_T1).open).toBe(false);
    expect(must(state.landings[1]).undone_by).toBe(2);
    expect(must(state.landings[2])).toMatchObject({ kind: "undo", request_id: "r_1" });
    expect(must(state.undo.r_1)).toMatchObject({ target_seq: 1, landing_seq: 2 });
    expect(must(state.attempts.a_T)).toMatchObject({ reopened_by: "undo", revision: 2 });
  });

  it("pool.paused then a fresh pool.state returned the pool to ready", () => {
    expect(state.pool.state).toBe("ready");
    expect(state.push).toBeNull();
    expect(state.last_push).toEqual({ batch_id: 2, landings: 1, tries: 1, ms: 200 });
    expect(state.green).toMatchObject({ seq: 1, runtime: "isolate" });
    expect(state.swarm).toMatchObject({ running: true, ever_ran: true });
  });
});

describe("FE3: live replay, a snapshot join and a second replay agree", () => {
  it.each(["tracer.ndjson", "hero-c04.ndjson", "hero-c05.ndjson"])(
    "%s: state after a snapshot round-trip equals the full replay",
    (name) => {
      const { events } = replayFile(name);
      const full = replay(events);
      // A snapshot join: reduce a prefix, persist it as JSON (the Floor's snapshot row), restore it,
      // then reduce the tail — the same path the Floor DO's loadState takes.
      const cut = Math.floor(events.length / 2);
      const snapshot = emptyFloorState();
      for (const event of events.slice(0, cut)) reduce(snapshot, event);
      const joined = JSON.parse(JSON.stringify(snapshot)) as FloorState;
      for (const event of events.slice(cut)) reduce(joined, event);
      expect(JSON.stringify(joined)).toBe(JSON.stringify(full));
      // And a second independent replay agrees (determinism).
      expect(JSON.stringify(replay(events))).toBe(JSON.stringify(full));
    },
  );
});
