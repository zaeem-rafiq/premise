// The replay of 01-core.md 5.1 and the drops OP1-OP5 (OP6 is the drop, exercised through
// replayPath of 5.2). Operations are the write/replace shape of 5.1.

import { describe, expect, it } from "vitest";
import { ABSENT } from "../../protocol/premise.ts";
import { blobId } from "../sync/sha1.ts";
import { utf8 } from "../sync/bytes.ts";
import { replay, replayPath, spanTargets } from "./replay.ts";
import type { ReplayOperation } from "./replay.ts";

const ENERGY = "// Energy is counted in points, from 0 to ENERGY_MAX.\nexport const ENERGY_MAX = 100;\n";

const write = (
  op_seq: number,
  path: string,
  content: string | null,
  tree: ReadonlyMap<string, string>,
): ReplayOperation => {
  const head = tree.get(path);
  return { op_seq, op: "write", path, content, base_oid: head === undefined ? ABSENT : blobId(utf8(head)) };
};

const replace = (op_seq: number, path: string, old: string, next: string, targets: string[]): ReplayOperation => ({
  op_seq,
  op: "replace",
  path,
  old,
  new: next,
  targets,
});

describe("replay (5.1)", () => {
  it("applies operations in op_seq order, not the order given", () => {
    const tree = new Map([["a.js", "x = 1;\n"]]);
    const ops: ReplayOperation[] = [
      replace(2, "a.js", "y", "z", ["a.js#(top)"]),
      replace(1, "a.js", "x", "y", ["a.js#(top)"]),
    ];
    // seq 1 runs first: x -> y, then seq 2: y -> z. Given order would fail with OP1 on seq 2.
    const result = replay(ops, tree);
    expect(result.ok).toBe(true);
    expect(result.ok ? result.changed.get("a.js") : "").toBe("z = 1;\n");
  });

  it("a write stores its content; a write with content null deletes the path", () => {
    const tree = new Map([["a.js", "x = 1;\n"]]);
    const result = replay([write(1, "a.js", "whole = 9;\n", tree)], tree);
    expect(result.ok).toBe(true);
    expect(result.ok ? result.changed.get("a.js") : "").toBe("whole = 9;\n");
  });

  it("a write with content null deletes the path", () => {
    const tree = new Map([["a.js", "x\n"]]);
    const result = replay([write(1, "a.js", null, tree)], tree);
    expect(result.ok).toBe(true);
    expect(result.ok ? result.changed.get("a.js") : "kept").toBe(null);
  });

  it("OP1: a replace whose old text does not occur fails", () => {
    const tree = new Map([["a.js", "x = 1;\n"]]);
    const result = replay([replace(1, "a.js", "y = 1", "y = 2", ["a.js#(top)"])], tree);
    expect(result).toEqual({ ok: false, path: "a.js", op_seq: 1, rule: "OP1" });
  });

  it("OP2: a replace whose old text occurs more than once fails", () => {
    const tree = new Map([["a.js", "x = 1;\nx = 2;\n"]]);
    const result = replay([replace(1, "a.js", "x = ", "y = ", ["a.js#(top)"])], tree);
    expect(result).toEqual({ ok: false, path: "a.js", op_seq: 1, rule: "OP2" });
  });

  it("OP3: a replace whose matched span has different targets than recorded fails", () => {
    const tree = new Map([["world/energy.js", ENERGY]]);
    // The text matches once, but the recorded targets name the wrong entity.
    const result = replay(
      [replace(1, "world/energy.js", "ENERGY_MAX = 100", "ENERGY_MAX = 1", ["world/energy.js#drain"])],
      tree,
    );
    expect(result).toEqual({ ok: false, path: "world/energy.js", op_seq: 1, rule: "OP3" });
  });

  it("OP3 does not fire when the recorded targets equal the span's targets", () => {
    const tree = new Map([["world/energy.js", ENERGY]]);
    const start = ENERGY.indexOf("ENERGY_MAX = 100");
    expect(spanTargets("world/energy.js", ENERGY, start, start + "ENERGY_MAX = 100".length)).toEqual([
      "world/energy.js#ENERGY_MAX",
    ]);
    const result = replay(
      [replace(1, "world/energy.js", "ENERGY_MAX = 100", "ENERGY_MAX = 1", ["world/energy.js#ENERGY_MAX"])],
      tree,
    );
    expect(result.ok).toBe(true);
    expect(result.ok ? result.changed.get("world/energy.js") : "").toBe(ENERGY.replace("= 100", "= 1"));
  });

  it("OP4: a replace on a path that does not exist fails", () => {
    const result = replay([replace(1, "missing.js", "x", "y", ["missing.js"])], new Map());
    expect(result).toEqual({ ok: false, path: "missing.js", op_seq: 1, rule: "OP4" });
  });

  it("OP5: a write whose base_oid no longer matches the starting tree fails", () => {
    const tree = new Map([["a.js", "x = 1;\n"]]);
    // Recorded against a different starting tree.
    const op: ReplayOperation = {
      op_seq: 1,
      op: "write",
      path: "a.js",
      content: "y\n",
      base_oid: blobId(utf8("stale\n")),
    };
    expect(replay([op], tree)).toEqual({ ok: false, path: "a.js", op_seq: 1, rule: "OP5" });
  });

  it("OP5: a write on an absent path requires base_oid absent", () => {
    const op: ReplayOperation = { op_seq: 1, op: "write", path: "new.js", content: "y\n", base_oid: blobId(utf8("x")) };
    expect(replay([op], new Map())).toEqual({ ok: false, path: "new.js", op_seq: 1, rule: "OP5" });
    expect(replay([{ ...op, base_oid: ABSENT }], new Map()).ok).toBe(true);
  });

  it("OP6 shape: replayPath replays only the path's own operations for the view of 5.2", () => {
    // 5.2: the view of a path replays the attempt's operations on it; on failure the view is head.
    const tree = new Map([
      ["a.js", "x = 1;\n"],
      ["b.js", "y = 1;\n"],
    ]);
    const ops: ReplayOperation[] = [
      replace(1, "a.js", "missing", "z", ["a.js"]),
      replace(2, "b.js", "y = 1", "y = 2", ["b.js#(top)"]),
    ];
    const a = replayPath(ops, "a.js", tree.get("a.js"));
    expect(a.ok).toBe(false); // the caller falls back to head, as 5.2 says
    const b = replayPath(ops, "b.js", tree.get("b.js"));
    expect(b).toEqual({ ok: true, content: "y = 2;\n" });
  });
});
