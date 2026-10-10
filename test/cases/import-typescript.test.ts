// test/cases/import-typescript.test.ts — 06-repos step 2 (LG1-LG3, LG5) at the engine level on a
// pool the import path itself created: `meta.app` "" makes openPool pick IMPORT_LANGUAGES, so
// `.ts`, `.tsx`, `.mts`, `.cts`, `.cjs` and `.jsx` are modules, `./config.js` resolves to the
// `.ts` file LG3 names, an entity premise is pinned by the entity's hash (types included), and a
// bare specifier is external — no premise, no check failure. The file set and every expected
// value are worked by hand from the specification (BP1); the last case replays vector C04 on a
// TypeScript constant.

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Sql } from "../../src/protocol/ports.ts";
import type { ToolRequest, ToolResponse, OutlineResult, ReadEntityResult } from "../../src/protocol/tools.ts";
import { Trunk } from "../../src/core/trunk/registry.ts";
import { an, entityAt } from "../../src/core/trunk/sets.ts";
import { IMPORT_LANGUAGES } from "../../src/core/keys/paths.ts";
import { blobId } from "../../src/core/sync/sha1.ts";
import { utf8 } from "../../src/core/sync/bytes.ts";
import { ScriptedTriage } from "../../src/swarm/scripted-triage.ts";

/** `node:sqlite` speaks the `Sql` port (same adapter shape the case driver uses). */
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

const CONFIG =
  "// The shared cap, counted in points.\n" +
  "export const CAP: number = 4;\n" +
  "\n" +
  "export interface Named {\n" +
  "  name: string;\n" +
  "}\n" +
  "\n" +
  "export type Pair = [number, number];\n";

// The imported tree: the shared constant in `src/config.ts`, the two modules that import it
// through the `.js` specifier LG3 maps to `.ts`, one of each added extension, a `.d.ts`, a
// module with a bare `react` import, and one `.ts` file that does not parse.
const FILES: Record<string, string> = {
  "src/config.ts": CONFIG,
  "src/a.ts": 'import { CAP } from "./config.js";\n\nexport function a(): number {\n  return CAP;\n}\n',
  "src/b.ts": 'import { CAP } from "./config.js";\n\nexport function b(): number {\n  return CAP + 1;\n}\n',
  "src/util.js": "export function util() {\n  return 1;\n}\n",
  "src/comp.tsx": "export const C = () => <div />;\n",
  "src/comp-jsx.jsx": "export const J = () => <span />;\n",
  "src/esm.mts": "export const M: number = 1;\n",
  "src/cts.cts": "export const K: number = 2;\n",
  "src/cjs.cjs": "export function twice(n) {\n  return n * 2;\n}\n",
  "types/globals.d.ts": "export declare const VERSION: string;\n",
  "src/lib.ts": 'import React from "react";\n\nexport const view = React.createElement;\n',
  "src/broken.ts": "export const broken: = 4;\n",
  "lib/lib.rs": "pub fn weigh(x: i32) -> i32 {\n    x * 2\n}\n",
};

const TREE = (n: number) => `${String(n).padStart(40, "0")}`;

/** An imported pool holding FILES: `createImported` + the job's finishing `importStep`. */
function setup(): { sql: Sql; trunk: Trunk } {
  const sql = sqlOver(new DatabaseSync(":memory:"));
  const trunk = Trunk.createImported(sql, {
    pool_id: "imp-ts",
    source: "tldrs/src-ts",
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
      { dir: "src", oid: TREE(2) },
      { dir: "types", oid: TREE(3) },
      { dir: "lib", oid: TREE(4) },
    ],
    finish: { head_commit: TREE(40), head_tree: TREE(1), guide: null },
  });
  expect(r).toMatchObject({ ok: true, done: true });
  return { sql, trunk };
}

function call(
  trunk: Trunk,
  attempt: string,
  n: number | string,
  tool: string,
  args: object,
  ack?: number,
): ToolResponse {
  return trunk.tool({
    attempt_id: attempt,
    call_id: `${attempt}:${n}`,
    tool: tool as ToolRequest["tool"],
    args,
    ack: ack ?? trunk.pool.attempts.get(attempt)?.heads.length ?? 0,
  });
}

type PremiseRow = { kind: string; key: string; read?: boolean; edit?: boolean; derived?: boolean };

