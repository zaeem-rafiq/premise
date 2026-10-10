// The strip of 03-floor 3.8: the run clock and the counters, a `region` landmark labelled
// `strip.label` (AX6). Values come from `stripCells` (4.4) - pure of `FloorState` and the
// stream clock. CO29: tabular figures; a counter that changes is underlined for 1 s (`flashUntil`).
// The strip has one fixed height per layout (2.1): numbers draw at counter size, a value
// that is a sentence draws at status size (`strip-value--text`) so it never stretches the
// strip. The spend cell carries the cap bar of 3.18 and lists each model's use on hover
// or focus (`spend.model_line`).

import { useContext, useEffect, useRef } from "react";
import { ShellContext } from "../../app/context.ts";
import type { StripCell } from "../../state/derive.ts";
import { duration } from "../../../copy/format.ts";

/** CO29: how long a changed counter stays underlined. */
export const FLASH_MS = 1000;

/**
 * CO29: the cells whose counter changed, as `id -> underline until`. A value that only arrives in
 * place of the dash (3.8 loading or empty) is not a change, so a page that has just opened or
 * reloaded underlines nothing (seen in the scripted rehearsal after Lock and a reload). The run
 * clock is not a counter.
 */
export function flashUntil(
  previous: ReadonlyMap<string, string>,
  running: ReadonlyMap<string, number>,
  cells: readonly StripCell[],
  dash: string,
  now: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const cell of cells) {
    if (cell.id === "strip.clock") continue;
    const before = previous.get(cell.id);
    if (before !== undefined && before !== dash && before !== cell.value) out.set(cell.id, now + FLASH_MS);
    else {
      const until = running.get(cell.id);
      if (until !== undefined && until > now) out.set(cell.id, until);
    }
  }
  return out;
}

export function Strip({ cells, stale }: { cells: StripCell[]; stale: number | null }) {
  const shell = useContext(ShellContext)!;
  const previous = useRef<Map<string, string>>(new Map());
  const running = useRef<Map<string, number>>(new Map());
  const flashing = flashUntil(previous.current, running.current, cells, shell.t("strip.dash"), Date.now());
  useEffect(() => {
    previous.current = new Map(cells.map((cell) => [cell.id, cell.value]));
    running.current = flashing;
  });
  return (
    <section className="strip" role="region" aria-label={shell.t("strip.label")} data-stale={stale !== null}>
      {cells.map((cell) => (
        <div
          className="strip-cell"
          key={cell.id}
          data-cell={cell.id}
          data-tone={cell.tone}
          title={cell.title}
          // AX2 puts the strip between header and banners in the focus order, so every
          // cell is a focus stop whether or not it carries a tip.
          tabIndex={0}
        >
          {/* 2.8: label, value and sub-line share one inline flow - a label that wraps
              keeps the value on its last line, so nothing is ever clipped. At stage width
              (2.2) the label takes its own line, above the value (base.css). */}
          <div className="strip-main">
            <span className="strip-label">{cell.label}</span>{" "}
            <span
              className={
                (cell.text === true ? "strip-value strip-value--text" : "strip-value") +
                (flashing.has(cell.id) ? " strip-value--flash" : "")
              }
              key={cell.value}
            >
              {cell.value}
            </span>
            {cell.sub !== undefined && <span className="strip-sub"> {cell.sub}</span>}
          </div>
          {cell.bar !== undefined && (
            <div className="strip-bar" aria-hidden="true">
              <div className="strip-bar-fill" style={{ width: `${Math.round(cell.bar * 100)}%` }} />
            </div>
          )}
          {cell.tip !== undefined && (
            <div className="strip-tip" role="note">
              {cell.tip.map((line) => (
                <div className="strip-tip-line" key={line}>
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      {stale !== null && <div className="strip-stale">{shell.t("strip.stale", { duration: duration(stale) })}</div>}
    </section>
  );
}
