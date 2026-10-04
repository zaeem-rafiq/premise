/**
 * Who relies (01-core.md 11.6, 03-floor.md 3.11), derived purely from
 * `FloorState`: for an entity or a file, the in-flight attempts with a live
 * premise on it and the landed, not undone changes with a frozen premise on
 * it. Also the pick list a file tile shows first (every entity key of the path
 * plus the file itself) and the creature kinds the pool frame outlines while
 * the panel is open (CO23b).
 */

import type { PremiseKind } from "../premise.ts";
import type { AttemptView, FloorState, PremiseView } from "./state.ts";

/** What the panel answers for: an entity `path#name`, a file `path`, or any premise key as given. */
export type WhoTarget = { kind: PremiseKind | "check"; key: string };

/** One in-flight attempt row of 3.11: the attempt and the premise that matched, with its flags. */
export type WhoInflightRow = {
  attempt: AttemptView;
  matched: PremiseView; // the live premise that matched the target (its flags show)
};

/** One landed row of 3.11: the landing seq and the frozen premise that matched. */
export type WhoLandedRow = {
  seq: number;
  kind: "change" | "undo" | "revert";
  paths: string[];
  matched: { kind: PremiseKind; key: string };
};

export type WhoResult = {
  summaryOnly: boolean;
  windowed: boolean; // digest entries exist: older landings sit outside FLOOR_KEEP_LANDINGS
  inFlight: WhoInflightRow[];
  landed: WhoLandedRow[]; // newest first
};

/** The path a premise key lives in (`entity` strips the `#name`; other kinds are their own path). */
export function premisePath(kind: PremiseKind | "check", key: string): string {
  if (kind === "entity") {
    const hash = key.indexOf("#");
    return hash === -1 ? key : key.slice(0, hash);
  }
  if (kind === "query") {
    // `refs:<entity>` relies on the entity's path; `outline:<path>` on the path.
    if (key.startsWith("refs:")) return premisePath("entity", key.slice(5));
    if (key.startsWith("outline:")) return key.slice(8);
    return key;
  }
  return key;
}

/**
 * Does premise `p` rely on `target`? (11.6.) For an entity `path#name`: the
 * entity premise itself or a `file:` premise on its path. For a file: the file
 * premise itself or an `entity:` premise on one of its entities. Any other
 * kind matches on kind and key alone.
 */
export function premiseMatches(p: { kind: PremiseKind | "check"; key: string }, target: WhoTarget): boolean {
  if (target.kind === "entity") {
    if (p.kind === "entity") return p.key === target.key;
    return p.kind === "file" && p.key === premisePath("entity", target.key);
  }
  if (target.kind === "file") {
    if (p.kind === "file") return p.key === target.key;
    return p.kind === "entity" && premisePath("entity", p.key) === target.key;
  }
  return p.kind === target.kind && p.key === target.key;
}

/** An attempt whose accepted landing already landed is on main, not in flight. */
function isInflight(state: FloorState, attempt: AttemptView): boolean {
  if (attempt.state === "landed" || attempt.state === "stopped") return false;
  if (attempt.landed_seq !== null) {
    const entry = state.landings[attempt.landed_seq];
    const landed =
      entry === undefined ? false : entry.digest === true ? entry.landed_ts !== null : entry.landed !== null;
    if (landed) return false;
  }
  return true;
}

/** The Who relies result for `target` (3.11): in-flight rows in rail order, landed newest first. */
export function whoRelies(state: FloorState, target: WhoTarget): WhoResult {
  const summaryOnly = state.pool.summary_only;
  const windowed = Object.values(state.landings).some((entry) => entry.digest === true);

  const inFlight: WhoInflightRow[] = [];
  if (!summaryOnly) {
    const ordered: AttemptView[] = [];
    for (const id of state.working_order) {
      const attempt = state.attempts[id];
      if (attempt !== undefined) ordered.push(attempt);
    }
    const rest = Object.values(state.attempts)
      .filter((attempt) => !state.working_order.includes(attempt.id))
      .sort((a, b) => a.opened_ts - b.opened_ts);
    for (const attempt of [...ordered, ...rest]) {
      if (!isInflight(state, attempt)) continue;
      const matched = Object.values(attempt.premises).find((premise) => premiseMatches(premise, target));
      if (matched !== undefined) inFlight.push({ attempt, matched });
    }
  }

  const landed: WhoLandedRow[] = [];
  for (const seq of state.landed_order) {
    const entry = state.landings[seq];
    if (entry === undefined) continue;
    const isLanded = entry.digest === true ? entry.landed_ts !== null : entry.landed !== null;
    if (!isLanded || entry.undone_by !== null) continue;
    const keys = entry.digest === true ? entry.premise_keys : entry.premises;
    const matched = keys.find((premise) => premiseMatches(premise, target));
    if (matched !== undefined)
      landed.push({ seq: entry.seq, kind: entry.kind, paths: entry.paths, matched: { kind: matched.kind, key: matched.key } });
  }

  return { summaryOnly, windowed, inFlight, landed };
}

/**
 * The pick list of a file tile (3.11): every entity key of `path` known in
 * `files[path].keys` (keys seen in premises or writes, FS2) plus the file
 * itself last.
 */
export function whoPickList(state: FloorState, path: string): WhoTarget[] {
  const keys = state.files[path]?.keys ?? [];
  return [...keys.map((key) => ({ kind: "entity" as const, key })), { kind: "file", key: path }];
}

/** `creatures/crab.js` → `crab`; a path outside `creatures/` → null (CO23b kinds). */
function creatureKind(path: string): string | null {
  if (!path.startsWith("creatures/")) return null;
  const base = path.slice("creatures/".length);
  if (base.includes("/")) return null; // only files directly in creatures/
  const dot = base.lastIndexOf(".");
  return dot === -1 ? base : base.slice(0, dot);
}

/**
 * The creature kinds of the panel's lists, for `{ type: "highlight"; kinds }`
 * (CO23b): the kind of every creature file a listed row touches — an attempt's
 * operation and premise paths, a landing's paths — plus the target's own kind
 * when the target itself is a creature.
 */
export function whoKinds(state: FloorState, target: WhoTarget, result: WhoResult): string[] {
  const paths = new Set<string>();
  paths.add(premisePath(target.kind, target.key));
  for (const row of result.inFlight) {
    for (const op of row.attempt.ops) paths.add(op.path);
    for (const premise of Object.values(row.attempt.premises)) {
      if (premise.kind === "entity" || premise.kind === "file") paths.add(premisePath(premise.kind, premise.key));
    }
  }
  for (const row of result.landed) for (const path of row.paths) paths.add(path);
  const kinds = new Set<string>();
  for (const path of paths) {
    const kind = creatureKind(path);
    if (kind !== null) kinds.add(kind);
  }
  return [...kinds].sort();
}
