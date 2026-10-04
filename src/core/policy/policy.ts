// The policy file of 01-core.md 10.1: tiers (PO1, PO2), the fail-closed parse (PO3), the
// globals allow-list and the limits (PO4). `.premise/**` is always held (PO3, PO5).

import { DEFAULT_GLOBALS, MAX_CHANGE_BYTES, MAX_PATHS } from "../../protocol/constants.ts";

export type PolicyTier = "auto" | "held";

export type PolicyRule = { paths: string[]; tier: PolicyTier };

export type Policy = {
  defaultTier: PolicyTier;
  tiers: PolicyRule[];
  /** The global allow-list (PO4): the file's `globals`, or DEFAULT_GLOBALS when it has none. */
  globals: string[];
  /** The limits of 4.2 as the file's `limits` lower them (PO4); never above the configured caps. */
  limits: { max_paths: number; max_change_bytes: number };
};

const CAPS = { max_paths: MAX_PATHS, max_change_bytes: MAX_CHANGE_BYTES } as const;

/** The closed policy: every path is held (PO3). */
export const CLOSED_POLICY: Policy = {
  defaultTier: "held",
  tiers: [],
  globals: [...DEFAULT_GLOBALS],
  limits: { max_paths: MAX_PATHS, max_change_bytes: MAX_CHANGE_BYTES },
};

const POLICY_KEYS = new Set(["v", "default", "tiers", "globals", "limits"]);
const LIMIT_KEYS = new Set(["max_paths", "max_change_bytes"]);
const TIERS = new Set(["auto", "held"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Parses `.premise/policy.json` (10.1). Returns null on anything that does not satisfy the
 * format: unknown keys, a `v` that is not 1, a `tier` outside {auto, held}, `limits` that try to
 * raise a cap, or malformed JSON. Every such file closes the pool (PO3).
 */
export function parsePolicy(text: string): Policy | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (!Object.keys(raw).every((key) => POLICY_KEYS.has(key))) return null; // unknown keys are errors (PO3)
  if (raw.v !== 1) return null;
  if (typeof raw.default !== "string" || !TIERS.has(raw.default)) return null;

  const tiers: PolicyRule[] = [];
  if (raw.tiers !== undefined) {
    if (!Array.isArray(raw.tiers)) return null;
    for (const entry of raw.tiers) {
      if (!isRecord(entry) || !Object.keys(entry).every((key) => key === "paths" || key === "tier")) return null;
      if (typeof entry.tier !== "string" || !TIERS.has(entry.tier)) return null;
      if (!Array.isArray(entry.paths) || entry.paths.length === 0) return null;
      if (!entry.paths.every((pattern) => typeof pattern === "string" && pattern.length > 0)) return null;
      tiers.push({ paths: entry.paths as string[], tier: entry.tier as PolicyTier });
    }
  }

  let globals = [...DEFAULT_GLOBALS];
  if (raw.globals !== undefined) {
    if (!Array.isArray(raw.globals) || !raw.globals.every((name) => typeof name === "string" && name.length > 0)) {
      return null;
    }
    globals = raw.globals as string[];
  }

  const limits: { max_paths: number; max_change_bytes: number } = { ...CAPS };
  if (raw.limits !== undefined) {
    if (!isRecord(raw.limits) || !Object.keys(raw.limits).every((key) => LIMIT_KEYS.has(key))) return null;
    for (const key of LIMIT_KEYS) {
      const value = raw.limits[key];
      if (value === undefined) continue;
      // `limits` may only lower the limits of 4.2 (PO4); an attempt to raise one is invalid.
      if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > CAPS[key as keyof typeof CAPS]) {
        return null;
      }
      limits[key as keyof typeof CAPS] = value as number;
    }
  }

  return { defaultTier: raw.default as PolicyTier, tiers, globals, limits };
}

/** The policy a pool applies: the parsed file, or the closed policy when it cannot be read (PO3). */
export function policyOf(text: string | null | undefined): Policy {
  if (text === null || text === undefined) return CLOSED_POLICY;
  return parsePolicy(text) ?? CLOSED_POLICY;
}

const REGEXP_SPECIAL = /[.+?^${}()|[\]\\]/g;

/** True when `pattern` matches `path` (PO1): `*` inside one segment, `**` across segments. */
export function globMatch(pattern: string, path: string): boolean {
  const segments = pattern.split("/");
  let source = "^";
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment === "**") {
      source += index === segments.length - 1 ? ".*" : "(?:[^/]+/)*";
      continue;
    }
    source += segment.replace(REGEXP_SPECIAL, "\\$&").replace(/\*/g, "[^/]*");
    if (index < segments.length - 1) source += "/";
  }
  return new RegExp(`${source}$`).test(path);
}

/**
 * The tier a path lands under (PO1): the first matching rule; `default` when none matches.
 * `.premise/**` is always held (PO3), whatever the rules say.
 */
export function tierOfPath(policy: Policy, path: string): PolicyTier {
  if (path === ".premise" || path.startsWith(".premise/")) return "held";
  for (const rule of policy.tiers) {
    if (rule.paths.some((pattern) => globMatch(pattern, path))) return rule.tier;
  }
  return policy.defaultTier;
}

/** The tier of a change (PO2): held when any touched path is held, else auto. */
export function changeTier(policy: Policy, touchedPaths: readonly string[]): PolicyTier {
  return touchedPaths.every((path) => tierOfPath(policy, path) === "auto") && touchedPaths.length > 0 ? "auto" : "held";
}
