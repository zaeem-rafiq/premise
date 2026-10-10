// The three-way text merge of 01-core.md 11.7, PM3a: a line diff and a merge of three versions
// of one file, as `git merge-file` merges them. Written from the rule's text and from Myers'
// paper ("An O(ND) Difference Algorithm and Its Variations", 1986); no code is taken from Git.
// Pure and synchronous: no clock, no storage.

/**
 * PM3a's lines: runs of characters that end with `\n`, the `\n` included (a `\r` before it
 * belongs to the line). A last run with no `\n` is a line of its own.
 */
export function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) break;
    lines.push(text.slice(start, nl + 1));
    start = nl + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** One hunk of an edit script: base lines `[start, end)` become `lines`. */
export type Hunk = { readonly start: number; readonly end: number; readonly lines: readonly string[] };

/**
 * A shortest edit script from `a` to `b` (Myers, linear space), with each run of changed lines
 * slid as far down as its neighbours allow, unless an earlier position lines it up with a change
 * on the other side. Returns the hunks in order, each over a half-open range of `a`.
 */
export function diffLines(a: readonly string[], b: readonly string[]): Hunk[] {
  // Equal lines share a number, so the comparisons below are integer compares.
  const ids = new Map<string, number>();
  const idOf = (line: string): number => {
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    return id;
  };
  const x = a.map(idOf);
  const y = b.map(idOf);
  const changedA = new Array<boolean>(x.length).fill(false);
  const changedB = new Array<boolean>(y.length).fill(false);
  // Equal first and last lines stay; a line of the rest that the other side's rest never holds
  // is changed whatever the script, so only the lines both rests hold go to the search.
  let lo = 0;
  while (lo < x.length && lo < y.length && x[lo] === y[lo]) lo++;
  let xHi = x.length;
  let yHi = y.length;
  while (xHi > lo && yHi > lo && x[xHi - 1] === y[yHi - 1]) {
    xHi--;
    yHi--;
  }
  const inX = new Set(x.slice(lo, xHi));
  const inY = new Set(y.slice(lo, yHi));
  const keptX: number[] = [];
  const keptY: number[] = [];
  for (let i = lo; i < xHi; i++) {
    if (inY.has(x[i]!)) keptX.push(i);
    else changedA[i] = true;
  }
  for (let j = lo; j < yHi; j++) {
    if (inX.has(y[j]!)) keptY.push(j);
    else changedB[j] = true;
  }
  const subX = keptX.map((i) => x[i]!);
  const subY = keptY.map((j) => y[j]!);
  const subChangedX = new Array<boolean>(subX.length).fill(false);
  const subChangedY = new Array<boolean>(subY.length).fill(false);
  compare(subX, 0, subX.length, subY, 0, subY.length, subChangedX, subChangedY);
  keptX.forEach((i, k) => {
    if (subChangedX[k]) changedA[i] = true;
  });
  keptY.forEach((j, k) => {
    if (subChangedY[k]) changedB[j] = true;
  });
  slideDown(x, changedA, changedB);
  slideDown(y, changedB, changedA);
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && !changedA[i] && !changedB[j]) {
      i++;
      j++;
      continue;
    }
    const start = i;
    const from = j;
    while (i < x.length && changedA[i]) i++;
    while (j < y.length && changedB[j]) j++;
    hunks.push({ start, end: i, lines: b.slice(from, j) });
  }
  return hunks;
}

/** Marks the lines of `x[xLo, xHi)` and `y[yLo, yHi)` that a shortest edit script changes. */
function compare(
  x: readonly number[],
  xLo: number,
  xHi: number,
  y: readonly number[],
  yLo: number,
  yHi: number,
  changedX: boolean[],
  changedY: boolean[],
): void {
  for (;;) {
    while (xLo < xHi && yLo < yHi && x[xLo] === y[yLo]) {
      xLo++;
      yLo++;
    }
    while (xLo < xHi && yLo < yHi && x[xHi - 1] === y[yHi - 1]) {
      xHi--;
      yHi--;
    }
    if (xLo === xHi) {
      for (let j = yLo; j < yHi; j++) changedY[j] = true;
      return;
    }
    if (yLo === yHi) {
      for (let i = xLo; i < xHi; i++) changedX[i] = true;
      return;
    }
    const snake = middleSnake(x, xLo, xHi, y, yLo, yHi);
    compare(x, xLo, snake.x0, y, yLo, snake.y0, changedX, changedY);
    // The second half as a loop: the recursion depth stays logarithmic.
    xLo = snake.x1;
    yLo = snake.y1;
  }
}

/**
 * The middle snake of Myers' linear-space refinement: a run of equal lines, `x[x0, x1)` against
 * `y[y0, y1)`, that lies on a shortest edit path halfway along it. Both ends of each sequence
 * differ (the caller strips equal prefixes and suffixes), so the path has at least one edit.
 */
