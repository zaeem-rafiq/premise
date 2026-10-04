// The behavior of the plain-merge pool frame, without a DOM (docs/spec/03-floor.md 3.6,
// CO24/CO24a; docs/spec/01-core.md PM6 and SE16a; Replay 8.6). It is the live-frame driver of
// 3.5 specialized to the `plain` source: the page address is `/pool/{pool}/plain/`, the version
// it waits on is `p-<plain.commit>`, and only `plain.updated` moves it. There is no `green`
// fallback — FR28's "every other frame" rule applies (reload once at its own address, then
// `frame.stalled`) — and a `tapped` message is ignored by the component, so nothing here
// handles it. `highlight` is likewise not part of 3.6's contract: the Who relies panel opens
// over the Floor view's frame (CO23b).

import { versionToken } from "../../../protocol/cards.ts";
import type { FloorToPool } from "../../../protocol/channel.ts";
import {
  FRAME_ADVANCE_DEBOUNCE_MS,
  FRAME_ADVANCE_TIMEOUT_MS,
  FRAME_LOAD_TIMEOUT_MS,
  FRAME_PROBE_RETRY_MS,
  HOST_SEED,
  POOL_STALL_MS,
} from "../../../protocol/constants.ts";
import type { CopyVars } from "../../../copy/fill.ts";
import { commitSrc, liveSrc, stallFallback } from "../pool-frame/frame-plan.ts";
import type { StalledId } from "../pool-frame/frame-plan.ts";
import type { DriverSink, FramePhase, FrameStats, TimerKey } from "../pool-frame/frame-driver.ts";

export type { DriverSink, FramePhase, FrameStats, TimerKey };

/** What the driver reads each time the Floor state changes — the `plain` field of FloorState,
 * already reduced (FL1). Null until the first `plain.updated` (PM6). */
export type PlainDriverTarget = {
  /** `state.plain?.commit`: the commit `plain` resolves to now; in Replay, the commit of the
   * newest `plain.updated` at the position (8.6). */
  plainCommit: string | null;
};

export type PlainDriverOptions = {
  /** The main pool this frame belongs to — the `{pool}` of every `/pool/{pool}/…` address. */
  pool: string;
  /** Live follows the moving `plain` source and gets `probe`; Replay follows fixed `p-` commits
   * and gets `advance` (SE16a, AC23). */
  mode: "live" | "replay";
  /** The world seed of the pool page (HOST_SEED; Compare shares one seed between its frames,
   * CO24a). */
  seed?: number;
};

export class PlainFrameDriver {
  phase: FramePhase = "loading";
  /** The FR28 caption while the frame is stalled (`frame.stalled`), or null. */
  stalledCaption: { id: StalledId; vars: CopyVars } | null = null;
  /** The version token this frame is being asked to reach (`p-<commit>`), or null when current. */
  expecting: string | null = null;
  /** The newest validated `stats` (CO22), kept for the self-test badge (CO25a). */
  lastStats: FrameStats | null = null;
  /** The comparison base of the loaded page address — no `paused` page parameter, so a pause
   * toggle never reads as a new address. "" before the first load. */
  base = "";

  private readonly sink: DriverSink;
  private readonly opts: Required<PlainDriverOptions>;
  private target: PlainDriverTarget = { plainCommit: null };
  private stalls = 0;
  private probeRetried = false;
  private lastStatsVersion: string | null = null;
  private userPaused = false;
  private visible = true;
  /** What the frame was last told (`pause`/`resume`), so transitions post once (CO23a). */
  private announced = false;
  private wantSelftest = false;
  private askedSelftest: string | null = null;

  constructor(sink: DriverSink, opts: PlainDriverOptions) {
    this.sink = sink;
    this.opts = { seed: HOST_SEED, ...opts };
  }

  /** A frame counts paused when the owner paused it or it is off-screen (AS14). */
  private effectivePaused(): boolean {
    return this.userPaused || !this.visible;
  }

  private fullSrc(base: string): string {
    return this.effectivePaused() ? `${base}&paused=1` : base;
  }

  private liveBase(): string {
    return liveSrc(this.opts.pool, "plain", this.opts.seed);
  }

  private commitBase(commit: string): string {
    return commitSrc(this.opts.pool, { repo: "plain", commit }, this.opts.seed);
  }

  private loadNow(base: string): void {
    this.base = base;
    this.phase = "loading";
    this.lastStatsVersion = null;
    this.lastStats = null;
    this.askedSelftest = null;
    // The `paused` page parameter already tells the host (AC11): the first stats does not
    // need a `pause` post for a state the page address announced.
    this.announced = this.effectivePaused();
    this.sink.cancel("stall");
    this.sink.schedule("load", FRAME_LOAD_TIMEOUT_MS);
    this.sink.load(this.fullSrc(base));
    this.sink.changed();
  }

  /** A `plain.updated` moved the frame: the probe/advance follows the debounce of CO21/RY17.
   * The expected token is `p-<commit>` (PM6, PV5). */
  private expectVersion(commit: string, timer: "probe" | "advance"): void {
    this.expecting = versionToken({ repo: "plain", commit });
    this.probeRetried = false;
    this.sink.schedule(timer, FRAME_ADVANCE_DEBOUNCE_MS);
  }

