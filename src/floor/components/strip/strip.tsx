// The strip of 03-floor 3.8: the run clock and the counters, a `region` landmark labelled
// `strip.label` (AX6). Values come from `stripCells` (4.4) - pure of `FloorState` and the
// stream clock. CO29: tabular figures; a counter that changes is underlined for 1 s.
// The strip has one fixed height per layout (2.1): numbers draw at counter size, a value
// that is a sentence draws at status size (`strip-value--text`) so it never stretches the
// strip. The spend cell carries the cap bar of 3.18 and lists each model's use on hover
// or focus (`spend.model_line`).

import { useContext } from "react";
import { ShellContext } from "../../app/context.ts";
import type { StripCell } from "../../state/derive.ts";
import { duration } from "../../../copy/format.ts";

export function Strip({ cells, stale }: { cells: StripCell[]; stale: number | null }) {
  const shell = useContext(ShellContext)!;
  return (
    <section className="strip" role="region" aria-label={shell.t("strip.label")} data-stale={stale !== null}>
      {cells.map((cell) => (
        <div
          className="strip-cell"
          key={cell.id}
          data-tone={cell.tone}
          title={cell.title}
          // AX2 puts the strip between header and banners in the focus order, so every
          // cell is a focus stop whether or not it carries a tip.
          tabIndex={0}
        >
          {/* 2.2/2.8: label, value and sub-line share one inline flow - a label that
              wraps keeps the value on its last line, so nothing is ever clipped. */}
          <div className="strip-main">
            <span className="strip-label">{cell.label}</span>{" "}
            <span
              className={cell.text === true ? "strip-value strip-value--text" : "strip-value"}
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
