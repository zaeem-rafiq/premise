// The strip of 03-floor 3.8: the run clock and the counters, a `region` landmark labelled
// `strip.label` (AX6). Values come from `stripCells` (4.4) - pure of `FloorState` and the
// stream clock. CO29: tabular figures; a counter that changes is underlined for 1 s.

import { useContext } from "react";
import { ShellContext } from "../../app/context.ts";
import type { StripCell } from "../../state/derive.ts";

export function Strip({ cells, stale }: { cells: StripCell[]; stale: number | null }) {
  const shell = useContext(ShellContext)!;
  return (
    <section className="strip" role="region" aria-label={shell.t("strip.label")} data-stale={stale !== null}>
      {cells.map((cell) => (
        <div className="strip-cell" key={cell.id} data-tone={cell.tone} title={cell.title}>
          <div className="strip-label">{cell.label}</div>
          <div className="strip-value" key={cell.value}>
            {cell.value}
          </div>
          {cell.sub !== undefined && <div className="strip-sub">{cell.sub}</div>}
        </div>
      ))}
      {stale !== null && (
        <div className="strip-stale">{shell.t("strip.stale", { duration: `${Math.round(stale / 1000)} s` })}</div>
      )}
    </section>
  );
}
