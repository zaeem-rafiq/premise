// The attempt card (03-floor 3.2, 3.3): the collapsed rail item, the CO10 compact variant and the
// expanded form — heads-up panels (3.4, CO11), the "Relies on" list (CO17), "What it changes",
// the checks block (5.7) and the owner's `attempt.stop` (4.5). It is a pure function of
// `FloorState` and the page clock; the sentences and the light tips come from `model.ts` and
// `src/copy`, so the component carries no text of its own (CP1, FL8).

import "./attempt-card.css";

import { useEffect, useState } from "react";
import type { AttemptView, FloorState } from "../../../protocol/reducer/state.ts";
import { errorSentence } from "../../../copy/errors.ts";
import { text } from "../../../copy/strings.ts";
import { inFlight } from "../../state/derive.ts";
import { postJson, requestId } from "../rail/request.ts";
import { HeadsUpPanel } from "../heads-up/heads-up.tsx";
import { headsUpModel } from "../heads-up/model.ts";
import { PremiseLight, PremiseRowItem } from "../lights/lights.tsx";
import { premiseRows } from "../lights/model.ts";
import type { LightView, StatusShape } from "./model.ts";
import { cardModel, checkRows, checksSummary, lightsInOrder, opRows } from "./model.ts";

export type AttemptCardProps = {
  /** The attempt this card shows (one `AttemptView` and its intent, 03 3.2). */
  attempt: AttemptView;
  /** The reducer state it reads (lights order, landing confirmation, slot check). */
  state: FloorState;
  /** The page clock: the stream clock live, the recorded clock in Replay (FL9, RY13). */
  clock: number;
  /** CP7: a visitor, and everyone in Replay (the owner sees `false`). */
  visitor: boolean;
  /** CO10: the compact form the list uses with more than 5 attempt cards. */
  compact?: boolean;
  /** CO11: the rail allocates its global automatic panel window once per event. */
  autoHns?: readonly number[];
  /** Opens the attempt's card sheet (`attempt.open_card`, 03 3.2 `held` row). */
  onOpenCard?: (cardId: string) => void;
  /** Opens the Who-relies sheet of a premise row (`who.open`, 03 3.11). */
  onOpenWho?: (kind: string, key: string) => void;
  /** The owner's stop request; the default posts the stop route of 4.5. */
  onStop?: (attemptId: string) => Promise<{ ok: boolean; status: number | null; code?: string }>;
};

