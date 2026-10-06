// The pure decisions of a pool frame (docs/spec/03-floor.md 3.5, docs/spec/02-tidepool.md 4.2 and
// 4.5): which page address the frame loads, which version token counts it as current, which copy
// id each state shows and which channel message a mode allows. Nothing here touches the DOM,
// the clock or the network; the DOM-facing half is frame-driver.ts and pool-frame.tsx.

import { frameUrl, versionToken } from "../../../protocol/cards.ts";
import type { FrameAddress } from "../../../protocol/cards.ts";
import type { PoolToFloor } from "../../../protocol/channel.ts";
import { HOST_SEED } from "../../../protocol/constants.ts";
import type { FloorState } from "../../../protocol/reducer/index.ts";
import type { CopyVars } from "../../../copy/fill.ts";
import { landingLabel } from "../../../copy/format.ts";

/** A moving page source of the app server (02-tidepool 4.2 `PoolSource`). `green` exists only as
 * the FR28 fallback of a stalled main frame; `plain` is the plain-merge repository's head. */
export type LiveSource = "main" | "plain" | "green";

/** The page address of a live frame on a moving source (02-tidepool 4.2, AS12). `seed` is the
 * deterministic world seed the pool must boot with; `paused` asks the host to hold the pool
 * paused from load (host page parameters, AS7). */
export function liveSrc(pool: string, source: LiveSource, seed: number = HOST_SEED, paused = false): string {
  return `/pool/${pool}/${source}/?seed=${seed}${paused ? "&paused=1" : ""}`;
}

/** The page address of a commit frame: a fixed PoolSource address from `frameUrl` (PV5), so it
 * can never move under the reader. Commit frames never take `follow`: the Floor drives them by
 * `advance` (RY17). */
export function commitSrc(pool: string, address: FrameAddress, seed: number = HOST_SEED, paused = false): string {
  return `${frameUrl(pool, address)}?seed=${seed}${paused ? "&paused=1" : ""}`;
}

/** 8.6 row 1: in Replay the main frame shows "the commit of the newest `landing.landed` at the
 * position" — exactly `state.pool.landed_commit`, which the reducer already holds at the seed
 * commit of the first `pool.state` before any landing. Null before the stream has started. */
export function mainReplayAddress(state: FloorState): FrameAddress | null {
  const commit = state.pool.landed_commit;
  return commit === null ? null : { repo: "main", commit };
}

/** CO23 with FL3/AC3: landings `landing.accepted` but not yet `landing.landed`. They show
 * `frame.landing` on the caption bar and move nothing — not the counter, not the frame. */
export function landingPending(state: FloorState): number {
  let n = 0;
  for (const seq of state.landed_order) {
    const entry = state.landings[seq];
    if (entry !== undefined && entry.digest !== true && entry.landed === null) n += 1;
  }
  return n;
}

/** CO21: the `stats.version` the main frame must report before it counts as current after a
 * landing — `c-<landed_commit>` (PV5's token shape, via `versionToken`). */
export function expectedVersion(state: FloorState): string | null {
  const commit = state.pool.landed_commit;
  return commit === null ? null : versionToken({ repo: "main", commit });
}

/** The version the plain-merge frame must report — `p-<plain.commit>` — used by Compare (CO24)
 * and by `plain.updated` probes. */
export function plainVersion(state: FloorState): string | null {
  return state.plain === null ? null : versionToken({ repo: "plain", commit: state.plain.commit });
}

export type CaptionCall = { readonly id: string; readonly vars: CopyVars };

/** The caption of the main pool frame (3.5): live names the landed seq; before any landing it is
 * `frame.main.seed`. While the pool's kind is undecided — no `pool.state` yet (IR12) — it is the
 * neutral `frame.loading`, not a seed caption the pool may never own (a repository pool's caption
 * is `frame.no_app`, and the pool-area swaps to it when `app` reads null). In Replay the frame is
 * recorded code (RY21). `frame.replay`'s `{landing}` has no seed variant in the copy, so seq 0 is
 * filled with "the seed" (see report). */
export function mainCaption(state: FloorState, mode: "live" | "replay"): CaptionCall {
  const seq = state.pool.landed_seq;
  if (mode === "replay") {
    return { id: "frame.replay", vars: { landing: seq === 0 ? "the seed" : landingLabel(seq) } };
  }
  if (state.pool.state === "unknown") return { id: "frame.loading", vars: {} };
  return seq === 0
    ? { id: "frame.main.seed", vars: {} }
    : { id: "frame.main.caption", vars: { landing: landingLabel(seq) } };
}

export type StalledId = "frame.stalled.green" | "frame.stalled.reloaded" | "frame.stalled";

export type StallDecision =
  | { action: "reload"; onGreen: boolean; caption: "frame.stalled.green" | "frame.stalled.reloaded" }
  | { action: "reload-silent" } // a non-main frame's first stall: reload once at its own address
  | { action: "hold"; caption: "frame.stalled" };

/** FR28: what a stall does. The live pool frame falls back to `green` when a verified commit
 * exists (caption `frame.stalled.green`), else reloads `main` once (`frame.stalled.reloaded`);
 * a second stall only shows `frame.stalled`. Every other frame — the plain-merge frame, a
 * card's commit frame, a Replay frame — reloads once at its own address, then `frame.stalled`. */