function middleSnake(
  x: readonly number[],
  xLo: number,
  xHi: number,
  y: readonly number[],
  yLo: number,
  yHi: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const n = xHi - xLo;
  const m = yHi - yLo;
  const delta = n - m;
  const odd = (delta & 1) !== 0;
  const max = Math.ceil((n + m) / 2) + 1;
  const off = max + 1;
  // forward[k + off]: the furthest x on diagonal k (x - y = k) from the start;
  // backward[k + off]: the furthest distance back from the end on reversed diagonal k.
  const forward = new Int32Array(2 * off + 1);
  const backward = new Int32Array(2 * off + 1);
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let i =
        k === -d || (k !== d && forward[k - 1 + off]! < forward[k + 1 + off]!)
          ? forward[k + 1 + off]!
          : forward[k - 1 + off]! + 1;
      let j = i - k;
      const i0 = i;
      const j0 = j;
      while (i < n && j < m && x[xLo + i] === y[yLo + j]) {
        i++;
        j++;
      }
      forward[k + off] = i;
      const back = delta - k;
      if (odd && back >= -(d - 1) && back <= d - 1 && i + backward[back + off]! >= n) {
        return { x0: xLo + i0, y0: yLo + j0, x1: xLo + i, y1: yLo + j };
      }
    }
    for (let k = -d; k <= d; k += 2) {
      let i =
        k === -d || (k !== d && backward[k - 1 + off]! < backward[k + 1 + off]!)
          ? backward[k + 1 + off]!
          : backward[k - 1 + off]! + 1;
      let j = i - k;
      const i0 = i;
      const j0 = j;
      while (i < n && j < m && x[xHi - 1 - i] === y[yHi - 1 - j]) {
        i++;
        j++;
      }
      backward[k + off] = i;
      const fwd = delta - k;
      if (!odd && fwd >= -d && fwd <= d && i + forward[fwd + off]! >= n) {
        return { x0: xHi - i, y0: yHi - j, x1: xHi - i0, y1: yHi - j0 };
      }
    }
  }
  throw new Error("middleSnake: no overlap found");
}

/**
 * Slides each run of changed lines of one side down while the line after it equals its first
 * line (the edit stays the same), merging runs that come to touch. When the run could move, it
 * is put back at the lowest position that lines it up with a run of changes on the other side,
 * if one exists. `other` is read only.
 */
function slideDown(lines: readonly number[], changed: boolean[], other: readonly boolean[]): void {
  const n = lines.length;
  // gapChanged[u]: the other side has changed lines just before its u-th unchanged line (or
  // its end, for u = the count of unchanged lines).
  const gapChanged: boolean[] = [];
  let pending = false;
  for (const c of other) {
    if (c) pending = true;
    else {
      gapChanged.push(pending);
      pending = false;
    }
  }
  gapChanged.push(pending);
  /** Whether the other side has a run of changes at the place this side's boundary `end` maps to. */
  const otherChangedAt = (end: number): boolean => {
    let unchanged = 0;
    for (let i = 0; i < end; i++) if (!changed[i]) unchanged++;
    return gapChanged[unchanged] ?? false;
  };
  let s = 0;
  while (s < n) {
    if (!changed[s]) {
      s++;
      continue;
    }
    let e = s;
    while (e < n && changed[e]) e++;
    let size: number;
    let earliestEnd: number;
    let alignedEnd: number;
    do {
      size = e - s;
      while (s > 0 && lines[s - 1] === lines[e - 1]) {
        changed[--s] = true;
        changed[--e] = false;
        while (s > 0 && changed[s - 1]) s--;
      }
      earliestEnd = e;
      alignedEnd = otherChangedAt(e) ? e : -1;
      while (e < n && lines[s] === lines[e]) {
        changed[s++] = false;
        changed[e++] = true;
        while (e < n && changed[e]) e++;
        if (otherChangedAt(e)) alignedEnd = e;
      }
    } while (size !== e - s);
    if (e !== earliestEnd && alignedEnd !== -1) {
      while (e > alignedEnd) {
        changed[--s] = true;
        changed[--e] = false;
      }
    }
    s = e;
  }
}

/** The outcome of one three-way merge: the merged text, or a conflict. */
export type Merge3 = { readonly ok: true; readonly text: string } | { readonly ok: false };

/** A change of one side, or of both, in the coordinates of base, ours and theirs. */
type Region = {
  side: "ours" | "theirs" | "both";
  baseStart: number;
  baseEnd: number;
  oursStart: number;
  oursEnd: number;
  theirsStart: number;
  theirsEnd: number;
};

/**
 * PM3a's line merge of `ours` and `theirs` against `base`. Each side's hunks are taken in base
 * order. A hunk of one side that ends before the other side's next hunk starts is that side's
 * change alone. Hunks of the two sides that overlap or touch are one change of both sides,
 * except a pair with the same base range and the same lines, which both sides made alike and
 * which is no region at all. A region joins the region before it when it starts, in ours or in
 * theirs, where that one ends or earlier; a region joined from different sides is a change of
 * both. A change of both sides merges cleanly only when the two sides' lines over it are equal.
 * The merged text is ours with every change of theirs alone put in.
 */
