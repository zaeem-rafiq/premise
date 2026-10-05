// Appendix A, row A22: the rule-based `confirm` items of 10.3's third table, each observed on
// seed `tidepool-swarm` through the real `Trunk` engine, and the `acknowledges with no edit`
// each canned pattern gives them. The patterns the row names but `src/swarm` does not carry —
// `retune`, `reader`, `sweep-colour`, `edit-creature` and `sweep-search` — are written here as
// ad-hoc canned casts, faithful to their 10.3 rows, on the seed they were designed for.

import { describe, expect, it } from "vitest";
import type { HeadsUp } from "../../../src/protocol/headsup.ts";
import { cannedCast, type CastCall } from "../../../src/swarm/casts/runner.ts";
import { fileNamesOf, freshName } from "../../../src/swarm/scripted.ts";
import { PALETTE, tPlain } from "../../../src/swarm/templates.ts";
import { SwarmSim, swarmFiles, type AgentHandle } from "../../integration/collide/harness.ts";

function sim(): SwarmSim {
  return new SwarmSim(swarmFiles(), { seed: 7, synthetic: true, features_held: true });
}

/** Drive `agent` until it parks (a `wait` step, `stop`, or a terminal state). */
function drive(s: SwarmSim, agent: AgentHandle): void {
  for (let i = 0; i < 80; i += 1) {
    if (!s.step(agent)) return;
  }
  throw new Error("drive: the agent did not park within 80 calls");
}

/** Step + land alternately until the agent lands (bounded). */
function landNow(s: SwarmSim, agent: AgentHandle): void {
  for (let i = 0; i < 20; i += 1) {
    drive(s, agent);
    s.land();
    if (s.state(agent) === "landed") return;
  }
  throw new Error("landNow: the agent did not land");
}

function judgmentsOf(s: SwarmSim, agent: AgentHandle): Array<Record<string, unknown>> {
  return [...s.trunk.pool.judgments.values()].filter((j) => j.attempt_id === agent.id);
}

const itemKeys = (hu: HeadsUp): string[] => hu.items.map((i) => `${i.rule}:${i.premise.key}`);

// --- The ad-hoc casts of 10.3, on `tidepool-swarm` -------------------------------------------

/** `retune` of `energy#REST_TICKS`: read the entity, cycle 300 -> 240, submit. */
const RETUNE_REST_TICKS = cannedCast({
  id: "retune",
  intent: "retune REST_TICKS",
  truth: ["entity:world/energy.js#REST_TICKS"],
  script: [
    { tool: "read", args: { path: "world/energy.js", entity: "REST_TICKS" }, why: "read" },
    {
      tool: "replace",
      args: { path: "world/energy.js", old: "export const REST_TICKS = 300;", new: "export const REST_TICKS = 240;" },
      why: "edit",
    },
  ],
});

/** `reader`: a whole-file `read` of `world/energy.js`, then `add-plain`'s body. */
const READER = cannedCast({
  id: "reader",
  intent: "add a creature",
  truth: ["entity:world/bounds.js#bounce", "entity:world/movement.js#step", "entity:world/movement.js#wander"],
  script: [
    { tool: "read", args: { path: "world/energy.js" }, why: "wide-read" },
    { tool: "list", args: { path: "creatures/" }, why: "list" },
    { tool: "read", args: { path: "GUIDE.md" }, why: "read" },
    { tool: "read", args: { path: "world/bounds.js", entity: "bounce" }, why: "read" },
    { tool: "read", args: { path: "world/movement.js", entity: "step" }, why: "read" },
    { tool: "read", args: { path: "world/movement.js", entity: "wander" }, why: "read" },
    (s) => {
      const entries = (s.data.entries ?? ["s0000.js"]) as string[];
      const name = freshName(entries);
      // The palette/speed draws `add-plain` makes; a fixed pick keeps this cast deterministic.
      s.data.name = name;
      return { tool: "write", args: { path: name, content: tPlain("purple", 2) }, why: "write" };
    },
  ],
  onResult(s, call, result) {
    if (call.why === "list") s.data.entries = fileNamesOf(result);
  },
});

/** `edit-creature` of `s0000`: read `creatures/s0000.js#SPEED`, cycle 1 -> 1.5, submit. */
const EDIT_CREATURE_S0000 = cannedCast({
  id: "edit-creature",
  intent: "speed up s0000",
  truth: ["entity:creatures/s0000.js#SPEED"],
  script: [
    { tool: "read", args: { path: "creatures/s0000.js", entity: "SPEED" }, why: "read" },
    {
      tool: "replace",
      args: { path: "creatures/s0000.js", old: "const SPEED = 1;", new: "const SPEED = 1.5;" },
      why: "edit",
    },
  ],
});

