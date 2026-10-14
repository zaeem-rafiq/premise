// The behavior of one pool frame, without a DOM (docs/spec/03-floor.md 3.5, CO20 to CO23, FR20,
// FR28; docs/spec/02-tidepool.md 4.5; Replay RY17). The component feeds it `postMessage` payloads
// and `load` events and hands it timers; the driver answers with page addresses to load and
// `FloorToPool` messages to post. Everything here is testable with a fake scheduler.

import { versionToken } from "../../../protocol/cards.ts";
import type { FloorToPool, PoolToFloor } from "../../../protocol/channel.ts";
import {
  FRAME_ADVANCE_DEBOUNCE_MS,
  FRAME_ADVANCE_TIMEOUT_MS,
  FRAME_LOAD_TIMEOUT_MS,
  FRAME_PROBE_RETRY_MS,
  HOST_SEED,
  OFFLINE_AFTER_MS,
  POOL_STALL_MS,
} from "../../../protocol/constants.ts";
import type { CopyVars } from "../../../copy/fill.ts";
import { landingLabel } from "../../../copy/format.ts";
import { commitSrc, liveSrc, stallFallback } from "./frame-plan.ts";
import type { StalledId } from "./frame-plan.ts";

export type FrameStats = Extract<PoolToFloor, { type: "stats" }>;

/** `loading`: the iframe has not finished a page load yet (or has no src). `live`: running and
 * answering. `error`: the page did not load in FRAME_LOAD_TIMEOUT_MS or reported an error (FR20).
 * `stalled`: it kept not answering after the FR28 fallback (no silent wait, FL10). */
export type FramePhase = "loading" | "live" | "error" | "stalled";

export type TimerKey = "load" | "stall" | "probe" | "probe-retry" | "advance" | "advance-wait" | "kind";

/** What the driver reads each time the Floor state changes. All of it comes from `FloorState`,
 * already reduced — the frame never learns a pool fact from anywhere else (FL1). */
export type DriverTarget = {
  /** `pool.landed_commit`: the commit `main` resolves to now; in Replay, the position's commit. */
  landedCommit: string | null;
  /** `green.commit`: the fallback source a stalled main frame may switch to (FR28). */
  greenCommit: string | null;
  /** `green.seq`: the landing seq of that green commit, for `frame.stalled.green`. */
  greenSeq: number | null;
  /** `state.pool.state !== "unknown"` — the stream's first `pool.state` has named the pool's
   * kind (IR12). `false` holds the first live load: a pool made from a repository has no live
   * picture, so a speculative `/pool/{pool}/main/` request must not go out while the kind is
   * undecided. The hold lapses at the page's own lost-connection window (OFFLINE_AFTER_MS),
   * so a pool whose stream is slow or down still shows its frame. Absent means decided —
   * feeds with no stream question (unit tests, a card's commit frame) load at once. */
  poolKnown?: boolean;
};

/** The wall between the driver and the DOM. The component implements it with the iframe's
 * `contentWindow`, `window.setTimeout` and React state; a test implements it with arrays. */
export type DriverSink = {
  /** Load the iframe at `src` (a page address of the app server, AS7). A new call is a reload. */
  load(src: string): void;
  /** Post a validated `FloorToPool` message to the frame's `contentWindow` (CO22). */
  post(message: FloorToPool): void;
  /** Fire `onTimer(key)` after `ms`; a repeat of the same key replaces the pending one. */
  schedule(key: TimerKey, ms: number): void;
  cancel(key: TimerKey): void;
  /** Driver-visible state changed; the component re-reads it and re-renders. */
  changed(): void;
};

export type DriverOptions = {
  /** The main pool this frame belongs to — the `{pool}` of every `/pool/{pool}/…` address (FE7). */
  pool: string;
  /** Live follows the moving source and gets `probe`; Replay follows fixed commits and gets
   * `advance` (SE16a, AC23). */
  mode: "live" | "replay";
  /** `main` is the live pool frame of 3.5; `other` is every other frame (FR28's second rule). */
  kind?: "main" | "other";
  /** The world seed of the pool page (HOST_SEED unless a caller overrides it — Compare keeps one
   * seed for both frames, CO24a). */
  seed?: number;
};

