// 06-repos step 3 at the engine level, with the real tree-sitter parsers: the extra `file` premise of
// LG4 and its rows (LG10), and a collision on a shared Python constant and on a shared Go constant,
// each caught as C04 is for JavaScript (a heads-up E2, a go-around, then a landing). The pool is made
// by the import path itself (`meta.app` "", so IMPORT_LANGUAGES). Every expected value is worked by
// hand from the specification (BP1).

import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "../../src/protocol/ports.ts";
import type { ToolResponse } from "../../src/protocol/tools.ts";
import { Trunk } from "../../src/core/trunk/registry.ts";
import { blobId } from "../../src/core/sync/sha1.ts";
import { utf8 } from "../../src/core/sync/bytes.ts";
import { ScriptedTriage } from "../../src/swarm/scripted-triage.ts";
import { classify } from "../../src/core/classify/table.ts";
import { installTreeSitter } from "../support/tree-sitter.ts";

beforeAll(installTreeSitter);

/** `node:sqlite` speaks the `Sql` port (the adapter shape of the case driver). */
function sqlOver(db: DatabaseSync): Sql {
  return {
    exec: (query, ...bindings) => {
      const rows = db.prepare(query).all(...bindings) as Array<Record<string, unknown>>;
      return { toArray: () => rows };
    },
    transaction: (run) => {
      db.exec("BEGIN");
      try {
        const r = run();
        db.exec("COMMIT");
        return r;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

const TREE = (n: number) => `${String(n).padStart(40, "0")}`;

const FILES: Record<string, string> = {
  "go.mod": "module example.com/shop\n\ngo 1.22\n",
  "shop/consts.py": "# Limits of the shop.\nLIMIT = 3\nGREETING = 'hi'\n\n\ndef helper():\n    return LIMIT\n",
  "shop/cart.py": "from shop.consts import LIMIT\n\n\ndef full(items):\n    return len(items) >= LIMIT\n",
  "store/limits.go": "package store\n\n// Max is the cap.\nconst Max = 3\n\nconst Min = 1\n",
  "store/cart.go": "package store\n\nfunc Full(n int) bool { return n >= Max }\n",
};

function setup(): Trunk {
  const sql = sqlOver(new DatabaseSync(":memory:"));
  const trunk = Trunk.createImported(sql, {
    pool_id: "imp-py-go",
    source: "tldrs/shop",
    now: () => 1_000,
    syncTriage: ScriptedTriage,
  });
  const r = trunk.importStep({
    cursor: null,
    files: Object.entries(FILES).map(([path, content]) => ({
      path,
      oid: blobId(utf8(content)),
      mode: "100644",
      content,
    })),
    trees: [
      { dir: "", oid: TREE(1) },
      { dir: "shop", oid: TREE(2) },
      { dir: "store", oid: TREE(3) },
    ],
    finish: { head_commit: TREE(40), head_tree: TREE(1), guide: null },
  });
  expect(r).toMatchObject({ ok: true, done: true });
  return trunk;
}

let calls = 0;
function call(trunk: Trunk, attempt: string, tool: string, args: object, ack?: number): ToolResponse {
  calls += 1;
  return trunk.tool({
    attempt_id: attempt,
    call_id: `${attempt}:${calls}`,
    tool: tool as never,
    args,
    ack: ack ?? trunk.pool.attempts.get(attempt)?.heads.length ?? 0,
  });
}

type Item = { key: string; kind: string; rule: string; result: string };

type Out = Trunk["out"];

/** Ticks and pushes; answers what the tick's trace held (the push starts a new trace). */
function tickAndPush(trunk: Trunk): Out {
  trunk.tick();
  const out = { ...trunk.out, judgments: [...trunk.out.judgments], heads_ups: [...trunk.out.heads_ups] };
  trunk.pushOk();
  return out;
}

/** The breaker: one replace in `path`, submitted, landed and pushed; answers the landing tick's trace. */
function land(trunk: Trunk, id: string, path: string, old: string, replacement: string): Out {
  trunk.openAttempt(id, { intent: `change ${path}` });
  expect(call(trunk, id, "read", { path }).ok).toBe(true);
  const rep = call(trunk, id, "replace", { path, old, new: replacement });
  expect(rep.ok, JSON.stringify(rep.error)).toBe(true);
  expect(call(trunk, id, "submit", { summary: `change ${path}` }).result).toMatchObject({ status: "validated" });
  const out = tickAndPush(trunk);
  expect(trunk.state(id)).toBe("landed");
  return out;
}

/** The judgment rows a trace gave attempt `a` on `kind|key`. */
const judged = (out: Out, a: string, kind: string, key: string) =>
  out.judgments.filter((j) => j.attempt_id === a && j.kind === kind && j.key === key);

describe("LG4 and LG10: the extra file premise of a Python or Go module", () => {
  it("LG4: an entity read of a .py file also holds a file premise on it with derived, kept after later operations", () => {
    const trunk = setup();
    trunk.openAttempt("a", { intent: "look at the cart" });
    const rd = call(trunk, "a", "read", { path: "shop/cart.py", entity: "full" });
    expect(rd.ok).toBe(true);
    expect(rd.premises).toEqual([
      expect.objectContaining({ kind: "entity", key: "shop/cart.py#full", read: true }),
      expect.objectContaining({ kind: "file", key: "shop/cart.py", read: false, derived: true }),
    ]);
    // Later operations run syncPremises, which keeps it (LG10).
    expect(call(trunk, "a", "write", { path: "notes.txt", content: "cart\n" }).ok).toBe(true);
    expect(call(trunk, "a", "write", { path: "notes.txt", content: "cart, again\n" }).ok).toBe(true);
    const premise = trunk.pool.attempts.get("a")!.premises.get("file|shop/cart.py");
    expect(premise).toMatchObject({ derived: true, read: false });
  });

  it("LG4: an entity read of a .go file holds the same file premise", () => {
    const trunk = setup();
    trunk.openAttempt("a", { intent: "look at the store" });
    const rd = call(trunk, "a", "read", { path: "store/cart.go", entity: "Full" });
    expect(rd.premises).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "file", key: "store/cart.go", derived: true })]),
    );
  });

  it("LG10: a landing that changes another entity of the file gives F3m, confirm", () => {
    const trunk = setup();
    trunk.openAttempt("a", { intent: "use the helper" });
    call(trunk, "a", "read", { path: "shop/consts.py", entity: "helper" });
    call(trunk, "a", "write", { path: "notes.txt", content: "helper\n" });
    const out = land(trunk, "s", "shop/consts.py", "GREETING = 'hi'", "GREETING = 'hello'");
    expect(judged(out, "a", "file", "shop/consts.py")).toEqual([
      expect.objectContaining({ rule: "F3m", result: "confirm", reason: "module_reference_changed" }),
    ]);
    const items = out.heads_ups.filter((h) => h.to === "a").flatMap((h) => h.items as Item[]);
    expect(items).toEqual([
      expect.objectContaining({ kind: "file", key: "shop/consts.py", rule: "F3m", result: "confirm" }),
    ]);
  });

  it("LG10: a comment-only change gives F2, holds", () => {
    const trunk = setup();
    trunk.openAttempt("a", { intent: "use the helper" });
    call(trunk, "a", "read", { path: "shop/consts.py", entity: "helper" });
    call(trunk, "a", "write", { path: "notes.txt", content: "helper\n" });
    const out = land(trunk, "s", "shop/consts.py", "# Limits of the shop.", "# The shop's limits.");
    expect(judged(out, "a", "file", "shop/consts.py")).toEqual([
      expect.objectContaining({ rule: "F2", result: "holds", reason: "cosmetic" }),
    ]);
    expect(out.heads_ups.filter((h) => h.to === "a")).toEqual([]);
    expect(trunk.pool.attempts.get("a")!.premises.get("file|shop/consts.py")).toMatchObject({ derived: true });
  });

  it("LG10: the file turning unparseable gives F5, repair", () => {
    const trunk = setup();
    trunk.openAttempt("a", { intent: "use the helper" });
    call(trunk, "a", "read", { path: "shop/consts.py", entity: "helper" });
    call(trunk, "a", "write", { path: "notes.txt", content: "helper\n" });
    // The tools refuse to write a Python file that does not parse (LG1), so the opaque `after` is
    // handed to the classification of section 7 directly.
    const before = trunk.pool.files;
    const after = new Map(before).set("shop/consts.py", "LIMIT = = 3\n");
    const { items } = classify(trunk.pool, trunk.pool.attempts.get("a")!, before, after, null);
    expect(items.find((item) => item.kind === "file" && item.key === "shop/consts.py")).toMatchObject({
      rule: "F5",
      result: "repair",
    });
  });

  it("LG1: write and replace refuse Python that does not parse, with acorn's loc form", () => {
    const trunk = setup();
    trunk.openAttempt("s", { intent: "break it" });
    call(trunk, "s", "read", { path: "shop/consts.py" });
    const bad = call(trunk, "s", "write", { path: "shop/consts.py", content: "X = 1\nLIMIT = = 3\n" });
    expect(bad.error).toMatchObject({ code: "parse_error", detail: { line: 2, column: 8 } });
    const rep = call(trunk, "s", "replace", { path: "store/limits.go", old: "const Max = 3", new: "const Max = " });
    expect(rep.error).toMatchObject({ code: "parse_error", detail: { line: 4 } });
  });

  it("LG10: the file being removed gives F5, repair", () => {
    const trunk = setup();
    trunk.openAttempt("a", { intent: "use the helper" });
    call(trunk, "a", "read", { path: "shop/consts.py", entity: "helper" });
    call(trunk, "a", "write", { path: "notes.txt", content: "helper\n" });
    trunk.openAttempt("s", { intent: "remove consts" });
    call(trunk, "s", "read", { path: "shop/consts.py" });
    expect(call(trunk, "s", "write", { path: "shop/consts.py", delete: true }).ok).toBe(true);
    expect(call(trunk, "s", "submit", { summary: "remove consts" }).result).toMatchObject({ status: "validated" });
    const out = tickAndPush(trunk);
    expect(judged(out, "a", "file", "shop/consts.py")).toEqual([
      expect.objectContaining({ rule: "F5", result: "repair", reason: "referenced_file_changed" }),
    ]);
  });
});