describe("an imported pool works in IMPORT_LANGUAGES (06-repos step 2, LG1-LG3, LG5)", () => {
  it("LG1: the pool's language set is IMPORT_LANGUAGES; an opaque extension stays file-level", () => {
    const { trunk } = setup();
    expect(trunk.pool.languages).toBe(IMPORT_LANGUAGES);
    // The .rs neighbour is file-level under either set — readable, but never a module (LG1).
    trunk.openAttempt("a", { intent: "look around" });
    const rs = call(trunk, "a", 1, "outline", { path: "lib/lib.rs" });
    expect(rs.ok).toBe(false);
    expect(rs.error?.code).toBe("not_a_module");
    const rd = call(trunk, "a", 2, "read", { path: "lib/lib.rs" });
    expect(rd.ok).toBe(true);
    expect((rd.result as { content: string }).content).toContain("pub fn weigh");
  });

  it("LG5: outline and read with entity work on .ts, .tsx, .mts, .cts, .cjs, .jsx and .d.ts", () => {
    const { trunk } = setup();
    trunk.openAttempt("a", { intent: "inspect the modules" });

    for (const [path, want] of [
      ["src/config.ts", "CAP"],
      ["src/a.ts", "a"],
      ["src/util.js", "util"],
      ["src/comp.tsx", "C"],
      ["src/comp-jsx.jsx", "J"],
      ["src/esm.mts", "M"],
      ["src/cts.cts", "K"],
      ["src/cjs.cjs", "twice"],
      ["types/globals.d.ts", "VERSION"], // .d.ts follows .ts
    ] as const) {
      const r = call(trunk, "a", `o-${path}`, "outline", { path });
      expect(r.ok, path).toBe(true);
      const entities = (r.result as OutlineResult).entities;
      expect(
        entities.some((e) => e.name === want),
        path,
      ).toBe(true);
    }

    // LG2: an interface is an entity of kind `interface`, a type alias of kind `type`.
    const cfg = call(trunk, "a", "o-cfg2", "outline", { path: "src/config.ts" });
    const entities = (cfg.result as OutlineResult).entities;
    expect(entities.find((e) => e.name === "CAP")?.kind).toBe("const");
    expect(entities.find((e) => e.name === "Named")?.kind).toBe("interface");
    expect(entities.find((e) => e.name === "Pair")?.kind).toBe("type");

    const named = call(trunk, "a", "r-named", "read", { path: "src/config.ts", entity: "Named" });
    expect(named.ok).toBe(true);
    expect(named.result).toMatchObject({ key: "src/config.ts#Named", kind: "interface" });
    const pair = call(trunk, "a", "r-pair", "read", { path: "src/config.ts", entity: "Pair" });
    expect((pair.result as ReadEntityResult).kind).toBe("type");

    // A .ts file its parser cannot parse is opaque: `outline` answers not_a_module (LG5).
    const bad = call(trunk, "a", "o-bad", "outline", { path: "src/broken.ts" });
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("not_a_module");
  });

  it("LG3: `./config.js` resolves to `src/config.ts`; a bare specifier is external — no premise, no check failure", () => {
    const { trunk } = setup();
    trunk.openAttempt("a", { intent: "use the cap" });
    call(trunk, "a", 0, "read", { path: "src/config.ts", entity: "CAP" });

    // Writing a module that imports `./config.js` pins a derived entity premise on
    // `src/config.ts#CAP` — the specifier resolved LG3's replacement order to the .ts file.
    const w = call(trunk, "a", 1, "write", {
      path: "src/user.ts",
      content: 'import { CAP } from "./config.js";\n\nexport const mine: number = CAP + 1;\n',
    });
    expect(w.ok).toBe(true);
    const keys = (w.premises as PremiseRow[]).map((p) => `${p.kind}|${p.key}`);
    expect(keys).toContain("entity|src/config.ts#CAP");
    expect((w.premises as PremiseRow[]).find((p) => p.key === "src/config.ts#CAP")?.derived).toBe(true);

    // A bare specifier is external in an imported pool: `import React from "react"` makes no
    // premise, and no `banned_import` check fails the submit (the tide pool would refuse it).
    const bare = call(trunk, "a", 2, "write", {
      path: "src/view.ts",
      content: 'import React from "react";\n\nexport const view = React.createElement;\n',
    });
    expect(bare.ok).toBe(true);
    expect((bare.premises as PremiseRow[]).some((p) => p.key.includes("react"))).toBe(false);
    const sub = call(trunk, "a", 3, "submit", { summary: "a user and a view" });
    expect(sub.result).toMatchObject({ status: "validated" });
  });

  it("C04 on TypeScript: a shared `const` premise is pinned by its entity hash — a landing behind it repairs the referencer E2", () => {
    const { trunk } = setup();

    // The victim: reads the constant by entity, then writes a module that imports it — a read
    // premise and a derived premise on `src/config.ts#CAP` (D1 through the .js specifier).
    trunk.openAttempt("a", { intent: "a crab that caches the cap" });
    const rd = call(trunk, "a", 1, "read", { path: "src/config.ts", entity: "CAP" });
    expect(rd.ok).toBe(true);
    expect(rd.premises).toEqual([
      expect.objectContaining({ kind: "entity", key: "src/config.ts#CAP", read: true, derived: false }),
    ]);
    const capHash = entityAt(trunk.pool.files, "src/config.ts#CAP", trunk.pool.languages)?.hash;
    expect(trunk.pool.attempts.get("a")?.premises.get("entity|src/config.ts#CAP")?.hash).toBe(capHash);

    call(trunk, "a", 2, "write", {
      path: "src/user.ts",
      content: 'import { CAP } from "./config.js";\n\nexport const mine: number = CAP + 1;\n',
    });

    // The breaker: changes CAP and lands first.
    trunk.openAttempt("s", { intent: "lower the cap to 1" });
    call(trunk, "s", 1, "read", { path: "src/config.ts", entity: "CAP" });
    const rep = call(trunk, "s", 2, "replace", {
      path: "src/config.ts",
      old: "CAP: number = 4",
      new: "CAP: number = 1",
    });
    expect(rep.ok).toBe(true);
    // LG3 in the landing write set: the referencers named are a.ts/b.ts entities, reached
    // through their `.js` specifiers.
    const relied = (rep.result as { relied_on_by: Record<string, string[]> }).relied_on_by["src/config.ts#CAP"];
    expect(relied).toEqual(
      expect.arrayContaining([expect.stringMatching(/^src\/a\.ts#/), expect.stringMatching(/^src\/b\.ts#/)]),
    );
    const sub = call(trunk, "s", 3, "submit", { summary: "cap is 1" });
    expect(sub.result).toMatchObject({ status: "validated" });

    // s lands; the premise's entity hash moved under it — the referencer is sent around (E2).
    trunk.tick();
    const sent = trunk.out.heads_ups.filter((h) => h.to === "a");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.result).toBe("repair");
    const item = (sent[0]?.items as Array<Record<string, unknown>>).find((i) => i.key === "src/config.ts#CAP");
    expect(item).toMatchObject({ kind: "entity", rule: "E2", result: "repair" });
    expect(item?.after).toContain("CAP: number = 1");
    expect(trunk.state("a")).toBe("going_around");
    expect(trunk.pool.attempts.get("a")?.go_arounds).toBe(1);
    // The premise was pinned by the read-time entity hash: the heads-up item's old_hash is
    // exactly the hash a pinned, and new_hash is the landed entity's (pinning is by entity
    // hash, not by file — `src/config.ts` is still there, its CAP is not the same entity).
    const body = (trunk.pool.attempts.get("a")?.heads[0]?.body.items ?? []).find(
      (i) => i.premise.key === "src/config.ts#CAP",
    );
    expect(body?.old_hash).toBe(capHash);
    const now = entityAt(trunk.pool.files, "src/config.ts#CAP", trunk.pool.languages)?.hash;
    expect(now).toBeTruthy();
    expect(body?.new_hash).toBe(now);
    expect(body?.diff).toMatchObject({ kind: "entity", after: expect.stringContaining("CAP: number = 1") });
    trunk.pushOk();
    expect(trunk.state("s")).toBe("landed");

    // The referencer repairs and lands — the go-around replays its ops under the same set.
    call(trunk, "a", 3, "replace", {
      path: "src/user.ts",
      old: "export const mine: number = CAP + 1;",
      new: "export const mine: number = CAP + 2;",
    });
    const hns = trunk.pool.attempts.get("a")!.heads.map((h) => h.hn);
    const again = call(trunk, "a", 4, "submit", { summary: "cache cap 1", acknowledge: hns });
    expect(again.result).toMatchObject({ status: "validated" });
    trunk.tick();
    trunk.pushOk();
    expect(trunk.state("a")).toBe("landed");
    expect(trunk.pool.files.get("src/user.ts")).toContain("CAP + 2");
  });

  it("LG2: a change to a type annotation alone is a change of the entity's hash", () => {
    const { trunk } = setup();
    const before = an(trunk.pool.files, trunk.pool.languages).modules.get("src/config.ts");
    const cap = before?.entities.find((e) => e.name === "CAP");
    expect(cap?.kind).toBe("const");

    // `CAP: number` -> `CAP: number | 0`: the value tokens are identical; only the annotation
    // changed. 2.4's canonical form carries the annotation, so the hash — and with it every
    // premise pinned on the entity — moves.
    const files = new Map(trunk.pool.files);
    files.set("src/config.ts", CONFIG.replace("CAP: number = 4", "CAP: number | 0 = 4"));
    const changed = an(files, trunk.pool.languages).modules.get("src/config.ts");
    const moved = changed?.entities.find((e) => e.name === "CAP");
    expect(moved?.hash).toBeTruthy();
    expect(moved?.hash).not.toBe(cap?.hash);
  });
});