export class FrameDriver {
  phase: FramePhase = "loading";
  /** The FR28 caption while on a fallback (`frame.stalled.*`), or null. Stays until `reload()`. */
  stalledCaption: { id: StalledId; vars: CopyVars } | null = null;
  /** The version token this frame is being asked to reach (`c-<commit>`), or null when current. */
  expecting: string | null = null;
  /** The newest validated `stats` (CO22), kept for the self-test badge (CO25a). */
  lastStats: FrameStats | null = null;
  /** The comparison base of the loaded page address — no `paused` page parameter, so a pause
   * toggle never reads as a new address. "" before the first load. */
  base = "";

  private readonly sink: DriverSink;
  private readonly opts: Required<DriverOptions>;
  private target: DriverTarget = { landedCommit: null, greenCommit: null, greenSeq: null };
  private stalls = 0;
  private onGreen = false;
  private probeRetried = false;
  private lastStatsVersion: string | null = null;
  private userPaused = false;
  private visible = true;
  /** What the frame was last told (`pause`/`resume`), so transitions post once (CO23a). */
  private announced = false;
  private highlight: string[] = [];
  private highlightSent = false;
  /** CO23b: `highlight` is posted only while the prop is given — an empty list when the panel
   * closes, nothing at all when the caller never passes the prop. */
  private highlightGiven = false;
  private wantSelftest = false;
  private askedSelftest: string | null = null;

  constructor(sink: DriverSink, opts: DriverOptions) {
    this.sink = sink;
    this.opts = { kind: "main", seed: HOST_SEED, ...opts };
  }

  /** A frame counts paused when the owner paused it or it is off-screen (AS14). */
  private effectivePaused(): boolean {
    return this.userPaused || !this.visible;
  }

  private fullSrc(base: string): string {
    return this.effectivePaused() ? `${base}&paused=1` : base;
  }

  private liveBase(): string {
    return liveSrc(this.opts.pool, this.onGreen ? "green" : "main", this.opts.seed);
  }

  private commitBase(commit: string): string {
    return commitSrc(this.opts.pool, { repo: "main", commit }, this.opts.seed);
  }

  private loadNow(base: string): void {
    this.base = base;
    this.phase = "loading";
    this.lastStatsVersion = null;
    this.lastStats = null;
    this.highlightSent = false;
    this.askedSelftest = null;
    // The `paused` page parameter already tells the host (AC11): the first stats does not
    // need a `pause` post for a state the page address announced.
    this.announced = this.effectivePaused();
    this.sink.cancel("kind");
    this.sink.cancel("stall");
    this.sink.schedule("load", FRAME_LOAD_TIMEOUT_MS);
    this.sink.load(this.fullSrc(base));
    this.sink.changed();
  }

  /** A `landing.landed` moved the frame: the probe/advance follows the debounce of CO21/RY17. */
  private expectVersion(commit: string, timer: "probe" | "advance"): void {
    this.expecting = versionToken({ repo: "main", commit });
    this.probeRetried = false;
    this.sink.schedule(timer, FRAME_ADVANCE_DEBOUNCE_MS);
  }

  /** Feed the reduced state. Call it whenever `FloorState` changes — it is idempotent: nothing
   * here moves on `landing.accepted` alone (AC3/FL3), only on `landed_commit`/`green.commit`. */
  setTarget(target: DriverTarget): void {
    if (this.opts.mode === "live" && this.base === "" && target.poolKnown === false) {
      // IR12: the pool's kind is undecided — hold the first live load. The `kind` timer
      // lapses the wait at OFFLINE_AFTER_MS, so a page whose stream never answers still
      // gets its live picture (the promise the immediate load made).
      this.sink.schedule("kind", OFFLINE_AFTER_MS);
      return;
    }
    const prev = this.target;
    this.target = target;
    if (this.opts.mode === "replay") {
      if (target.landedCommit !== null && target.landedCommit !== prev.landedCommit) {
        if (this.base === "") {
          // First paint of the replay position: load straight at the commit, no advance needed.
          this.loadNow(this.commitBase(target.landedCommit));
        } else {
          this.expectVersion(target.landedCommit, "advance");
        }
      }
      return;
    }
    if (this.onGreen) {
      // A frame on green gets probe when `green.advanced` arrives (FR28's by-itself column).
      if (target.greenCommit !== null && target.greenCommit !== prev.greenCommit) {
        this.expectVersion(target.greenCommit, "probe");
      }
    } else if (target.landedCommit !== null && target.landedCommit !== prev.landedCommit) {
      this.expectVersion(target.landedCommit, "probe");
    }
    const base = this.liveBase();
    if (base !== this.base) this.loadNow(base);
  }

