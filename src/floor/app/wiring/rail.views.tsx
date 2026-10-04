// The floor-rail lane's tag→component bindings (the registry contract of `../registry.ts`).
// `app.tsx` resolves tags only through `../bindings.tsx`. Each binding takes the untyped
// `Record<string, unknown>` the seam passes and casts it to the component's props.

import type { ReactNode } from "react";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import { CardSheet } from "../../components/card-sheet/card-sheet.tsx";

export const views: Record<string, (props: Record<string, unknown>) => ReactNode> = {
  /** The no-frames card sheet of 03-floor 2.4/3.13/3.14 (held, choice, race). */
  "sheet.card": (props) => (
    <CardSheet
      floor={props.floor as FloorState}
      cardId={String(props.cardId ?? props.card_id ?? "")}
      onClose={typeof props.onClose === "function" ? (props.onClose as () => void) : () => undefined}
    />
  ),
};
