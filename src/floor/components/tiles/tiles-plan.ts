// The pure decisions of the file tiles (docs/spec/03-floor.md 3.7, CO26-CO28): which paths get a
// tile, how they group under directory labels, what a cell shows, and how many cells fit before
// the rest fold behind `tiles.more`. Everything derives from `FloorState` (FL1) — the component
// (tiles.tsx) renders these cells; nothing here touches the DOM or the clock.

import type { FileView, FloorState } from "../../../protocol/reducer/index.ts";

/** A tile's marks (3.7): at most `MARKS_MAX` of each kind, then `tile.more_marks` for the rest.
 * A reader mark is a ring, a writer mark a filled square (the shapes come from the CSS). */
export const MARKS_MAX = 5;

/** The directory of a path: everything through the last `/`, or "" for a file at the root. */
export function dirOfPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash + 1);
}

/** What a tile shows (3.7): the file name without its directory and extension. */
export function tileName(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** One grid position of the tile area. The group's label cell counts as one (3.7), and the
 * `tiles.more` cell takes the last position when the cells do not fit (CO28). */
export type TileCell =
  | { kind: "label"; dir: string; readers: readonly string[] }
  | { kind: "file"; file: FileView; removed: boolean; glow: boolean }
  | { kind: "more"; hidden: number };

/** The reader marks a group label carries (CO26): a listing premise or a text search over the
 * directory marks the label, recorded under `dirs` — the key is written both with and without
 * the trailing slash, so both are looked up. */
export function dirReaders(state: FloorState, dir: string): readonly string[] {
  const dirs = state.dirs;
  const entry = dirs[dir] ?? dirs[dir.replace(/\/+$/, "")] ?? dirs[`${dir}/`];
  return entry?.readers ?? [];
}

/**
 * The grid cells of the tile area, in the order `state.files` lists them (the `pool.files`
 * order the reducer recorded — "their order, from FloorState only"). Groups keep
 * first-appearance order; each group starts with its directory label cell. `removedPaths` are
 * files a landing just removed (the component times them out after 2 s); `glowPaths` are files
 * the newest `landing.landed` changed (the 2 s edge glow of 6.4).
 */
export function tileCells(
  state: FloorState,
  opts: { capacity?: number; removedPaths?: ReadonlySet<string>; glowPaths?: ReadonlySet<string> } = {},
): TileCell[] {
  const groups = new Map<string, { files: FileView[]; removed: FileView[] }>();
  const order: string[] = [];
  const removedPaths = opts.removedPaths ?? new Set<string>();
  for (const file of Object.values(state.files)) {
    const dir = dirOfPath(file.path);
    let group = groups.get(dir);
    if (group === undefined) {
      group = { files: [], removed: [] };
      groups.set(dir, group);
      order.push(dir);
    }
    if (file.exists) group.files.push(file);
    else if (removedPaths.has(file.path)) group.removed.push(file);
  }

  const cells: TileCell[] = [];
  for (const dir of order) {
    const group = groups.get(dir)!;
    if (group.files.length === 0 && group.removed.length === 0) continue;
    cells.push({ kind: "label", dir, readers: dirReaders(state, dir) });
    for (const file of group.files) {
      cells.push({
        kind: "file",
        file,
        removed: false,
        glow: opts.glowPaths?.has(file.path) === true,
      });
    }
    for (const file of group.removed) {
      cells.push({ kind: "file", file, removed: true, glow: false });
    }
  }

  const capacity = opts.capacity;
  if (capacity === undefined || cells.length <= capacity) return cells;
  // CO28: the last cell is `tiles.more`; its {n} counts the file tiles that did not fit.
  const shown = cells.slice(0, Math.max(0, capacity - 1));
  const totalFiles = cells.filter((c) => c.kind === "file").length;
  const shownFiles = shown.filter((c) => c.kind === "file").length;
  return [...shown, { kind: "more", hidden: Math.max(1, totalFiles - shownFiles) }];
}

/** The visible mark counts of a cell (3.7, CO26): up to MARKS_MAX rings and MARKS_MAX squares,
 * then `+{n}` for the rest. */
export function tileMarks(
  readers: readonly string[],
  writers: readonly string[],
): {
  readers: number;
  writers: number;
  more: number;
} {
  return {
    readers: Math.min(readers.length, MARKS_MAX),
    writers: Math.min(writers.length, MARKS_MAX),
    more: Math.max(0, readers.length - MARKS_MAX) + Math.max(0, writers.length - MARKS_MAX),
  };
}