  /** The iframe's `load` event: a document arrived — which is not yet the pool page (FR20).
   * An error document, an aborted navigation's error page or a server's fallback fires `load`
   * just the same, so `load` alone cannot make the frame live: the first `stats` message can.
   * The `load` timer keeps running; a document that never speaks hits `error` (FR20/RY22). */
  onLoad(): void {}

  /** The iframe's `error` event — FR20's "reports an error" half of the load failure. */
  onLoadError(): void {
    if (this.phase === "loading") {
      this.phase = "error";
      this.sink.cancel("load");
      this.sink.changed();
    }
  }

  /** A validated `stats` message (parse with `parsePoolMessage` first). Keeps the version
   * expectation of CO21/RY17, re-posts the highlight of CO23b on a fresh page, and resets the
   * FR28 stall watch. */
  onStats(stats: FrameStats): void {
    this.lastStatsVersion = stats.version;
    this.lastStats = stats;
    if (this.phase === "loading" || this.phase === "error" || this.phase === "stalled") {
      this.phase = "live";
      this.sink.cancel("load");
    }
    // FR28 (amended 2026-10-14): once the frame loaded again on `main` answers, it is healthy, so
    // `frame.stalled.reloaded` leaves the caption. A frame on `green` keeps its chip: it still
    // shows the last verified version, not `main`.
    if (this.stalledCaption?.id === "frame.stalled.reloaded") this.stalledCaption = null;
    this.askSelftest(stats);
    if (this.expecting !== null && stats.version === this.expecting) {
      this.expecting = null;
      this.probeRetried = false;
      this.sink.cancel("advance-wait");
    } else if (this.expecting !== null && this.opts.mode === "live" && !this.probeRetried) {
      // CO21: the answer named an older version — one more probe, once.
      this.probeRetried = true;
      this.sink.schedule("probe-retry", FRAME_PROBE_RETRY_MS);
    }
    if (!this.highlightSent && this.highlightGiven) {
      this.sink.post({ type: "highlight", kinds: [...this.highlight] });
      this.highlightSent = true;
    }
    this.syncPausePost();
    this.armStall();
    this.sink.changed();
  }

  /** A timer the sink armed fired. */
  onTimer(key: TimerKey): void {
    switch (key) {
      case "load":
        if (this.phase === "loading") {
          this.phase = "error";
          this.sink.changed();
        }
        break;
      case "kind":
        // The kind wait outlived the lost-connection window without a `pool.state`:
        // load the live picture anyway — the stream may be down, and its pool then
        // still gets its frame.
        if (this.base === "") this.loadNow(this.liveBase());
        break;
      case "stall":
        if (this.phase === "live" && !this.effectivePaused()) this.applyStall();
        break;
      case "probe":
      case "probe-retry":
        // AC23/RY17: a Replay frame is never sent probe; the mode guard is here, not in callers.
        if (this.opts.mode === "live") this.sink.post({ type: "probe" });
        break;
      case "advance":
        if (this.opts.mode === "replay" && this.expecting !== null) {
          this.sink.post({ type: "advance", version: this.expecting });
          this.sink.schedule("advance-wait", FRAME_ADVANCE_TIMEOUT_MS);
        }
        break;
      case "advance-wait":
        // RY17: `advance` went unanswered — load the frame again at the commit address.
        if (
          this.opts.mode === "replay" &&
          this.expecting !== null &&
          this.lastStatsVersion !== this.expecting &&
          this.target.landedCommit !== null
        ) {
          this.loadNow(this.commitBase(this.target.landedCommit));
        }
        break;
    }
  }

