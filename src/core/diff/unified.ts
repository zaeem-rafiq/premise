// src/core/diff/unified.ts — the compact unified-style diff of the heads-up item bodies (8.1).
//
// Pure string diff: common prefix, changed middle, common suffix, with three lines of context.

export function unified(before: string, after: string): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  // A compact unified-style diff: common prefix, changed middle, common suffix.
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let hi = 0;
  while (hi < a.length - lo && hi < b.length - lo && a[a.length - 1 - hi] === b[b.length - 1 - hi]) hi++;
  const out: string[] = [`@@ -${lo + 1},${a.length - lo - hi} +${lo + 1},${b.length - lo - hi} @@`];
  for (const l of a.slice(Math.max(0, lo - 3), lo)) out.push(` ${l}`);
  for (const l of a.slice(lo, a.length - hi)) out.push(`-${l}`);
  for (const l of b.slice(lo, b.length - hi)) out.push(`+${l}`);
  for (const l of a.slice(a.length - hi, Math.min(a.length, a.length - hi + 3))) out.push(` ${l}`);
  return out.join("\n");
}
