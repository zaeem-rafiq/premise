// The card sheet of 03-floor 2.4, 3.13 and 3.14 — the no-frames form this slice builds: one sheet
// serves `held`, `choice` and `race`. Title, body and option labels are the card's own (CD5); the
// buttons are `Card.options`, in order, the first the primary at the right (CD4). A tap POSTs the
// card-action route of 4.5 once (`request_id`, `submit_ids`, the typed reason; `attempt_id` only
// for `choose`, CO38a); a failure keeps the sheet open with the 5.9 sentence. The closing sentence
// and the sheet's lifetime come from `card.closed` on the stream (FL1, FL2).

import "./card-sheet.css";

import { useContext, useEffect, useRef, useState } from "react";
import type { CardOption } from "../../../protocol/cards.ts";
import { STALE_CARD_MS } from "../../../protocol/constants.ts";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import { errorSentence } from "../../../copy/errors.ts";
import { ShellContext } from "../../app/context.ts";
import { PremiseLight } from "../lights/lights.tsx";
import { postJson, requestId } from "../rail/request.ts";
import type { CardSheetModel, RaceColumn } from "./model.ts";
import { cardSheetModel } from "./model.ts";

export type CardSheetProps = {
  floor: FloorState;
  cardId: string;
  /** Closes the sheet (Esc, the Close button, or the auto-close of a closed card). */
  onClose: () => void;
};

const OWNER_CLOSE_MS = 1_500;

/** One race column of the sheet (03 3.14): facts, the state line, the one `choose` button. */
function RaceColumnView({
  column,
  chooseLabel,
  busy,
  onChoose,
}: {
  column: RaceColumn;
  /** The label of the card's one option, `choose`, as Trunk sent it (CD5). */
  chooseLabel: string;
  busy: boolean;
  onChoose: (attemptId: string) => void;
}) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  return (
    <div className="card-sheet__candidate" data-attempt-id={column.attemptId}>
      <p className="card-sheet__model">{shell.model(column.modelId)}</p>
      {column.lights.length > 0 && (
        <span className="card-sheet__lights">
          <span className="card-sheet__relies">{t("attempt.relies")}</span>
          {column.lights.map((light) => (
            <PremiseLight key={light.id} light={light} />
          ))}
        </span>
      )}
      {column.checks !== null && <p className="card-sheet__checks">{column.checks}</p>}
      <p className="card-sheet__fact">
        {column.took} &middot; {column.cost}
      </p>
      <p className="card-sheet__fact">{column.blast}</p>
      {column.working !== null && (
        <p className="card-sheet__state">
          {t("race.working")} &middot; {column.working.word} &middot; step {column.working.steps}
        </p>
      )}
      {column.stopped !== null && <p className="card-sheet__state">{column.stopped}</p>}
      {column.noPreview && <p className="card-sheet__state">{t("held.no_preview")}</p>}
      {column.canChoose && (
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => onChoose(column.attemptId)}
        >
          {chooseLabel}
        </button>
      )}
    </div>
  );
}

/**
 * The card sheet. Renders nothing — and asks to close — when the card id is not in `floor.cards`.
 * While a request is in flight every action button is disabled (CO2: two fast taps send one).
 */