/** `sweep-colour`: list `creatures/`; for each of the first four kinds in name order read the
 * file and `replace` its first colour constant with the next palette name; submit. */
const SWEEP_COLOUR = cannedCast({
  id: "sweep-colour",
  intent: "repaint the first four creatures",
  truth: ["listing:creatures/"],
  secondRepairWithdraws: true,
  script: [
    { tool: "list", args: { path: "creatures/" }, why: "list" },
    (s) =>
      ((s.data.first4 ?? []) as string[]).map((path) => ({
        tool: "read" as const,
        args: { path },
        why: `read:${path}`,
      })),
    (s) => {
      const calls: CastCall[] = [];
      const texts = (s.data.texts ?? {}) as Record<string, string>;
      const colours = new Set<string>(PALETTE);
      for (const path of (s.data.first4 ?? []) as string[]) {
        // The first colour constant: the first `const NAME = "<a palette colour>";`.
        const match = /const (\w+) = "(\w+)";/.exec(texts[path] ?? "");
        if (match === null || !colours.has(match[2] as string)) continue;
        const next = PALETTE[(PALETTE.indexOf(match[2] as (typeof PALETTE)[number]) + 1) % PALETTE.length];
        calls.push({
          tool: "replace",
          args: { path, old: match[0], new: `const ${match[1]} = "${next}";` },
          why: `edit:${path}`,
        });
      }
      return calls;
    },
  ],
  onResult(s, call, result) {
    if (call.why === "list") {
      const entries = fileNamesOf(result).sort();
      s.data.first4 = entries.slice(0, 4).map((name) => `creatures/${name}`);
      return;
    }
    if (call.why?.startsWith("read:")) {
      const path = call.why.slice("read:".length);
      const text = (result as { content?: unknown }).content;
      const texts = (s.data.texts ??= {}) as Record<string, string>;
      if (typeof text === "string") texts[path] = text;
    }
  },
});

/** `sweep-search`: `search` for `wander(creature, 0.05)` in `creatures/`; for the first three
 * containers: `read`, `replace` with `wander(creature, 0.1)`; submit. */
const SWEEP_SEARCH = cannedCast({
  id: "sweep-search",
  intent: "widen the wander",
  truth: ["query:text:creatures/:wander(creature, 0.05)"],
  secondRepairWithdraws: true,
  script: [
    { tool: "search", args: { query: "wander(creature, 0.05)", path: "creatures/" }, why: "search" },
    (s) =>
      ((s.data.containers ?? []) as string[]).slice(0, 3).map((path) => ({
        tool: "read" as const,
        args: { path },
        why: `read:${path}`,
      })),
    (s) =>
      ((s.data.containers ?? []) as string[]).slice(0, 3).map((path) => ({
        tool: "replace" as const,
        args: { path, old: "wander(creature, 0.05)", new: "wander(creature, 0.1)" },
        why: `edit:${path}`,
      })),
  ],
  onResult(s, call, result) {
    if (call.why === "search") {
      const containers = (result as { containers?: unknown }).containers;
      s.data.containers = Array.isArray(containers)
        ? containers.filter((c): c is string => typeof c === "string").map((c) => c.split("#")[0] as string)
        : [];
    }
  },
  onHeadsUp(s, hu, ack) {
    // QT1 `repair`: the same edit in each added container; no read is needed (the source rides
    // the diff's `added` entries).
    for (const item of hu.items) {
      if (item.rule !== "QT1" || item.diff.kind !== "query") continue;
      for (const added of item.diff.added) {
        s.queue.push({
          tool: "replace",
          args: { path: added.key.split("#")[0], old: "wander(creature, 0.05)", new: "wander(creature, 0.1)" },
          why: "repair",
        });
      }
    }
    ack.statement = "widened the wander in the new file too";
  },
});

/** `retune` of `energy#REST_TICKS` that answers its E1 (OP1) as its row says: `read` the entity
 * again, `replace` from the new current value (the cycle 300 -> 240 -> 360 -> 300), acknowledge. */