export function mergeLines(base: string, ours: string, theirs: string): Merge3 {
  const b = splitLines(base);
  const o = splitLines(ours);
  const t = splitLines(theirs);
  const oh = diffLines(b, o);
  const th = diffLines(b, t);
  // Offsets of each side over base: the change in line count of its hunks so far.
  const regions: Region[] = [];
  const push = (r: Region): void => {
    const prev = regions[regions.length - 1];
    if (prev !== undefined && (r.oursStart <= prev.oursEnd || r.theirsStart <= prev.theirsEnd)) {
      if (prev.side !== r.side) prev.side = "both";
      prev.baseEnd = Math.max(prev.baseEnd, r.baseEnd);
      prev.oursEnd = Math.max(prev.oursEnd, r.oursEnd);
      prev.theirsEnd = Math.max(prev.theirsEnd, r.theirsEnd);
      return;
    }
    regions.push(r);
  };
  let io = 0;
  let it = 0;
  let oursShift = 0; // ours line count minus base line count, over the hunks of ours before io
  let theirsShift = 0;
  while (io < oh.length || it < th.length) {
    const ho = oh[io];
    const ht = th[it];
    if (ho !== undefined && (ht === undefined || ho.end < ht.start)) {
      push({
        side: "ours",
        baseStart: ho.start,
        baseEnd: ho.end,
        oursStart: ho.start + oursShift,
        oursEnd: ho.start + oursShift + ho.lines.length,
        theirsStart: ho.start + theirsShift,
        theirsEnd: ho.end + theirsShift,
      });
      oursShift += ho.lines.length - (ho.end - ho.start);
      io++;
      continue;
    }
    if (ht !== undefined && (ho === undefined || ht.end < ho.start)) {
      push({
        side: "theirs",
        baseStart: ht.start,
        baseEnd: ht.end,
        oursStart: ht.start + oursShift,
        oursEnd: ht.end + oursShift,
        theirsStart: ht.start + theirsShift,
        theirsEnd: ht.start + theirsShift + ht.lines.length,
      });
      theirsShift += ht.lines.length - (ht.end - ht.start);
      it++;
      continue;
    }
    // Both exist and overlap or touch.
    const o1 = ho!;
    const t1 = ht!;
    const alike =
      o1.start === t1.start &&
      o1.end === t1.end &&
      o1.lines.length === t1.lines.length &&
      o1.lines.every((line, k) => line === t1.lines[k]);
    if (!alike) {
      const start = Math.min(o1.start, t1.start);
      const end = Math.max(o1.end, t1.end);
      push({
        side: "both",
        baseStart: start,
        baseEnd: end,
        oursStart: start + oursShift,
        oursEnd: o1.start + oursShift + o1.lines.length + (end - o1.end),
        theirsStart: start + theirsShift,
        theirsEnd: t1.start + theirsShift + t1.lines.length + (end - t1.end),
      });
    }
    // Move past whichever hunk ends first (both when they end together).
    if (o1.end >= t1.end) {
      theirsShift += t1.lines.length - (t1.end - t1.start);
      it++;
    }
    if (t1.end >= o1.end) {
      oursShift += o1.lines.length - (o1.end - o1.start);
      io++;
    }
  }
  const out: string[] = [];
  let at = 0; // the next line of ours to copy
  for (const r of regions) {
    if (r.side === "ours") continue;
    const oursLines = o.slice(r.oursStart, r.oursEnd);
    const theirsLines = t.slice(r.theirsStart, r.theirsEnd);
    if (r.side === "both") {
      if (oursLines.length !== theirsLines.length || oursLines.some((line, k) => line !== theirsLines[k])) {
        return { ok: false };
      }
      continue;
    }
    for (; at < r.oursStart; at++) out.push(o[at]!);
    out.push(...theirsLines);
    at = r.oursEnd;
  }
  for (; at < o.length; at++) out.push(o[at]!);
  return { ok: true, text: out.join("") };
}

/** A file's content, or `null` for `absent`. */
export type Content = string | null;

/** The outcome of PM3a for one path: the merged content (`null` removes it), or a conflict. */
export type FileMerge =
  | { readonly ok: true; readonly content: Content }
  | { readonly ok: false; readonly kind: "lines" | "add_add" | "modify_delete" };

/** PM3a's whole-file rules, then the line merge. */
export function mergeFile(base: Content, ours: Content, theirs: Content): FileMerge {
  if (ours === base) return { ok: true, content: theirs };
  if (theirs === base) return { ok: true, content: ours };
  if (ours === theirs) return { ok: true, content: ours };
  if (base === null) return { ok: false, kind: "add_add" };
  if (ours === null || theirs === null) return { ok: false, kind: "modify_delete" };
  const merged = mergeLines(base, ours, theirs);
  return merged.ok ? { ok: true, content: merged.text } : { ok: false, kind: "lines" };
}
