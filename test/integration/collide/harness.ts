// The Node driver the collision tests use (04-build-plan.md 2.3 item 4): the real `Trunk`
// engine over `node:sqlite` — the same seam `test/cases/driver.ts` uses, no Durable Object
// and no network — on a pool seeded with the files of `tidepool-swarm`. Each scripted agent
// opens a synthetic attempt with its pattern's truth list (TR8); `step` drives the pattern
// exactly the way `src/worker/agent/agent-do.ts` `#run` drives a `PatternDriver`, part by
// part:
//
//   - `delivered` mirrors the Agent's `shown_hn` (HE1): the highest heads-up number the
//     driver's context has carried; every tool call sends it as `ack` (HU6a/TA3).
//   - `inbox` mirrors the Agent's inbox table (`inbox.receive` of worker/agent/inbox.ts):
//     heads-up bodies pushed after a commit (HU5b) or carried on a response (TA8),
//     de-duplicated by `hn`.
//   - the wake check mirrors `#run` lines 444–467: only a contiguous `inboxNext` run that
//     holds a `wake` heads-up is shown before the next decision — as a message carrying
//     `heads_ups` and `raw_heads_ups` and no result, exactly `#showHeadsUps`'s
//     `driver_last`. A `wake:false` heads-up (every `info`, 8.1) is NOT shown: it stays
//     in the inbox and arrives with the next tool response (HE2).
//   - the call mirrors `#toolCall`: `call_id` counts transcript steps, `ack` is shown_hn,
//     and a `submit` gains the `acknowledge` list of `#submitArgs` (confirm/repair hns
//     shown but not yet resolved by an earlier submit — `inbox.acknowledge`, TL10 —
//     with TD6's `statement` fallback "not affected").
//   - the response path mirrors `#applyToolResponse`: `response.heads_ups` are received
//     into the inbox, the contiguous unshown run (whatever its wake flags) is marked
//     shown and attached to `last` as `{ heads_ups, raw_heads_ups, result|error }` —
//     which is how a `heads_up_first` refusal (TA3, the write/replace/submit refused
//     without being recorded) reaches the pattern together with the heads-ups that
//     caused it. `heads_ups_more`, `attempt_closed`, `attempt_unknown` and terminal
//     answers set the sync flag; a submit answered with a non-final status advances
//     `acked_hn` and prunes the inbox (TL10).
//   - `sync` mirrors `#sync`: it runs only where the Agent runs it — the `syncNeeded`
//     flag or an inbox gap (HU6a) — never before a step for fresh heads-ups.
//   - `stop` mirrors `#sendStop` (TA9/TL16); `land` mirrors HU5b: after the accept
//     transaction commits, every heads-up Trunk recorded for an attempt is pushed into
//     that agent's inbox, and a `wake` one is what would start its `#run` (HE2).
//   - `pattern.next` sees `heads_ups: last.raw_heads_ups` and costs one `rand` draw for
//     SW6's think_ms wait when heads-ups are present, like `PatternDriver.#next`.
//
// Not mirrored — this sim has no durable store, no clock and no remote: the journal's
// resend path (AG4) and `register` after a rebuild (the engine keeps the attempt), the
// timers, `pending_stop`, the budget checks, and `resume_show` (RS2 — `pause`/`resume`
// here are test controls that hold the pump, not the protocol resume of a stopped
// attempt). The terminal check reads the pool directly where the Agent would converge
// after one doomed call and a sync.

import { DatabaseSync } from "node:sqlite";
import type { AttemptState } from "../../../src/protocol/attempt.ts";
import type { HeadsUp } from "../../../src/protocol/headsup.ts";
import type { ModelToolMessage, ToolRequest, ToolResponse } from "../../../src/protocol/tools.ts";
import { Trunk, type Pool } from "../../../src/core/trunk/registry.ts";
import { inboxNext } from "../../../src/core/agent/inbox.ts";
import { scriptedHeadsUpForModel } from "../../../src/worker/agent/scripted-driver.ts";
import { sqlOver } from "../../cases/driver.ts";
import { patternById, type Pattern } from "../../../src/swarm/pattern.ts";
import { agentRandom } from "../../../src/swarm/prng.ts";
import type { Landing } from "../../../src/core/trunk/sets.ts";
import type { Note } from "../../../src/protocol/note.ts";
import { buildSeeds } from "../../../scripts/seeds/build.ts";
import { ScriptedTriage } from "../../../src/swarm/scripted-triage.ts";