/** The status shape of 03 5.3. Decorative: the word beside it carries the state (VD10, AX7). */
function StatusGlyph({ shape }: { shape: StatusShape }) {
  return (
    <svg
      className={`attempt-card__glyph attempt-card__glyph--${shape}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {shape === "ring-dotted" && (
        <circle
          cx="12"
          cy="12"
          r="7"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeDasharray="0.1 4.6"
        />
      )}
      {shape === "dot" && <circle className="attempt-card__pulse" cx="12" cy="12" r="5" fill="currentColor" />}
      {shape === "diamond" && <path d="M12 4 20 12 12 20 4 12Z" fill="currentColor" />}
      {shape === "triangle" && <path d="M12 5 20 19 4 19Z" fill="currentColor" />}
      {shape === "half" && (
        <>
          <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="2.4" />
          <path d="M12 5 A7 7 0 0 1 12 19 Z" fill="currentColor" />
        </>
      )}
      {shape === "ring" && <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="2.4" />}
      {shape === "bars" && (
        <>
          <rect x="8" y="5" width="3" height="14" rx="1.2" fill="currentColor" />
          <rect x="13" y="5" width="3" height="14" rx="1.2" fill="currentColor" />
        </>
      )}
      {shape === "circle-tick" && (
        <>
          <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="2.4" />
          <path
            d="M8.4 12.3 10.9 14.8 15.6 9.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {shape === "cross" && (
        <path d="M8 8 16 16 M16 8 8 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      )}
    </svg>
  );
}

/** The owner's `attempt.stop` (4.5): one request per tap until the response arrives (CO2). */
function StopControl({
  attempt,
  pool,
  onStop,
}: {
  attempt: AttemptView;
  pool: string;
  onStop?: AttemptCardProps["onStop"];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="attempt-card__stop">
      <button
        type="button"
        className="danger"
        disabled={busy}
        onClick={() => {
          if (busy) return;
          setBusy(true);
          setError(null);
          const send =
            onStop ??
            ((id: string) =>
              postJson(`/api/pools/${encodeURIComponent(pool)}/attempts/${encodeURIComponent(id)}/stop`, {
                request_id: requestId(),
              }));
          void send(attempt.id).then((result) => {
            setBusy(false);
            if (!result.ok) setError(errorSentence(result.status, result.code));
          });
        }}
      >
        {busy ? text("attempt.stopping") : text("attempt.stop")}
      </button>
      {error !== null && <p className="attempt-card__error">{error}</p>}
    </div>
  );
}

/**
 * One attempt card (03 3.2). A tap or Enter on the card expands it: heads-up panels, the
 * premise list, the ops, the checks, and for the owner the stop control. CO11: a `repair` or
 * `confirm` heads-up opens the card's newest panel by itself, at most AUTO_EXPAND_MAX at once.
 */
export function AttemptCard({
  attempt,
  state,
  clock,
  visitor,
  compact = false,
  autoHns = [],
  onOpenCard,
  onOpenWho,
  onStop,
}: AttemptCardProps) {
  const model = cardModel(state, attempt, clock, visitor);
  const [expanded, setExpanded] = useState(false);
  // A touched panel stays in the owner's chosen state, even when the global automatic
  // window advances. Manual opens do not count against the CO11 cap.
  const [manual, setManual] = useState<ReadonlyMap<number, boolean>>(new Map());
  const newestAutoHn = autoHns.length === 0 ? null : Math.max(...autoHns);
  useEffect(() => {
    if (newestAutoHn !== null) setExpanded(true);
  }, [newestAutoHn]);

  const panelOpen = (hn: number): boolean => manual.get(hn) ?? autoHns.includes(hn);
  const togglePanel = (hn: number): void => {
    const nextOpen = !panelOpen(hn);
    setManual((panels) => new Map(panels).set(hn, nextOpen));
  };

  const className = compact ? "attempt-card attempt-card--compact" : "attempt-card";
  const openCard = model.line4.opensCard && model.cardId !== null && onOpenCard !== undefined;
  const headsups = Object.values(attempt.heads_ups).sort((a, b) => b.hn - a.hn);
  const resolved = headsups.filter((headsup) => headsup.resolved !== null);
  const waiting = headsups.filter((headsup) => headsup.resolved === null);
  const rows = premiseRows(state, attempt, lightsInOrder(attempt));
  const ops = opRows(attempt);
  const checks = checkRows(attempt);
  const summary = checksSummary(attempt);

  /** Tap or Enter expands (03 3.2). Interactive children and the open detail keep their own
   * behaviour — a tap on a button or inside a panel does not fold the card. */
  const onToggle = (event: React.MouseEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, select, textarea, .attempt-card__detail") !== null) return;
    setExpanded((open) => !open);
  };

  return (
    <article
      className={className}
      data-attempt-id={attempt.id}
      data-state={attempt.state}
      data-expanded={expanded}
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) {
          event.preventDefault();
          setExpanded((open) => !open);
        }
      }}
    >
      {!compact && (
        <header className="attempt-card__top">
          <span className="attempt-card__requester">{model.requester}</span>
          {model.tags.map((tag) => (
            <span className="attempt-card__tag" key={tag}>
              {tag}
            </span>
          ))}
          <span className="attempt-card__meta">
            {model.model !== null && <span className="attempt-card__model">{model.model}</span>}
            <span className="attempt-card__elapsed">{model.elapsed}</span>
          </span>
        </header>
      )}
      <p className="attempt-card__intent" dir="auto">
        &ldquo;{model.intent}&rdquo;
      </p>
      <div className={`attempt-card__status attempt-card__status--${model.status.tone}`}>
        <StatusGlyph shape={model.status.shape} />
        <span className="attempt-card__word">{model.status.word}</span>
        {model.sentBack !== null && <span className="attempt-card__sent-back">&middot; {model.sentBack}</span>}
        {model.relies && (
          <span className="attempt-card__lights">
            <span className="attempt-card__relies">{text("attempt.relies")}</span>
            {model.lights.map((light: LightView) => (
              <PremiseLight key={light.id} light={light} />
            ))}
            {model.lightsMore > 0 && (
              <span className="attempt-card__more">{text("light.more", { n: model.lightsMore })}</span>
            )}
          </span>
        )}
        {compact &&
          model.tags.map((tag) => (
            <span className="attempt-card__tag" key={tag}>
              {tag}
            </span>
          ))}
        {compact && (
          <span className="attempt-card__meta">
            {model.model !== null && <span className="attempt-card__model">{model.model}</span>}
            <span className="attempt-card__elapsed">{model.elapsed}</span>
          </span>
        )}
      </div>
      <p className={`attempt-card__line4${model.line4.warning ? " attempt-card__line4--warning" : ""}`}>
        {openCard ? (
          <button
            type="button"
            className="attempt-card__open"
            onClick={(event) => {
              event.stopPropagation();
              if (model.cardId !== null) onOpenCard?.(model.cardId);
            }}
          >
            {model.line4.text}
          </button>
        ) : (
          model.line4.text
        )}
      </p>
      {model.note !== null && <p className="attempt-card__note">{model.note}</p>}

      {expanded && (
        <div className="attempt-card__detail">
          {waiting.map((headsup) => (
            <HeadsUpPanel
              key={headsup.hn}
              model={headsUpModel(headsup, attempt)}
              open={panelOpen(headsup.hn)}
              onToggle={() => togglePanel(headsup.hn)}
            />
          ))}
          {resolved.length > 0 && attempt.reopened_by !== null && (
            <p className="attempt-card__earlier">{text("attempt.earlier")}</p>
          )}
          {resolved.map((headsup) => (
            <HeadsUpPanel
              key={headsup.hn}
              model={headsUpModel(headsup, attempt)}
              open={panelOpen(headsup.hn)}
              onToggle={() => togglePanel(headsup.hn)}
            />
          ))}
          {rows.length > 0 && (
            <section className="attempt-card__section">
              <h4 className="attempt-card__heading">{text("attempt.relies")}</h4>
              <ul className="attempt-card__premises">
                {rows.map((row) => (
                  <PremiseRowItem key={row.id} row={row} onWho={onOpenWho} />
                ))}
              </ul>
            </section>
          )}
          {ops.length > 0 && (
            <section className="attempt-card__section">
              <h4 className="attempt-card__heading">{text("attempt.changes")}</h4>
              <ul className="attempt-card__ops">
                {ops.map((op, index) => (
                  <li key={index} className={op.dropped ? "attempt-card__op--dropped" : undefined}>
                    <span className="attempt-card__op-path" dir="auto">
                      {op.path}
                    </span>
                    {op.entities.length > 0 && (
                      <span className="attempt-card__op-entities" dir="auto">
                        {op.entities.join(", ")}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {checks !== null && (
            <section className="attempt-card__section">
              <h4 className="attempt-card__heading">{text("attempt.checks")}</h4>
              {summary !== null && <p className="attempt-card__checks-summary">{summary}</p>}
              <ul className="attempt-card__checks">
                {checks.map((check, index) => (
                  <li key={index} data-ok={check.ok}>
                    <span className="attempt-card__check-mark" aria-hidden="true">
                      {check.ok ? "\u2713" : "\u2717"}
                    </span>
                    <span className="attempt-card__check-label">{check.label}</span>
                    {check.error !== null && <span className="attempt-card__check-error">{check.error}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {!visitor && inFlight(attempt) && <StopControl attempt={attempt} pool={state.pool.id} onStop={onStop} />}
        </div>
      )}
    </article>
  );
}
