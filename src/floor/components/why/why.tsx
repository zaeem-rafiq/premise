// The Why card (03-floor 3.9, 2.5): a right-edge sheet, 760 wide; the pool area stays visible
// behind it so the tapped creature stays in view. Every section in the order of 3.9; every
// string from `src/copy`; stream and note text shown as text (FL8). `G` opens and closes the
// git drawer (6.6). The states of the 3.9 table are `WhyCard.status` + the `undone`/`partial`
// flags — all from `FloorState`, with the note route of 4.5 for a landing the page no longer
// holds (a digest; 404 in a summary_only pool, EV6).

import "./why.css";

import { useContext, useEffect, useRef, useState } from "react";
import type { Note } from "../../../protocol/note.ts";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import { UNDO_WINDOW } from "../../../protocol/constants.ts";
import { whyCard } from "../../../protocol/reducer/why.ts";
import { ShellContext } from "../../app/context.ts";
import { GitDrawer } from "../git-drawer/git-drawer.tsx";
import { PremiseLight } from "../lights/lights.tsx";
import { landingLabel } from "../../../copy/format.ts";
import {
  checkLines,
  landedLine,
  reliedRows,
  riskLines,
  saidLine,
  underLine,
  undoLines,
  whyHeadline,
  whyTitle,
} from "./model.ts";

export type WhySheetProps = {
  floor: FloorState;
  seq: number;
  onClose: () => void;
  /** Replay mode: the note route is live-only (4.5), so a missing record is `why.partial`. */
  mode?: "live" | "replay";
  /** Opens Who relies for a premise key or file (3.11). */
  onOpenWho?: (kind: string, key: string) => void;
  /** Opens the undo sheet for this landing (3.12; `undo.open` shows on `change` landings). */
  onOpenUndo?: (seq: number) => void;
};