/** `TERMINAL_STATES` of agent-do.ts (the mirror `state` check) plus `FINAL_FOR_ACK`. */
const TERMINAL = new Set<AttemptState>(["landed", "stopped"]);
const FINAL_FOR_ACK = new Set(["accepted", "landed", "stopped", "rejected"]);

/** The files of the seed `tidepool-swarm` (scripts/seeds/build.ts, 02-tidepool.md 10.1). */
export function swarmFiles(): Record<string, string> {
  const tree = buildSeeds().get("tidepool-swarm");
  if (tree === undefined) throw new Error("buildSeeds: no tidepool-swarm seed");
  return Object.fromEntries(tree);
}

/** The files of the stored seed `tidepool` (world/*.js is not auto there: the held tier shows). */
export function tidepoolFiles(): Record<string, string> {
  const tree = buildSeeds().get("tidepool");
  if (tree === undefined) throw new Error("buildSeeds: no tidepool seed");
  return Object.fromEntries(tree);
}

/** The files of the generated seed `tidepool-auto` (02-tidepool.md 6: `world/*.js` is auto). */
export function tidepoolAutoFiles(): Record<string, string> {
  const tree = buildSeeds().get("tidepool-auto");
  if (tree === undefined) throw new Error("buildSeeds: no tidepool-auto seed");
  return Object.fromEntries(tree);
}

export type AgentHandle = {
  id: string;
  pattern: Pattern;
  n: number; // its position in the cast (SW1: `agentRandom(seed, n)`)
  hold: boolean;
  released: boolean;
  /** `shown_hn` (HE1): the highest heads-up hn the driver's context has carried — the
   * `ack` the next tool call sends (HU6a/TA3). */
  delivered: number;
  /** `acked_hn` (TL10): the `ack` of the last submit Trunk answered with a non-final state. */
  ackedHn: number;
  /** The `state` mirror (MIR1): what the Agent last learned from a response or a sync. */
  mirror: AttemptState;
  /** The Agent-side inbox: heads-up bodies pushed after a commit (HU5b) or carried on a
   * response (TA8), de-duplicated by hn like `inboxPut`. */
  inbox: Map<number, HeadsUp>;
  /** `sync_needed` (4.10): set by `heads_ups_more`, `attempt_closed` and terminal answers. */
  syncNeeded: boolean;
  /** The transcript-step counter `call_id` counts (shows and tool rows both count, TA2). */
  txStep: number;
  state: unknown;
  /** `driver_last` (agent-do.ts): the model message plus the raw heads-ups a `Pattern` reads. */
  last: (ModelToolMessage & { raw_heads_ups?: HeadsUp[] }) | null;
  rand: () => number; // the agent's draw stream (SW1), opened once at `open`
  calls: number;
  done: boolean;
  paused: boolean;
};

export class SwarmSim {
  readonly trunk: Trunk;
  readonly db: DatabaseSync;
  readonly agents: AgentHandle[] = [];
  private readonly seed: number;

  constructor(
    files: Record<string, string>,
    opts: { seed: number; summary_only?: boolean; synthetic?: boolean; features_held?: boolean },
  ) {
    this.db = new DatabaseSync(":memory:");
    this.trunk = Trunk.create(sqlOver(this.db), files, {
      summary_only: opts.summary_only === true,
      synthetic: opts.synthetic === true,
      features: { held: opts.features_held === true },
      // S6a/TR8: the pool's `SyncTriage` port is the one scripted implementation; every agent
      // the harness opens is synthetic, so its truth list answers the triage rows.
      syncTriage: ScriptedTriage,
    });
    // PL1: the seed is batch 0 of the outbox and nothing lands before it is on Artifacts. This
    // harness has no remote, so it confirms the seed push here, as `test/cases/driver.ts` does.
    this.trunk.pushOk();
    this.seed = opts.seed;
  }

