// The limits of a visitor's try (09-try TY6, TY6a), as pure functions over the rows the model
// gate keeps: one row per recorded try, its time and — while it is younger than the address
// window — the salted hash of its client address. The gate object runs these inside one storage
// transaction; nothing here reads a clock or touches storage.

/** TY6: one try per client address per this many seconds. */
export const TRY_ADDRESS_WINDOW_S = 600;
/** TY6: tries per hour across the deployment. */
export const TRY_PER_HOUR = 20;
/** TY6: tries in total for the deployment. */
export const TRY_TOTAL = 300;

const HOUR_MS = 3_600_000;
const WINDOW_MS = TRY_ADDRESS_WINDOW_S * 1000;

/** One recorded try: when, and the address hash (null once the window has passed, TY6a). */
export type TryRow = { t: number; h: string | null };

/** Which limit of TY6's table refused, in the table's order. */
export type TryLimit = "address" | "hour" | "total";

export type TryDecision = { ok: true } | { ok: false; limit: TryLimit };

/** TY6: the first limit that refuses a try from `hash` at `now`, or `ok`. `total` counts every
 * try ever recorded; `rows` may hold rows of any age — older ones simply do not count. */
export function decideTry(rows: readonly TryRow[], total: number, hash: string, now: number): TryDecision {
  if (rows.some((row) => row.h === hash && now - row.t < WINDOW_MS)) return { ok: false, limit: "address" };
  if (rows.filter((row) => now - row.t < HOUR_MS).length >= TRY_PER_HOUR) return { ok: false, limit: "hour" };
  if (total >= TRY_TOTAL) return { ok: false, limit: "total" };
  return { ok: true };
}

/** TY6a's two cut-offs at `now`: a row whose `t` is at or before `drop` leaves (an hour old), and a
 * row whose `t` is at or before `erase` loses its hash (the address window has passed). */
export function tryCutoffs(now: number): { drop: number; erase: number } {
  return { drop: now - HOUR_MS, erase: now - WINDOW_MS };
}

/** TY6a: the rows worth keeping at `now`, by `tryCutoffs`. */
export function pruneTries(rows: readonly TryRow[], now: number): TryRow[] {
  const { drop, erase } = tryCutoffs(now);
  return rows
    .filter((row) => row.t > drop)
    .map((row) => (row.h !== null && row.t <= erase ? { t: row.t, h: null } : row));
}

/** The copy id of the sentence a refusal answers with (TY6's table). */
export function tryLimitCopyId(limit: TryLimit): "try.limited.address" | "try.limited.hour" | "try.limited.total" {
  return limit === "address" ? "try.limited.address" : limit === "hour" ? "try.limited.hour" : "try.limited.total";
}