describe("06-repos step 3: collisions on a shared Python and a shared Go constant", () => {
  it("C04 on Python: a shared constant read by entity, changed by a landing, repairs the referencer E2", () => {
    const trunk = setup();
    // The victim reads the constant and writes a module that imports it: a read premise and a
    // derived premise (LG9: `from shop.consts import LIMIT`) on shop/consts.py#LIMIT.
    trunk.openAttempt("a", { intent: "a cart that caches the limit" });
    expect(call(trunk, "a", "read", { path: "shop/consts.py", entity: "LIMIT" }).ok).toBe(true);
    const wr = call(trunk, "a", "write", {
      path: "shop/cache.py",
      content: "from shop.consts import LIMIT\n\nCACHED = LIMIT + 1\n",
    });
    expect(wr.premises).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "entity", key: "shop/consts.py#LIMIT", derived: true })]),
    );

    const out = land(trunk, "s", "shop/consts.py", "LIMIT = 3", "LIMIT = 1");

    const sent = out.heads_ups.filter((h) => h.to === "a");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.result).toBe("repair");
    const item = (sent[0]?.items as Item[]).find((i) => i.key === "shop/consts.py#LIMIT");
    expect(item).toMatchObject({ kind: "entity", rule: "E2", result: "repair" });
    expect(trunk.state("a")).toBe("going_around");

    call(trunk, "a", "replace", { path: "shop/cache.py", old: "CACHED = LIMIT + 1", new: "CACHED = LIMIT + 2" });
    const hns = trunk.pool.attempts.get("a")!.heads.map((h) => h.hn);
    expect(call(trunk, "a", "submit", { summary: "cache the limit", acknowledge: hns }).result).toMatchObject({
      status: "validated",
    });
    trunk.tick();
    trunk.pushOk();
    expect(trunk.state("a")).toBe("landed");
    expect(trunk.pool.files.get("shop/cache.py")).toContain("LIMIT + 2");
  });

  it("C04 on Go: a shared constant read by entity, changed by a landing, repairs the referencer E2", () => {
    const trunk = setup();
    // The victim reads Max and writes a file of the same package that uses it (LG9: same package).
    trunk.openAttempt("a", { intent: "a cache of the cap" });
    expect(call(trunk, "a", "read", { path: "store/limits.go", entity: "Max" }).ok).toBe(true);
    const wr = call(trunk, "a", "write", {
      path: "store/cache.go",
      content: "package store\n\nvar Cached = Max + 1\n",
    });
    expect(wr.premises).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "entity", key: "store/limits.go#Max", derived: true })]),
    );

    const out = land(trunk, "s", "store/limits.go", "const Max = 3", "const Max = 1");

    const sent = out.heads_ups.filter((h) => h.to === "a");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.result).toBe("repair");
    const item = (sent[0]?.items as Item[]).find((i) => i.key === "store/limits.go#Max");
    expect(item).toMatchObject({ kind: "entity", rule: "E2", result: "repair" });
    expect(trunk.state("a")).toBe("going_around");

    call(trunk, "a", "replace", { path: "store/cache.go", old: "Max + 1", new: "Max + 2" });
    const hns = trunk.pool.attempts.get("a")!.heads.map((h) => h.hn);
    expect(call(trunk, "a", "submit", { summary: "cache the cap", acknowledge: hns }).result).toMatchObject({
      status: "validated",
    });
    trunk.tick();
    trunk.pushOk();
    expect(trunk.state("a")).toBe("landed");
    expect(trunk.pool.files.get("store/cache.go")).toContain("Max + 2");
  });
});