export function WhySheet({ floor, seq, onClose, mode = "live", onOpenWho, onOpenUndo }: WhySheetProps) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [gitOpen, setGitOpen] = useState(false);
  const [fetched, setFetched] = useState<Note | null | undefined>(undefined);
  const [fetching, setFetching] = useState(false);

  // In Replay the note route does not answer (4.5): treat the record as absent at once.
  const resolved = fetched !== undefined ? fetched : mode === "replay" ? null : undefined;
  const card = whyCard(floor, seq, resolved);
  const title = whyTitle(floor, card);

  // Focus lands in the dialog on open (AX4); Esc closes (the app's own Esc handler does the
  // same). `G` toggles the drawer (6.6) — but never while typing in a field.
  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName ?? "";
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if ((event.key === "g" || event.key === "G") && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
        setGitOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      openerRef.current?.focus();
    };
  }, [onClose]);

  // The note route of 4.5 (live only): for a landing the page no longer holds in full, or one
  // whose note_json the stream did not carry in a non-summary pool. 404 -> fetched === null.
  useEffect(() => {
    if (!card.needsNote || fetched !== undefined || mode === "replay") return;
    let live = true;
    setFetching(true);
    void fetch(`/api/pools/${encodeURIComponent(floor.pool.id)}/landings/${seq}/note`)
      .then(async (response) => (response.ok ? ((await response.json()) as Note) : null))
      .then((note) => {
        if (live) setFetched(note);
      })
      .catch(() => {
        if (live) setFetched(null);
      })
      .finally(() => {
        if (live) setFetching(false);
      });
    return () => {
      live = false;
    };
  }, [card.needsNote, fetched, floor.pool.id, seq, mode]);

  const noteState: "held" | "loading" | "none" =
    card.note !== null
      ? "held"
      : card.needsNote && (fetching || fetched === undefined) && mode === "live"
        ? "loading"
        : "none";

  const checks = checkLines(card);
  const relied = reliedRows(card);
  const undo = undoLines(floor, card, shell.model);
  const risk = riskLines(card);
  const landed = landedLine(card);
  const tooOld = card.kind === "change" && floor.landed_order.indexOf(seq) >= UNDO_WINDOW;

  return (
    <div className="sheet-backdrop why-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      {gitOpen && (
        <GitDrawer floor={floor} card={card} noteState={noteState} note={card.note} onClose={() => setGitOpen(false)} />
      )}
      <div
        className="sheet why-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-status={card.status}
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="why-head-row">
          <div>
            <h2 className="sheet-title">{title}</h2>
            {(card.status === "live" || card.status === "unwitnessed") && (
              <p className="why-head" dir="auto">
                {whyHeadline(card, shell.model)}
              </p>
            )}
          </div>
          <button type="button" className="why-close" onClick={onClose}>
            {t("card.close")}
          </button>
        </header>

        {card.status === "seed" && <p className="why-note">{t("why.seed")}</p>}
        {card.status === "landing" && <p className="why-note">{t("why.landing")}</p>}
        {card.status === "loading" && <p className="why-note">{t("why.loading")}</p>}
        {card.status === "unwitnessed" && (
          <>
            <dl className="why-commit-lines">
              {card.commit !== null && (
                <>
                  <dt>commit</dt>
                  <dd dir="auto">
                    <code>{card.commit}</code>
                  </dd>
                </>
              )}
              {card.parentCommit !== null && (
                <>
                  <dt>parent</dt>
                  <dd dir="auto">
                    <code>{card.parentCommit}</code>
                  </dd>
                </>
              )}
              {card.tree !== null && (
                <>
                  <dt>tree</dt>
                  <dd dir="auto">
                    <code>{card.tree}</code>
                  </dd>
                </>
              )}
            </dl>
            <p className="why-note">{t("why.unwitnessed")}</p>
          </>
        )}

        {card.status === "live" && (
          <>
            {card.undone && (
              <p className="why-note why-undone" role="status">
                {t("why.undone", { landing: landingLabel(card.undoneBy ?? 0) })}
              </p>
            )}

            {card.undo !== null && (undo.tookBack !== null || undo.reopened !== null || undo.kept !== null) && (
              <section className="why-section" data-section="undo">
                {undo.tookBack !== null && <p dir="auto">{undo.tookBack}</p>}
                {undo.reopened !== null && <p dir="auto">{undo.reopened}</p>}
                {undo.kept !== null && <p dir="auto">{undo.kept}</p>}
              </section>
            )}

            {card.intentText !== null && (
              <section className="why-section" data-section="asked">
                <h3>{t("why.asked")}</h3>
                <p dir="auto">
                  {t("why.asked.line", { requester: card.requester ?? "", "intent text": card.intentText })}
                </p>
              </section>
            )}

            {card.agent !== null && (
              <section className="why-section" data-section="wrote">
                <h3>{t("why.wrote")}</h3>
                <p>
                  {card.agent === "synthetic"
                    ? t("why.wrote.synthetic")
                    : t("why.wrote.real", { model: card.model !== null ? shell.model(card.model) : "" })}
                </p>
              </section>
            )}

            {relied.length > 0 && (
              <section className="why-section" data-section="relied">
                <h3>{t("why.relied")}</h3>
                <ul className="why-relied">
                  {relied.map((row) => (
                    <li key={row.id} className="why-relied__row">
                      <PremiseLight
                        light={{ id: row.id, light: row.light, edit: row.edit, tip: row.label }}
                        size="list"
                      />
                      <span className="why-relied__label" dir="auto">
                        {row.label}
                      </span>
                      {row.flags.length > 0 && <span className="why-relied__flags">({row.flags.join(", ")})</span>}
                      {onOpenWho !== undefined && (
                        <button
                          type="button"
                          className="why-relied__who"
                          onClick={() => onOpenWho(row.id.split(" ")[0] ?? "", row.id.split(" ").slice(1).join(" "))}
                        >
                          {t("who.open")}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="why-section" data-section="under">
              <h3>{t("why.under")}</h3>
              {card.under.length === 0 && <p>{t("why.under.none")}</p>}
              {card.under.map((under, index) => (
                <div key={index} className="why-under__row">
                  {under.items.map((item, itemIndex) => (
                    <p key={itemIndex} dir="auto">
                      {underLine(under, item)}
                    </p>
                  ))}
                  {under.statement !== null && <p dir="auto">{saidLine(under.statement)}</p>}
                </div>
              ))}
            </section>

            {checks !== null && (
              <section className="why-section" data-section="checked">
                <h3>{t("why.checked")}</h3>
                <p>{checks.count}</p>
                {checks.labels.length > 0 && (
                  <details className="why-checks">
                    <summary>{t("why.checked.all")}</summary>
                    <ul>
                      {checks.labels.map((label, index) => (
                        <li key={index} dir="auto">
                          {label}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </section>
            )}

            {landed !== null && (
              <section className="why-section" data-section="landed">
                <h3>{t("why.landed_how")}</h3>
                <p>{landed}</p>
                {risk !== null && (
                  <div className="why-risk">
                    {risk.lines.map((line, index) => (
                      <p key={index}>{line}</p>
                    ))}
                    <p className="why-risk__footer">{risk.footer}</p>
                  </div>
                )}
              </section>
            )}

            {(card.paths.length > 0 || card.writes.length > 0) && (
              <section className="why-section" data-section="changed">
                <h3>{t("why.changed")}</h3>
                <ul className="why-changed">
                  {card.paths.map((path) => (
                    <li key={path} dir="auto">
                      {path}
                    </li>
                  ))}
                  {card.writes
                    .filter((write) => write.kind === "entity")
                    .map((write, index) => (
                      <li key={`e-${index}`} dir="auto">
                        {write.key}
                      </li>
                    ))}
                </ul>
              </section>
            )}

            {card.partial && <p className="why-note why-partial">{t("why.partial")}</p>}
          </>
        )}

        <div className="sheet-actions">
          {(card.status === "live" || card.status === "unwitnessed") && (
            <button
              type="button"
              className="why-git"
              onClick={() => setGitOpen((open) => !open)}
              aria-expanded={gitOpen}
            >
              {t("why.git")}
            </button>
          )}
          {onOpenWho !== undefined && card.paths.length > 0 && (
            <button type="button" className="why-who" onClick={() => onOpenWho("file", card.paths[0]!)}>
              {t("who.open")}
            </button>
          )}
          {onOpenUndo !== undefined &&
            card.kind === "change" &&
            !card.undone &&
            card.status === "live" &&
            shell.settings.features.undo && (
              <button
                type="button"
                className="why-undo"
                disabled={tooOld}
                title={tooOld ? t("undo.too_old") : undefined}
                onClick={() => onOpenUndo(seq)}
              >
                {t("undo.open")}
              </button>
            )}
        </div>
      </div>
    </div>
  );
}
