// The green line: the verification result and the fixed list of check names and codes (GR8).
// Source: 01-core 11.5.

export type VerifyResult = {
  seq: number;
  commit: string;
  ok: boolean;
  runtime: "browser" | "isolate" | "container" | "static";
  checks: Array<{ name: string; ok: boolean; code?: string }>; // names and codes from GR8; `code` only when ok is false
  duration_ms: number;
  log: string; // at most GREEN_LOG_MAX_CHARS; shown to the owner only (GR7)
};

/** The check names of GR8 for a runtime that runs the pool's self-test (`isolate`, `browser`, `container`):
 * `selftest_ran` first, then the twelve invariants of 02-tidepool 5.2, in that order. */
export const GREEN_RUNTIME_CHECKS = [
  "selftest_ran",
  "files",
  "no_errors",
  "in_bounds",
  "energy_range",
  "population",
  "not_exhausted",
  "state_is_data",
  "pen_rules",
  "visible",
  "within_reach",
  "draw_is_pure",
  "deterministic",
] as const;

/** The check names of the `static` runtime's fallback (GR5): no pool code is run. */
export const GREEN_STATIC_CHECKS = ["parse", "imports_resolve", "policy_invariants"] as const;

export const GREEN_CHECK_NAMES = [...GREEN_RUNTIME_CHECKS, ...GREEN_STATIC_CHECKS] as const;

export type GreenCheckName = (typeof GREEN_CHECK_NAMES)[number];

/** The codes a failed `selftest_ran` may carry (GR8). */
export const SELFTEST_CODES = ["no_verdict", "bad_verdict", "harness_error"] as const;

export type SelftestCode = (typeof SELFTEST_CODES)[number];

/** The code of any other failed check (GR8): the check name followed by `:failed`. */
export function greenCheckCode(name: GreenCheckName): string {
  return `${name}:failed`;
}
