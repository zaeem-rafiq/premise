// src/core/trunk/selftest.ts — the pre-landing self-test of a submit (01-core 4.9 CK6c). The run
// itself is asynchronous (a Worker Loader isolate, S4a) and so happens in the Worker before the
// `tool` entry: `selftestCandidate` hands it the tree a submit would land, and the Worker hands the
// verdict back through the pool's options as `Pool.selftest`. `submitCall` uses that verdict only
// when its `key` names the very tree it validated; any other case is "skipped" (fail open).

import type { ToolRequest } from "../../protocol/tools.ts";
import type { Pool } from "./sets.ts";
import { curOps, replayOps } from "./sets.ts";
import { H } from "../sync/h.ts";
import { changedPaths } from "./submit.ts";

/** 02-tidepool 5.1: the self-test's module. A pool without it has no self-test to run. */
export const SELFTEST_PATH = "selftest/run.js";

/** One failure a submit is rejected for: a check name and code of GR8, and the creature kind
 * when the failure names one of the candidate tree's own `creatures/<kind>.js` files. */
export type SelftestFailure = { name: string; code: string; kind?: string };

/** The Worker's verdict on one candidate tree: `failed` lists the failures new against head
 * (GR3d); null means the isolate gave no verdict and the submit proceeds (fail open). */
export type SelftestVerdict = { key: string; failed: SelftestFailure[] | null };

/** What the Worker runs: the candidate tree and head's tree, with the key of the candidate. */
export type SelftestCandidate = {
  key: string;
  /** Head's commit id: the Worker computes head's own run once per head commit. */
  head: string;
  headFiles: Map<string, string>;
  files: Map<string, string>;
};

/** The key of a candidate tree: head's commit and the content of every changed path. Equal keys
 * name equal trees, so a verdict computed before a landing moved head is never applied after. */
export function selftestKey(
  headCommit: string,
  after: ReadonlyMap<string, string>,
  changed: readonly string[],
): string {
  return H(JSON.stringify([headCommit, changed.map((p) => [p, after.get(p) ?? null])]));
}

/** True when this pool's submits run the self-test: features.green "full", a pool that is not
 * imported (IR7: `app` "" has no self-test) and a head that has `selftest/run.js`. */
export function selftestApplies(pool: Pool): boolean {
  return pool.featuresGreen === "full" && pool.meta.get("app") !== "" && pool.files.has(SELFTEST_PATH);
}

/**
 * The tree a `submit` request would land, or null when no self-test is due: the feature is off or
 * the pool has none, the request is no fresh submit of an open attempt, or the change does not
 * replay or is empty (CK2, CK3 answer those without running anything). Reads only.
 */
export function selftestCandidate(pool: Pool, input: unknown): SelftestCandidate | null {
  if (!selftestApplies(pool)) return null;
  const req = input as Partial<ToolRequest> | null;
  if (req === null || typeof req !== "object" || req.tool !== "submit" || typeof req.attempt_id !== "string") {
    return null;
  }
  const a = pool.attempts.get(req.attempt_id);
  if (a === undefined || a.state === "accepted" || a.state === "landed" || a.state === "stopped") return null;
  if (a.last_call_id !== null && req.call_id === a.last_call_id) return null; // TA2 replays the answer
  const rep = replayOps(curOps(a), pool.files, {}, pool.languages);
  if (rep.failed.length > 0) return null;
  const changed = changedPaths(pool.files, rep.files);
  if (changed.length === 0) return null;
  const head = pool.meta.get("head_commit") ?? "";
  return {
    key: selftestKey(head, rep.files, changed),
    head,
    headFiles: new Map(pool.files),
    files: new Map(rep.files),
  };
}
