// The collision proofs of docs/spec/04-build-plan.md 2.3, items 2 to 8 and the `info` row of
// docs/spec/02-tidepool.md 10.3, driven in Node against the real Trunk engine over `node:sqlite`
// (the same seam `test/cases/driver.ts` uses): no Durable Object, no network. Each scripted agent
// opens a synthetic attempt with its truth list (TR8) and plays its canned pattern through the
// seven tools; `hold`/`released` stand in for SWR3's `hold_before_submit` and `release`.
//
// Expected values come from the specification and the plan's acceptance items, never from the
// engine's output. `it.fails` marks the assertions the engine cannot answer today; each one is
// commented with the rule it quotes and what the engine answered instead.

import { describe, expect, it } from "vitest";
import type { HeadsUpItem } from "../../../src/protocol/headsup.ts";
import { sw2Escapes } from "../../../src/swarm/sw2.ts";
import { SwarmSim, swarmFiles, tidepoolFiles, type AgentHandle } from "./harness.ts";

const ENERGY_KEY = "world/energy.js#ENERGY_MAX";
const REFS_KEY = `refs:${ENERGY_KEY}`;

/** The `headsup.sent` events recorded for `agent`. */
function sentTo(sim: SwarmSim, agent: AgentHandle): Array<Record<string, unknown>> {
  return sim.eventsOf("headsup.sent").filter((e) => e.attempt_id === agent.id);
}

/** The `headsup.resolved` events recorded for `agent`. */
function resolvedOf(sim: SwarmSim, agent: AgentHandle): Array<Record<string, unknown>> {
  return sim.eventsOf("headsup.resolved").filter((e) => e.attempt_id === agent.id);
}

/** The `attempt.state` events recorded for `agent` whose `to` is `state`. */
function transitions(sim: SwarmSim, agent: AgentHandle, state: string): Array<Record<string, unknown>> {
  return sim.eventsOf("attempt.state").filter((e) => e.attempt_id === agent.id && e.to === state);
}

/** Drive one agent until it parks (a `wait` step, a `stop`, or a terminal state). */
function drive(sim: SwarmSim, agent: AgentHandle): void {
  for (let i = 0; i < 20; i += 1) {
    if (!sim.step(agent)) return;
  }
  throw new Error("drive: the agent did not park within 20 calls");
}

/**
 * Order 1 (2.3 item 2): the `held` agents work until their first `submit` (SW8: calls through
 * the first submit, then wait) — `op.recorded` for the file is the hold signal — and the
 * `rescale-energy` agent validates and lands while they are parked at the submit gate.
 */
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

