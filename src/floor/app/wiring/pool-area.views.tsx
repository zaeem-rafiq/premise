// The floor-pool lane's tag→component bindings (the registry contract of `../registry.ts`).
// Bound here when the lane registers entries: `view.compare`, `sheet.why`, `sheet.who`,
// `sheet.undo`. `app.tsx` resolves tags only through `../bindings.tsx`.

import type { ReactNode } from "react";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import { WhySheet } from "../../components/why/why.tsx";
import { WhoSheet } from "../../components/who-relies/who-relies.tsx";

export const views: Record<string, (props: Record<string, unknown>) => ReactNode> = {
  /** The Why card of 03-floor 3.9 (the git drawer of 3.10 lives inside it). */
  "sheet.why": (props) => (
    <WhySheet
      floor={props.floor as FloorState}
      seq={Number(props.seq ?? 0)}
      onClose={typeof props.onClose === "function" ? (props.onClose as () => void) : () => undefined}
      onOpenWho={typeof props.onOpenWho === "function" ? (props.onOpenWho as (kind: string, key: string) => void) : undefined}
      onOpenUndo={typeof props.onOpenUndo === "function" ? (props.onOpenUndo as (seq: number) => void) : undefined}
    />
  ),
  /** The Who relies panel of 03-floor 3.11. The shell's `key` prop is React-reserved and never
   * reaches the component; until the shell passes `whoKey`, the panel shows its pick/empty state. */
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
};