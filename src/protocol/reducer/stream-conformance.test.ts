// Protocol conformance of every fixture stream (01-core 12.1, 12.2, 9.2; 03-floor 8.2/8.3).
//
// For every file of test/fixtures/streams/ and every event in it, this checks what a test
// can check of "the event satisfies the protocol's type for its `type`": the set of keys is
// exactly the set 12.1 names for that type (none missing, none extra), the `src` is the one
// EV2a gives to the type, and every `attempt.state.transition` is an id of the table of 9.2
// whose `from` and `to` rows match the event. It also checks the guarantees a stream owes:
// EV1 (n is contiguous from 1), EV3 (a batch's landing.accepted precedes the events the
// batch caused, and landing.landed/batch.pushed follow their landing.accepted) and the
// 9.2-path clause of EV3 (one attempt's attempt.state events chain: the first leaves
// `opened` and each next one starts where the last ended). RY11/FE1: an event whose `type`
// is not in the table is legal — the page ignores it — but it still carries the envelope.
//
// Every table below is written by hand from docs/spec/01-core.md (BP1): the allowed keys,
// the sources and the transitions are read from the specification's text, never from the
// fixtures under test and never from src/protocol/events.ts, so a mistake in either shows
// up here as a failure rather than passing silently in both places.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const STREAMS = join(__dirname, "../../../test/fixtures/streams");
const FILES = readdirSync(STREAMS)
  .filter((name) => name.endsWith(".ndjson"))
  .sort();

type StreamEvent = Record<string, unknown> & { n: number; type: string };

function eventsOf(name: string): { header: Record<string, unknown>; events: StreamEvent[] } {
  const lines = readFileSync(join(STREAMS, name), "utf8")
    .split("\n")
    .filter((line) => line !== "");
  const header = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
  const events = lines.slice(1).map((line) => JSON.parse(line) as StreamEvent);
  return { header, events };
}

// ---------------------------------------------------------------------------
// 12.1: the envelope, then the body keys each event type names.
// ---------------------------------------------------------------------------

const ENVELOPE_KEYS = ["n", "t", "ts", "pool", "src", "type"];

/** The body keys 12.1 names for each event type — the full set, not a subset. */
const BODY_KEYS: Record<string, string[]> = {
  "pool.state": [
    "head_seq",
    "head_commit",
    "green_seq",
    "landed_seq",
    "landed_commit",
    "state",
    "reason",
    "epoch",
    "remote",
    "plain_remote",
    "rebuild",
    "unwitnessed",
    "real_agents",
    "max_real_agents",
    "synthetic",
    "summary_only",
  ],
  "pool.files": ["files"],
  "pool.paused": ["reason", "detail"],
  "trunk.error": ["where", "code"],
  "intent.created": ["intent_id", "text", "requester", "race", "prewritten"],
  "intent.state": ["intent_id", "state"],
  "attempt.opened": ["attempt_id", "intent_id", "change_id", "agent", "model", "race"],
  "attempt.state": [
    "attempt_id",
    "from",
    "to",
    "transition",
    "reason",
    "go_arounds",
    "pull_backs",
    "right_of_way",
  ],
  "attempt.reopened": ["attempt_id", "cause", "revision", "model_changed"],
  "attempt.step": [
    "attempt_id",
    "step",
    "tool",
    "target",
    "ok",
    "error",
    "ms",
    "tokens_in",
    "tokens_out",
    "cost_usd",
  ],
  "attempt.repo": ["attempt_id", "ok", "ms", "error"],
  "premise.recorded": ["attempt_id", "premise", "tool"],
  "premise.removed": ["attempt_id", "kind", "key", "rule"],
  "premise.judged": [
    "attempt_id",
    "kind",
    "key",
    "old_hash",
    "new_hash",
    "cause",
    "cause_seq",
    "rule",
    "class",
    "result",
    "reason",
    "clef",
  ],
  "op.recorded": ["attempt_id", "op_seq", "op", "path", "targets", "altered", "added", "removed"],
  "op.dropped": ["attempt_id", "op_seqs", "path", "rule"],
  "headsup.sent": [
    "attempt_id",
    "hn",
    "result",
    "wake",
    "cause",
    "keys",
    "items",
    "dropped_ops",
    "go_around",
  ],
  "headsup.resolved": ["attempt_id", "hn", "result", "go_around", "changed", "statement"],
  "submit.result": ["attempt_id", "submit_id", "status", "tier", "checks", "duplicate"],
  "card.opened": ["card"],
  "card.updated": ["card"],
  "card.closed": ["card_id", "action", "by", "attempt_id", "reason"],
  "landing.accepted": [
    "seq",
    "batch_id",
    "kind",
    "attempt_id",
    "change_id",
    "intent_id",
    "request_id",
    "paths",
    "writes",
  ],
  "landing.landed": ["seq", "batch_id", "commit", "tree", "note", "note_json", "time_to_land_ms"],
  "batch.pushed": ["batch_id", "first_seq", "last_seq", "main", "notes", "tries", "ms"],
  "push.retry": ["batch_id", "tries", "error", "next_try_ms"],
  "tick.skipped": ["attempt_id", "why", "behind"],
  "undo.planned": ["request_id", "cause", "target_seq", "reverted", "reopened", "kept_readers"],
  "undo.refused": ["request_id", "target_seq", "reason"],
  "plain.updated": ["commit", "tree", "through_seq", "skipped", "interrupted"],
  "green.verified": ["seq", "commit", "ok", "runtime", "checks", "ms", "confirmed"],
  "green.advanced": ["seq", "commit"],
  metrics: [
    "window_ms",
    "landings_per_second",
    "time_to_land_ms",
    "time_held_ms",
    "go_around_rate",
    "false_abort_rate",
    "escape_rate",
    "waiting_behind",
    "push_backlog",
    "tick_cpu_ms",
  ],
  limits: ["spend_usd", "reserved_usd", "cap_usd", "killed", "refusing", "models"],
  "swarm.state": ["synthetic", "running", "agents", "collision_dial", "pools"],
};

