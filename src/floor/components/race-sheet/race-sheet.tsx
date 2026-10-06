// The race sheet of 03-floor 3.14: one column per candidate of `Card.attempt_ids`, in order —
// the preview frame of `Card.preview.after[id]` while `can_choose` (the card has no preview for it
// reads `held.no_preview`, the error row), model name, lights, checks, `race.took`/`race.cost`
// (`race.unknown` for a null the card carries, CO39 — never a zero), `race.blast` of
// `Card.blast_radius[id]` and the Choose button of the card's one option (CD5). A working or
// stopped candidate shows its state line and no frame (3.14 loading row). The typed reason goes in
// `reason` and nowhere else (CO38a); `card.closed` with action `choose` reads `race.closed` and
// the sheet closes after 1.5 s. The chrome is the shared card shell of card-sheet.tsx.

import { RaceColumnView, CardSheetShell, useCardSheet } from "../card-sheet/card-sheet.tsx";
import type { CardSheetProps } from "../card-sheet/card-sheet.tsx";

/**
 * The race sheet. `model.race` is one `RaceColumn` per attempt id of the card, already resolved to
 * sentences; the shared shell renders the reason field and keeps buttons out of the actions row —
 * each column carries its own Choose.
 */
export function RaceSheet({ floor, cardId, onClose }: CardSheetProps) {
  const st = useCardSheet(floor, cardId, onClose);
  if (st === null) return null;
  const { model } = st;
  return (
    <CardSheetShell st={st} onClose={onClose}>
      <div className="card-sheet__race">
        {model.race?.map((column) => (
          <RaceColumnView
            key={column.attemptId}
            column={column}
            pool={floor.pool.id}
            chooseLabel={model.options[0]?.label ?? ""}
            busy={st.busy}
            onChoose={(attemptId) => st.send("choose", attemptId)}
          />
        ))}
      </div>
    </CardSheetShell>
  );
}