const RETUNE_ADAPT = cannedCast({
  id: "retune",
  intent: "retune REST_TICKS",
  truth: ["entity:world/energy.js#REST_TICKS"],
  script: [
    { tool: "read", args: { path: "world/energy.js", entity: "REST_TICKS" }, why: "read" },
    {
      tool: "replace",
      args: { path: "world/energy.js", old: "export const REST_TICKS = 300;", new: "export const REST_TICKS = 240;" },
      why: "edit",
    },
  ],
  onResult(s, call, result) {
    if (call.why === "reread") {
      const source = (result as { source?: unknown }).source;
      const m = typeof source === "string" ? /REST_TICKS = (\d+)/.exec(source) : null;
      if (m !== null) s.data.rest_ticks = Number(m[1]);
    }
  },
  onHeadsUp(s, hu, ack) {
    if (hu.dropped_ops.length === 0) return;
    // E1 + OP1: the queued replace no longer applies. `read` it again, `replace` from the new
    // current value to the next of the cycle (10.3's `retune` row).
    s.queue.push({ tool: "read", args: { path: "world/energy.js", entity: "REST_TICKS" }, why: "reread" });
    s.queue.push({
      tool: "replace",
      args: (s) => {
        const cycle = [300, 240, 360];
        const cur = (s.data.rest_ticks ?? 300) as number;
        const next = cycle[(cycle.indexOf(cur) + 1) % cycle.length];
        return {
          path: "world/energy.js",
          old: `export const REST_TICKS = ${cur};`,
          new: `export const REST_TICKS = ${next};`,
        };
      },
      why: "repair",
    });
    ack.statement = "rescaled from the new current value";
    ack.dropped = "handled";
  },
});

// --- A22's scenarios, on seed `tidepool-swarm` ----------------------------------------------

