// The floor-pool lane's tag→component bindings (the registry contract of `../registry.ts`).
// Bound here when the lane registers entries: `view.compare`, `sheet.why`, `sheet.who`,
// `sheet.undo`. `app.tsx` resolves tags only through `../bindings.tsx`.

import type { ReactNode } from "react";
import type { FloorState } from "../../../protocol/reducer/index.ts";
import type { FrameStats } from "../../components/pool-frame/frame-driver.ts";
import { Compare } from "../../components/compare/compare.tsx";
import { WhySheet } from "../../components/why/why.tsx";
import { WhoSheet } from "../../components/who-relies/who-relies.tsx";
import { UndoSheet } from "../../components/undo-sheet/undo-sheet.tsx";

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
  /** The Why card of 03-floor 3.9 (the git drawer of 3.10 lives inside it). */
  "sheet.why": (props) => (
    <WhySheet
      floor={props.floor as FloorState}
      seq={Number(props.seq ?? 0)}
      mode={props.mode === "replay" ? "replay" : "live"}
      onClose={typeof props.onClose === "function" ? (props.onClose as () => void) : () => undefined}
      onOpenWho={
        typeof props.onOpenWho === "function" ? (props.onOpenWho as (kind: string, key: string) => void) : undefined
      }
      onOpenUndo={typeof props.onOpenUndo === "function" ? (props.onOpenUndo as (seq: number) => void) : undefined}
    />
  ),
  /** The Who relies panel of 03-floor 3.11. React keeps the shell's `key` prop for itself, so the
   * shell names the panel's subject in `whoKey`. */
  "sheet.who": (props) => (
    <WhoSheet
      floor={props.floor as FloorState}
      kind_={String(props.kind_ ?? "")}
      whoKey={typeof props.whoKey === "string" ? props.whoKey : undefined}
      onClose={typeof props.onClose === "function" ? (props.onClose as () => void) : () => undefined}
      onOpenWhy={typeof props.onOpenWhy === "function" ? (props.onOpenWhy as (seq: number) => void) : undefined}
      onOpenAttempt={
        typeof props.onOpenAttempt === "function" ? (props.onOpenAttempt as (attemptId: string) => void) : undefined
      }
      onKinds={typeof props.onKinds === "function" ? (props.onKinds as (kinds: string[]) => void) : undefined}
    />
  ),
  /** The undo sheet of 03-floor 3.12 (registered in `pool-area.ts`): `app.tsx` calls it with
   * `{floor, seq, onClose}` when the Why card's `undo.open` fires. */
  "sheet.undo": (props) => (
    <UndoSheet
      floor={props.floor as FloorState}
      seq={Number(props.seq ?? 0)}
      onClose={typeof props.onClose === "function" ? (props.onClose as () => void) : () => undefined}
    />
  ),
};