/** EV2a (12.2): every type not named here is the pool's Trunk's — src "trunk". */
const EVENT_SRC: Record<string, string> = {
  "attempt.step": "agent", // model turns, tokens, cost — what only the Agent knows
  "attempt.repo": "agent", // the Agent's repo
  limits: "gate", // the model gate, sent to every registered pool
  "swarm.state": "swarm", // the Swarm launcher, sent to every registered pool
  metrics: "floor", // appended by the Floor Durable Object to its own stream
};

/** The five legal envelope sources (EV2a). */
const SOURCES = ["trunk", "agent", "gate", "swarm", "floor"];

// ---------------------------------------------------------------------------
// 9.2: the transition table — `from` rows, then the states each row may end in.
// "same as above" in the spec is resolved; "unchanged" means `to` equals `from`.
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<string, { from: string[]; to: string[] | "unchanged" }> = {
  T1: { from: ["opened"], to: ["working"] },
  T2: { from: ["working", "going_around", "needs_confirm"], to: ["validated"] },
  T3: { from: ["working", "going_around", "needs_confirm"], to: ["submitted"] },
  T4: { from: ["working", "going_around", "needs_confirm"], to: ["held"] },
  T5: { from: ["working", "going_around", "needs_confirm"], to: ["needs_confirm"] },
  T6: { from: ["working", "going_around", "needs_confirm"], to: ["going_around"] },
  T7: { from: ["working", "going_around", "needs_confirm"], to: "unchanged" },
  T8: { from: ["working", "needs_confirm", "submitted", "validated", "held"], to: ["going_around"] },
  T9: { from: ["working", "needs_confirm", "submitted", "validated", "held", "going_around"], to: ["stopped"] },
  T9c: { from: ["working", "needs_confirm", "submitted", "validated", "held", "going_around"], to: ["stopped"] },
  T10: { from: ["going_around"], to: ["going_around"] },
  T10a: { from: ["going_around"], to: ["going_around"] },
  T11: { from: ["submitted", "validated", "held"], to: ["needs_confirm"] },
  T11s: { from: ["submitted", "validated", "held"], to: ["stopped"] },
  T12: { from: ["submitted"], to: ["validated", "held"] },
  T13: { from: ["held"], to: ["validated"] },
  T14: { from: ["held"], to: ["stopped"] },
  T15: { from: ["validated"], to: ["accepted"] },
  T16: { from: ["accepted"], to: ["landed"] },
  T17: { from: ["accepted"], to: ["going_around"] },
  T17a: { from: ["accepted"], to: ["landed"] },
  T18: { from: ["landed"], to: ["stopped"] },
  T19: { from: ["landed"], to: ["going_around"] },
  T19s: { from: ["landed"], to: ["stopped"] },
  T20: {
    from: ["opened", "working", "going_around", "needs_confirm", "submitted", "validated", "held"],
    to: ["stopped"],
  },
  T20r: { from: ["going_around", "needs_confirm", "working"], to: ["stopped"] },
  T21: { from: ["stopped"], to: ["going_around", "needs_confirm", "working"] },
  T22: { from: ["submitted", "validated", "held"], to: ["working"] },
};

