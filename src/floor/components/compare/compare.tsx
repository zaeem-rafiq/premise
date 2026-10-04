// The Compare view of docs/spec/03-floor.md 2.3 and 3.6: the live `main` frame beside the
// plain-merge frame, both on one seed (CO24a), each with its self-test badge under it
// (CO25a), then the CO25 list — what differs, the tree-equality line, the approximated count,
// Back and the thesis. The list comes only from the stream (compare-plan.ts), never from what
// the frames draw.
//
// The shell opens the view through the `view.compare` registry entry (wiring/pool-area.ts,
// bound in wiring/pool-area.views.tsx); the props below are what the binding passes. When a
// host gives no `onBack`, the Back button dispatches the same key the shell binds to
// view-compare (`c` of 6.6) — the view closes by the spec's own route.

import { useMemo } from "react";
import type { FloorState } from "../../../protocol/reducer/index.ts";
import type { CopyVars } from "../../../copy/fill.ts";
import { text } from "../../../copy/strings.ts";
import { PoolFrame } from "../pool-frame/pool-frame.tsx";
import type { FrameStats } from "../pool-frame/frame-driver.ts";
import { PlainFrame } from "../plain-frame/plain-frame.tsx";
import { conflictCount, diffLines, plainSameAsLanded } from "./compare-plan.ts";

export type CompareProps = {
  /** The main pool id — the `{pool}` of every `/pool/{pool}/…` address of both frames. */
  pool: string;
  /** The reduced event stream at the position the Floor shows (the binding accepts `floor`,
   * the name `app.tsx` gives the Swarm view, as an alias — see pool-area.views.tsx). */
  state: FloorState;
  /** `ViewState.mode`: live frames on moving sources, or commit frames in Replay (8.6). */
  mode?: "live" | "replay";
  /** `ViewState.pool_paused` — CO23a: one pause state posts `pause` to both frames. */
  paused?: boolean;
  /** The left frame's Pause control reports here; the plain frame has none of its own (CO24). */
  onPausedChange?: (paused: boolean) => void;
  /** `ViewState.frames` bookkeeping for stall and badge freshness (CO22, CO25a). */
  onFrameStats?: (frame: string, stats: FrameStats, atMs: number) => void;
  /** The world seed both frames share — CO24a. */
  seed?: number;
  /** `view.compare` closes back to the Floor view (2.3: "Closed by the same, or by Esc"). */
  onBack?: () => void;
};

/** The Compare view's own styles. Two equal columns at stage and laptop width (2.3), stacked
 * under 1100 px (2.9). The badge rules move each frame's badge out of its in-frame overlay
 * position to the line under the frame that 2.3 draws ("under each frame is its self-test
 * badge"); `.pf-selftest` is the main frame's existing badge node — no file outside this lane
 * changes for it. */
const COMPARE_CSS = `
.cmp { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  column-gap: var(--body-gap, 24px); row-gap: 16px; min-width: 0; min-height: 0;
  align-content: start; }
.cmp-col { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.cmp-col > .pf, .cmp-col > .plf { min-height: 0; }
/* CO24's two caption lines are taller than the main frame's one; pin the caption row so both
 * frame bodies start on the same line. */
.cmp-col .pf-caption, .cmp-col .plf-caption { min-height: 44px; }
/* 2.3: "under each frame is its self-test badge" — both badges take the line under the body. */
.cmp .pf-selftest, .cmp .plf-selftest { position: static; max-width: none; margin-top: 8px;
  align-self: flex-start; }
.cmp-diff { grid-column: 1 / -1; min-width: 0; display: flex; flex-direction: column; gap: 8px;
  font-size: var(--size-body, 16px); color: var(--text, #eaf2f4); }
.cmp-diff h2 { margin: 0; font-size: var(--size-title, 20px); }
.cmp-diff ul { margin: 0; padding-inline-start: 22px; display: flex; flex-direction: column;
  gap: 4px; }
.cmp-diff p { margin: 0; }
.cmp-diff-tail { display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
  justify-content: space-between; }
.cmp-back { min-width: 44px; min-height: 44px; padding: 8px 12px;
  border: var(--border, 1px) solid var(--control, #7c98a8); border-radius: var(--radius, 8px);
  background: transparent; color: var(--text, #eaf2f4); font: inherit; font-weight: 600;
  cursor: pointer; }
.cmp-back:focus-visible { outline: 3px solid var(--focus, #ffe08a); outline-offset: 2px; }
.cmp-thesis { color: var(--muted, #a8bcc6); }
@media (max-width: 1099px) { .cmp { grid-template-columns: minmax(0, 1fr); } }
`;

/** The back action of the view: the host's callback when it gives one; otherwise the key C —
 * 2.3 says the same key that opened Compare closes it, and the shell's key map owns the
 * toggle, so a synthetic keydown reaches the same handler. */
function closeCompare(onBack: CompareProps["onBack"]): void {
  if (onBack !== undefined) {
    onBack();
    return;
  }
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "c" }));
}

export function Compare(props: CompareProps) {
  const { pool, state, mode = "live", paused, onPausedChange, onFrameStats, seed, onBack } = props;
  const lines = useMemo(() => diffLines(state), [state]);
  const sameAsLanded = useMemo(() => plainSameAsLanded(state), [state]);
  const conflicts = conflictCount(state);

  return (
    <div className="cmp">
      <style>{COMPARE_CSS}</style>
      <div className="cmp-col" data-pool="main">
        <PoolFrame
          pool={pool}
          state={state}
          mode={mode}
          paused={paused}
          onPausedChange={onPausedChange}
          onFrameStats={onFrameStats}
          selftest
          seed={seed}
          name="main"
        />
      </div>
      <div className="cmp-col" data-pool="plain">
        <PlainFrame
          pool={pool}
          state={state}
          mode={mode}
          paused={paused}
          onFrameStats={onFrameStats}
          selftest
          seed={seed}
          name="plain"
        />
      </div>
      <div className="cmp-diff">
        <h2>{text("plain.differs")}</h2>
        {state.plain === null ? (
          // 3.6's loading row: the plain-merge pool has not reported yet — the frame shows
          // plain.loading and the list has nothing to say about a pool still being built.
          <p className="cmp-note">{text("plain.loading")}</p>
        ) : lines.length === 0 ? (
          // 3.6's empty row: the list says plain.same where the per-change lines would be.
          <p className="cmp-note">{text("plain.same")}</p>
        ) : (
          <ul>
            {lines.map((line: { seq: number; id: string; vars: CopyVars }) => (
              <li key={line.seq} className="cmp-line" data-seq={line.seq}>
                {text(line.id, line.vars)}
              </li>
            ))}
          </ul>
        )}
        {sameAsLanded && <p className="cmp-note cmp-no-diff">{text("plain.no_difference")}</p>}
        <div className="cmp-diff-tail">
          {conflicts !== null && (
            <p className="cmp-note cmp-conflicts" title={text("plain.conflicts.tip")}>
              {text("plain.conflicts", { n: conflicts })}
            </p>
          )}
          <button type="button" className="cmp-back" onClick={() => closeCompare(onBack)}>
            {text("compare.back")}
          </button>
        </div>
        <p className="cmp-thesis">{text("app.thesis")}</p>
      </div>
    </div>
  );
}
