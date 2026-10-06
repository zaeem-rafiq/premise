// The live pool frame of docs/spec/03-floor.md 3.5: a caption bar and one sandboxed iframe that
// runs the pool's own code. Live it follows `/pool/{pool}/main/` (CO20); in Replay it follows the
// position's commit (8.6). Behavior — probe/advance, stall fallback, pause — lives in
// frame-driver.ts; this file is the DOM half: the iframe, the caption, the message listener.

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { FloorState } from "../../../protocol/reducer/index.ts";
import type { CopyVars } from "../../../copy/fill.ts";
import { text } from "../../../copy/strings.ts";
import {
  highlightKinds,
  iframeAttrs,
  landingPending,
  loadFailureId,
  mainCaption,
  parsePoolMessage,
} from "./frame-plan.ts";
import { greenCheckLabel } from "../../../copy/checks.ts";
import { FrameDriver } from "./frame-driver.ts";
import type { DriverSink, FrameStats, TimerKey } from "./frame-driver.ts";

/** The props the shell hands the pool area (registered as "pool-area", see app/wiring/pool-area.ts).
 * Everything the frame shows derives from `state` (FL1); `paused`, `highlight` and the callbacks
 * are the slice of `ViewState` the frame touches. */
export type PoolFrameProps = {
  /** The main pool id — the `{pool}` of every `/pool/{pool}/…` address (13.6 `/p/{pool}`, FE7). */
  pool: string;
  /** The reduced event stream at the position the Floor shows (rebuilt per Replay position, RY16). */
  state: FloorState;
  /** `ViewState.mode`: "live" follows the moving source; "replay" follows fixed commits. */
  mode?: "live" | "replay";
  /** `ViewState.pool_paused` (controlled). When absent the component keeps its own pause state,
   * initialized by `defaultPaused` — reduced motion starts frames paused (6.4, AC11). */
  paused?: boolean;
  defaultPaused?: boolean;
  /** The pause/play control and key P report here → `ViewState.pool_paused`. */
  onPausedChange?: (paused: boolean) => void;
  /** `frame.compare` → `ViewState.view = "compare"`. The button is absent when the pool has no
   * plain-merge repository (`pool.plain_remote` null, 3.6 stopped state) — the callback is the
   * shell's decision to offer the view. */
  onCompare?: () => void;
  /** `ViewState.frames[name]` bookkeeping: every validated `stats` message and its arrival time,
   * for freshness, stall detection and self-test badges (CO21, CO24, FR28). */
  onFrameStats?: (frame: string, stats: FrameStats, atMs: number) => void;
  /** A `tapped` message → open the Why card of `whyTarget(path)` (CO22). The component reports
   * the file path; opening the card is the shell's. */
  onTapped?: (path: string) => void;
  /** Who relies: kind names to outline in the frame (CO23b): kinds post while the panel is
   * open, the empty list posts when it is given (the panel closed); an absent prop posts
   * nothing at all. */
  highlight?: readonly string[];
  /** CO25a: run the pool's self-test in this frame and show its badge under it (Compare turns
   * it on; the Floor view's frame leaves it off). */
  selftest?: boolean;
  /** The world seed of the pool page (default HOST_SEED; Compare shares one seed, CO24a). */
  seed?: number;
  /** The `ViewState.frames` key this frame reports under (default "main"). */
  name?: string;
};

/** Styles for the pool frame, emitted once as a scoped <style> block — the zone may not import a
 * .css file (the wiring module must stay importable in the Node test program), and the tokens
 * (`--bg`, `--control`, …) resolve against the shell's base.css; the fallbacks are the 6.3 dark
 * values so the frame still reads on its own. */
