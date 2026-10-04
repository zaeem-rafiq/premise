// The pool area of the Floor view (docs/spec/03-floor.md 2.1, the "pool area" of the wireframes):
// what is on `main` — the live pool frame (3.5) above the file tiles (3.7). The shell draws the
// green line under the region; nothing of the shell sits between the frame and the tiles.
// LY1: the frame keeps 16:9 at the area's full width unless the tiles would get less than their
// one guaranteed row (64 high) — then the frame shrinks and centres.

import { useEffect, useRef } from "react";
import { PoolFrame } from "./pool-frame.tsx";
import type { PoolFrameProps } from "./pool-frame.tsx";
import { FileTiles } from "../tiles/tiles.tsx";

/** The tiles region never drops below one row (LY1). */
const TILES_MIN_PX = 64;

const AREA_CSS = `
.pool-area { display: flex; flex-direction: column; gap: 8px; min-width: 0; height: 100%; min-height: 0; }
.pool-area[data-tight="true"] .pf-body { width: auto; height: var(--pf-body-h); margin-inline: auto; flex: none; }
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
      const caption = el.querySelector(".pf-caption");
      const captionH = caption?.getBoundingClientRect().height ?? 0;
      const gaps = 16; // .pool-area gap + .pf gap
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

  return (
    <div className="pool-area" ref={areaRef}>
      <style>{AREA_CSS}</style>
      <PoolFrame {...frameProps} />
      <FileTiles state={props.state} onTileWho={onTileWho} onTileWhy={onTileWhy} />
    </div>
  );
}