  /** Open a synthetic attempt for a pattern (SWR2: agent n is entry n of the cast, unless
   * `opts.n` overrides the draw position — two entries with the same `n` share one stream,
   * which is how a `same-file` pair draws the same name).
   * A pattern whose truth list depends on its draws (`retune`, `edit-creature`, `same-file`)
   * names it through `truthOf` on a fresh stream at the same positions (SW1). */
  open(patternOrId: string | Pattern, opts: { hold?: boolean; n?: number } = {}): AgentHandle {
    const pattern = typeof patternOrId === "string" ? patternById(patternOrId) : patternOrId;
    if (pattern === undefined) throw new Error(`unknown pattern ${patternOrId}`);
    const n = opts.n ?? this.agents.length;
    const id = `a_${this.agents.length}`;
    this.trunk.openAttempt(id, {
      intent: pattern.intent,
      agent_kind: "synthetic",
      truth: [...(pattern.truthOf?.(agentRandom(this.seed, n)) ?? pattern.truth)],
      model: null,
    });
    const agent: AgentHandle = {
      id,
      pattern,
      n,
      hold: opts.hold ?? false,
      released: false,
      delivered: 0,
      ackedHn: 0,
      mirror: "opened",
      inbox: new Map(),
      syncNeeded: false,
      txStep: 0,
      state: null,
      last: null,
      rand: agentRandom(this.seed, n),
      calls: 0,
      done: false,
      paused: false,
    };
    this.agents.push(agent);
    return agent;
  }

  /** `inbox.receive`: pushed and response-carried heads-up bodies, de-duplicated by hn. */
  private receiveAll(agent: AgentHandle, heads_ups: readonly HeadsUp[]): void {
    for (const hu of heads_ups) {
      if (!agent.inbox.has(hu.hn)) agent.inbox.set(hu.hn, hu);
    }
  }

  /** HU5b: after a commit the heads-ups Trunk recorded for an attempt are pushed to its
   * Agent — here: copied into the per-agent inbox, deduped by hn. Called wherever a Trunk
   * call could have committed heads-up rows for another attempt (`land`, a tool call). */
  private pushAll(): void {
    for (const agent of this.agents) {
      const a = this.trunk.pool.attempts.get(agent.id);
      if (a === undefined) continue;
      for (const h of a.heads) {
        if (!agent.inbox.has(h.hn)) agent.inbox.set(h.hn, h.body);
      }
    }
  }

  /** `#showHeadsUps`: the whole contiguous run is shown — `delivered` advances to its top
   * and `last` becomes a heads_ups-only message (SP5, HE1). */
  private showHeadsUps(agent: AgentHandle, hns: number[]): void {
    const raw = hns.map((hn) => agent.inbox.get(hn) as HeadsUp);
    agent.txStep += 1;
    agent.delivered = Math.max(...hns);
    agent.last = { heads_ups: raw.map(scriptedHeadsUpForModel), raw_heads_ups: raw };
  }

  /** `#sync` (4.10): receives the gap-fill heads-ups and the attempt's real state; the
   * flag stays up while the response says more heads-ups are still owed. */
  private syncNow(agent: AgentHandle): void {
    const res = this.trunk.sync({ attempt_id: agent.id, ack: agent.delivered }) as
      | { ok: true; heads_ups?: HeadsUp[]; heads_ups_more?: boolean; attempt?: { state: AttemptState } }
      | { ok: false; error: string };
    if (res.ok === true) {
      this.receiveAll(agent, res.heads_ups ?? []);
      if (res.attempt !== undefined) agent.mirror = res.attempt.state;
      if (res.heads_ups_more !== true) agent.syncNeeded = false;
      return;
    }
    // A real Agent retries on a timer and converges on the pool's state through a later
    // response; in this harness the attempt is one field away.
    agent.syncNeeded = false;
    agent.mirror = this.trunk.pool.attempts.get(agent.id)?.state ?? agent.mirror;
  }

  /** `#submitArgs` + `inbox.acknowledge` (TL10): every confirm/repair hn shown but not
   * yet resolved by an earlier submit is acknowledged; TD6's statement fallback applies. */
  private submitArgs(agent: AgentHandle, args: object): object {
    const acknowledge = [...agent.inbox.values()]
      .filter((hu) => hu.hn <= agent.delivered && hu.hn > agent.ackedHn && hu.result !== "info")
      .map((hu) => hu.hn)
      .sort((a, b) => a - b);
    if (acknowledge.length === 0) return args;
    const given = args as { statement?: string };
    return { ...args, acknowledge, statement: given.statement ?? "not affected" };
  }