export const FRAME_CSS = `
.pf { position: relative; display: flex; flex-direction: column; min-width: 0; }
.pf-caption { display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  font-size: var(--size-body, 16px); color: var(--text, #eaf2f4); }
.pf-caption-text { color: var(--muted, #a8bcc6); }
.pf-chip { border: var(--border, 1px) solid var(--control, #7c98a8); border-radius: var(--radius, 8px);
  padding: 4px 8px; color: var(--muted, #a8bcc6); }
.pf-chip-landing { color: var(--confirm, #ffc857); }
.pf-chip-stalled { color: var(--changed, #ff7a6b); }
.pf-spacer { flex: 1; }
.pf-btn { min-width: 44px; min-height: 44px; padding: 8px 12px;
  border: var(--border, 1px) solid var(--control, #7c98a8); border-radius: var(--radius, 8px);
  background: transparent; color: var(--text, #eaf2f4); font: inherit;
  font-weight: 600; cursor: pointer; }
.pf-btn:focus-visible { outline: 3px solid var(--focus, #ffe08a); outline-offset: 2px; }
.pf-body { position: relative; aspect-ratio: 16 / 9; width: 100%;
  border: var(--border, 1px) solid var(--control, #7c98a8); border-radius: var(--radius, 8px);
  overflow: hidden; background: var(--bg, #0b1720); }
.pf-body iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; }
.pf-body--framefocus { outline: 3px solid var(--focus, #ffe08a); outline-offset: -3px; border-radius: 8px; }
.pf-overlay { position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 12px; padding: 16px;
  background: var(--bg, #0b1720); color: var(--muted, #a8bcc6);
  font-size: var(--size-body, 16px); text-align: center; }
.pf-body.pf-glow { animation: pf-edge 1.2s var(--ease, cubic-bezier(0.2, 0.8, 0.2, 1)); }
@keyframes pf-edge { from { outline: 3px solid var(--accent, #6fd6cc); outline-offset: -3px; }
  to { outline: 3px solid transparent; outline-offset: -3px; } }
.pf-selftest { position: absolute; inset-inline-end: 8px; inset-block-end: 8px; z-index: 1;
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; max-width: 70%;
  padding: 2px 8px; border: var(--border, 1px) solid var(--control, #7c98a8);
  border-radius: var(--radius, 8px); background: var(--surface, #13242f);
  font-size: var(--size-small, 14px); color: var(--muted, #a8bcc6); }
.pf-selftest-pass { color: var(--holds, #5bd68f); }
.pf-selftest-fail { color: var(--changed, #ff7a6b); }
.pf-selftest ul { margin: 0; padding-inline-start: 18px; }
@media (prefers-reduced-motion: reduce) { .pf-overlay { transition: none; }
  .pf-body.pf-glow { animation: none; outline: 3px solid var(--accent, #6fd6cc); outline-offset: -3px; } }
`;

/** 6.4/AC11: "reduced" is the system's `prefers-reduced-motion: reduce`. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** CO25a: the badge under a frame — fed only by that frame's `stats.selftest`. `running` until
 * the self-test's version equals the frame's reported version, then `pass` or `fail` with one
 * `selftest.fail.line` per failed check. */
function SelftestBadge({ stats }: { stats: FrameStats | null }) {
  const st = stats?.selftest ?? null;
  const fresh = st !== null && stats !== null && st.version === stats.version;
  return (
    <div className="pf-selftest" title={text("selftest.tip")}>
      {!fresh ? (
        <span>{text("selftest.running")}</span>
      ) : st.ok ? (
        <span className="pf-selftest-pass">{text("selftest.pass")}</span>
      ) : (
        <span className="pf-selftest-fail">
          {text("selftest.fail", { n: st.failed.length })}
          <ul>
            {st.failed.map((f, i) => (
              <li key={i}>
                {f.kind === null
                  ? greenCheckLabel(f.name)
                  : text("selftest.fail.line", { "check label": greenCheckLabel(f.name, f.kind), kind: f.kind })}
              </li>
            ))}
          </ul>
        </span>
      )}
    </div>
  );
}

