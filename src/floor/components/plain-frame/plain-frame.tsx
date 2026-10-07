// The plain-merge pool frame of docs/spec/03-floor.md 3.6: shown only in the Compare view,
// beside the live pool frame, with the same sandbox and message rules (CO20, CO22 — a `tapped`
// message is ignored). Live it follows `/pool/{pool}/plain/`; in Replay it is a commit frame
// on `p-<plain.commit>` (8.6). Behavior lives in plain-driver.ts; this file is the DOM half:
// the iframe, the two-line caption of CO24 and the self-test badge of CO25a.

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { FloorState } from "../../../protocol/reducer/index.ts";
import type { CopyVars } from "../../../copy/fill.ts";
import { text } from "../../../copy/strings.ts";
import { iframeAttrs, loadFailureId, parsePoolMessage } from "../pool-frame/frame-plan.ts";
import { greenCheckLabel } from "../../../copy/checks.ts";
import { landingLabel } from "../../../copy/format.ts";
import { PlainFrameDriver } from "./plain-driver.ts";
import type { DriverSink, FrameStats, TimerKey } from "./plain-driver.ts";
import { plainBehind } from "../compare/compare-plan.ts";
import { adoptCss } from "../../styles/adopt.ts";

/** The props the Compare view hands the plain-merge frame. Everything the frame shows derives
 * from `state` (FL1) — the `plain` field of FloorState drives both the caption's "through"
 * landing and the probes; `paused`, `selftest` and `seed` are the shared frame settings. */
export type PlainFrameProps = {
  /** The main pool id — the `{pool}` of every `/pool/{pool}/…` address. */
  pool: string;
  /** The reduced event stream at the position the Floor shows (rebuilt per Replay position). */
  state: FloorState;
  /** `ViewState.mode`: "live" follows the `plain` source; "replay" follows `p-` commits. */
  mode?: "live" | "replay";
  /** `ViewState.pool_paused` (controlled). When absent the component keeps its own pause state,
   * initialized by `defaultPaused` — reduced motion starts frames paused (6.4, AC11). The
   * plain frame carries no pause button of its own (CO24 fixes its caption); the shared
   * `paused` still posts `pause`/`resume` to it (CO23a). */
  paused?: boolean;
  defaultPaused?: boolean;
  /** `ViewState.frames[name]` bookkeeping: every validated `stats` and its arrival time (CO22). */
  onFrameStats?: (frame: string, stats: FrameStats, atMs: number) => void;
  /** CO25a: run the pool's self-test in this frame and show its badge under it. In the Compare
   * view it is always on — the badge is how the constructed pool shows a verdict. */
  selftest?: boolean;
  /** The world seed of the pool page (Compare gives both frames one seed, CO24a). */
  seed?: number;
  /** The `ViewState.frames` key this frame reports under (default "plain"). */
  name?: string;
};

/** Styles for the plain frame, emitted once as a scoped <style> block — same approach as
 * pool-frame.tsx (the zone may not import a .css file). The rules mirror `.pf-*` so both
 * frames of the Compare view draw alike; the tokens resolve against the shell's base.css. */
const PLAIN_FRAME_CSS = `
.plf { position: relative; display: flex; flex-direction: column; min-width: 0; }
.plf-caption { display: flex; flex-direction: column; gap: 2px; min-height: 44px;
  justify-content: center; font-size: var(--size-body, 16px); color: var(--text, #eaf2f4); }
.plf-caption-label { font-weight: 600; }
.plf-caption-built { color: var(--muted, #a8bcc6); font-size: var(--size-small, 14px); }
.plf-chips { display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  font-size: var(--size-small, 14px); }
.plf-chip { border: var(--border, 1px) solid var(--control, #7c98a8); border-radius: var(--radius, 8px);
  padding: 2px 8px; color: var(--confirm, #ffc857); }
.plf-chip-stalled { color: var(--changed, #ff7a6b); }
.plf-body { position: relative; aspect-ratio: 16 / 9; width: 100%;
  border: var(--border, 1px) solid var(--control, #7c98a8); border-radius: var(--radius, 8px);
  overflow: hidden; background: var(--bg, #0b1720); }
.plf-body iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; }
.plf-body--framefocus { outline: 3px solid var(--focus, #ffe08a); outline-offset: -3px; border-radius: 8px; }
.plf-overlay { position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 12px; padding: 16px;
  background: var(--bg, #0b1720); color: var(--muted, #a8bcc6);
  font-size: var(--size-body, 16px); text-align: center; }
.plf-btn { min-width: 44px; min-height: 44px; padding: 8px 12px;
  border: var(--border, 1px) solid var(--control, #7c98a8); border-radius: var(--radius, 8px);
  background: transparent; color: var(--text, #eaf2f4); font: inherit;
  font-weight: 600; cursor: pointer; }
.plf-btn:focus-visible { outline: 3px solid var(--focus, #ffe08a); outline-offset: 2px; }
.plf-selftest { position: absolute; inset-inline-end: 8px; inset-block-end: 8px; z-index: 1;
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; max-width: 70%;
  padding: 2px 8px; border: var(--border, 1px) solid var(--control, #7c98a8);
  border-radius: var(--radius, 8px); background: var(--surface, #13242f);
  font-size: var(--size-small, 14px); color: var(--muted, #a8bcc6); }
.plf-selftest-pass { color: var(--holds, #5bd68f); }
.plf-selftest-fail { color: var(--changed, #ff7a6b); }
.plf-selftest ul { margin: 0; padding-inline-start: 18px; }
`;

