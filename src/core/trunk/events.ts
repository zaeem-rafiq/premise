// src/core/trunk/events.ts — the `events_out` append path (01-core.md 12). Every state change
// the engine makes emits a `PoolEvent` of `src: "trunk"`, numbered `next_event_n` with no gaps.
// For the case driver the trace keeps just the type names; the rows keep the full body.

import type { Pool } from "./sets.ts";
import { metaSet } from "./schema.ts";

/**
 * Append one event: numbered `next_event_n`, clock from `pool.now()`, and persisted immediately
 * inside the call's transaction. `fields` is the type's body without the envelope keys.
 */
export function event(
  pool: Pool,
  type: string,
  fields: Record<string, unknown>,
  opts: { headsup?: boolean } = {},
): void {
  // EV3: the candidate classification of a tick runs before the batch commits, but its events
  // order after every `landing.accepted` — the tick buffers them and flushes at the commit.
  if (pool.eventBuffer !== null) {
    pool.eventBuffer.push({ type, fields, opts });
    return;
  }
  if (pool.meta.get("summary_only") === "1") {
    // EV6: the detailed per-op, per-premise and per-step events are not emitted on a
    // summary-only stream; a `premise.judged` of `holds` emits only when a heads-up item
    // carries it (X0's info, a triage outcome's item); `headsup.sent` and `landing.landed`
    // lose their detail bodies while the rest of the event stands.
    if (type === "attempt.step" || type === "premise.recorded" || type === "premise.removed" || type === "op.recorded")
      return;
    if (type === "premise.judged" && fields.result === "holds" && opts.headsup !== true) return;
    if (type === "headsup.sent") fields = { ...fields, items: null };
    else if (type === "landing.landed") fields = { ...fields, note_json: null };
  }
  const n = pool.eventCounter;
  pool.eventCounter += 1;
  pool.meta.set("next_event_n", String(pool.eventCounter));
  const body = {
    n,
    t: pool.now(),
    ts: pool.now(),
    pool: pool.meta.get("pool_id") ?? "",
    src: "trunk",
    type,
    ...fields,
  };
  pool.sql.exec("INSERT INTO events_out (n, ts, body, sent) VALUES (?, ?, ?, 0)", n, pool.now(), JSON.stringify(body));
  pool.out.events.push(type);
}

/** Drain the buffer the tick opened: every buffered event, in the order it was produced. */
export function flushEvents(pool: Pool): void {
  const buf = pool.eventBuffer;
  pool.eventBuffer = null;
  if (buf === null) return;
  for (const e of buf) event(pool, e.type, e.fields, e.opts);
}

export function metaWrite(pool: Pool, k: string, v: string | number | null): void {
  pool.meta.set(k, v === null ? "" : String(v));
  metaSet(pool.sql, k, v);
}

// ---------------------------------------------------------------------------
// EM1/EM1a: `pool.state` and `pool.files`, the stream's first two events and the pair re-emitted
// whenever one of their fields changes (EM1) or when the visible tree or the synthetic flag does.

import { MAX_REAL_AGENTS } from "../../protocol/constants.ts";
import { policyOf, changeTier } from "../policy/policy.ts";
import type { FileMap } from "./sets.ts";

/** `pool.files`' rows at `files`: every path with its tier under the tree's own policy (EM1). */
export function poolFileRows(files: FileMap): Array<{ path: string; tier: "auto" | "held" }> {
  const policy = policyOf(files.get(".premise/policy.json") ?? null);
  return [...files.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((path) => ({ path, tier: changeTier(policy, [path]) }));
}

/** The `pool.state` body of the pool's `meta` (EM1): every field the Floor and the app server read. */
export function poolStateBody(pool: Pool): Record<string, unknown> {
  const meta = pool.meta;
  const num = (k: string): number => Number(meta.get(k) ?? "0");
  return {
    head_seq: num("head_seq"),
    head_commit: meta.get("head_commit") ?? "",
    green_seq: num("green_seq"),
    landed_seq: num("landed_seq"),
    landed_commit: meta.get("landed_commit") ?? "",
    state: meta.get("pool_state") ?? "ready",
    reason: meta.get("pause_reason") === undefined || meta.get("pause_reason") === "" ? null : meta.get("pause_reason"),
    epoch: num("epoch"),
    remote: meta.get("remote") ?? "",
    plain_remote:
      meta.get("plain_remote") === undefined || meta.get("plain_remote") === "" ? null : meta.get("plain_remote"),
    rebuild: (() => {
      // RB3: the running job's cursor carries {done,total}; absent, no job runs.
      const raw = meta.get("rebuild_cursor");
      if (raw === undefined || raw === "") return null;
      try {
        const c = JSON.parse(raw) as { done?: unknown; total?: unknown };
        return { done: Number(c.done ?? 0), total: Number(c.total ?? 0) };
      } catch {
        return null;
      }
    })(),
    unwitnessed: (() => {
      const raw = meta.get("unwitnessed");
      if (raw === undefined || raw === "") return [];
      try {
        return (JSON.parse(raw) as unknown[]).map((s) => Number(s));
      } catch {
        return [];
      }
    })(),
    real_agents: num("real_agents"),
    max_real_agents: MAX_REAL_AGENTS,
    synthetic: meta.get("synthetic") === "1",
    summary_only: meta.get("summary_only") === "1",
  };
}

/** EM1: emit `pool.state` now (its `ts` is the pool's clock, like every trunk event). */
export function emitPoolState(pool: Pool): void {
  event(pool, "pool.state", poolStateBody(pool));
}

/** EM1: emit `pool.files` with the head tree's rows. */
export function emitPoolFiles(pool: Pool): void {
  event(pool, "pool.files", { files: poolFileRows(pool.files) });
}
