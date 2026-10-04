// The recorded operations and the replay of 01-core.md 5.1, with the drops of OP1-OP6.
//
// The `Operation` here is the shape section 5.1 fixes. `src/protocol/operations.ts` defines a
// different union (create_file / edit_file / create_entities / ...) that no section of 01-core.md
// names; it is left alone, and this local type is the one replay consumes (reported to the lead).

import { ABSENT } from "../../protocol/premise.ts";
import { blobId } from "../sync/sha1.ts";
import { utf8 } from "../sync/bytes.ts";
import { isModulePath } from "../keys/paths.ts";
import { occurrences } from "../keys/search.ts";
import { parseModule, regionTargets } from "../entities/entities.ts";

/** An operation of 5.1: a whole-file `write` or a unique-span `replace`, in `op_seq` order. */
export type ReplayOperation =
  | { op_seq: number; op: "write"; path: string; content: string | null; base_oid: string }
  | { op_seq: number; op: "replace"; path: string; old: string; new: string; targets: string[] };

/** The rule under which a replay stops (OP1-OP5; OP6 is the drop it causes, not a rule). */
export type ReplayRule = "OP1" | "OP2" | "OP3" | "OP4" | "OP5";

export type ReplayFailure = {
  ok: false;
  /** The path whose operation could not be applied. OP6 drops every operation on it. */
  path: string;
  /** The op_seq that failed. The engine records it in `dropped_ops` (5.4). */
  op_seq: number;
  rule: ReplayRule;
};

export type ReplayResult = { ok: true; changed: Map<string, string | null> } | ReplayFailure;

/**
 * The keys an operation records for a span (5.1, OP3): the target keys of `[start, end)` in a
 * module, `path` for any other file or for a module that does not parse.
 */
export function spanTargets(path: string, content: string, start: number, end: number): string[] {
  if (isModulePath(path)) {
    try {
      return regionTargets(parseModule(content), start, end).map((name) => `${path}#${name}`);
    } catch {
      // a module that does not parse is opaque: the span targets the file itself (R4)
    }
  }
  return [path];
}

/**
 * Replays `operations` over `tree` (5.1), in `op_seq` order. On success returns the paths that
 * changed (`null` for a deleted file). On the first operation that cannot apply, returns the
 * failing path, op_seq and the OP rule; the engine then drops every operation on that path (OP6).
 */
export function replay(operations: readonly ReplayOperation[], tree: ReadonlyMap<string, string>): ReplayResult {
  const work = new Map(tree);
  const changed = new Map<string, string | null>();
  const ordered = [...operations].sort((a, b) => a.op_seq - b.op_seq);
  const fail = (op: ReplayOperation, rule: ReplayRule): ReplayFailure => ({
    ok: false,
    path: op.path,
    op_seq: op.op_seq,
    rule,
  });
  for (const op of ordered) {
    if (op.op === "write") {
      const head = tree.get(op.path);
      const startingOid = head === undefined ? ABSENT : blobId(utf8(head));
      if (startingOid !== op.base_oid) return fail(op, "OP5");
      if (op.content === null) {
        work.delete(op.path);
        changed.set(op.path, null);
      } else {
        work.set(op.path, op.content);
        changed.set(op.path, op.content);
      }
    } else {
      const content = work.get(op.path);
      if (content === undefined) return fail(op, "OP4");
      const offsets = occurrences(content, op.old);
      if (offsets.length === 0) return fail(op, "OP1");
      if (offsets.length > 1) return fail(op, "OP2");
      const start = offsets[0]!;
      const end = start + op.old.length;
      const targets = spanTargets(op.path, content, start, end);
      if (targets.length !== op.targets.length || !targets.every((key, index) => key === op.targets[index])) {
        return fail(op, "OP3");
      }
      const replaced = content.slice(0, start) + op.new + content.slice(end);
      work.set(op.path, replaced);
      changed.set(op.path, replaced);
    }
  }
  return { ok: true, changed };
}

export type PathReplay = { ok: true; content: string | undefined } | ReplayFailure;

/**
 * The view of one path under an attempt's operations (5.2): replay over the tree restricted to
 * that path. `head` is the path's content at head, `undefined` when the path does not exist. On
 * failure the caller shows head for the path, as 5.2 says.
 */
export function replayPath(operations: readonly ReplayOperation[], path: string, head: string | undefined): PathReplay {
  const tree = new Map<string, string>();
  if (head !== undefined) tree.set(path, head);
  const result = replay(
    operations.filter((op) => op.path === path),
    tree,
  );
  if (!result.ok) return result;
  const content = result.changed.has(path) ? result.changed.get(path)! : head;
  return { ok: true, content };
}
