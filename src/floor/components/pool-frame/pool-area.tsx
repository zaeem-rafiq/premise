// The pool area of the Floor view (docs/spec/03-floor.md 2.1, the "pool area" of the wireframes):
// what is on `main` — the live pool frame (3.5) above the file tiles (3.7). The shell draws the
// green line under the region; nothing of the shell sits between the frame and the tiles.
// LY1: the frame keeps 16:9 at the area's full width unless the tiles would get less than their
// one guaranteed row (64 high) — then the frame shrinks and centres.
// IR12: a pool made from a repository (`pool.app` null) has no live picture — the area holds
// no frame at all, its caption bar reads `frame.no_app`, and the tiles take the frame's place.

import { useEffect, useRef } from "react";
import { PoolFrame, FRAME_CSS } from "./pool-frame.tsx";
import type { PoolFrameProps } from "./pool-frame.tsx";
import { FileTiles } from "../tiles/tiles.tsx";
import { text } from "../../../copy/strings.ts";
import { adoptCss } from "../../styles/adopt.ts";

/** The tiles region never drops below one row (LY1). */
const TILES_MIN_PX = 64;

const AREA_CSS = `
.pool-area { display: flex; flex-direction: column; gap: 8px; min-width: 0; height: 100%; min-height: 0; }
.pool-area[data-tight="true"] .pf-body { width: auto; height: var(--pf-body-h); margin-inline: auto; flex: none; }
/* IR12: with no frame the tiles fill the region — lift the grid's row cap so the cells use
 * the frame's height rather than folding behind the more-cell. */
.pool-area[data-app="none"] .tiles { --tile-rows: 99; }
`;

export type PoolAreaProps = PoolFrameProps & {
  /** 3.7/CO27 + 3.11: the tile menu's `tile.menu.who` asks the shell to open Who relies for the
   * file. Optional — without it the tile menu offers only the entries it has. */
  onTileWho?: (path: string) => void;
  /** 3.9 "the tile menu": `tile.menu.why` opens the Why card of the file's newest landed change
   * (its `last_landed_seq`). Optional. */
  onTileWhy?: (path: string, seq: number) => void;
};

export function PoolArea(props: PoolAreaProps) {
  const { onTileWho, onTileWhy, ...frameProps } = props;
  const areaRef = useRef<HTMLDivElement | null>(null);

  // LY1: measure the region; when an outer bound leaves less than the caption, the tiles' row
  // and the gaps need, the frame body shrinks (keeping 16:9) and centres. In the Floor's
  // content-sized column the area is never shorter than its content, so this binds only where
  // a host caps the region's height.
  useEffect(() => {
    const el = areaRef.current;
    if (el === null || typeof ResizeObserver !== "function") return;
    const measure = () => {
      // IR12: a no-app area holds no frame body — the LY1 shrink math has nothing to move.
      if (el.querySelector(".pf-body") === null) {
        delete el.dataset.tight;
        el.style.removeProperty("--pf-body-h");
        return;
      }
      const caption = el.querySelector(".pf-caption");
      const captionH = caption?.getBoundingClientRect().height ?? 0;
      const gaps = 8; // .pool-area gap (the caption sits on the frame: .pf gap is 0)
      const need = el.clientWidth * (9 / 16) + captionH + TILES_MIN_PX + gaps;
      if (el.clientHeight > 0 && need > el.clientHeight) {
        el.dataset.tight = "true";
        el.style.setProperty("--pf-body-h", `${Math.max(0, el.clientHeight - captionH - TILES_MIN_PX - gaps)}px`);
      } else {
        delete el.dataset.tight;
        el.style.removeProperty("--pf-body-h");
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // IR12 (06-repos): `pool.app` is null only after the stream's pool.state says so —
  // the pool then gets no frame, no frame request, no Pause, no Compare and no self-test
  // badge. Before that event the kind is undecided; the frame holds its first load.
  const noApp = props.state.pool.app === null;

  adoptCss(AREA_CSS);
  adoptCss(FRAME_CSS);
  return (
    <div className="pool-area" ref={areaRef} data-app={noApp ? "none" : undefined}>
      {noApp ? (
        <div className="pf">
          <div className="pf-caption">
            <span className="pf-caption-text">{text("frame.no_app")}</span>
          </div>
        </div>
      ) : (
        <PoolFrame {...frameProps} />
      )}
      <FileTiles state={props.state} onTileWho={onTileWho} onTileWhy={onTileWhy} />
    </div>
  );
}