  /** `#applyToolResponse` (AG1/TA8/HE1): response-carried heads-ups go into the inbox, the
   * contiguous unshown run is marked shown and rides on `last` beside the result or the
   * error (TA3's `heads_up_first` carries the heads-ups that caused it), the mirror and
   * the sync flag move, and a non-final submit answer advances `acked_hn` and prunes the
   * inbox (TL10). */
  private applyToolResponse(agent: AgentHandle, req: ToolRequest, resp: ToolResponse): void {
    this.receiveAll(agent, resp.heads_ups ?? []);
    const run = inboxNext(agent.delivered, [...agent.inbox.keys()]).show;
    const raw = run.map((hn) => agent.inbox.get(hn) as HeadsUp);
    const msg: ModelToolMessage & { raw_heads_ups?: HeadsUp[] } = {};
    if (raw.length > 0) {
      msg.heads_ups = raw.map(scriptedHeadsUpForModel);
      msg.raw_heads_ups = raw;
    }
    if (resp.ok) {
      if (resp.result !== undefined) msg.result = resp.result;
    } else {
      msg.error = resp.error ?? { code: "timeout", message: "no response" };
    }
    agent.txStep += 1;
    if (run.length > 0) agent.delivered = run[run.length - 1] ?? agent.delivered;
    agent.mirror = resp.attempt.state;
    if (resp.heads_ups_more === true) agent.syncNeeded = true;
    if (resp.error?.code === "attempt_closed" || TERMINAL.has(resp.attempt.state)) agent.syncNeeded = true;
    if (resp.error?.code === "attempt_unknown") agent.syncNeeded = true;
    if (req.tool === "submit" && resp.ok) {
      const r = resp.result as { status?: string; duplicate?: true } | undefined;
      if (r?.status !== undefined && !FINAL_FOR_ACK.has(r.status) && r.duplicate !== true) {
        agent.ackedHn = req.ack; // TL10
        // inbox.prune: resolved rows below acked_hn and shown `info` rows go.
        for (const [hn, hu] of [...agent.inbox]) {
          if (hn <= agent.ackedHn || (hn <= agent.delivered && hu.result === "info")) {
            agent.inbox.delete(hn);
          }
        }
      }
    }
    agent.last = msg;
  }

  /** `#sendStop` (TA9/TL16): an answered or forgotten stop marks the mirror; an
   * `attempt_closed` answer learns the real state through a sync. */
  private sendStop(agent: AgentHandle, reason: string): void {
    const res = this.trunk.stop({ attempt_id: agent.id, reason }) as
      { ok: true; stop_reason: string; attempt?: { state: AttemptState } } | { ok: false; error: string };
    if (res.ok === true || (res as { error?: string }).error === "attempt_unknown") {
      agent.mirror = "stopped";
      return;
    }
    if ((res as { error?: string }).error === "attempt_closed") {
      agent.syncNeeded = true;
      this.syncNow(agent);
    }
  }

  /**
   * One turn of one scripted agent — `#run` pumped until it sends a tool call or a stop,
   * the driver decides `wait`, or the attempt is terminal. True when a call or a stop
   * was sent. Shows, syncs and refused calls happen inside the pump where the Agent
   * does them, so one `step` is the span between two sent tool calls.
   */
  step(agent: AgentHandle): boolean {
    if (agent.done || agent.paused) return false;
    for (;;) {
      const a = this.trunk.pool.attempts.get(agent.id);
      if (a === undefined) {
        agent.done = true;
        return false;
      }
      // The TERMINAL_STATES check of #run line 426 reads the Agent's mirror; the pool's
      // `accepted` means the attempt is in the outbox — the pattern has nothing left to do.
      if (TERMINAL.has(agent.mirror) || a.state === "accepted" || TERMINAL.has(a.state)) {
        agent.mirror = a.state;
        agent.done = true;
        return false;
      }
      if (agent.syncNeeded) {
        this.syncNow(agent);
        continue;
      }
      const next = inboxNext(agent.delivered, [...agent.inbox.keys()]);
      if (next.sync) {
        this.syncNow(agent);
        continue;
      }
      // HE2: only a run holding a `wake` heads-up is shown before the next decision; a
      // `wake:false` (`info`) stays in the inbox and arrives with the next response.
      const run = next.show.filter((hn) => agent.inbox.get(hn)?.wake === true);
      if (run.length > 0) {
        this.showHeadsUps(agent, next.show);
        continue;
      }
      const rawHu = agent.last?.raw_heads_ups ?? [];
      // PatternDriver.#next: SW6's think_ms costs one draw on the agent's stream.
      if (rawHu.length > 0) agent.rand();
      const decision = agent.pattern.next({
        last: agent.last,
        heads_ups: rawHu,
        hold: agent.hold,
        released: agent.released,
        attempt_id: agent.id,
        state: agent.state,
        rand: agent.rand,
      });
      // The state and the consumed `last` move together (agent-do.ts lines 488-491).
      agent.state = decision.state;
      agent.last = null;
      if (decision.kind === "wait") return false;
      if (decision.kind === "stop") {
        this.sendStop(agent, decision.reason);
        agent.done = true;
        this.pushAll();
        return true;
      }
      agent.calls += 1;
      const req: ToolRequest = {
        attempt_id: agent.id,
        call_id: `${agent.id}:${agent.txStep + 1}`,
        ack: agent.delivered,
        tool: decision.tool,
        args: (decision.tool === "submit"
          ? this.submitArgs(agent, decision.args as object)
          : decision.args) as ToolRequest["args"],
      };
      const resp = this.trunk.tool(req);
      this.applyToolResponse(agent, req, resp);
      this.pushAll();
      return true;
    }
  }

