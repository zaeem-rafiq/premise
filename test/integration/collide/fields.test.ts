// Field checks of 01-core.md 12.1, one `it` per event, on the collision scenario of
// 04-build-plan 2.3 item 2 (order 1): a held `add-energy` attempt is repaired by a landing
// `rescale-energy`, resolves the heads-up and lands. Expected values are worked by hand from
// the specification and the scenario — never copied from the engine's output (BP1).

import { describe, expect, it } from "vitest";
import type { HeadsUpItem } from "../../../src/protocol/headsup.ts";
import type { Note } from "../../../src/protocol/note.ts";
import { entityAt } from "../../../src/core/trunk/sets.ts";
import { blobId } from "../../../src/core/sync/sha1.ts";
import { utf8 } from "../../../src/core/sync/bytes.ts";
import { canonicalJson } from "../../../src/core/git/note.ts";
import { SwarmSim, swarmFiles, type AgentHandle } from "./harness.ts";

const ENERGY_KEY = "world/energy.js#ENERGY_MAX";

function drive(sim: SwarmSim, agent: AgentHandle): void {
  for (let i = 0; i < 20; i += 1) {
    if (!sim.step(agent)) return;
  }
}

/** Order 1 of 2.3 item 2: `held` parks at its first submit; `rescale` validates and lands. */
function order1(sim: SwarmSim, heldIds: string[]): { held: AgentHandle[]; rescale: AgentHandle } {
  const held = heldIds.map((id) => {
    const agent = sim.open(id, { hold: true });
    drive(sim, agent);
    return agent;
  });
  const rescale = sim.open("rescale-energy");
  drive(sim, rescale);
  sim.land();
  return { held, rescale };
}

/** The seed files as the head map the engine started from (batch 0, seq 0). */
function seedHead(): Map<string, string> {
  return new Map(Object.entries(swarmFiles()));
}

