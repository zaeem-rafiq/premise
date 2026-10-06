// The held-change sheet of 03-floor 3.13: title, body and intent of the card (5.10), the two
// commit frames `held.before` and `held.after` (CO36), the "What it changes / Who it affects /
// What was checked" grid with the blast-radius sentences (CO35) and the risk lines, the reason
// field and the options of `Card.options` — Land first (primary), Decline, and "Land now" only
// while the card offers `land_now` (CO35a). `features.held` false renders the minimal form (HD1):
// no frames, no affects, no risk. The chrome — closing sentence, stale card, reason, buttons,
// request error — is the shared card shell of card-sheet.tsx.

import "./held-sheet.css";

import { useContext } from "react";
import { ShellContext } from "../../app/context.ts";
import { CardSheetFacts, CardSheetShell, useCardSheet } from "../card-sheet/card-sheet.tsx";
import type { CardSheetProps } from "../card-sheet/card-sheet.tsx";
import { SheetFrameCell } from "../card-sheet/commit-frame.tsx";

/**
 * The held sheet. The `frames` of the model carry the two `FrameAddress`es — `Card.preview.before`
 * and `Card.preview.after[attempt_id]` — or the in-place sentence of the state table
 * (`held.preview_building`, `held.no_preview`; FR32). In the minimal form `frames` is null and the
 * grid alone renders.
 */
export function HeldSheet({ floor, cardId, onClose }: CardSheetProps) {
  const shell = useContext(ShellContext)!;
  const st = useCardSheet(floor, cardId, onClose);
  if (st === null) return null;
  const { model } = st;
  return (
    <CardSheetShell st={st} onClose={onClose}>
      {model.frames !== null && (
        <div className="held-sheet__frames">
          <SheetFrameCell
            label={shell.t("held.before")}
            pool={floor.pool.id}
            address={model.frames.before}
            note={model.frames.beforeNote}
            title={shell.t("held.before")}
          />
          <SheetFrameCell
            label={shell.t("held.after")}
            pool={floor.pool.id}
            address={model.frames.after}
            note={model.frames.afterNote}
            title={shell.t("held.after")}
          />
        </div>
      )}
      <CardSheetFacts model={model} />
    </CardSheetShell>
  );
}