/** 6.4/AC11: "reduced" is the system's `prefers-reduced-motion: reduce`. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** CO25a: the badge under the frame — fed only by this frame's `stats.selftest`. `running`
 * until the self-test's version equals the frame's reported version, then `pass` or `fail`
 * with one `selftest.fail.line` per failed check. */
function SelftestBadge({ stats }: { stats: FrameStats | null }) {
  const st = stats?.selftest ?? null;
  const fresh = st !== null && stats !== null && st.version === stats.version;
  return (
    <div className="plf-selftest" title={text("selftest.tip")}>
      {!fresh ? (
        <span>{text("selftest.running")}</span>
      ) : st.ok ? (
        <span className="plf-selftest-pass">{text("selftest.pass")}</span>
      ) : (
        <span className="plf-selftest-fail">
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

export function PlainFrame(props: PlainFrameProps) {
  const { pool, state, mode = "live", name = "plain" } = props;
  const [innerPaused, setInnerPaused] = useState(() => props.defaultPaused ?? prefersReducedMotion());
  const paused = props.paused ?? innerPaused;
  const [frameFocus, setFrameFocus] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const driverRef = useRef<PlainFrameDriver | null>(null);
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
        // The frame is sandboxed (opaque origin): targetOrigin "*" is required; safety comes
        // from validating event.source and the message shape on the way in (CO22), not the
        // send.
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
    driver: new PlainFrameDriver(sink, { pool, mode, seed: props.seed }),
  }));
  if (drv.key !== `${pool}:${mode}:${props.seed ?? "s"}`) {
    drv.driver.dispose();
    setDrv({
      key: `${pool}:${mode}:${props.seed ?? "s"}`,
      driver: new PlainFrameDriver(sink, { pool, mode, seed: props.seed }),
    });
    setFrame({ src: "", seq: 0 });
  }
  const driver = drv.driver;
  driverRef.current = driver;

  // Feed the driver: the `plain` field of the reduced state on every change, then the pause
  // slice — pause goes first so a `paused` page parameter lands on the first load (AC11).
  useEffect(() => {
    driver.setUserPaused(paused);
    driver.setSelftest(props.selftest === true);
    driver.setTarget({ plainCommit: state.plain?.commit ?? null });
  }, [driver, paused, props.selftest, state.plain]);

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

  // CO22/SE16: accept messages only from our own iframe, only of the channel's shape. A
  // `tapped` message is ignored here (3.6): the plain-merge pool is a comparison, and its
  // creatures' Why cards would tell the main pool's story, not this one's.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const win = iframeRef.current?.contentWindow;
      if (win === null || win === undefined || event.source !== win) return;
      const message = parsePoolMessage(event.data);
      if (message === null || message.type !== "stats") return;
      driverRef.current?.onStats(message);
      propsRef.current.onFrameStats?.(propsRef.current.name ?? "plain", message, Date.now());
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

  const phase = driver.phase;
  const stalled = driver.stalledCaption;
  const behind = plainBehind(state);
  const through = state.plain === null ? "…" : landingLabel(state.plain.through_seq);
  // 3.6's state table: `plain` null or the iframe still loading both show `plain.loading`;
  // the loading sentence also covers an iframe that errored before the first `plain.updated`
  // — until the pool exists there is nothing to report but that it is being built.
  const loading = state.plain === null || phase === "loading";

  const overlayText = (id: string, vars?: CopyVars) => (
    <div className="plf-overlay" role="status">
      <span>{text(id, vars)}</span>
      <button type="button" className="plf-btn" onClick={() => driver.reload()}>
        {text("frame.reload")}
      </button>
    </div>
  );

  adoptCss(PLAIN_FRAME_CSS);
  return (
    <div className="plf" data-frame={name} ref={rootRef}>
      <div className="plf-caption">
        <span className="plf-caption-label">{text("plain.label")}</span>
        <span className="plf-caption-built">{text("plain.constructed", { landing: through })}</span>
        {(paused || behind > 0 || (stalled !== null && phase !== "stalled")) && (
          <span className="plf-chips">
            {paused && <span className="plf-chip">{text("frame.paused")}</span>}
            {behind > 0 && <span className="plf-chip">{text("plain.behind", { n: behind })}</span>}
            {stalled !== null && phase !== "stalled" && (
              <span className="plf-chip plf-chip-stalled">{text(stalled.id, stalled.vars)}</span>
            )}
          </span>
        )}
      </div>
      <div className={`plf-body${frameFocus ? " plf-body--framefocus" : ""}`}>
        {frame.src !== "" && (
          <iframe
            key={frame.seq}
            ref={iframeRef}
            {...iframeAttrs(frame.src, text("plain.title"))}
            onLoad={() => driver.onLoad()}
            onError={() => driver.onLoadError()}
          />
        )}
        {loading && (
          <div className="plf-overlay" role="status">
            <span>{text("plain.loading")}</span>
          </div>
        )}
        {!loading && phase === "error" && overlayText(loadFailureId(mode))}
        {!loading && phase === "stalled" && overlayText(stalled?.id ?? "frame.stalled", stalled?.vars)}
      </div>
      {props.selftest === true && <SelftestBadge stats={driver.lastStats} />}
    </div>
  );
}
