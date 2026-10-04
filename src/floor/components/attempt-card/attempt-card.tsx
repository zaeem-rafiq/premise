// The attempt card (03-floor 3.2, 3.3): the collapsed rail item and the CO10 compact variant.
// It is a pure function of `FloorState` and the page clock; the sentences and the light tips come
// from `model.ts` and `src/copy`, so the component carries no text of its own (CP1, FL8).

import "./attempt-card.css";

import type { AttemptView, FloorState } from "../../../protocol/reducer/state.ts";
import { text } from "../../../copy/strings.ts";
import type { LightView, StatusShape } from "./model.ts";
import { cardModel } from "./model.ts";

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
  /** Opens the attempt's card sheet (`attempt.open_card`, 03 3.2 `held` row). */
  onOpenCard?: (cardId: string) => void;
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

/** One premise light (03 3.3): the state's shape and colour, its `light.tip` name (CO16, AX7). */
function PremiseLight({ light }: { light: LightView }) {
  return (
    <span className={`light light--${light.light}`} role="img" aria-label={light.tip} title={light.tip} tabIndex={0}>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        {light.light === "holds" && <circle cx="12" cy="12" r="7" fill="currentColor" />}
        {light.light === "changed" && <path d="M12 4 20 12 12 20 4 12Z" fill="currentColor" />}
        {light.light === "confirm" && <path d="M12 5 20 19 4 19Z" fill="currentColor" />}
        {light.light === "blind_spot" && (
          <circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
        )}
        {light.light === "checking" && (
          <>
            <circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
            <path d="M12 5.5 A6.5 6.5 0 0 1 12 18.5 Z" fill="currentColor" />
          </>
        )}
      </svg>
      {light.edit && <i className="light__edit" aria-hidden="true" />}
    </span>
  );
}

/**
 * One attempt card (03 3.2, collapsed anatomy). The `compact` variant is the CO10 form:
 * the intent on one line; status, lights and model on the second.
 */
export function AttemptCard({ attempt, state, clock, visitor, compact = false, onOpenCard }: AttemptCardProps) {
  const model = cardModel(state, attempt, clock, visitor);
  const className = compact ? "attempt-card attempt-card--compact" : "attempt-card";
  const openCard = model.line4.opensCard && model.cardId !== null && onOpenCard !== undefined;
  return (
    <article className={className} data-attempt-id={attempt.id} data-state={attempt.state}>
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
            {model.lights.map((light) => (
              <PremiseLight key={light.id} light={light} />
            ))}
            {model.lightsMore > 0 && (
              <span className="attempt-card__more">{text("light.more", { n: model.lightsMore })}</span>
            )}
          </span>
        )}
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
            onClick={() => {
              if (model.cardId !== null) onOpenCard?.(model.cardId);
            }}
          >
            {model.line4.text}
          </button>
        ) : (
          model.line4.text
        )}
      </p>
      {!compact && model.note !== null && <p className="attempt-card__note">{model.note}</p>}
    </article>
  );
}
