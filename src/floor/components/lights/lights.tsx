// The premise lights (03-floor 3.3): one light per `premise.recorded`, its shape and colour
// token the two channels of the state (VD10), `title`/`aria-label` the `light.tip` sentence
// (CO16, AX7). The row form is one line of the expanded card's "Relies on" list (CO17): light,
// keyLabel, word, flags, judgment sentence and the `who.open` link.

import "./lights.css";

import { text } from "../../../copy/strings.ts";
import type { LightView } from "../attempt-card/model.ts";
import type { PremiseRow } from "./model.ts";

/** The light of one premise. `size` is the CO15 size: a card shows 28, a compact card 20, a
 * row of the expanded list 16. */
export function PremiseLight({ light, size = "card" }: { light: LightView; size?: "card" | "list" }) {
  return (
    <span
      className={`light light--${light.light}${size === "list" ? " light--list" : ""}`}
      role="img"
      aria-label={light.tip}
      title={light.tip}
      tabIndex={0}
    >
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

/** One premise row of the expanded card (CO17): the light at list size, its keyLabel, word,
 * flags, the newest judgment sentence and the `who.open` link. */
export function PremiseRowItem({
  row,
  onWho,
}: {
  row: PremiseRow;
  onWho?: (kind: string, key: string) => void;
}) {
  return (
    <li className="premise-row" data-light={row.light}>
      <PremiseLight light={{ id: row.id, light: row.light, edit: row.edit, tip: `${row.label}: ${row.word}.` }} size="list" />
      <span className="premise-row__label" dir="auto">
        {row.label}
      </span>
      <span className="premise-row__word">{row.word}</span>
      {row.flags !== "" && <span className="premise-row__flags">({row.flags})</span>}
      {row.sentence !== null && <span className="premise-row__sentence">{row.sentence}</span>}
      <button type="button" className="premise-row__who" onClick={() => onWho?.(row.id.split(" ")[0] ?? "", row.id.split(" ").slice(1).join(" "))}>
        {text("who.open")}
      </button>
    </li>
  );
}