describe("10.3 rule-based confirms (A22)", () => {
  it(
    "`retune` of REST_TICKS lands while `rescale-energy` is in flight: E2m and QR1m `confirm`",
    { timeout: 30_000 },
    () => {
      const s = sim();
      const rescale = s.open("rescale-energy", { hold: true });
      drive(s, rescale); // has read ENERGY_MAX and replaced it; its `refs:` premise stands
      const retune = s.open(RETUNE_REST_TICKS);
      landNow(s, retune);

      const hus = s.headsUps(rescale);
      expect(hus).toHaveLength(1);
      expect(hus[0]!.result).toBe("confirm");
      expect(itemKeys(hus[0]!)).toEqual(["E2m:world/energy.js#REST_TICKS", "QR1m:refs:world/energy.js#ENERGY_MAX"]);
      // The pattern acknowledges with no edit: release, land, and its landing is exactly its own
      // change (no extra repair paths beyond what its `replace` + relied_on_by fixes wrote).
      s.release(rescale);
      landNow(s, rescale);
      expect(s.landingOf(rescale)).toBeDefined();
      expect([...s.landingOf(rescale)!.files.keys()]).toContain("world/energy.js");
    },
  );

  it("`rescale-energy` lands while `cosmetic` is in flight: E2m `confirm`, F3m folded", { timeout: 30_000 }, () => {
    const s = sim();
    const cosmetic = s.open("cosmetic", { hold: true });
    drive(s, cosmetic); // has read world/energy.js and reworded its comment
    const rescale = s.open("rescale-energy");
    landNow(s, rescale);

    const hus = s.headsUps(cosmetic);
    expect(hus).toHaveLength(1);
    expect(hus[0]!.result).toBe("confirm");
    // One item: the F3m judgment on the file is folded into the E2m (HU2a).
    expect(itemKeys(hus[0]!)).toEqual(["E2m:world/energy.js#ENERGY_MAX"]);
    expect(judgmentsOf(s, cosmetic)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "E2m", kind: "entity", key: "world/energy.js#ENERGY_MAX", result: "confirm" }),
        expect.objectContaining({ rule: "F3m", kind: "file", key: "world/energy.js", result: "confirm" }),
      ]),
    );
    s.release(cosmetic);
    landNow(s, cosmetic);
  });

  it(
    "`cosmetic` lands while `rescale-energy`, `add-energy` and `reader` are in flight: F2 `holds` for `reader`, no heads-up to anyone",
    { timeout: 30_000 },
    () => {
      const s = sim();
      const rescale = s.open("rescale-energy", { hold: true });
      const addEnergy = s.open("add-energy", { hold: true });
      const reader = s.open(READER, { hold: true });
      drive(s, rescale);
      drive(s, addEnergy);
      drive(s, reader);

      const cosmetic = s.open("cosmetic");
      landNow(s, cosmetic);

      for (const a of [rescale, addEnergy, reader]) expect(s.headsUps(a)).toHaveLength(0);
      expect(judgmentsOf(s, reader)).toEqual([
        expect.objectContaining({ rule: "F2", kind: "file", key: "world/energy.js", result: "holds" }),
      ]);
      expect(judgmentsOf(s, rescale)).toHaveLength(0);
      expect(judgmentsOf(s, addEnergy)).toHaveLength(0);
    },
  );

  it(
    "`sweep-colour` lands while `edit-creature` of the same file is in flight: E2m and QR1m `confirm`",
    { timeout: 30_000 },
    () => {
      const s = sim();
      const edit = s.open(EDIT_CREATURE_S0000, { hold: true });
      drive(s, edit); // has replaced `const SPEED = 1;` with `1.5`
      const sweep = s.open(SWEEP_COLOUR);
      landNow(s, sweep);

      const hus = s.headsUps(edit);
      expect(hus).toHaveLength(1);
      expect(hus[0]!.result).toBe("confirm");
      expect(itemKeys(hus[0]!)).toEqual(["E2m:creatures/s0000.js#BODY", "QR1m:refs:creatures/s0000.js#SPEED"]);
      s.release(edit);
      landNow(s, edit);
    },
  );

  it(
    "`edit-creature` lands while `sweep-colour` holds an edit of that file: E2m and QR1m `confirm`",
    { timeout: 30_000 },
    () => {
      const s = sim();
      const sweep = s.open(SWEEP_COLOUR, { hold: true });
      drive(s, sweep); // has replaced the BODY of s0000.js (among its first four)
      const edit = s.open(EDIT_CREATURE_S0000);
      landNow(s, edit);

      const hus = s.headsUps(sweep);
      expect(hus).toHaveLength(1);
      expect(hus[0]!.result).toBe("confirm");
      expect(itemKeys(hus[0]!)).toEqual(["E2m:creatures/s0000.js#SPEED", "QR1m:refs:creatures/s0000.js#BODY"]);
      s.release(sweep);
      landNow(s, sweep);
    },
  );

  // 02-tidepool.md 10.3: "a `reader` | `rescale-energy` in flight | `refs:…#ENERGY_MAX` | QR4,
  // scripted `holds`". TR8 (01-core.md): for QR4 "the input's `truth` is the landed change's list"
  // — the reader's `[bounce, step, wander]` does not name the query, so the scripted answer is
  // `holds`. The engine answers `repair` (`triage_depends`, p = 1) with a `repair` heads-up:
  // `applyClassification` falls back to the RECEIVER's truth because `causeAttempt` is only set
  // when the classification holds an E1 item (src/core/trunk/tick.ts, the E1 loop before
  // `applyClassification`), so QR4's decider is never the landed change without an E1.
  it.fails(
    "a `reader` lands while `rescale-energy` is in flight: QR4 triage, answered `holds`",
    { timeout: 30_000 },
    () => {
      const s = sim();
      const rescale = s.open("rescale-energy", { hold: true });
      drive(s, rescale);
      const reader = s.open(READER);
      landNow(s, reader);

      expect(
        judgmentsOf(s, rescale).some(
          (j) =>
            j.rule === "QR4" &&
            j.klass === "triage" &&
            j.result === "holds" &&
            j.key === "refs:world/energy.js#ENERGY_MAX",
        ),
      ).toBe(true);
      // A triage answer of `holds` arrives as an `info` heads-up (HU2a).
      const hus = s.headsUps(rescale);
      expect(hus).toHaveLength(1);
      expect(hus[0]!.result).toBe("info");
    },
  );

  it(
    "a T-plain file lands while `sweep-search` has altered three containers: QT1 `repair`",
    { timeout: 30_000 },
    () => {
      const s = sim();
      const sweep = s.open(SWEEP_SEARCH, { hold: true });
      drive(s, sweep); // its three replaces on the first containers stand
      const add = s.open("add-plain");
      landNow(s, add);
      const added = [...s.landingOf(add)!.files.keys()][0]!;

      const hus = s.headsUps(sweep);
      expect(hus).toHaveLength(1);
      const hu = hus[0]!;
      expect(hu.result).toBe("repair");
      const qt1 = hu.items.find((i) => i.rule === "QT1")!;
      expect(qt1.reason).toBe("sweep_incomplete");
      expect(qt1.diff.kind).toBe("query");
      if (qt1.diff.kind === "query") {
        expect(qt1.diff.added.map((x) => x.key)).toContain(`${added}#update`);
      }
      // The pattern repairs the gained container with the same edit, then lands.
      s.release(sweep);
      landNow(s, sweep);
      expect(s.files().get(added)).toContain("wander(creature, 0.1)");
    },
  );

  it(
    "a `retune` of REST_TICKS lands while another `retune` of it is in flight: E1 with a QR1m item in the same heads-up",
    { timeout: 30_000 },
    () => {
      const s = sim();
      const a = s.open(RETUNE_ADAPT, { hold: true });
      drive(s, a); // its `replace` 300 -> 240 is recorded
      const b = s.open(RETUNE_REST_TICKS);
      landNow(s, b);

      const hus = s.headsUps(a);
      expect(hus).toHaveLength(1);
      const hu = hus[0]!;
      expect(hu.result).toBe("repair");
      expect(itemKeys(hu)).toEqual(["E1:world/energy.js#REST_TICKS", "QR1m:refs:world/energy.js#REST_TICKS"]);
      expect(hu.dropped_ops.length).toBe(1);
      // Its row's answer: read again, replace from the new current value (240 -> 360), land.
      s.release(a);
      landNow(s, a);
      expect(s.files().get("world/energy.js")).toContain("export const REST_TICKS = 360;");
    },
  );
});