describe("event fields of 12.1, worked by hand (BP1)", () => {
  it("premise.recorded: the entity a read pins (EM2, TA7)", () => {
    const sim = new SwarmSim(swarmFiles(), { seed: 7 });
    const re = sim.open("rescale-energy");
    drive(sim, re);
    // rescale-energy's first call is `read world/energy.js#ENERGY_MAX` (02-tidepool 10.3). A
    // read pins the entity premise with `read`. The row then reads the `update` entity of
    // every creature module `relied_on_by` names — on the swarm seed fish, minnow and
    // turtle — so TA7 lists exactly those four premises.
    const recorded = sim.eventsOf("premise.recorded").filter((e) => e.attempt_id === re.id && e.tool === "read");
    expect(recorded.map((e) => (e.premise as { key: string }).key)).toEqual([
      ENERGY_KEY,
      "creatures/fish.js#update",
      "creatures/minnow.js#update",
      "creatures/turtle.js#update",
    ]);
    expect(recorded[0]).toEqual(
      expect.objectContaining({
        src: "trunk",
        type: "premise.recorded",
        attempt_id: re.id,
        premise: {
          kind: "entity",
          key: ENERGY_KEY,
          // the entity's hash at head when it was pinned — seq 0, before any landing
          hash: entityAt(seedHead(), ENERGY_KEY)?.hash,
          seq: 0,
          read: true,
          edit: false,
          derived: false,
        },
        tool: "read",
      }),
    );
  });

  it("premise.removed: a premise left flagless is deleted (R5)", () => {
    const sim = new SwarmSim(swarmFiles(), { seed: 7 });
    const a = sim.open("add-energy", { hold: true });
    // Write 1 references ENERGY_MAX: D1 pins `entity:ENERGY_MAX` with `derived`.
    sim.trunk.tool({
      attempt_id: a.id,
      call_id: "c1",
      tool: "write",
      args: {
        path: "creatures/x.js",
        content: 'import { ENERGY_MAX } from "../world/energy.js";\nexport const x = ENERGY_MAX;\n',
      },
      ack: 0,
    });
    // Write 2 drops the import: the flag no longer applies; a premise with no flags is
    // deleted — `premise.removed` under R5.
    sim.trunk.tool({
      attempt_id: a.id,
      call_id: "c2",
      tool: "write",
      args: { path: "creatures/x.js", content: "export const y = 1;\n" },
      ack: 0,
    });
    const removed = sim.eventsOf("premise.removed").filter((e) => e.attempt_id === a.id);
    expect(removed).toEqual([
      expect.objectContaining({
        src: "trunk",
        type: "premise.removed",
        attempt_id: a.id,
        kind: "entity",
        key: ENERGY_KEY,
        rule: "R5",
      }),
    ]);
  });

  it("premise.judged: the E2 judgment the landing gives the held attempt (EM3)", () => {
    const sim = new SwarmSim(swarmFiles(), { seed: 7 });
    const { held, rescale } = order1(sim, ["add-energy"]);
    const ae = held[0] as AgentHandle;
    const judged = sim.eventsOf("premise.judged").filter((e) => e.attempt_id === ae.id);
    // The held attempt read ENERGY_MAX at seq 0; seq 1 changed it — rule E2, repair, and a
    // rule decision asks no triage model (clef null).
    const e2 = judged.filter((e) => e.rule === "E2");
    expect(e2.length).toBeGreaterThanOrEqual(1);
    expect(e2[0]).toEqual(
      expect.objectContaining({
        src: "trunk",
        type: "premise.judged",
        attempt_id: ae.id,
        kind: "entity",
        key: ENERGY_KEY,
        old_hash: entityAt(seedHead(), ENERGY_KEY)?.hash,
        new_hash: entityAt(sim.files() as Map<string, string>, ENERGY_KEY)?.hash,
        cause: "landing",
        cause_seq: 1,
        rule: "E2",
        class: "rule",
        result: "repair",
        reason: "referenced_entity_changed",
        clef: null,
      }),
    );
    sim.release(ae);
    sim.settle();
    expect(rescale.id).toBe("a_1");
  });

  it("intent.state: the landed attempt's intent goes to landed (T16)", () => {
    const sim = new SwarmSim(swarmFiles(), { seed: 7 });
    const { rescale } = order1(sim, ["add-energy"]);
    const states = sim.eventsOf("intent.state").filter((e) => e.intent_id === `i_${rescale.id}`);
    expect(states).toEqual([
      expect.objectContaining({ src: "trunk", type: "intent.state", intent_id: `i_${rescale.id}`, state: "landed" }),
    ]);
  });

  it("landing.accepted: seq 1 of the scenario (9.4, EM4)", () => {
    const sim = new SwarmSim(swarmFiles(), { seed: 7 });
    const { rescale } = order1(sim, ["add-energy"]);
    const accepted = sim.eventsOf("landing.accepted");
    expect(accepted).toHaveLength(1);
    const landed = sim.files();
    const e = accepted[0] as Record<string, unknown>;
    expect(e).toEqual(
      expect.objectContaining({
        src: "trunk",
        type: "landing.accepted",
        seq: 1,
        batch_id: 1,
        kind: "change",
        attempt_id: rescale.id,
        change_id: expect.stringMatching(/^c_/),
        intent_id: `i_${rescale.id}`,
        request_id: null,
        paths: ["world/energy.js"],
      }),
    );
    // writes: the file row plus the entity row the replace changed (12.1: Note["writes"]).
    const writes = e.writes as Array<{ kind: string; key: string; old: string; new: string }>;
    expect(writes).toContainEqual({
      kind: "file",
      key: "world/energy.js",
      old: blobId(utf8(seedHead().get("world/energy.js") ?? "")),
      new: blobId(utf8(landed.get("world/energy.js") ?? "")),
    });
    expect(writes).toContainEqual({
      kind: "entity",
      key: ENERGY_KEY,
      old: entityAt(seedHead(), ENERGY_KEY)?.hash,
      new: entityAt(landed as Map<string, string>, ENERGY_KEY)?.hash,
    });
    expect(writes).toHaveLength(2);
  });

  it("landing.landed: seq 1 lands after the batch push (9.6)", () => {
    const sim = new SwarmSim(swarmFiles(), { seed: 7 });
    order1(sim, ["add-energy"]);
    const landed = sim.eventsOf("landing.landed");
    expect(landed).toHaveLength(1);
    const e = landed[0] as Record<string, unknown>;
    expect(e).toEqual(
      expect.objectContaining({
        src: "trunk",
        type: "landing.landed",
        seq: 1,
        batch_id: 1,
        commit: expect.stringMatching(/^[0-9a-f]{40}$/),
        tree: expect.stringMatching(/^[0-9a-f]{40}$/),
        note: expect.stringMatching(/^[0-9a-f]{40}$/),
        time_to_land_ms: expect.any(Number),
      }),
    );
    // NT1: `note` is the git blob id of `note_json`'s canonical bytes followed by one LF.
    const note = JSON.parse(e.note_json as string) as Note;
    expect(blobId(utf8(canonicalJson(note) + "\n"))).toBe(e.note);
    expect(note.seq).toBe(1);
    expect(note.kind).toBe("change");
    expect(note.batch).toEqual({ id: 1, index: 0, size: 1 });
  });

  it("headsup.sent: the repair heads-up of item 2 (8.2)", () => {
    const sim = new SwarmSim(swarmFiles(), { seed: 7 });
    const { held } = order1(sim, ["add-energy"]);
    const ae = held[0] as AgentHandle;
    const sent = sim.eventsOf("headsup.sent").filter((e) => e.attempt_id === ae.id);
    expect(sent).toHaveLength(1);
    const e = sent[0] as Record<string, unknown>;
    expect(e).toEqual(
      expect.objectContaining({
        src: "trunk",
        type: "headsup.sent",
        attempt_id: ae.id,
        hn: 1,
        result: "repair",
        wake: true, // a parked attempt wakes on a repair (8.1)
        cause: {
          type: "landing",
          seqs: [1],
          changes: [{ seq: 1, change_id: expect.stringMatching(/^c_/), intent_text: "rescale ENERGY_MAX" }],
        },
        keys: [{ kind: "entity", key: ENERGY_KEY, rule: "E2" }],
        dropped_ops: [],
        go_around: 1, // the go-around this heads-up starts
      }),
    );
    const items = e.items as HeadsUpItem[];
    expect(items).toHaveLength(1);
    const item = items[0] as HeadsUpItem;
    expect(item.premise).toEqual({ kind: "entity", key: ENERGY_KEY });
    expect(item.rule).toBe("E2");
    expect(item.result).toBe("repair");
    expect(item.reason).toBe("referenced_entity_changed");
    expect(item.old_hash).toBe(entityAt(seedHead(), ENERGY_KEY)?.hash);
    expect(item.new_hash).toBe(entityAt(sim.files() as Map<string, string>, ENERGY_KEY)?.hash);
    expect(item.cause_seq).toBe(1);
    if (item.diff.kind === "entity") {
      expect(item.diff.before ?? "").toContain("ENERGY_MAX = 100");
      expect(item.diff.after ?? "").toContain("ENERGY_MAX = 1");
    } else {
      throw new Error("expected an entity diff");
    }
  });

  it("headsup.resolved: the repair resolves as changed (HU12)", () => {
    const sim = new SwarmSim(swarmFiles(), { seed: 7 });
    const { held } = order1(sim, ["add-energy"]);
    const ae = held[0] as AgentHandle;
    sim.release(ae);
    sim.settle();
    const resolved = sim.eventsOf("headsup.resolved").filter((e) => e.attempt_id === ae.id);
    expect(resolved).toHaveLength(1);
    // The attempt replaced its write for the new threshold: an operation sits after op_mark,
    // so HU12's `changed` is true.
    expect(resolved[0]).toEqual(
      expect.objectContaining({
        src: "trunk",
        type: "headsup.resolved",
        attempt_id: ae.id,
        hn: 1,
        result: "repair",
        go_around: 1,
        changed: true,
        statement: "rescaled the threshold",
      }),
    );
  });
});
