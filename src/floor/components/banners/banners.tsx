// The banner stack of 03-floor 3.18 and 5.11: a fixed order from the top, at most three
// drawn (CO50) - banners 1 and 2 always, of the rest the first by number - the others
// counted in `banner.more`. VD4: SYNTHETIC carries the diagonal stripe, REPLAY the inverse
// band with a dotted edge. Banners 1 and 2 cannot be closed (CO49); the others leave only
// when their condition ends - there is no close control on any banner.

import { useContext, useState } from "react";
import { ShellContext } from "../../app/context.ts";
import type { BannerRow } from "../../state/derive.ts";

const DRAWN = 3;

export function Banners({ rows, onAction }: { rows: BannerRow[]; onAction: (action: string) => void }) {
  const shell = useContext(ShellContext)!;
  const [open, setOpen] = useState(false);
  const shown = rows.slice(0, DRAWN);
  const rest = rows.slice(DRAWN);
  if (rows.length === 0) return null;
  return (
    <div className="banners">
      {shown.map((row) => (
        <Banner key={row.id} row={row} onAction={onAction} />
      ))}
      {rest.length > 0 && (
        <div className="banner banner-more">
          <button type="button" className="banner-more-button" onClick={() => setOpen(!open)} aria-expanded={open}>
            {shell.t("banner.more", { n: rest.length })}
          </button>
          {open && (
            <div className="banner-more-list">
              {rest.map((row) => (
                <Banner key={row.id} row={row} onAction={onAction} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Banner({ row, onAction }: { row: BannerRow; onAction: (action: string) => void }) {
  return (
    <div className="banner" data-tone={row.tone} role="status">
      <span className="banner-word">{row.word}</span>
      <span className="banner-sentence">{row.sentence}</span>
      {row.button !== undefined && (
        <button type="button" className="banner-button" onClick={() => onAction(row.button!.action)}>
          {row.button.label}
        </button>
      )}
    </div>
  );
}