export function stallFallback(opts: {
  kind: "main" | "other";
  replay: boolean;
  /** stalls this frame already went through (0 = the first). */
  stalls: number;
  greenCommit: string | null;
}): StallDecision {
  if (opts.kind === "main" && !opts.replay && opts.stalls === 0) {
    return opts.greenCommit !== null
      ? { action: "reload", onGreen: true, caption: "frame.stalled.green" }
      : { action: "reload", onGreen: false, caption: "frame.stalled.reloaded" };
  }
  if (opts.stalls === 0) return { action: "reload-silent" };
  return { action: "hold", caption: "frame.stalled" };
}

/** FR20 and RY22: the copy id of a frame that cannot be served. A commit frame in Replay names
 * `frame.replay_gone`; anything else `frame.error`. */
export function loadFailureId(mode: "live" | "replay"): "frame.error" | "frame.replay_gone" {
  return mode === "replay" ? "frame.replay_gone" : "frame.error";
}

/** SE16a and AC23: the "find the newest version" message a mode allows. Live frames get `probe`;
 * commit frames get `advance` — a Replay frame is never sent `probe` (RY17). */
export function moveMessage(mode: "live" | "replay"): "probe" | "advance" {
  return mode === "replay" ? "advance" : "probe";
}

/** The attributes of the one iframe a pool frame mounts (CO20/SE16a): `sandbox="allow-scripts"`
 * and no other token — the pool's own code runs, nothing else is trusted. `title` is the frame's
 * accessible name (AX7): `frame.main.title` for the main frame. */
export function iframeAttrs(src: string, title: string): { src: string; sandbox: "allow-scripts"; title: string } {
  return { src, sandbox: "allow-scripts", title };
}

/** HO15: a kind name the pool host accepts (`[a-z][a-z0-9-]{0,30}`, never "constructor"). The
 * Floor validates before posting `highlight`, so a bad kind name in state cannot produce a
 * message the host must refuse. */
export function isKindName(name: unknown): name is string {
  return typeof name === "string" && name !== "constructor" && /^[a-z][a-z0-9-]{0,30}$/.test(name);
}

/** Kinds worth posting in `highlight` (CO23b): valid names only, duplicates kept out. */
export function highlightKinds(kinds: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const kind of kinds) {
    if (isKindName(kind) && !out.includes(kind)) out.push(kind);
  }
  return out;
}

// ---- CO22/SE16: what the Floor accepts from a frame. `event.source` is checked by the caller;
// here the message's own shape is validated field by field. Every string stays text.

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isKindStats(
  value: unknown,
): value is Record<string, { count: number; resting: number; errors: number; benched: boolean }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  for (const entry of Object.values(value)) {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    if (!isNumber(e.count) || !isNumber(e.resting) || !isNumber(e.errors) || typeof e.benched !== "boolean") {
      return false;
    }
  }
  return true;
}

function isSwap(value: unknown): value is { mode: "adopt" | "restart"; arrived: string[]; failed: string[] } | null {
  if (value === null) return true;
  if (typeof value !== "object" || value === null) return false;
  const swap = value as Record<string, unknown>;
  return (
    (swap.mode === "adopt" || swap.mode === "restart") &&
    Array.isArray(swap.arrived) &&
    swap.arrived.every((v) => typeof v === "string") &&
    Array.isArray(swap.failed) &&
    swap.failed.every((v) => typeof v === "string")
  );
}

function isSelftest(
  value: unknown,
): value is { version: string; ok: boolean; failed: Array<{ name: string; kind: string | null }> } | null {
  if (value === null) return true;
  if (typeof value !== "object" || value === null) return false;
  const selftest = value as Record<string, unknown>;
  return (
    typeof selftest.version === "string" &&
    typeof selftest.ok === "boolean" &&
    Array.isArray(selftest.failed) &&
    selftest.failed.every((f) => {
      if (typeof f !== "object" || f === null) return false;
      const item = f as Record<string, unknown>;
      return typeof item.name === "string" && (item.kind === null || typeof item.kind === "string");
    })
  );
}

/** Validate a `postMessage` payload into `PoolToFloor` (CO22). Returns null for anything that is
 * not exactly a `tapped` or `stats` message of the channel's shape — the Floor drops it. */
export function parsePoolMessage(data: unknown): PoolToFloor | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.type === "tapped") {
    return typeof m.creature === "string" && typeof m.path === "string"
      ? { type: "tapped", creature: m.creature, path: m.path }
      : null;
  }
  if (m.type !== "stats") return null;
  if (
    typeof m.source === "string" &&
    typeof m.version === "string" &&
    (m.seq === null || isNumber(m.seq)) &&
    isNumber(m.tick) &&
    typeof m.paused === "boolean" &&
    isKindStats(m.kinds) &&
    isNumber(m.shown) &&
    isNumber(m.total) &&
    isSwap(m.swap) &&
    isSelftest(m.selftest)
  ) {
    return {
      type: "stats",
      source: m.source,
      version: m.version,
      seq: m.seq,
      tick: m.tick,
      paused: m.paused,
      kinds: m.kinds,
      shown: m.shown,
      total: m.total,
      swap: m.swap,
      selftest: m.selftest,
    };
  }
  return null;
}
