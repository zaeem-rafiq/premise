// The commit frames of the card sheets (03-floor 3.13, 3.14): a fixed `FrameAddress` played as one
// sandboxed iframe at its `frameUrl` (CO36, PV5), or the in-place sentence the state tables give a
// cell with no address (`held.preview_building`, `held.no_preview`). A commit frame never follows
// the live pool — a commit address cannot move (PV5) — so nothing here drives it; `frame.loading`
// shows until the iframe's own load event, `frame.error` after its error event (3.13 error rows).

import { useState } from "react";
import type { FrameAddress } from "../../../protocol/cards.ts";
import { versionToken } from "../../../protocol/cards.ts";
import { text } from "../../../copy/strings.ts";
import { commitSrc, iframeAttrs } from "../pool-frame/frame-plan.ts";

/** One sandboxed iframe at a fixed commit address (PV5, CO36). `title` is its accessible name
 * (AX7). `frame.loading` and `frame.error` are the cell's own states of 3.13's table. */
export function CommitFrame({
  pool,
  address,
  title,
  seed,
}: {
  pool: string;
  address: FrameAddress;
  /** The iframe's accessible name (AX7). */
  title: string;
  /** The world seed of the pool page (default HOST_SEED). */
  seed?: number;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const src = commitSrc(pool, address, seed);
  return (
    <>
      {!failed && (
        <iframe {...iframeAttrs(src, title)} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
      )}
      {!loaded && (
        <p className="sheet-frame__note" role="status">
          {text(failed ? "frame.error" : "frame.loading")}
        </p>
      )}
    </>
  );
}

/** A labeled frame cell of a card sheet (3.13's "before"/"after", 3.14's per-candidate preview):
 * the caption over the cell body, which holds the commit frame, or `note` in place of it when the
 * card carries no address. `key` the cell by address at the call site when it can change. */
export function SheetFrameCell({
  label,
  pool,
  address,
  note,
  title,
  seed,
}: {
  /** The caption of the cell (`held.before`, `held.after`); null for no caption. */
  label: string | null;
  pool: string;
  /** The `FrameAddress` to play, or null for the in-place `note`. */
  address: FrameAddress | null;
  /** The in-place sentence when `address` is null (a state-table sentence of 3.13/3.14). */
  note: string | null;
  /** The iframe's accessible name (AX7). */
  title: string;
  seed?: number;
}) {
  return (
    <figure className="sheet-frame">
      {label !== null && <figcaption className="sheet-frame__caption">{label}</figcaption>}
      <div className="sheet-frame__body">
        {address !== null ? (
          <CommitFrame key={versionToken(address)} pool={pool} address={address} title={title} seed={seed} />
        ) : (
          <p className="sheet-frame__note" role="status">
            {note ?? ""}
          </p>
        )}
      </div>
    </figure>
  );
}
