// The floor-pool lane's tag→component bindings (the registry contract of `../registry.ts`).
// Bound here when the lane registers entries: `view.compare`, `sheet.why`, `sheet.who`,
// `sheet.undo`. `app.tsx` resolves tags only through `../bindings.tsx`.

import type { ReactNode } from "react";
import type { FloorState } from "../../../protocol/reducer/index.ts";
import type { FrameStats } from "../../components/pool-frame/frame-driver.ts";
import { Compare } from "../../components/compare/compare.tsx";

export const views: Record<string, (props: Record<string, unknown>) => ReactNode> = {
  /** The Compare view of 03-floor 2.3/3.6 (registered in `pool-area.ts`). `floor` is the prop
   * name `app.tsx` gives a body view (see the `view.swarm` call); `state` is accepted as an
   * alias for hosts that name it so. `mode`, `paused`, `onPausedChange`, `onFrameStats`,
   * `seed` and `onBack` are the shell's slice of `ViewState` plus the close callback. */
  "view.compare": (props) => (
    <Compare
      pool={String(props.pool ?? "")}
      state={(props.state ?? props.floor) as FloorState}
      mode={props.mode === "replay" ? "replay" : "live"}
      paused={props.paused === undefined ? undefined : props.paused === true}
      onPausedChange={
        typeof props.onPausedChange === "function" ? (props.onPausedChange as (p: boolean) => void) : undefined
      }
      onFrameStats={
        typeof props.onFrameStats === "function"
          ? (props.onFrameStats as (frame: string, stats: FrameStats, atMs: number) => void)
          : undefined
      }
      seed={typeof props.seed === "number" ? props.seed : undefined}
      onBack={typeof props.onBack === "function" ? (props.onBack as () => void) : undefined}
    />
  ),
};
