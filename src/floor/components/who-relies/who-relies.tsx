// The Who relies panel (03-floor 3.11, 01-core 11.6): same right-edge slot and width as the
// Why sheet. For a file it first lists the keys known for that path plus the file itself
// (`who.pick`); for an entity the two lists directly: `who.in_flight` (attempts with a live
// premise, with flags and status word) and `who.landed` (landed, not undone changes, each
// opening its Why card). While it is open it reports the creature kinds of its lists to the
// pool frame through `onKinds` (CO23b), and an empty list when it closes.

import "./who-relies.css";

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import type { WhoTarget } from "../../../protocol/reducer/who-relies.ts";
import { whoKinds, whoPickList, whoRelies } from "../../../protocol/reducer/who-relies.ts";
import { ShellContext } from "../../app/context.ts";
import { FLOOR_KEEP_LANDINGS } from "../../../protocol/constants.ts";
import { changeName, keyLabel, keyShort } from "../../../copy/names.ts";
import { statusOf } from "../attempt-card/model.ts";
import type { AttemptView } from "../../../protocol/reducer/state.ts";
import { lightFlagWords } from "./model.ts";

export type WhoSheetProps = {
  floor: FloorState;
  /** The premise kind the opener named ("file" for a tile, "entity" for a light). */
  kind_: string;
  /**
   * The key the opener named. The shell's `sheet.who` call today passes it under the prop name
   * `key`, which React consumes and never delivers — the shell must pass `whoKey` instead.
   */
  whoKey?: string;
  onClose: () => void;
  /** Opens the Why card of a landed row. */
  onOpenWhy?: (seq: number) => void;
  /** Opens (expands) the attempt card of an in-flight row. */
  onOpenAttempt?: (attemptId: string) => void;
  /** CO23b: the creature kinds of the shown lists; [] while closed. */
  onKinds?: (kinds: string[]) => void;
};

function isKind(kind: string): kind is WhoTarget["kind"] {
  return kind === "entity" || kind === "file" || kind === "listing" || kind === "query" || kind === "check";
}

export function WhoSheet({ floor, kind_, whoKey, onClose, onOpenWhy, onOpenAttempt, onKinds }: WhoSheetProps) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const [picked, setPicked] = useState<WhoTarget | null>(null);

  // A file tile first lists the keys known for the path plus the file itself (3.11).
  const pickList = useMemo(
    () => (kind_ === "file" && whoKey !== undefined ? whoPickList(floor, whoKey) : null),
    [floor, kind_, whoKey],
  );
  const target: WhoTarget | null =
    picked ??
    (whoKey === undefined || !isKind(kind_)
      ? null
      : pickList !== null && pickList.length === 1
        ? (pickList[0] ?? null)
        : kind_ === "file"
          ? null // wait for the owner to pick a part of the file
          : { kind: kind_, key: whoKey });

  const result = useMemo(() => (target === null ? null : whoRelies(floor, target)), [floor, target]);
  const kinds = useMemo(
    () => (target === null || result === null ? [] : whoKinds(floor, target, result)),
    [floor, target, result],
  );

  // CO23b: while the panel is open the pool frame outlines these creatures; [] when it closes.
  useEffect(() => {
    onKinds?.(kinds);
    return () => onKinds?.([]);
  }, [kinds, onKinds]);

  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      openerRef.current?.focus();
    };
  }, [onClose]);

  const label =
    target !== null
      ? keyLabel(target.kind === "check" ? "check" : target.kind, target.key)
      : whoKey !== undefined && isKind(kind_)
        ? keyLabel(kind_, whoKey)
        : (whoKey ?? "");
  const title = t("who.title", { keyLabel: label });

  return (
    <div className="sheet-backdrop who-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="sheet who-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="who-head-row">
          <h2 className="sheet-title" dir="auto">
            {title}
          </h2>
          <button type="button" className="who-close" onClick={onClose}>
            {t("card.close")}
          </button>
        </header>

        {pickList !== null && pickList.length > 1 && picked === null && whoKey !== undefined && (
          <section className="who-pick">
            <p>{t("who.pick", { path: whoKey })}</p>
            <ul>
              {pickList.map((entry) => (
                <li key={`${entry.kind} ${entry.key}`}>
                  <button type="button" onClick={() => setPicked(entry)}>
                    {keyShort(entry.kind, entry.key)}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {result !== null && result.summaryOnly && <p className="who-note">{t("who.summary_only")}</p>}

        {result !== null && !result.summaryOnly && result.inFlight.length === 0 && result.landed.length === 0 && (
          <p className="who-note">{t("who.none")}</p>
        )}

        {result !== null && !result.summaryOnly && (result.inFlight.length > 0 || result.landed.length > 0) && (
          <>
            <section className="who-list" data-list="in_flight">
              <h3>{t("who.in_flight", { n: result.inFlight.length })}</h3>
              <ul>
                {result.inFlight.map((row) => {
                  const status = statusOf(floor, row.attempt, shell.visitor);
                  const flags = lightFlagWords(row.matched);
                  return (
                    <li key={row.attempt.id}>
                      <button
                        type="button"
                        className="who-row"
                        onClick={() => onOpenAttempt?.(row.attempt.id)}
                      >
                        <span className="who-row__name" dir="auto">
                          {attemptName(floor, row.attempt)}
                        </span>
                        <span className="who-row__status">{status.word}</span>
                        {flags !== "" && <span className="who-row__flags">({flags})</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section className="who-list" data-list="landed">
              <h3>{t("who.landed", { n: result.landed.length })}</h3>
              <ul>
                {result.landed.map((row) => (
                  <li key={row.seq}>
                    <button type="button" className="who-row" onClick={() => onOpenWhy?.(row.seq)}>
                      <span className="who-row__name" dir="auto">
                        {`landing ${row.seq} ${landingName(floor, row.seq)}`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            {result.windowed && (
              <p className="who-note who-window">{t("who.window", { FLOOR_KEEP_LANDINGS })}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function attemptName(floor: FloorState, attempt: AttemptView): string {
  const intent = floor.intents[attempt.intent_id];
  return changeName({
    intentText: intent?.text ?? "",
    race: intent?.race ?? attempt.race,
    model: attempt.model,
    premises: Object.values(attempt.premises),
  });
}

function landingName(floor: FloorState, seq: number): string {
  const entry = floor.landings[seq];
  if (entry === undefined) return "";
  const intent = entry.intent_id !== null ? floor.intents[entry.intent_id] : undefined;
  const attempt = entry.attempt_id !== null ? floor.attempts[entry.attempt_id] : undefined;
  return changeName({
    intentText: intent?.text ?? "",
    race: intent?.race ?? attempt?.race ?? false,
    model: attempt?.model ?? null,
    premises: entry.digest === true ? [] : entry.premises,
  });
}
