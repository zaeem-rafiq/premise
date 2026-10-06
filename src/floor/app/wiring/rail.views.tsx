// The floor-rail lane's tag→component bindings (the registry contract of `../registry.ts`).
// `app.tsx` resolves tags only through `../bindings.tsx`. Each binding takes the untyped
// `Record<string, unknown>` the seam passes and casts it to the component's props.

import type { ReactNode } from "react";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import { CardSheet } from "../../components/card-sheet/card-sheet.tsx";
import type { CardSheetProps } from "../../components/card-sheet/card-sheet.tsx";
import { HeldSheet } from "../../components/held-sheet/held-sheet.tsx";
import { RaceSheet } from "../../components/race-sheet/race-sheet.tsx";

/** The `{floor, cardId, onClose}` props the card sheets take, from the untyped seam record. */
function cardSheetProps(props: Record<string, unknown>): CardSheetProps {
  return {
    floor: props.floor as FloorState,
    cardId: String(props.cardId ?? props.card_id ?? ""),
    onClose: typeof props.onClose === "function" ? (props.onClose as () => void) : () => undefined,
  };
}

export const views: Record<string, (props: Record<string, unknown>) => ReactNode> = {
  /** The card sheet of 03-floor 2.4: dispatched on the card's kind — `held` to the held sheet of
   * 3.13, `race` to the race sheet of 3.14, everything else (`choice`, and a card not yet in
   * `floor.cards`) to the shared no-frames surface of `card-sheet.tsx`. */
  "sheet.card": (props) => {
    const { floor, cardId, onClose } = cardSheetProps(props);
    const kind = floor.cards[cardId]?.card.kind;
    if (kind === "held") return <HeldSheet floor={floor} cardId={cardId} onClose={onClose} />;
    if (kind === "race") return <RaceSheet floor={floor} cardId={cardId} onClose={onClose} />;
    return <CardSheet floor={floor} cardId={cardId} onClose={onClose} />;
  },
  /** The held-change sheet of 03-floor 3.13, bound by kind. */
  "sheet.held": (props) => <HeldSheet {...cardSheetProps(props)} />,
  /** The race sheet of 03-floor 3.14, bound by kind. */
  "sheet.race": (props) => <RaceSheet {...cardSheetProps(props)} />,
};
