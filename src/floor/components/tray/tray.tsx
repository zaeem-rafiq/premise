// The tray (03-floor 3.13, CO38): one row per open card that can be answered — a `held` or
// `choice` card is a row while open; a `race` card joins once a candidate has `can_choose`.
// A row carries the card's own title and the `card.open` button that opens the card sheet.

import "./tray.css";

import { useContext } from "react";
import type { CardView, FloorState } from "../../../protocol/reducer/state.ts";
import { ShellContext } from "../../app/context.ts";

export type TrayProps = {
  floor: FloorState;
  onOpenCard: (cardId: string) => void;
};

/** The cards the tray lists, in `open_cards` order (CO38: a race row exists only once a
 * candidate can be chosen). */
export function trayCards(floor: FloorState): CardView[] {
  return floor.open_cards
    .map((id) => floor.cards[id])
    .filter(
      (view): view is CardView =>
        view !== undefined &&
        view.open &&
        (view.card.kind !== "race" ||
          Object.values(view.card.candidates ?? {}).some((candidate) => candidate.can_choose)),
    );
}

export function Tray({ floor, onOpenCard }: TrayProps) {
  const t = useContext(ShellContext)!.t;
  const cards = trayCards(floor);
  if (cards.length === 0) return null;
  return (
    <div className="tray" role="list" aria-label={t("needs.title", { n: cards.length })}>
      {cards.map((view) => (
        <div className="tray-row" role="listitem" key={view.card.card_id}>
          <span className="tray-title" dir="auto">
            {view.card.title}
          </span>
          <button type="button" onClick={() => onOpenCard(view.card.card_id)}>
            {t("card.open")}
          </button>
        </div>
      ))}
    </div>
  );
}