export function PoolFrame(props: PoolFrameProps) {
  const { pool, state, mode = "live", name = "main" } = props;
  const [innerPaused, setInnerPaused] = useState(() => props.defaultPaused ?? prefersReducedMotion());
  const paused = props.paused ?? innerPaused;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const driverRef = useRef<FrameDriver | null>(null);
  const timersRef = useRef(new Map<TimerKey, number>());
  const [frame, setFrame] = useState<{ src: string; seq: number }>({ src: "", seq: 0 });
  const [, bump] = useReducer((c: number) => c + 1, 0);
  const propsRef = useRef(props);
  propsRef.current = props;

  const sink = useMemo<DriverSink>(
    () => ({
      load: (src) => setFrame((f) => ({ src, seq: f.seq + 1 })),
      post: (message) => {
        const win = iframeRef.current?.contentWindow;
        // The frame is sandboxed (opaque origin): targetOrigin "*" is required; safety comes from
        // validating event.source and the message shape on the way in (CO22), not the send.
        if (win !== null && win !== undefined) win.postMessage(message, "*");
      },
      schedule: (key, ms) => {
        const prev = timersRef.current.get(key);
        if (prev !== undefined) window.clearTimeout(prev);
        timersRef.current.set(
          key,
          window.setTimeout(() => {
            timersRef.current.delete(key);
            driverRef.current?.onTimer(key);
          }, ms),
        );
      },
      cancel: (key) => {
        const prev = timersRef.current.get(key);
        if (prev !== undefined) {
          window.clearTimeout(prev);
          timersRef.current.delete(key);
        }
      },
      changed: () => bump(),
    }),
    [],
  );

  const [drv, setDrv] = useState(() => ({
    key: `${pool}:${mode}:${props.seed ?? "s"}`,
    driver: new FrameDriver(sink, { pool, mode, seed: props.seed }),
  }));
  if (drv.key !== `${pool}:${mode}:${props.seed ?? "s"}`) {
    drv.driver.dispose();
    setDrv({
      key: `${pool}:${mode}:${props.seed ?? "s"}`,
      driver: new FrameDriver(sink, { pool, mode, seed: props.seed }),
    });
    setFrame({ src: "", seq: 0 });
  }
  const driver = drv.driver;
  driverRef.current = driver;

  // 6.4/AC11: under reduced motion a frame starts paused. Uncontrolled, `innerPaused` already
  // covers it; the report still goes through the same callback the Pause button uses, so a
  // controlled `pool_paused` records it too.
  const rmReported = useRef(false);
  useEffect(() => {
    if (rmReported.current || !prefersReducedMotion()) return;
    rmReported.current = true;
    if (propsRef.current.paused !== true) propsRef.current.onPausedChange?.(true);
  }, []);

  // Feed the driver: state targets on every reducer change, then the ViewState slice. Pause goes
  // first so a `paused` page parameter lands on the first load (AC11/6.4).
  useEffect(() => {
    driver.setUserPaused(paused);
    driver.setHighlight(highlightKinds(props.highlight ?? []), props.highlight !== undefined);
    driver.setSelftest(props.selftest === true);
    // IR12: the first live load waits for the stream's first `pool.state` — a pool made from
    // a repository has no live picture, so no speculative `/pool/{pool}/main/` request may go
    // out while the kind is undecided. The driver lapses the wait at the page's lost-connection
    // window (OFFLINE_AFTER_MS), so a pool whose stream is slow or down still shows its frame —
    // the promise the once-immediate load made.
    driver.setTarget({
      landedCommit: state.pool.landed_commit,
      greenCommit: state.green.commit,
      greenSeq: state.green.seq,
      poolKnown: state.pool.state !== "unknown",
    });
  }, [
    driver,
    paused,
    props.highlight,
    props.selftest,
    state.pool.landed_commit,
    state.pool.state,
    state.green.commit,
    state.green.seq,
  ]);

  useEffect(() => {
    const onBlur = () => setFrameFocus(document.activeElement === iframeRef.current);
    const onFocus = () => setFrameFocus(false);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // CO22/SE16: accept messages only from our own iframe, only of the channel's shape.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const win = iframeRef.current?.contentWindow;
      if (win === null || win === undefined || event.source !== win) return;
      const message = parsePoolMessage(event.data);
      if (message === null) return;
      if (message.type === "stats") {
        driverRef.current?.onStats(message);
        propsRef.current.onFrameStats?.(propsRef.current.name ?? "main", message, Date.now());
      } else {
        propsRef.current.onTapped?.(message.path);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // AS14: a frame that is not visible is paused. jsdom-free fallback: assume visible.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (el === null || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) driverRef.current?.setVisible(entry.isIntersecting);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => driverRef.current?.dispose(), []);

  // 6.4 "a change lands": the frame's edge glows in `accent` for 1.2 s — a static outline for
  // 2 s under reduced motion.
  const seenLanded = useRef<number | null>(null);
  const [edgeGlow, setEdgeGlow] = useState(false);
  // Focus that moves into the frame's document matches no parent-document pseudo and fires
  // no element event: the page window blurs instead, with the iframe as `activeElement`.
  // `frameFocus` follows that so the ring draws on `.pf-body` (AX2).
  const [frameFocus, setFrameFocus] = useState(false);
  useEffect(() => {
    const seq = state.pool.landed_seq;
    const prev = seenLanded.current;
    seenLanded.current = seq;
    if (prev === null || prev === seq) return;
    setEdgeGlow(true);
    const t = window.setTimeout(() => setEdgeGlow(false), prefersReducedMotion() ? 2000 : 1200);
    return () => window.clearTimeout(t);
  }, [state.pool.landed_seq]);

  const caption = mainCaption(state, mode);
  const pending = landingPending(state);
  const poolStopped = state.pool.state === "paused" || state.pool.state === "rebuilding";
  const compareOffered = state.pool.plain_remote !== null && state.pool.app !== null && props.onCompare !== undefined;
  const phase = driver.phase;
  const stalled = driver.stalledCaption;

  const togglePause = () => {
    const next = !paused;
    if (props.paused === undefined) setInnerPaused(next);
    props.onPausedChange?.(next);
  };
  const reload = () => driver.reload();

  const overlayText = (id: string, vars?: CopyVars) => (
    <div className="pf-overlay" role="status">
      <span>{text(id, vars)}</span>
      <button type="button" className="pf-btn" onClick={reload}>
        {text("frame.reload")}
      </button>
    </div>
  );

  return (
    <div className="pf" data-frame={name} ref={rootRef}>
      <style>{FRAME_CSS}</style>
      <div className="pf-caption">
        <span className="pf-caption-text">{text(caption.id, caption.vars)}</span>
        {pending > 0 && <span className="pf-chip pf-chip-landing">{text("frame.landing", { n: pending })}</span>}
        {poolStopped && <span className="pf-chip">{text("frame.pool_paused")}</span>}
        {paused && <span className="pf-chip">{text("frame.paused")}</span>}
        {stalled !== null && phase !== "stalled" && (
          <span className="pf-chip pf-chip-stalled">{text(stalled.id, stalled.vars)}</span>
        )}
        <span className="pf-spacer" />
        {compareOffered && (
          <button type="button" className="pf-btn" onClick={props.onCompare}>
            {text("frame.compare")}
          </button>
        )}
        <button type="button" className="pf-btn" onClick={togglePause} aria-pressed={paused}>
          {paused ? text("frame.play") : text("frame.pause")}
        </button>
      </div>
      <div className={`pf-body${edgeGlow ? " pf-glow" : ""}${frameFocus ? " pf-body--framefocus" : ""}`}>
        {frame.src !== "" && (
          <iframe
            key={frame.seq}
            ref={iframeRef}
            {...iframeAttrs(frame.src, text("frame.main.title"))}
            onLoad={() => driver.onLoad()}
            onError={() => driver.onLoadError()}
          />
        )}
        {phase === "loading" && (
          <div className="pf-overlay" role="status">
            <span>{text("frame.loading")}</span>
          </div>
        )}
        {phase === "error" && overlayText(loadFailureId(mode))}
        {phase === "stalled" && overlayText(stalled?.id ?? "frame.stalled", stalled?.vars)}
      </div>
      {props.selftest === true && <SelftestBadge stats={driver.lastStats} />}
    </div>
  );
}