export function CardSheet({ floor, cardId, onClose }: CardSheetProps) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  const view = floor.cards[cardId];
  const model: CardSheetModel | null =
    view === undefined ? null : cardSheetModel(floor, view, { features: shell.settings.features, visitor: shell.visitor });
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Esc closes the sheet and does nothing else (CO37). Focus lands in the dialog on open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Closed cards: the sentence reads for 1.5 s (owner) or STALE_CARD_MS (system), then closes.
  useEffect(() => {
    if (model?.closedSentence == null || model.closedSentence === null) return;
    const wait = model.closedByOwner ? OWNER_CLOSE_MS : STALE_CARD_MS;
    const timer = window.setTimeout(onClose, wait);
    return () => window.clearTimeout(timer);
  }, [model?.closedSentence, model?.closedByOwner, onClose]);

  // A card that left `floor.cards` closes the sheet.
  useEffect(() => {
    if (model === null) onClose();
  }, [model, onClose]);

  if (model === null) return null;

  const send = (option: CardOption, attemptId?: string): void => {
    if (inFlightRef.current || model.closedSentence !== null) return;
    inFlightRef.current = true;
    setBusy(true);
    setError(null);
    void postJson(`/api/pools/${encodeURIComponent(floor.pool.id)}/cards/${encodeURIComponent(cardId)}`, {
      option,
      submit_ids: model.submitIds,
      ...(attemptId !== undefined ? { attempt_id: attemptId } : {}),
      ...(reason.trim() !== "" ? { reason: reason.trim() } : {}),
      request_id: requestId(),
    }).then((result) => {
      inFlightRef.current = false;
      setBusy(false);
      if (!result.ok) setError(errorSentence(result.status, result.code));
    });
  };

  const primary = model.options[0];
  const others = model.options.slice(1);

  return (
    <div className="card-sheet__backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="card-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={model.title}
        data-kind={model.kind}
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="card-sheet__head">
          <div>
            <h2 className="card-sheet__title">{model.title}</h2>
            {model.body.map((sentence, index) => (
              <p className="card-sheet__body" key={index}>
                {sentence}
              </p>
            ))}
            {model.intentLine !== null && (
              <p className="card-sheet__intent" dir="auto">
                {model.intentLine}
              </p>
            )}
          </div>
          <button type="button" className="card-sheet__close" onClick={onClose}>
            {t("card.close")}
          </button>
        </header>

        {model.closedSentence !== null ? (
          <p className="card-sheet__closed">{model.closedSentence}</p>
        ) : (
          <>
            {model.previewNote !== null && <p className="card-sheet__note">{model.previewNote}</p>}

            {model.race !== null ? (
              <div className="card-sheet__race">
                {model.race.map((column) => (
                  <RaceColumnView
                    key={column.attemptId}
                    column={column}
                    chooseLabel={primary?.label ?? ""}
                    busy={busy}
                    onChoose={(attemptId) => send("choose", attemptId)}
                  />
                ))}
              </div>
            ) : (
              <div className="card-sheet__grid">
                {model.changes !== null && (
                  <section>
                    <h3 className="card-sheet__heading">{t("held.changes")}</h3>
                    <ul className="card-sheet__paths">
                      {model.changes.map((row) => (
                        <li key={row.path}>
                          <span className="card-sheet__path" dir="auto">
                            {row.path}
                          </span>
                          {row.tierLabel !== null && (
                            <span className="card-sheet__tier">{row.tierLabel}</span>
                          )}
                          {row.entities.length > 0 && (
                            <span className="card-sheet__entities" dir="auto">
                              {row.entities.join(", ")}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {model.affects !== null && model.affects.length > 0 && (
                  <section>
                    <h3 className="card-sheet__heading">{t("held.affects")}</h3>
                    {model.affects.map((line, index) => (
                      <p className="card-sheet__affect" key={index}>
                        {line}
                      </p>
                    ))}
                  </section>
                )}
                {model.checked !== null && (
                  <section>
                    <h3 className="card-sheet__heading">{t("held.checked")}</h3>
                    {model.checked.summary !== null && <p>{model.checked.summary}</p>}
                    {model.checked.lights.length > 0 && (
                      <span className="card-sheet__lights">
                        <span className="card-sheet__relies">{t("attempt.relies")}</span>
                        {model.checked.lights.map((light) => (
                          <PremiseLight key={light.id} light={light} />
                        ))}
                      </span>
                    )}
                    {model.checked.checks !== null && (
                      <ul className="card-sheet__checklist">
                        {model.checked.checks.map((check, index) => (
                          <li key={index} data-ok={check.ok}>
                            {check.ok ? "\u2713" : "\u2717"} {check.label}
                            {check.error !== null && ` — ${check.error}`}
                          </li>
                        ))}
                      </ul>
                    )}
                    {model.checked.blind !== null && (
                      <p className="card-sheet__blind">{model.checked.blind}</p>
                    )}
                    {model.risk !== null && (
                      <div className="card-sheet__risk">
                        {model.risk.kind === "lines" ? (
                          <>
                            {model.risk.lines.map((line, index) => (
                              <p key={index}>{line}</p>
                            ))}
                            <p className="card-sheet__risk-footer">{model.risk.footer}</p>
                          </>
                        ) : (
                          <p>{model.risk.note}</p>
                        )}
                      </div>
                    )}
                  </section>
                )}
              </div>
            )}

            {model.reasonLabel !== null && (
              <label className="card-sheet__reason">
                <span>{model.reasonLabel}</span>
                <input
                  type="text"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  disabled={busy}
                />
              </label>
            )}

            {shell.visitor ? (
              <p className="card-sheet__visitor">{t("held.visitor")}</p>
            ) : model.race === null ? (
              <div className="card-sheet__actions">
                {others.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    disabled={busy}
                    title={option.tip ?? undefined}
                    onClick={() => send(option.id)}
                  >
                    {option.label}
                  </button>
                ))}
                {primary !== undefined && (
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    title={primary.tip ?? undefined}
                    onClick={() => send(primary.id)}
                  >
                    {primary.label}
                  </button>
                )}
                {busy && <span className="card-sheet__busy">{t("held.landing")}</span>}
              </div>
            ) : null}

            {error !== null && <p className="card-sheet__error">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}