  private applyStall(): void {
    const decision = stallFallback({
      kind: this.opts.kind,
      replay: this.opts.mode === "replay",
      stalls: this.stalls,
      greenCommit: this.target.greenCommit,
    });
    this.stalls += 1;
    switch (decision.action) {
      case "reload":
        this.onGreen = decision.onGreen;
        this.stalledCaption =
          decision.caption === "frame.stalled.green"
            ? { id: "frame.stalled.green", vars: { landing: landingLabel(this.target.greenSeq ?? 0) } }
            : { id: decision.caption, vars: {} };
        this.loadNow(this.liveBase());
        break;
      case "reload-silent":
        this.loadNow(this.base);
        break;
      case "hold":
        this.phase = "stalled";
        this.stalledCaption = { id: "frame.stalled", vars: {} };
        this.sink.changed();
        break;
    }
  }

  /** The pool pause/play control and key P (ViewState.pool_paused): held while the frame keeps
   * its last picture (CO23a). The driver posts on transitions only and uses the `paused` page
   * parameter on the next (re)load. */
  setUserPaused(paused: boolean): void {
    if (this.userPaused === paused) return;
    this.userPaused = paused;
    this.syncPause();
    this.sink.changed();
  }

  /** AS14: a frame that is not visible is paused. */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.syncPause();
  }

  /** Pause arrives by `postMessage` on a live frame and by the `paused` page parameter on a
   * load (6.4, AC11). A pause while a load is in flight waits for that page's first `stats`,
   * which posts it (`onStats` -> `syncPausePost`): restarting the load cost the viewer a second
   * load of "Loading the pool…" (seen on `test`, 2026-10-10, about 12 s). */
  private syncPause(): void {
    this.syncPausePost();
    this.armStall();
  }

  /** CO25a: the badge asks each frame to run its self-test — `probe` with `selftest` — once per
   * version the frame reports, until that version's `stats.selftest` arrives. With `on` false
   * nothing is posted (the Floor view's main frame shows no badge). */
  setSelftest(on: boolean): void {
    this.wantSelftest = on;
    if (on && this.lastStats !== null) this.askSelftest(this.lastStats);
  }

  private askSelftest(stats: FrameStats): void {
    if (!this.wantSelftest || this.phase !== "live") return;
    if (stats.selftest !== null && stats.selftest.version === stats.version) return;
    if (this.askedSelftest === stats.version) return;
    this.askedSelftest = stats.version;
    this.sink.post({ type: "probe", selftest: true });
  }

  /** The FR28 watch: armed while the frame is live, visible and not paused — the only state in
   * which "sent no stats for POOL_STALL_MS" means stalled. Re-armed on every stats. */
  private armStall(): void {
    this.sink.cancel("stall");
    if (this.phase === "live" && !this.effectivePaused()) {
      this.sink.schedule("stall", POOL_STALL_MS);
    }
  }

  private syncPausePost(): void {
    const want = this.effectivePaused();
    if (this.phase !== "live" || want === this.announced) return;
    this.announced = want;
    this.sink.post({ type: want ? "pause" : "resume" });
  }

  /** CO23b: outline the creatures of `kinds` (already filtered by `highlightKinds`). The host
   * forgets the set on each page load, so it is posted again on the first stats of a new page. */
  setHighlight(kinds: readonly string[], given = true): void {
    const changed = kinds.length !== this.highlight.length || kinds.some((k, i) => k !== this.highlight[i]);
    this.highlight = [...kinds];
    this.highlightGiven = given;
    this.highlightSent = false;
    if (changed && given && this.phase === "live") {
      this.sink.post({ type: "highlight", kinds: [...this.highlight] });
      this.highlightSent = true;
    }
  }

  /** `frame.reload` (FR20, FR28): back to `main` in live mode, back to the position's commit in
   * Replay. Clears the stall bookkeeping — this is a fresh start, not another fallback. */
  reload(): void {
    this.stalls = 0;
    this.onGreen = false;
    this.stalledCaption = null;
    this.expecting = null;
    this.probeRetried = false;
    const commit = this.target.landedCommit;
    this.loadNow(this.opts.mode === "replay" && commit !== null ? this.commitBase(commit) : this.liveBase());
  }

  /** Let every pending timer go. Called on unmount. */
  dispose(): void {
    const keys: TimerKey[] = ["load", "stall", "probe", "probe-retry", "advance", "advance-wait", "kind"];
    for (const key of keys) this.sink.cancel(key);
  }
}
