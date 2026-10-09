// The cell formats of 03-floor 5.2: count, share, money, duration, clock, time of day and landing.
// Pure functions; every placeholder the copy uses that is a number goes through one of these first.

/** `strip.dash`: what a share shows when its value is null (03 5.2 "Share"). */
export const DASH = "–";

/** Digits with a comma every three places. count(1024) -> "1,024". */
export function count(n: number): string {
  const sign = n < 0 ? "-" : "";
  const digits = String(Math.trunc(Math.abs(n)));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Whole percent. share(0.12) -> "12%". Null shows `strip.dash`. */
export function share(x: number | null): string {
  if (x === null) return DASH;
  return `${Math.round(x * 100)}%`;
}

/** Dollars with two decimals; below one cent: "less than $0.01". money(3.12) -> "$3.12". */
export function money(usd: number): string {
  if (usd < 0.01) return "less than $0.01";
  return `$${usd.toFixed(2)}`;
}

/**
 * Below 1 s: milliseconds. Below 60 s: seconds. Otherwise minutes and seconds.
 * duration(640) -> "640 ms"; duration(42_000) -> "42 s"; duration(72_000) -> "1 min 12 s".
 */
export function duration(ms: number): string {
  if (ms < 1_000) return `${count(Math.round(ms))} ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${count(seconds)} s`;
  return `${count(Math.floor(seconds / 60))} min ${count(seconds % 60)} s`;
}

/** `hh:mm:ss` (the run clock). clock(221_000) -> "00:03:41". */
export function clock(ms: number): string {
  const s = Math.floor(ms / 1_000);
  const pad = (v: number): string => String(v).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

/** The viewer's local time, 24-hour, with seconds. */
export function timeOfDay(ts: number): string {
  const d = new Date(ts);
  const pad = (v: number): string => String(v).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "landing {seq}": the plain-word name of a landing. landingLabel(9) -> "landing 9". */
export function landingLabel(seq: number): string {
  return `landing ${count(seq)}`;
}

/** The last segment of a path (the part after the last `/`). */
export function basename(path: string): string {
  const p = path.endsWith("/") ? path.slice(0, -1) : path;
  return p.slice(p.lastIndexOf("/") + 1);
}