/** EV3's order for the events a batch causes (12.2), as ranks. */
const CAUSED_RANK: Record<string, number> = {
  "tick.skipped": 0,
  "premise.judged": 1,
  "premise.removed": 2,
  "op.dropped": 3,
  "headsup.sent": 4,
  "attempt.state": 5,
  "card.opened": 6,
  "card.updated": 6,
  "card.closed": 6,
};

/** Events an undo/revert landing itself writes in its transaction (UN5a, GR3, RS1):
 * they are part of the acceptance record, not the classification list of EV3. */
const LANDING_TXN = new Set(["attempt.state", "attempt.reopened", "intent.state"]);

describe("fixture stream conformance (01-core 12.1, EV2a, EV3, 9.2)", () => {
  it.each(FILES)("%s: envelope, exact key set, EV2a source, valid transitions and order", (name) => {
    const { header, events } = eventsOf(name);

    // 12.3: the header says how many events follow; EV1: n is contiguous from 1.
    expect(header.premise_replay).toBe(2);
    expect(header.events).toBe(events.length);

    for (const [index, event] of events.entries()) {
      const label = `${name} event ${index + 1} (${String(event.type)})`;

      // Envelope: n is the 1-based position; every envelope key is present.
      expect(event.n, label).toBe(index + 1);
      for (const key of ENVELOPE_KEYS) expect(event, `${label}: missing envelope key ${key}`).toHaveProperty(key);
      expect(SOURCES, `${label}: illegal src ${String(event.src)}`).toContain(event.src);
      expect(event.pool, `${label}: pool disagrees with the header`).toBe(header.pool);

      // 12.1: the body keys are exactly the set the type names — none missing, none extra.
      const allowed = BODY_KEYS[event.type];
      if (allowed === undefined) {
        // RY11/FE1: a type the table does not know is ignored by the page; it still carries
        // the envelope, and nothing else is required of it.
        continue;
      }
      const body = Object.keys(event).filter((key) => !ENVELOPE_KEYS.includes(key));
      expect([...body].sort(), `${label}: body keys`).toEqual([...allowed].sort());
      expect(event.src, `${label}: src`).toBe(EVENT_SRC[event.type] ?? "trunk");

      // 9.2: the transition id exists and its from/to match the row.
      if (event.type === "attempt.state") {
        const row = TRANSITIONS[event.transition as string];
        expect(row, `${label}: ${String(event.transition)} is not an id of 9.2`).toBeDefined();
        if (row !== undefined) {
          expect(row.from, `${label}: ${String(event.transition)} does not go from ${String(event.from)}`).toContain(
            event.from,
          );
          if (row.to === "unchanged") {
            expect(event.to, `${label}: ${String(event.transition)} leaves the state unchanged`).toBe(event.from);
          } else {
            expect(row.to, `${label}: ${String(event.transition)} does not go to ${String(event.to)}`).toContain(
              event.to,
            );
          }
        }
      }
    }

    // EV3 last clause: one attempt's attempt.state events form a valid path through 9.2 —
    // the first leaves `opened` and each next one starts where the previous one ended.
    const paths = new Map<string, StreamEvent[]>();
    for (const event of events) {
      if (event.type !== "attempt.state") continue;
      const id = event.attempt_id as string;
      if (!paths.has(id)) paths.set(id, []);
      paths.get(id)!.push(event);
    }
    for (const [attemptId, states] of paths) {
      expect(states[0]?.from, `${name} ${attemptId}: the first transition leaves 'opened'`).toBe("opened");
      for (const [i, prev] of states.entries()) {
        const next = states[i + 1];
        if (next === undefined) break;
        expect(
          next.from,
          `${name} ${attemptId}: event ${next.n} starts from ${String(next.from)} but event ${prev.n} left ${String(
            prev.to,
          )}`,
        ).toBe(prev.to);
      }
    }

    // EV3: all landing.accepted of a batch come before the events the batch caused;
    // landing.landed and batch.pushed come later and always after the matching
    // landing.accepted. Events the undo/revert landing writes in its own transaction
    // (the target's T18 or a dependent's T19/reopen, the undone intent) are part of the
    // acceptance record; the classification effects of EV3's list follow them in the
    // order EV3 names.
    const acceptedBySeq = new Map<number, number>();
    const acceptedByBatch = new Map<number, number>();
    const plannedRequest = new Map<string, number>();
    events.forEach((event, i) => {
      if (event.type === "undo.planned") plannedRequest.set(event.request_id as string, i);
      if (event.type === "landing.accepted") {
        acceptedBySeq.set(event.seq as number, i);
        acceptedByBatch.set(event.batch_id as number, i);
      }
    });

    // Windows: a batch's caused events sit between its (last) landing.accepted and its
    // landing.landed; events outside a window are not the batch's. For each window, the
    // caused events must appear in the order EV3 names them — the landing's own
    // transaction events (LANDING_TXN) travel with the acceptance and stay out of the rank.
    const windows: Array<{ start: number; end: number; batch: number }> = [];
    events.forEach((event, i) => {
      if (event.type !== "landing.accepted") return;
      const batch = event.batch_id as number;
      if (windows.length > 0 && windows[windows.length - 1]!.batch === batch) {
        windows[windows.length - 1]!.start = i; // all landing.accepted of the batch come first
        return;
      }
      const landedIdx = events.findIndex(
        (x, j) => j > i && x.type === "landing.landed" && x.batch_id === batch,
      );
      windows.push({ start: i, end: landedIdx === -1 ? events.length : landedIdx, batch });
    });
    for (const { start, end, batch } of windows) {
      let lastRank = -1;
      for (let i = start + 1; i < end; i += 1) {
        const event = events[i]!;
        if (!(event.type in CAUSED_RANK) || LANDING_TXN.has(event.type)) continue;
        const rank = CAUSED_RANK[event.type]!;
        expect(
          rank >= lastRank,
          `${name} event ${event.n}: ${event.type} breaks EV3's order inside batch ${batch}`,
        ).toBe(true);
        lastRank = rank;
      }
    }

    events.forEach((event, i) => {
      if (event.type === "landing.landed" || event.type === "batch.pushed") {
        const accepted = acceptedByBatch.get(event.batch_id as number);
        expect(accepted, `${name} event ${event.n}: ${event.type} has no landing.accepted`).toBeDefined();
        expect(i, `${name} event ${event.n}: ${event.type} precedes its landing.accepted`).toBeGreaterThan(
          accepted ?? -1,
        );
      }
      if (event.type === "landing.accepted") {
        // EM4: an undo/revert landing carries the request_id of an earlier undo.planned.
        if (event.kind === "undo" || event.kind === "revert") {
          const plan = plannedRequest.get(event.request_id as string);
          expect(plan, `${name} event ${event.n}: no undo.planned ${String(event.request_id)}`).toBeDefined();
          // The plan's side effects must not precede the acceptance: nothing but another
          // plan or pool bookkeeping may sit between undo.planned and its landing.
          for (let j = (plan ?? i) + 1; j < i; j += 1) {
            const mid = events[j]!;
            expect(
              ["undo.planned", "undo.refused", "pool.state", "pool.files", "pool.paused", "trunk.error"].includes(
                mid.type,
              ),
              `${name} event ${mid.n}: ${mid.type} of the undo's effects precedes its landing.accepted (EV3)`,
            ).toBe(true);
          }
        }
      }
      // Attributed effects follow the landing they point at: premise.judged.cause_seq and
      // headsup.sent.cause.seqs name the landing that caused them (EV3, EV4).
      if (event.type === "premise.judged" && typeof event.cause_seq === "number") {
        const accepted = acceptedBySeq.get(event.cause_seq);
        if (accepted !== undefined) {
          expect(
            i,
            `${name} event ${event.n}: premise.judged for seq ${event.cause_seq} precedes its landing.accepted`,
          ).toBeGreaterThan(accepted);
        }
      }
      if (event.type === "headsup.sent") {
        const seqs = (event.cause as { seqs?: number[] } | undefined)?.seqs ?? [];
        for (const seq of seqs) {
          const accepted = acceptedBySeq.get(seq);
          if (accepted !== undefined) {
            expect(
              i,
              `${name} event ${event.n}: headsup.sent caused by seq ${seq} precedes its landing.accepted`,
            ).toBeGreaterThan(accepted);
          }
        }
      }
    });
  });
});
