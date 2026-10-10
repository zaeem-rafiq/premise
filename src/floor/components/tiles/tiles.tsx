// The file tiles under the pool frame (docs/spec/03-floor.md 3.7, CO26-CO28). One cell per file,
// grouped under directory labels, carrying reader rings and writer squares, the held tag, the
// removed state, and the landing glow — all from `FloorState` only (FL1). Cells that do not fit
// the capped grid fold behind the `tiles.more` cell, which toggles the scrollable full list
// (CO28; same toggle pattern as `banner.more`). Under 1100 px the region sits behind the
// `tiles.files` disclosure (LY3).

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { text } from "../../../copy/strings.ts";
import { keyShort } from "../../../copy/names.ts";
import type { FloorState } from "../../../protocol/reducer/index.ts";
import { tileCells, tileKeepsExtension, tileMarks, tileName, type TileCell } from "./tiles-plan.ts";
import { adoptCss } from "../../styles/adopt.ts";

/** How long a landed change glows and a removed file keeps its tile (6.4, 3.7). */
const FLASH_MS = 2_000;
/** One tile row is guaranteed (LY1): the tiles region never drops below it. */
const TILES_MIN_PX = 64;

const TILES_CSS = `
.tiles { display: flex; flex-direction: column; gap: 6px; min-height: ${TILES_MIN_PX}px; flex: 1 1 auto; position: relative;
  --tile-w: 120px; --tile-h: 56px; --tile-gap: 8px; --tile-rows: 3; }
@media (max-width: 1599px) { .tiles { --tile-w: 88px; --tile-h: 48px; --tile-rows: 2; } }
.tiles-toggle { display: none; align-items: center; gap: 8px; min-height: 44px; padding: 0 10px;
  background: var(--surface, #13242f); color: var(--muted, #a8bcc6);
  border: var(--border, 1px) solid var(--control, #7c98a8); border-radius: var(--radius, 8px);
  font: inherit; font-size: var(--size-body, 16px); cursor: pointer; }
.tiles-toggle:focus-visible { outline: 3px solid var(--focus, #ffe08a); outline-offset: 2px; }
.tiles-toggle .tiles-caret { margin-inline-start: auto; font-size: var(--size-small, 14px); }
.tiles-scroll { min-height: 0; overflow: hidden;
  max-height: calc(var(--tile-rows) * var(--tile-h) + (var(--tile-rows) - 1) * var(--tile-gap)); }
.tiles[data-open="true"] .tiles-scroll { overflow-y: auto; overscroll-behavior: contain; }
.tiles-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(0, var(--tile-w))); grid-auto-rows: var(--tile-h); gap: var(--tile-gap); align-content: start; }
.tile { display: flex; flex-direction: column; justify-content: center; gap: 3px; box-sizing: border-box; min-width: 0;
  width: 100%; height: 100%; padding: 4px 8px;
  border: var(--border, 1px) solid var(--control, #7c98a8); border-radius: var(--radius, 8px);
  background: var(--raised, #1c3342); color: var(--text, #eaf2f4); font: inherit; text-align: start; }
button.tile { cursor: pointer; }
button.tile:hover { border-color: var(--accent, #6fd6cc); }
.tile:focus-visible { outline: 3px solid var(--focus, #ffe08a); outline-offset: 2px; }
.tile-name { font-size: var(--size-small, 14px); line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tile-foot { display: flex; align-items: center; justify-content: space-between; gap: 4px; min-height: 8px; }
.tile-label { background: transparent; border-style: dashed; border-color: var(--line, #3a5669); color: var(--muted, #a8bcc6); }
.tile-label .tile-name { white-space: normal; }
.tile-marks { display: flex; align-items: center; gap: 4px; min-height: 8px; }
.tile-mark { display: inline-block; flex: none; width: 8px; height: 8px; box-sizing: border-box; }
.tile-mark-r { border: 1px solid var(--accent, #6fd6cc); border-radius: 50%; }
.tile-mark-w { background: var(--accent, #6fd6cc); }
.tile-more-marks { color: var(--muted, #a8bcc6); font-size: var(--size-small, 14px); }
.tile-tag { align-self: flex-start; padding: 0 6px; border-radius: 999px; border: var(--border, 1px) solid currentColor;
  color: var(--muted, #a8bcc6); font-size: var(--size-small, 14px); line-height: 1.2; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.tile-tag-held { color: var(--confirm, #ffc857); }
.tile-removed { color: var(--muted, #a8bcc6); border-style: dashed; }
.tile-removed .tile-name { text-decoration: line-through; }
.tile-glow { animation: tile-in 2s var(--ease, ease); }
@keyframes tile-in { from { outline: 3px solid var(--accent, #6fd6cc); outline-offset: 0; border-color: var(--accent, #6fd6cc); } to { outline: 3px solid transparent; } }
.tile-more { align-items: center; text-align: center; color: var(--muted, #a8bcc6); }
.tile-more .tile-name { font-size: var(--size-small, 14px); }
.tile-ghost { background: var(--raised, #1c3342); border-color: var(--line, #3a5669); opacity: 0.55; }
.tiles-loading { color: var(--muted, #a8bcc6); font-size: var(--size-small, 14px); padding: 2px 2px 0; }
.tile-menu { position: fixed; z-index: 40; min-width: 180px; padding: 4px; display: flex; flex-direction: column; gap: 2px;
  background: var(--raised, #1c3342); border: var(--border, 1px) solid var(--control, #7c98a8);
  border-radius: var(--radius, 8px); }
.tile-menu button { display: block; width: 100%; min-height: 44px; padding: 6px 10px; text-align: start;
  background: transparent; border: 0; color: var(--text, #eaf2f4); font: inherit; cursor: pointer; border-radius: var(--radius, 8px); }
.tile-menu button:hover, .tile-menu button:focus-visible { background: var(--surface, #13242f); outline: none; }
.tile-menu button:focus-visible { outline: 3px solid var(--focus, #ffe08a); outline-offset: -3px; }
@media (max-width: 1099px) {
  .tiles-toggle { display: inline-flex; }
  .tiles[data-open="false"] .tiles-scroll { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .tile-glow { animation: none; outline: 3px solid var(--accent, #6fd6cc); border-color: var(--accent, #6fd6cc); }
}
`;

