// The Needs-you badge and key N (03-floor 3.19, CO38, 6.6): the open cards that can be
// answered, oldest first. These are the cards the tray lists (`trayCards`), so a race card
// counts only while one of its candidates has `can_choose`. The badge shows how many there
// are; the badge and key N open the first of them.

import type { FloorState } from "../../protocol/reducer/state.ts";
import { trayCards } from "../components/tray/tray.tsx";

/** The ids of the open cards the owner can answer, oldest first. */
export function needsCards(floor: FloorState): string[] {
  return trayCards(floor).map((view) => view.card.card_id);
}
