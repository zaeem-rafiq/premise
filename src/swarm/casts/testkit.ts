// A tiny synchronous driver for unit tests of the canned casts (02-tidepool.md 10.5): it
// keeps the pattern's state between turns and answers each step by hand, so a test can check
// the canned calls word for word and feed a heads-up at any point — the way `SwarmSim` does,
// without the engine.

import type { HeadsUp, HeadsUpItem } from "../../protocol/headsup.ts";
import type { ModelToolMessage } from "../../protocol/tools.ts";
import type { Pattern, PatternStep } from "../pattern.ts";

export type Bag = { state: unknown; calls: Array<{ tool: string; args: Record<string, unknown> }> };

export function bag(): Bag {
  return { state: null, calls: [] };
}

/** One turn: `last` answers the previous call, `hus` are the heads-ups since. */
export function step(
  pattern: Pattern,
  b: Bag,
  last: ModelToolMessage | null,
  hus: HeadsUp[] = [],
  flags: { hold?: boolean; released?: boolean } = {},
): PatternStep {
  const out = pattern.next({
    last,
    heads_ups: hus,
    hold: flags.hold ?? false,
    released: flags.released ?? false,
    state: b.state,
    rand: () => 0,
  });
  b.state = out.state;
  if (out.kind === "tool") b.calls.push({ tool: out.tool, args: out.args as Record<string, unknown> });
  return out;
}

/** `ok` answers a tool call; `err` refuses it. */
export function ok(result: object = {}): ModelToolMessage {
  return { result };
}
export function err(code: string): ModelToolMessage {
  return { error: { code, message: code } };
}

/** A heads-up item with only the fields a cast reads filled in. `rule` is the decision-table
 * row the engine judged (`QR1`, `L1`, `QT1`, `E2`, …): a cast repairs only on its row. */
export function item(
  premise: HeadsUpItem["premise"],
  diff: HeadsUpItem["diff"],
  result: HeadsUpItem["result"] = "repair",
  rule = "X",
): HeadsUpItem {
  return {
    premise,
    rule,
    result,
    reason: "r",
    old_hash: "o",
    new_hash: "n",
    cause_seq: 1,
    diff,
    uses: [],
  };
}

/** A whole heads-up. */
export function hu(
  hn: number,
  result: HeadsUp["result"],
  items: HeadsUpItem[],
  dropped: HeadsUp["dropped_ops"] = [],
): HeadsUp {
  return {
    hn,
    attempt_id: "a1",
    result,
    wake: result !== "info",
    cause: { type: "landing", seqs: [1], changes: [] },
    items,
    dropped_ops: dropped,
    go_around: null,
    head_seq: hn,
    created_at: 0,
  };
}

/** The entity diff of a `repair` heads-up (E2/QR1). */
export function entityDiff(before: string | null, after: string | null): HeadsUpItem["diff"] {
  return { kind: "entity", before, after };
}

/** The file diff of an X0/F4 `info` or F3 `repair` item. */
export function fileDiff(unified: string, changed: string[] = []): HeadsUpItem["diff"] {
  return { kind: "file", before_oid: "b", after_oid: "a", unified, changed_entities: changed };
}

/** The listing diff of an L1/L2/L3 item. */
export function listingDiff(added: string[] = [], removed: string[] = []): HeadsUpItem["diff"] {
  return { kind: "listing", added, removed };
}

/** The query diff of a QT1 item. */
export function queryDiff(
  added: Array<{ key: string; source: string | null }>,
  context: Array<{ key: string; source: string }> = [],
): HeadsUpItem["diff"] {
  return { kind: "query", added, removed: [], context };
}

/** Run a pattern through canned results until it waits or stops; returns the last step. */
export function drain(
  pattern: Pattern,
  b: Bag,
  results: ModelToolMessage[] = [],
  flags: { hold?: boolean; released?: boolean } = {},
  cap = 40,
): PatternStep {
  let out: PatternStep = step(pattern, b, null, [], flags);
  for (let i = 0; i < cap && out.kind === "tool"; i += 1) {
    out = step(pattern, b, results[i] ?? ok(), [], flags);
  }
  return out;
}