describe("collide (04-build-plan 2.3, 02-tidepool 10.3): scripted agents through the engine", () => {
  it("item 2, order 1 (E2, SWR3, HU12, SW2): the held add-energy repairs its threshold and lands", () => {
    const sim = new SwarmSim(swarmFiles(), { seed: 7 });
    const { held, rescale } = order1(sim, ["add-energy"]);
    const ae = held[0] as AgentHandle;

    // The rescale lands while add-energy is held after its write. The heads-up carries the
    // exact entity diff, the attempt goes around once, and it waits for release (SWR3).
    expect(sim.state(rescale)).toBe("landed");
    expect(sim.state(ae)).toBe("going_around");
    expect(sim.attempt(ae)?.go_arounds).toBe(1);

    const sent = sentTo(sim, ae);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.result).toBe("repair");
    expect(sent[0]?.keys).toEqual([{ kind: "entity", key: ENERGY_KEY, rule: "E2", cause_seq: 1 }]);
    const item = (sent[0]?.items as HeadsUpItem[])[0] as HeadsUpItem;
    expect(item.diff.kind).toBe("entity");
    if (item.diff.kind === "entity") {
      expect(item.diff.before ?? "").toContain("ENERGY_MAX = 100");
      expect(item.diff.after ?? "").toContain("ENERGY_MAX = 1");
    }
    expect(transitions(sim, ae, "going_around")).toHaveLength(1);

    // After release the heads-up resolves as a repair with the operation changed, and the
    // attempt lands.
    sim.release(ae);
    sim.settle();
    expect(sim.state(ae)).toBe("landed");

    const resolved = resolvedOf(sim, ae);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.result).toBe("repair");
    expect(resolved[0]?.changed).toBe(true);
    expect(resolved[0]?.statement).toBe("rescaled the threshold");

    // The landed creature passes the SW2 oracle: threshold 0.3 = 0.3 x ENERGY_MAX(=1).
    expect(sw2Escapes(sim.files())).toEqual([]);

    // Its note has one go_arounds entry whose key carries rule E2.
    const note = sim.noteOf(ae);
    expect(note?.go_arounds).toHaveLength(1);
    expect(note?.go_arounds[0]?.keys).toEqual([{ kind: "entity", key: ENERGY_KEY, rule: "E2" }]);
  });

  it("item 2 (T8): the attempt.state event to going_around reports go_arounds 1", () => {
    // 01-core 9.2 T8: `going_around`, effect `go_arounds += 1`; the acceptance text expects
    // "attempt.state to going_around with go_arounds: 1". The event reports the count after
    // the transition: enterRepair applies T8's effect before setState emits it.
    const sim = new SwarmSim(swarmFiles(), { seed: 7 });
    const { held } = order1(sim, ["add-energy"]);
    const ae = held[0] as AgentHandle;
    const going = transitions(sim, ae, "going_around");
    expect(going).toHaveLength(1);
    expect(going[0]?.go_arounds).toBe(1);
  });

  it("item 3, order 2 (QR1, SWR3, SW2): the held rescale repairs the gained file's threshold", () => {
    const sim = new SwarmSim(swarmFiles(), { seed: 7 });
    const rescale = sim.open("rescale-energy", { hold: true });
    drive(sim, rescale); // read + replace; held before its submit
    const ae = sim.open("add-energy");
    drive(sim, ae);
    sim.land();

    // The add-energy lands while rescale is held after its replace: the derived
    // `query:refs:ENERGY_MAX` premise (D2) gains the new file's referrer entities.
    expect(sim.state(ae)).toBe("landed");
    expect(sim.state(rescale)).toBe("going_around");

    const sent = sentTo(sim, rescale);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.result).toBe("repair");
    expect(sent[0]?.keys).toContainEqual({ kind: "query", key: REFS_KEY, rule: "QR1", cause_seq: 1 });
    const item = (sent[0]?.items as HeadsUpItem[])[0] as HeadsUpItem;
    expect(item.diff.kind).toBe("query");
    if (item.diff.kind === "query") {
      expect(item.diff.added.map((m) => m.key)).toContain("creatures/s-1.js#spawn");
    }

    sim.release(rescale);
    sim.settle();
    expect(sim.state(rescale)).toBe("landed");

    // The repair replaced the threshold in the gained module: 0.3 = 0.3 x new ENERGY_MAX(=1).
    expect(sim.files().get("creatures/s-1.js")).toContain("creature.energy < 0.3");
    expect(sw2Escapes(sim.files())).toEqual([]);
  });

  it("item 4 (E0, F2): an add-plain in flight is not disturbed; a cosmetic landing disturbs nobody", () => {
    // An add-plain held during order 1: its truth entities (bounce, step, wander) do not change,
    // so it receives no heads-up at all.
    const first = new SwarmSim(swarmFiles(), { seed: 7 });
    const { held, rescale } = order1(first, ["add-plain", "add-energy"]);
    const ap = held[0] as AgentHandle;
    const ae = held[1] as AgentHandle;
    expect(first.state(rescale)).toBe("landed");
    expect(sentTo(first, ap)).toEqual([]);
    // The add-energy does get its E2; only the untouched attempt stays quiet.
    expect(sentTo(first, ae)).toHaveLength(1);

    // A cosmetic landing while other patterns are in flight: the comment change alters no
    // entity hash, so no attempt of another pattern is sent a heads-up (E0, F2).
    const sim = new SwarmSim(swarmFiles(), { seed: 7 });
    const aeHeld = sim.open("add-energy", { hold: true });
    drive(sim, aeHeld);
    const rsHeld = sim.open("rescale-energy", { hold: true });
    drive(sim, rsHeld);
    const cos = sim.open("cosmetic");
    drive(sim, cos);
    sim.land();
    expect(sim.state(cos)).toBe("landed");
    expect(sentTo(sim, sim.agents[0] as AgentHandle)).toEqual([]);
    expect(sentTo(sim, sim.agents[1] as AgentHandle)).toEqual([]);
  });

  it("item 5 (E2, HU12): the add-relative acknowledges with no edit — changed: false", () => {
    const sim = new SwarmSim(swarmFiles(), { seed: 7 });
    const { held, rescale } = order1(sim, ["add-relative"]);
    const ar = held[0] as AgentHandle;

    expect(sim.state(rescale)).toBe("landed");
    const sent = sentTo(sim, ar);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.keys).toEqual([{ kind: "entity", key: ENERGY_KEY, rule: "E2", cause_seq: 1 }]);

    // The designed false abort: it acknowledges with no new operation, so the resolution's
    // `changed` is false (HU12).
    sim.release(ar);
    sim.settle();
    expect(sim.state(ar)).toBe("landed");
    const resolved = resolvedOf(sim, ar);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.result).toBe("repair");
    expect(resolved[0]?.changed).toBe(false);

    // The T-relative file holds ENERGY_MAX * 0.3 whatever the value is; the oracle has no
    // numbered threshold to check on it.
    expect(sim.files().get("creatures/s-0.js")).toContain("creature.energy < ENERGY_MAX * 0.3");
    expect(sw2Escapes(sim.files())).toEqual([]);
  });

  it("item 6 (EV6, HU12): a summary_only pool strips the stream detail", () => {
    // 01-core EV6 and plan item 6: on a `summary_only` pool `headsup.sent` keeps the keys with
    // `items: null`, `landing.landed` carries `note_json: null`, and the stream holds no
    // `premise.recorded`, `op.recorded` or `attempt.step`. event() consults the pool's
    // summary_only meta: it drops the detailed records and rewrites the two detail bodies.
    const sim = new SwarmSim(swarmFiles(), { seed: 7, summary_only: true });
    const { held } = order1(sim, ["add-energy"]);
    const ae = held[0] as AgentHandle;
    sim.release(ae);
    sim.settle();

    const sent = sentTo(sim, ae);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.keys).toEqual([{ kind: "entity", key: ENERGY_KEY, rule: "E2", cause_seq: 1 }]);
    expect(sent[0]?.items).toBeNull();
    const landed = sim.eventsOf("landing.landed");
    expect(landed.length).toBeGreaterThan(0);
    for (const e of landed) expect(e.note_json).toBeNull();
    expect(sim.eventsOf("premise.recorded")).toEqual([]);
    expect(sim.eventsOf("op.recorded")).toEqual([]);
    expect(sim.eventsOf("attempt.step")).toEqual([]);
    // HU12 still applies: the resolution carries `changed` even in summary form.
    const resolved = resolvedOf(sim, ae);
    expect(resolved[0]?.changed).toBe(true);
  });

  it("item 7 (T4, T13, T14): a held-tier submit waits for the owner's land, or stops on decline", () => {
    // On the `tidepool` seed `world/` is a held path, so the scripted rescale answers `held`.
    const sim = new SwarmSim(tidepoolFiles(), { seed: 7 });
    const rescale = sim.open("rescale-energy");
    drive(sim, rescale);
    expect(sim.state(rescale)).toBe("held");
    const cards = sim.eventsOf("card.opened");
    expect(cards).toHaveLength(1);
    expect((cards[0]?.card as { kind: string }).kind).toBe("held");
    expect(sim.trunk.pool.landings).toEqual([]);

    // Nothing lands until the owner taps `land` (T13); then it validates and lands.
    sim.trunk.owner({ action: "land", attempt: rescale.id });
    sim.settle();
    expect(sim.state(rescale)).toBe("landed");
    expect(sim.landingOf(rescale)).toBeDefined();
    expect(sim.files().get("world/energy.js")).toContain("ENERGY_MAX = 1");

    // A second pool: `decline` stops the attempt (T14).
    const other = new SwarmSim(tidepoolFiles(), { seed: 7 });
    const second = other.open("rescale-energy");
    drive(other, second);
    expect(other.state(second)).toBe("held");
    other.trunk.owner({ action: "decline", attempt: second.id });
    expect(other.state(second)).toBe("stopped");
    expect(other.attempt(second)?.stop_reason).toBe("declined");
    expect(other.trunk.pool.landings).toEqual([]);
  });

  it("item 7 (HD1, CD4): the minimal held card offers land+decline, an empty blast radius, and refuses other options", () => {
    // HD1: `card.opened` of kind `held` with `preview: null`, an EMPTY blast radius and
    // exactly the options `land` and `decline` while `features.held` is off. CD4: an option
    // the card does not offer answers `invalid_args`, and so does an unknown owner action.
    const sim = new SwarmSim(tidepoolFiles(), { seed: 7 });
    const rescale = sim.open("rescale-energy");
    drive(sim, rescale);
    const cards = sim.eventsOf("card.opened");
    expect(cards).toHaveLength(1);
    const card = cards[0]?.card as {
      options?: Array<{ id: string }>;
      blast_radius?: object;
      preview?: unknown;
      risk?: unknown;
    };
    expect(card.preview).toBeNull();
    expect(card.risk).toBeNull();
    expect(card.blast_radius).toEqual({});
    expect(card.options?.map((o) => o.id)).toEqual(["land", "decline"]);
    const answer = sim.trunk.owner({ action: "land_now_forever", attempt: rescale.id });
    expect(answer).toMatchObject({ error: { code: "invalid_args" } });
  });

  it("item 8 (E1, OP1, TA9, TA9a): the second rescale withdraws through `stop`; no card opens", () => {
    const sim = new SwarmSim(swarmFiles(), { seed: 7 });
    const first = sim.open("rescale-energy");
    drive(sim, first);
    const second = sim.open("rescale-energy", { hold: true });
    drive(sim, second);
    sim.land();
    drive(sim, second); // the E1 repair arrives; the row's answer is `stop` `withdrawn`

    // The first rescale lands; the second's own replace no longer applies (OP1) and its edited
    // entity changed (E1): the row's answer is `stop` with `withdrawn`.
    expect(sim.state(first)).toBe("landed");
    const sent = sentTo(sim, second);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.result).toBe("repair");
    expect(sent[0]?.keys).toContainEqual({ kind: "entity", key: ENERGY_KEY, rule: "E1", cause_seq: 1 });
    expect(sent[0]?.dropped_ops).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "world/energy.js", rule: "OP1" })]),
    );

    expect(sim.state(second)).toBe("stopped");
    const stopped = transitions(sim, second, "stopped");
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.reason).toBe("withdrawn");
    expect(sim.attempt(second)?.stop_reason).toBe("withdrawn");

    // No card opens for it (TA9a): the only card-related events would name this attempt.
    for (const e of sim.events()) {
      if (typeof e.type === "string" && e.type.startsWith("card.")) {
        expect((e.attempt_ids as string[] | undefined) ?? []).not.toContain(second.id);
      }
    }

    // TA9 is idempotent: a repeated `stop` answers ok with the stored reason.
    const again = sim.trunk.stop({ attempt_id: second.id, reason: "withdrawn" }) as {
      ok: boolean;
      stop_reason?: string;
    };
    expect(again.ok).toBe(true);
    expect(again.stop_reason).toBe("withdrawn");
  });

  it("10.3 (X0, SW2): a rescale landing before the write gives info; the write uses the new value", () => {
    const sim = new SwarmSim(swarmFiles(), { seed: 7 });
    const ae = sim.open("add-energy");
    // Drive the script through its five calls before the write: list, read GUIDE.md and the
    // three entity reads, then park it so the rescale lands while it has no operation yet.
    for (let i = 0; i < 5; i += 1) sim.step(ae);
    expect(sim.attempt(ae)?.opCount ?? 0).toBe(0);
    sim.pause(ae);

    const rescale = sim.open("rescale-energy");
    drive(sim, rescale);
    sim.land();
    expect(sim.state(rescale)).toBe("landed");

    // With no patch yet the changed ENERGY_MAX premise is an info heads-up (X0), not a repair.
    const sent = sentTo(sim, ae);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.result).toBe("info");
    expect(sent[0]?.keys).toEqual([{ kind: "entity", key: ENERGY_KEY, rule: "X0", cause_seq: 1 }]);

    // The write that follows uses the new value: 0.3 = 0.3 x 1, and the file lands.
    sim.resume(ae);
    sim.settle();
    expect(sim.state(ae)).toBe("landed");
    expect(sim.files().get("creatures/s-0.js")).toContain("creature.energy < 0.3");
    expect(sw2Escapes(sim.files())).toEqual([]);
  });

  it("escape repro (X0, SW2, TA3): a held add-energy re-decides its refused write from the heads-up", () => {
    // The 2026-10-04 incident on the real service: `add-energy` held before submit reads
    // ENERGY_MAX = 100; `rescale-energy` lands in between. The X0 heads-up is `info`, so the
    // Agent does not show it (HE2): the `write` the pattern had already decided with the old
    // value is refused `heads_up_first` (TA3 — the operation is NOT recorded) and the
    // heads-up rides that answer. The pattern must decide the step again with what the
    // heads-up told it: threshold 0.3 x 1 = 0.3, and the SW2 oracle stays empty.
    const sim = new SwarmSim(swarmFiles(), { seed: 7 });
    const ae = sim.open("add-energy", { hold: true });
    for (let i = 0; i < 5; i += 1) sim.step(ae); // list, GUIDE.md and the three entity reads
    expect(sim.attempt(ae)?.opCount ?? 0).toBe(0);

    const rescale = sim.open("rescale-energy");
    drive(sim, rescale);
    sim.land();
    expect(sim.state(rescale)).toBe("landed");

    const sent = sentTo(sim, ae);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.result).toBe("info");
    expect(sent[0]?.keys).toEqual([{ kind: "entity", key: ENERGY_KEY, rule: "X0", cause_seq: 1 }]);

    sim.release(ae);
    sim.settle();
    expect(sim.state(ae)).toBe("landed");
    expect(sim.files().get("creatures/s-0.js")).toContain("creature.energy < 0.3");
    expect(sw2Escapes(sim.files())).toEqual([]);
  });

  it("10.3 (D2, SW2): a rescale after the landing repairs the stranded threshold, no heads-up", () => {
    // The plain sequential case: the creature lands first and parks `creature.energy < 30`
    // under ENERGY_MAX = 100. A rescale that starts afterwards finds the module in the
    // `relied_on_by` list of its own `replace` result (D2) — no heads-up is sent — reads its
    // `update` entity and lands the file with `0.3 x new V`.
    const sim = new SwarmSim(swarmFiles(), { seed: 7 });
    const ae = sim.open("add-energy");
    drive(sim, ae);
    sim.land();
    expect(sim.state(ae)).toBe("landed");
    expect(sim.files().get("creatures/s-0.js")).toContain("creature.energy < 30");

    const rescale = sim.open("rescale-energy");
    drive(sim, rescale);
    sim.land();
    expect(sim.state(rescale)).toBe("landed");
    expect(sentTo(sim, ae)).toEqual([]);

    expect(sim.files().get("world/energy.js")).toContain("ENERGY_MAX = 1");
    expect(sim.files().get("creatures/s-0.js")).toContain("creature.energy < 0.3");
    expect(sw2Escapes(sim.files())).toEqual([]);
  });

  it("10.3 (D2, SW2): a rescale repairs every absolute referrer and leaves the relative one alone", () => {
    // Two landed `add-energy` creatures hold `creature.energy < 30`; the landed
    // `add-relative` holds `creature.energy < ENERGY_MAX * 0.3`. The rescale lands
    // ENERGY_MAX = 1 and rewrites only the numbered lines: both absolutes become 0.3 and
    // the relative one is untouched.
    const sim = new SwarmSim(swarmFiles(), { seed: 7 });
    const first = sim.open("add-energy");
    drive(sim, first);
    sim.land();
    const second = sim.open("add-energy");
    drive(sim, second);
    sim.land();
    const rel = sim.open("add-relative");
    drive(sim, rel);
    sim.land();
    expect(sim.files().get("creatures/s-0.js")).toContain("creature.energy < 30");
    expect(sim.files().get("creatures/s-1.js")).toContain("creature.energy < 30");

    const rescale = sim.open("rescale-energy");
    drive(sim, rescale);
    sim.land();
    expect(sim.state(rescale)).toBe("landed");

    expect(sim.files().get("creatures/s-0.js")).toContain("creature.energy < 0.3");
    expect(sim.files().get("creatures/s-1.js")).toContain("creature.energy < 0.3");
    expect(sim.files().get("creatures/s-2.js")).toContain("creature.energy < ENERGY_MAX * 0.3");
    expect(sw2Escapes(sim.files())).toEqual([]);
  });

  it("10.4 (dial 0): 16 concurrent add-plain agents each write their own name — no name race, no go-around", () => {
    // The soak failure this amendment removes: concurrent adders listed `creatures/` and all
    // chose the same next free number, so one write landed and the rest went around. At dial
    // 0 (all agents independent) 10.4's go-around rate is 0 — every agent lands its own
    // `s-<id>` name and the listing premise's gains are held silently (L3).
    const sim = new SwarmSim(swarmFiles(), { seed: 7 });
    const agents = Array.from({ length: 16 }, () => sim.open("add-plain"));
    sim.settle();
    const paths: string[] = [];
    for (const [i, agent] of agents.entries()) {
      expect(sim.state(agent)).toBe("landed");
      expect(sentTo(sim, agent)).toEqual([]);
      expect(sim.attempt(agent)?.go_arounds ?? 0).toBe(0);
      // `a_<i>` -> `creatures/s-<i>.js`, worked from the rule and the harness's own ids (BP1).
      const files = [...(sim.landingOf(agent)?.files.keys() ?? [])].filter((p) => p.startsWith("creatures/"));
      expect(files).toEqual([`creatures/s-${i}.js`]);
      paths.push(files[0] as string);
    }
    expect(new Set(paths).size).toBe(agents.length);
  });
});
