import { describe, expect, it } from "vitest";
import { blastSentence, raceTitle } from "./cards.ts";
import { fill } from "./fill.ts";
import { duration, landingLabel } from "./format.ts";
import { quietSuffix } from "./activity.ts";
import { replayError } from "./replay.ts";
import { text } from "./strings.ts";

describe("D27 CP5 and 5.2: counted copy", () => {
  it.each([
    ["headsup.show_all", "Show 1 line"],
    ["plain.behind", "This pool is 1 landing behind."],
    ["undo.kept", "1 later change only read it. It stays: crab."],
    ["undo.in_flight", "1 change in flight gets a heads-up: crab."],
    ["undo.done", "Undo of landing 4 landed as landing 7. It took back 1 change."],
    ["held.relied_landed", "1 landed change relies on what it changes."],
    ["held.relied_inflight", "1 change in flight has a premise on what it changes: crab."],
    ["held.blind", "1 blind spot confirmed by the agent."],
    ["race.group", "Race · 1 attempt"],
    ["race.blast", "Would send back: 1 change"],
    ["swarm.last_push", "Last push: 1 push, 1 change"],
    ["swarm.starting", "Starting 1 scripted agent…"],
    ["swarm.wall.summary", "1 scripted agent: 1 working, 0 going around, 0 landing."],
    ["replay.unknown", "This recording has 1 event this page does not know. It is skipped."],
    ["about.run.synthetic", "Scripted agent (SYNTHETIC): 1. It makes no model calls."],
    ["about.unknown_events", "This page skipped 1 event of a newer kind. Reload to get the newest page."],
    ["about.trunk_errors", "Trunk recorded 1 internal error and tried the step again."],
    ["banner.more", "1 more notice"],
    ["sr.undo", "Undo of landing 4 planned. It takes back 1 change."],
    ["sr.swarm", "The Swarm started with 1 scripted agent."],
    ["sr.more", "1 more update"],
  ])("D27 CP5: %s has a complete singular form", (id, expected) => {
    expect(
      text(id, {
        n: 1,
        names: "crab",
        landing: id === "undo.done" ? ["landing 4", "landing 7"] : "landing 4",
        a: 1,
        b: 0,
        c: 0,
      }),
    ).toBe(expected);
  });

  it("D27 CP5: counts named max, all and agents select singular forms", () => {
    expect(text("intent.queue", { max: 1 })).toBe("The 1 agent slot is busy. Your request waits for a free slot.");
    expect(text("why.checked.count", { ok: 1, all: 1 })).toBe("1 of 1 check passed.");
    expect(text("spend.model_line", { model: "model-a", used: 1, limit: 1 })).toBe(
      "model-a: 1 of 1 request in the last minute.",
    );
    expect(text("swarm.real_limit", { max: 1 })).toBe(
      "Real agent in the main pool: 1 at most. The limit is the model rate.",
    );
    expect(text("about.run.real", { max: 1, models: "model-a" })).toBe("Real agent: at most 1 at once, on model-a.");
    for (const agents of [1, 2]) {
      const pools = 1;
      expect(text("swarm.shape", { pools, agents })).toBe(
        `This run: ${pools} pool, ${pools} Trunk, ${agents} scripted ${agents === 1 ? "agent" : "agents"}.`,
      );
    }
  });

  it.each([
    [
      0,
      "All 0 agent slots are busy. Your request waits for a free slot.",
      "0 of 0 checks passed.",
      "model-a: 0 of 0 requests in the last minute.",
      "This run: 1 pool, 1 Trunk, 0 scripted agents.",
    ],
    [
      2,
      "All 2 agent slots are busy. Your request waits for a free slot.",
      "2 of 2 checks passed.",
      "model-a: 2 of 2 requests in the last minute.",
      "This run: 1 pool, 1 Trunk, 2 scripted agents.",
    ],
  ] as const)("D27 CP5: non-n counts keep their plural form at %s", (n, queue, checks, requests, shape) => {
    expect(text("intent.queue", { max: n })).toBe(queue);
    expect(text("why.checked.count", { ok: n, all: n })).toBe(checks);
    expect(text("spend.model_line", { model: "model-a", used: n, limit: n })).toBe(requests);
    expect(text("swarm.shape", { pools: 1, agents: n })).toBe(shape);
  });

  it("D27 CP5: pending push has a singular landing", () => {
    expect(text("banner.push", { n: 1, tries: 2, seconds: 3 })).toBe(
      "The push of 1 landing has not been confirmed yet. Try 2. Next try in 3 s. Nothing shows as landed until main has it.",
    );
  });

  it("D27 CP5: held blast and a single race candidate use singular nouns and verbs", () => {
    const empty = {
      repair: [] as string[],
      confirm: [] as string[],
      triage: [] as string[],
      right_of_way: [] as string[],
    };
    expect(blastSentence({ ...empty, confirm: ["a"] }, { repair: [], confirm: ["crab"], triage: [] })).toBe(
      "1 change must confirm: crab.",
    );
    expect(blastSentence({ ...empty, triage: ["a"] }, { repair: [], confirm: [], triage: ["crab"] })).toBe(
      "Clef will judge 1 change that reads it: crab.",
    );
    expect(raceTitle(0, 1, "add a crab")).toBe('1 attempt at "add a crab" is still working.');
    expect(raceTitle(1, 1, "add a crab")).toBe('1 of 1 attempt at "add a crab" is ready. Choose it.');
    expect(replayError("incomplete", { a: 1, b: 2 })).toBe(
      "This recording is incomplete: it has 1 event and should have 2.",
    );
  });

  it("D27 5.2: numeric counts, arrays, constants and copy helpers share comma formatting", () => {
    expect(text("banner.synthetic.swarm", { n: 1024 })).toContain("1,024 scripted agents");
    expect(text("swarm.shape", { pools: 1, agents: 2000 })).toBe("This run: 1 pool, 1 Trunk, 2,000 scripted agents.");
    expect(text("about.run.landed", { n: [1024, 2000] })).toBe("Landed changes: 1,024. Go-arounds: 2,000.");
    expect(fill("{MAX_FILE_BYTES}")).toBe("32,768");
    expect(landingLabel(1024)).toBe("landing 1,024");
    expect(quietSuffix(1024)).toBe(" · 1,024 s");
    expect(duration(60_000_000)).toBe("1,000 min 0 s");
    expect(text("replay.speed", { x: 0.5 })).toBe("Speed 0.5×");
    expect(fill("{outside}", { outside: "1024 and 0.5 are exact user text" })).toBe("1024 and 0.5 are exact user text");
  });
});