export type FileTilesProps = {
  /** `FloorState` — the tiles are a pure function of it (FL1). */
  state: FloorState;
  /** CO27/3.11: the tile menu's `tile.menu.who` entry asks the shell to open Who relies on the
   * file. Optional: without any menu action the tiles stay inert (they render all the same). */
  onTileWho?: (path: string) => void;
  /** 3.9: the tile menu's `tile.menu.why` entry opens the Why card of the file's newest change
   * (`last_landed_seq`). */
  onTileWhy?: (path: string, seq: number) => void;
};

export function FileTiles(props: FileTilesProps) {
  const { state } = props;
  // IR12 (the 3.7 amendment): a pool made from a repository keeps each tile's extension —
  // repository files often differ only by it (`index.js` vs `index.d.ts`).
  const keepExtension = tileKeepsExtension(state);
  const [open, setOpen] = useState(false);
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [glow, setGlow] = useState<ReadonlySet<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [capacity, setCapacity] = useState<number | undefined>(undefined);
  const [columns, setColumns] = useState<number | undefined>(undefined);
  const [menu, setMenu] = useState<{ path: string; seq: number | null; left: number; top: number } | null>(null);

  // The just-landed sets: a landing's changed files glow for FLASH_MS and the ones it removed
  // keep their tile (showing tile.removed) for the same span, then leave (3.7).
  const lastSeq = useRef<number | null>(null);
  useEffect(() => {
    const seq = state.pool.landed_seq;
    const prev = lastSeq.current;
    lastSeq.current = seq;
    if (prev === null || prev === seq) return;
    const addGlow: string[] = [];
    const addGone: string[] = [];
    for (const f of Object.values(state.files)) {
      if (f.last_landed_seq !== seq) continue;
      (f.exists ? addGlow : addGone).push(f.path);
    }
    if (addGlow.length > 0) setGlow((s) => new Set([...s, ...addGlow]));
    if (addGone.length > 0) setGone((s) => new Set([...s, ...addGone]));
  }, [state]);
  useEffect(() => {
    if (gone.size === 0 && glow.size === 0) return;
    const t = window.setTimeout(() => {
      setGone(new Set());
      setGlow(new Set());
    }, FLASH_MS);
    return () => window.clearTimeout(t);
  }, [gone, glow]);

  // How many cells the capped grid holds: columns from the scroll width, rows capped by
  // --tile-rows and by the room the region actually has (LY1 shrinks the frame, not the tiles,
  // but the count still follows the measured space). The row count reads the `.tiles`
  // section's flex height: the scroll element's height follows its clipped content, and
  // measuring it would lock the grid at the rows it happens to show now.
  useEffect(() => {
    const el = scrollRef.current;
    const section = el?.parentElement ?? null;
    if (el === null || section === null || typeof ResizeObserver !== "function") return;
    const measure = () => {
      const grid = el.querySelector(".tiles-grid");
      const gs = getComputedStyle(grid ?? el);
      const tw = parseFloat(gs.getPropertyValue("--tile-w")) || 88;
      const th = parseFloat(gs.getPropertyValue("--tile-h")) || 48;
      const gap = parseFloat(gs.getPropertyValue("--tile-gap")) || 8;
      const cap = parseFloat(gs.getPropertyValue("--tile-rows")) || 2;
      const toggle = section.querySelector<HTMLElement>(".tiles-toggle");
      const toggleH = toggle !== null && toggle.offsetParent !== null ? toggle.offsetHeight + 6 : 0;
      // The region's top padding (the pool area's spacing under the frame) holds no row.
      const room = section.clientHeight - (parseFloat(getComputedStyle(section).paddingTop) || 0);
      const cols = Math.max(1, Math.floor((el.clientWidth + gap) / (tw + gap)));
      const rowsFit = section.clientHeight <= 0 ? cap : Math.max(1, Math.floor((room - toggleH + gap) / (th + gap)));
      const rows = Math.min(cap, rowsFit);
      setCapacity(cols * rows);
      setColumns(cols);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(section);
    (el as unknown as { __measure: () => void }).__measure = measure;
    return () => ro.disconnect();
  }, []);
  // The scroll box is content-sized unless an outer bound caps it: re-measure after every
  // render so capacity follows the real box as cells arrive and the region settles.
  useEffect(() => {
    const el = scrollRef.current;
    (el as unknown as { __measure?: () => void } | null)?.__measure?.();
  });

  // CO28: `tiles.more` clips the grid and opens the full list. While open the same cell (kept
  // last, same label, aria-expanded) closes it — the pattern `banner.more` uses.
  // `reduce` mutates `FloorState` in place: `state.n` in the deps stands for "the stream
  // moved" the way the rail's `[floor, floor.n]` does — a bare `[state]` never recomputes.
  const allCells = useMemo(
    () => tileCells(state, { columns, removedPaths: gone, glowPaths: glow }),
    [state, state.n, columns, gone, glow],
  );
  const clipped = useMemo(
    // Collapsed, the grid packs groups one after another, so a small region still shows every
    // group it can; the open full list (CO28) starts each group on a row of its own.
    () => tileCells(state, { capacity, removedPaths: gone, glowPaths: glow }),
    [state, state.n, capacity, gone, glow],
  );
  const tail = clipped[clipped.length - 1];
  const hidden = tail?.kind === "more" ? tail.hidden : 0;
  const cells = open && hidden > 0 ? [...allCells, { kind: "more" as const, hidden }] : clipped;

  const empty = Object.keys(state.files).length === 0;

  const renderCell = (cell: TileCell, i: number): ReactNode => {
    if (cell.kind === "gap") return <div key={`gap-${i}`} className="tile-gap" aria-hidden />;
    if (cell.kind === "label") {
      const marks = tileMarks(cell.readers, []);
      return (
        <div key={`label-${cell.dir}`} className="tile tile-label">
          <span className="tile-name">{cell.dir === "" ? keyShort("listing", "/") : cell.dir}</span>
          {marks.readers > 0 && (
            <span className="tile-marks">
              {Array.from({ length: marks.readers }, (_, k) => (
                <span key={k} className="tile-mark tile-mark-r" />
              ))}
            </span>
          )}
        </div>
      );
    }
    if (cell.kind === "more") {
      return (
        <button
          key="more"
          type="button"
          className="tile tile-more"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="tile-name">{text("tiles.more", { n: cell.hidden })}</span>
        </button>
      );
    }
    const { file, removed } = cell;
    const marks = tileMarks(file.readers, file.writers);
    const body = (
      <>
        <span className="tile-name">{tileName(file.path, keepExtension)}</span>
        <span className="tile-foot">
          <span className="tile-marks">
            {Array.from({ length: marks.readers }, (_, k) => (
              <span key={`r${k}`} className="tile-mark tile-mark-r" />
            ))}
            {Array.from({ length: marks.writers }, (_, k) => (
              <span key={`w${k}`} className="tile-mark tile-mark-w" />
            ))}
            {marks.more > 0 && <span className="tile-more-marks">{text("tile.more_marks", { n: marks.more })}</span>}
          </span>
          {file.tier === "held" && !removed && (
            <span className="tile-tag tile-tag-held" title={text("tile.held.tip")}>
              {text("tile.held")}
            </span>
          )}
          {removed && <span className="tile-tag">{text("tile.removed")}</span>}
        </span>
      </>
    );
    const cls = ["tile", removed ? "tile-removed" : "", cell.glow ? "tile-glow" : ""].filter(Boolean).join(" ");
    const label = text("tile.name", { path: file.path, r: file.readers.length, w: file.writers.length });
    const entries = menuEntries(file, props);
    if (removed || entries.length === 0) {
      return (
        <div key={file.path} className={cls} role="img" aria-label={label} title={file.path}>
          {body}
        </div>
      );
    }
    return (
      <button
        key={file.path}
        type="button"
        className={cls}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menu?.path === file.path}
        title={file.path}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu((m) =>
            m?.path === file.path
              ? null
              : {
                  path: file.path,
                  seq: file.last_landed_seq,
                  left: Math.max(4, Math.min(r.left, window.innerWidth - 220)),
                  top: r.bottom + 4 + 110 > window.innerHeight ? Math.max(4, r.top - 110) : r.bottom + 4,
                },
          );
        }}
      >
        {body}
      </button>
    );
  };

  adoptCss(TILES_CSS);
  return (
    <section className="tiles" data-open={open} aria-label={text("tiles.files")}>
      <button type="button" className="tiles-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {text("tiles.files")}
        <span className="tiles-caret" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>
      <div ref={scrollRef} className="tiles-scroll">
        {empty ? (
          <>
            <div className="tiles-grid tiles-grid-loading" aria-hidden>
              {Array.from({ length: 24 }, (_, i) => (
                <div key={i} className="tile tile-ghost" />
              ))}
            </div>
            <div className="tiles-loading" role="status">
              {text("tiles.loading")}
            </div>
          </>
        ) : (
          <div className="tiles-grid">{cells.map(renderCell)}</div>
        )}
      </div>
      {menu !== null && (
        <>
          <div
            className="tile-menu-backdrop"
            style={{ position: "fixed", inset: 0, zIndex: 39 }}
            onClick={() => setMenu(null)}
            onKeyDown={(e) => e.key === "Escape" && setMenu(null)}
          />
          <div
            className="tile-menu"
            role="menu"
            style={{ left: menu.left, top: menu.top }}
            onKeyDown={(e) => e.key === "Escape" && setMenu(null)}
          >
            {props.onTileWho !== undefined && (
              <button
                type="button"
                role="menuitem"
                autoFocus
                onClick={() => {
                  setMenu(null);
                  props.onTileWho?.(menu.path);
                }}
              >
                {text("tile.menu.who")}
              </button>
            )}
            {props.onTileWhy !== undefined && menu.seq !== null && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  props.onTileWhy?.(menu.path, menu.seq!);
                }}
              >
                {text("tile.menu.why")}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** The tile menu's entries (3.9, 3.11): `tile.menu.who` always, `tile.menu.why` once the file
 * has a landed change to explain. */
function menuEntries(file: { last_landed_seq: number | null }, props: FileTilesProps): string[] {
  const entries: string[] = [];
  if (props.onTileWho !== undefined) entries.push("who");
  if (props.onTileWhy !== undefined && file.last_landed_seq !== null) entries.push("why");
  return entries;
}