  /** Feed the reduced state on every change; idempotent like the main driver's `setTarget`.
   * In live mode the frame loads `/pool/{pool}/plain/` on the first call — a live frame's
   * address is the moving source, independent of what the newest `plain.updated` names —
   * and every later `plain.commit` change arms a debounced `probe` (SE16a, AC23). The `src`
   * never changes for it and `advance` is never posted. In Replay the frame loads at the
   * `p-<commit>` address and moves by `advance` (8.6); before the first `plain.updated` there
   * is no commit to show, so nothing loads. */
  setTarget(target: PlainDriverTarget): void {
    const prev = this.target;
    this.target = target;
    const commit = target.plainCommit;
    if (this.opts.mode === "replay") {
      if (commit !== null && commit !== prev.plainCommit) {
        if (this.base === "") {
          // First paint of the replay position: load straight at the commit, no advance needed.
          this.loadNow(this.commitBase(commit));
        } else {
          this.expectVersion(commit, "advance");
        }
      }
      return;
    }
    if (this.base === "") this.loadNow(this.liveBase());
    if (commit !== null && commit !== prev.plainCommit) {
      this.expectVersion(commit, "probe");
      // A frame that failed while `plain` was still null (no commit to serve) gets a fresh
      // load now that a version exists; a live frame is never reloaded for a landing (CO21),
      // but this is a recovery from an error, not a move for a landing.
      if (this.phase === "error") this.loadNow(this.liveBase());
    }
  }

  /** The iframe's `load` event: a document arrived — which is not yet the pool page (FR20).
   * Only the first `stats` message makes the frame live; the load timer keeps running so a
   * document that never speaks hits `error`. */
  onLoad(): void {}

  /** The iframe's `error` event — FR20's "reports an error" half of the load failure. */
  onLoadError(): void {
    if (this.phase === "loading") {
      this.phase = "error";
      this.sink.cancel("load");
      this.sink.changed();
    }
  }

  /** A validated `stats` message (parse with `parsePoolMessage` first). Keeps the `p-` version
   * expectation of CO21/RY17 and resets the FR28 stall watch. */
  onStats(stats: FrameStats): void {
    this.lastStatsVersion = stats.version;
    this.lastStats = stats;
    if (this.phase === "loading" || this.phase === "error" || this.phase === "stalled") {
      this.phase = "live";
      this.sink.cancel("load");
    }
    this.askSelftest(stats);
    if (this.expecting !== null && stats.version === this.expecting) {
      this.expecting = null;
      this.probeRetried = false;
      this.sink.cancel("advance-wait");
    } else if (this.expecting !== null && this.opts.mode === "live" && !this.probeRetried) {
      // CO21 applied to `p-`: the answer named an older version — one more probe, once.
      this.probeRetried = true;
      this.sink.schedule("probe-retry", FRAME_PROBE_RETRY_MS);
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
        // RY17: `advance` went unanswered — load the frame again at the `p-` commit address.
        if (
          this.opts.mode === "replay" &&
          this.expecting !== null &&
          this.lastStatsVersion !== this.expecting &&
          this.target.plainCommit !== null
        ) {
          this.loadNow(this.commitBase(this.target.plainCommit));
        }
        break;
    }
  }

  private applyStall(): void {
    // FR28's other-frames rule: a non-main frame reloads once at its own address, then holds
    // `frame.stalled` (no green fallback exists for the plain-merge pool).
    const decision = stallFallback({
      kind: "other",
      replay: this.opts.mode === "replay",
      stalls: this.stalls,
      greenCommit: null,
    });
    this.stalls += 1;
    switch (decision.action) {
      case "reload":
        // Unreachable for kind "other"; kept so the switch is total if stallFallback grows.
        this.loadNow(this.base);
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

  /** The shared pool pause/play state (ViewState.pool_paused) and key P: held while the frame
   * keeps its last picture (CO23a — one post per transition, `paused` parameter on loads). */
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
   * load (6.4, AC11): a load already in flight is restarted so its page comes up paused. */
  private syncPause(): void {
    if (this.phase === "loading" && this.base !== "" && this.effectivePaused()) {
      this.loadNow(this.base);
      return;
    }
    this.syncPausePost();
    this.armStall();
  }

  /** CO25a: the badge asks the frame to run its self-test — `probe` with `selftest` — once per
   * version the frame reports, until that version's `stats.selftest` arrives. */
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

  /** The FR28 watch: armed while the frame is live, visible and not paused. Re-armed on every
   * stats. */
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

  /** `frame.reload` (FR20, FR28): back to the `plain` source in live mode, back to the
   * position's `p-` commit in Replay (with no `plain.updated` yet there is nothing to load —
   * the frame stays in `plain.loading`). */
  reload(): void {
    this.stalls = 0;
    this.stalledCaption = null;
    this.expecting = null;
    this.probeRetried = false;
    const commit = this.target.plainCommit;
    if (this.opts.mode === "replay" && commit === null) {
      this.phase = "loading";
      this.sink.changed();
      return;
    }
    this.loadNow(this.opts.mode === "replay" && commit !== null ? this.commitBase(commit) : this.liveBase());
  }

  /** Let every pending timer go. Called on unmount. */
  dispose(): void {
    const keys: TimerKey[] = ["load", "stall", "probe", "probe-retry", "advance", "advance-wait"];
    for (const key of keys) this.sink.cancel(key);
  }
}
