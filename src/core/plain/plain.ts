// The plain-merge replay of 01-core.md 11.7: the "same changes, merged by plain git" pool,
// rebuilt as a pure function. PM1 chooses the operations (the caller hands them over), PM3
// defines the text conflicts, PM4 the interrupted marks, PM5 the undo and revert landings.
// No premise check, no clock, no randomness, no storage.

import type { Operation } from "../../protocol/operations.ts";
import { replay, type ReplayFailure } from "../replay/replay.ts";
import { makeTreeFromFiles } from "../git/tree-files.ts";

/** One landing handed to the plain-merge replay, in `seq` order (11.7, PM1). */
export type PlainLanding = {
  readonly seq: number;
  readonly kind: "change" | "undo" | "revert";
  /**
   * What PM1 replays for a `change`: the operations the attempt held before its first
   * heads-up of result `confirm` or `repair` (its `ops_first` row), or its landed
   * operations when it never had one. The caller decides which and marks `opsFirst`.
   * Unused for `undo` and `revert`.
   */
  readonly ops: readonly Operation[];
  /** Whether `ops` is an `ops_first` snapshot (PM1, PM4). */
  readonly opsFirst: boolean;
  /**
   * PM2's `submitted` flag of the `ops_first` snapshot: whether the attempt had passed a
   * submit before that heads-up. Read only when `opsFirst` is true.
   */
  readonly submitted: boolean;
  /** For `undo` and `revert`: the `seq`s the landing takes back (UN5a's `undoes`). */
  readonly undoes?: readonly number[];
};

/** What a landing did in the plain-merge pool. */
export type PlainOutcome =
  | "applied" // its operations replayed in full
  | "conflict" // PM3: skipped and counted as a text conflict
  | "reverted"; // an `undo` or `revert` landing: the landings it names were taken back (PM5)

export type PlainStep = {
  readonly seq: number;
  readonly kind: "change" | "undo" | "revert";
  readonly outcome: PlainOutcome;
  /** PM4: the landing was replayed from an `ops_first` whose `submitted` is 0. */
  readonly interrupted: boolean;
  /** The paths the landing changed in the pool (`null` for a removed path). Empty for a conflict. */
  readonly changed: ReadonlyMap<string, string | null>;
  /** For a conflict: the operation that did not apply and the OP rule it failed. */
  readonly failure?: { readonly path: string; readonly op_seq: number; readonly rule: ReplayFailure["rule"] };
  /** For `undo` and `revert`: the `seq`s taken back — the given `undoes` plus every landing
   *  that joined the revert when its operations could not be replayed (UN3). */
  readonly reverted?: readonly number[];
  /** The pool's files after this landing. */
  readonly files: ReadonlyMap<string, string>;
};

export type PlainMerge = {
  /** One entry per landing, in `seq` order: the pool's files after each landing. */
  readonly steps: readonly PlainStep[];
  /** The pool's files after the last landing. */
  readonly files: ReadonlyMap<string, string>;
  /** PM3: the `seq`s counted as text conflicts, cumulative, ascending. */
  readonly skipped: readonly number[];
  /** PM4: the `seq`s marked interrupted, cumulative, ascending. */
  readonly interrupted: readonly number[];
  /** PM6's `through_seq`: the last landing replayed, `null` when the input is empty. */
  readonly throughSeq: number | null;
};

/**
 * Replays `landings` over the seed's `files` (11.7, PM1 to PM5). `change` landings replay
 * their `ops` with the rules of 5.3 minus OP3 (PM3); a landing whose operations do not all
 * apply is skipped whole and counted as a text conflict. `undo` and `revert` landings take
 * back the `seq`s they name (PM5): for every path a reverted landing touched, the pool's
 * content returns to what it held just before the earliest reverted landing touched it, and
 * the operations on that path of every later applied landing not in the set are replayed
 * again (UN3, with OP5 not applied); a landing whose operations no longer apply joins the
 * set and the computation restarts. A reverted landing that was skipped changed nothing, so
 * there is nothing of it to take back.
 */