  /** One turn of every live agent, in cast order. True when any tool call or stop was sent. */
  stepAll(): boolean {
    let made = false;
    for (const agent of this.agents) made = this.step(agent) || made;
    return made;
  }

  /** The engine's accept transaction: validated candidates land, heads-ups go out (9.4) —
   * and HU5b pushes them into each agent's inbox after the commit. */
  land(): Pool["out"] {
    this.trunk.tick();
    const out = this.trunk.out;
    this.trunk.pushOk();
    this.pushAll();
    return out;
  }

  /** Alternates `stepAll` and `land` until nothing moves (bounded). */
  settle(rounds = 60): void {
    for (let i = 0; i < rounds; i += 1) {
      const made = this.stepAll();
      const out = this.land();
      if (!made && out.landings.length === 0 && out.heads_ups.length === 0) return;
    }
    throw new Error("settle: the swarm did not come to rest");
  }

  /** SWR3's `/release`: the flag is read live at the next turn (PatternDriver). */
  release(agent: AgentHandle): void {
    agent.released = true;
  }

  /** The owner's tap on the attempt's open card (CD4): `land`, `land_now`, `decline`, and on
   * a card already closed as `stale` the same call does nothing. */
  tap(agent: AgentHandle, option: string): Record<string, unknown> {
    const out = this.trunk.owner({ action: option, attempt: agent.id });
    this.pushAll();
    return out;
  }

  /** The attempt's open card body, or `undefined` when it holds none. */
  cardOf(agent: AgentHandle): Record<string, unknown> | undefined {
    const c = this.trunk.pool.cards.find((x) => x.open && x.attempt_ids.includes(agent.id));
    return c === undefined ? undefined : (c.body as Record<string, unknown>);
  }

  pause(agent: AgentHandle): void {
    agent.paused = true;
  }

  resume(agent: AgentHandle): void {
    agent.paused = false;
  }

  /** Every event the engine emitted so far, as parsed `events_out` bodies, in order. */
  events(): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT body FROM events_out ORDER BY n")
      .all()
      .map((row) => JSON.parse((row as { body: string }).body) as Record<string, unknown>);
  }

  eventsOf(type: string): Array<Record<string, unknown>> {
    return this.events().filter((e) => e.type === type);
  }

  /** The heads-ups the engine recorded for `agent`, raw `HeadsUp` bodies in `hn` order. */
  headsUps(agent: AgentHandle): HeadsUp[] {
    return (this.trunk.pool.attempts.get(agent.id)?.heads ?? []).map((h) => h.body);
  }

  state(agent: AgentHandle): string | undefined {
    return this.trunk.pool.attempts.get(agent.id)?.state;
  }

  attempt(agent: AgentHandle) {
    return this.trunk.pool.attempts.get(agent.id);
  }

  files(): ReadonlyMap<string, string> {
    return this.trunk.pool.files;
  }

  /** The landing an attempt produced, or undefined while it is in flight. */
  landingOf(agent: AgentHandle): Landing | undefined {
    return this.trunk.pool.landings.find((l) => l.attempt_id === agent.id);
  }

  /** The parsed note of the attempt's landing (3.5), or undefined. */
  noteOf(agent: AgentHandle): Note | undefined {
    const l = this.landingOf(agent);
    return l === undefined ? undefined : (JSON.parse(l.note) as Note);
  }

  /** The parsed note of a landing, or undefined. */
  note(seq: number): Record<string, unknown> | undefined {
    const l = this.trunk.pool.landings.find((x) => x.seq === seq);
    return l === undefined ? undefined : (JSON.parse(l.note) as Record<string, unknown>);
  }
}