export function replayPlainMerge(seed: ReadonlyMap<string, string>, landings: readonly PlainLanding[]): PlainMerge {
  const ordered = [...landings].sort((a, b) => a.seq - b.seq);
  const steps: PlainStep[] = [];
  const skipped: number[] = [];
  const interrupted: number[] = [];
  const stepOps: (readonly Operation[] | null)[] = [];
  let files = new Map(seed);

  /** The content `path` held just before the landing `seq`, in the pool's own history. */
  const contentBefore = (path: string, seq: number): string | undefined => {
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i]!;
      if (s.seq < seq) return s.files.get(path);
    }
    return seed.get(path);
  };

  /** The revert of PM5 for the set `undoes`, by the rules of UN3 on the pool's own history. */
  const applyRevert = (
    undoes: readonly number[],
  ): { result: Map<string, string>; changed: Map<string, string | null>; reverted: number[] } => {
    const reverted = new Set(undoes);
    for (;;) {
      // For every path a reverted landing touched: its earliest reverted toucher (seq) and
      // the content to return to.
      const base = new Map<string, { seq: number; content: string | undefined }>();
      for (const s of steps) {
        if (!reverted.has(s.seq)) continue;
        for (const path of s.changed.keys()) {
          if (!base.has(path)) base.set(path, { seq: s.seq, content: contentBefore(path, s.seq) });
        }
      }
      const result = new Map(files);
      let failed: number | null = null;
      for (const [path, restore] of base) {
        let current: string | null | undefined = restore.content;
        for (let i = 0; i < steps.length; i++) {
          const s = steps[i]!;
          if (s.seq <= restore.seq || reverted.has(s.seq) || !s.changed.has(path)) continue;
          if (s.kind === "change") {
            const ops = (stepOps[i] ?? []).filter((op) => op.path === path);
            const tree = new Map<string, string>();
            if (current !== undefined && current !== null) tree.set(path, current);
            const r = replay(ops, tree, { op3: false, op5: false });
            if (!r.ok) {
              failed = s.seq;
              break;
            }
            current = r.changed.has(path) ? r.changed.get(path)! : current;
          } else {
            // A later undo or revert outside the set re-sets the path to what it recorded.
            current = s.changed.get(path)!;
          }
        }
        if (failed !== null) break;
        if (current === undefined || current === null) result.delete(path);
        else result.set(path, current);
      }
      if (failed === null) {
        const changed = new Map<string, string | null>();
        for (const path of base.keys()) {
          const content = result.get(path);
          changed.set(path, content === undefined ? null : content);
        }
        return { result, changed, reverted: [...reverted].sort((a, b) => a - b) };
      }
      reverted.add(failed); // UN3: a landing whose operations no longer apply joins the set.
    }
  };

  for (const landing of ordered) {
    if (landing.kind !== "change") {
      const { result, changed, reverted } = applyRevert(landing.undoes ?? []);
      files = result;
      steps.push({
        seq: landing.seq,
        kind: landing.kind,
        outcome: "reverted",
        interrupted: false,
        changed,
        reverted,
        files: new Map(files),
      });
      stepOps.push(null);
      continue;
    }
    // PM4: a landing replayed from an `ops_first` with `submitted = 0` is interrupted.
    const intr = landing.opsFirst && !landing.submitted;
    if (intr) interrupted.push(landing.seq);
    // PM3: 5.3 without OP3; a change whose operations do not all apply is skipped whole.
    const r = replay(landing.ops, files, { op3: false });
    if (!r.ok) {
      skipped.push(landing.seq);
      steps.push({
        seq: landing.seq,
        kind: landing.kind,
        outcome: "conflict",
        interrupted: intr,
        changed: new Map(),
        failure: { path: r.path, op_seq: r.op_seq, rule: r.rule },
        files: new Map(files),
      });
      stepOps.push(landing.ops);
      continue;
    }
    for (const [path, content] of r.changed) {
      if (content === null) files.delete(path);
      else files.set(path, content);
    }
    steps.push({
      seq: landing.seq,
      kind: landing.kind,
      outcome: "applied",
      interrupted: intr,
      changed: r.changed,
      files: new Map(files),
    });
    stepOps.push(landing.ops);
  }

  return {
    steps,
    files,
    skipped,
    interrupted,
    throughSeq: ordered.length === 0 ? null : ordered[ordered.length - 1]!.seq,
  };
}

/**
 * The git tree id of the plain-merge files, built exactly as the tree of `main` (9.5):
 * every path a regular file (mode `100644`), entries in git's order. PM7 compares this id
 * to the `landing.landed.tree` of the landing `through_seq`.
 */
export function plainTreeId(files: ReadonlyMap<string, string>): string {
  const filesForTree: Record<string, string> = {};
  for (const [path, content] of files) filesForTree[path] = content;
  return makeTreeFromFiles(filesForTree).root.oid;
}
