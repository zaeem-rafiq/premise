// src/core/classify/table.test.ts — one test per row of the decision table of 7.2.
// Every expected (result, reason) is quoted from the table of docs/spec/01-core.md 7.2, never
// read back out of the implementation (BP1). The smallest input that reaches each row is a
// pinned premise, an attempt and a (before -> after) pair; the attempt's sets come from the
// real setsOf.

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Sql } from "../../protocol/ports.ts";
import { ABSENT } from "../../protocol/premise.ts";
import { Trunk } from "../trunk/registry.ts";
import { keyHash, setsOf, targetsOf } from "../trunk/sets.ts";
import type { Attempt, FileMap, Op, Pool, Premise } from "../trunk/sets.ts";
import { blobId } from "../sync/sha1.ts";
import { utf8 } from "../sync/bytes.ts";
import { classify } from "./table.ts";

// classify/rowFor take `pool` for callers that have one; the table itself never reads it.
const NO_POOL = null as unknown as Pool;

const fm = (files: Record<string, string>): FileMap => new Map(Object.entries(files));

function premise(kind: Premise["kind"], key: string, at: FileMap, extra: Partial<Premise> = {}): Premise {
  const cur = keyHash(at, kind, key);
  return {
    kind,
    key,
    hash: cur.hash,
    seq: 0,
    members: cur.members,
    shown: Array.isArray(cur.members) ? cur.members : null,
    read: false,
    edit: false,
    derived: false,
    status: "holds",
    ...extra,
  };
}

type OpSpec =
  { op: "write"; path: string; content: string | null } | { op: "replace"; path: string; old: string; new: string };

/** Ops as the tool layer records them (5.1): base_oid/targets computed on the evolving tree. */
function opsFrom(tree: FileMap, steps: OpSpec[]): Op[] {
  let files = new Map(tree);
  const ops: Op[] = [];
  steps.forEach((s, i) => {
    if (s.op === "write") {
      const head = files.get(s.path);
      ops.push({
        op_seq: i + 1,
        op: "write",
        path: s.path,
        content: s.content,
        base_oid: head === undefined ? ABSENT : blobId(utf8(head)),
        dropped: false,
      });
      if (s.content === null) files.delete(s.path);
      else files.set(s.path, s.content);
    } else {
      const content = files.get(s.path) ?? "";
      const off = content.indexOf(s.old);
      ops.push({
        op_seq: i + 1,
        op: "replace",
        path: s.path,
        old: s.old,
        new: s.new,
        targets: targetsOf(files, s.path, off, off + s.old.length),
        dropped: false,
      });
      files.set(s.path, content.slice(0, off) + s.new + content.slice(off + s.old.length));
    }
  });
  return ops;
}

function attempt(premises: Premise[], ops: Op[] = []): Attempt {
  const a: Attempt = {
    id: "A",
    intent_id: "I",
    change_id: "C",
    agent_kind: "real",
    model: null,
    race: false,
    truth: null,
    resumes: 0,
    state: "working",
    stop_reason: null,
    go_arounds: 0,
    pull_backs: 0,
    revision: 0,
    right_of_way_at: null,
    opened_seq: 0,
    submit_id: null,
    summary: null,
    tier: null,
    approved_by: null,
    bypass_row: false,
    submitted_at: null,
    validated_at: null,
    landed_seq: null,
    attempt_repo: null,
    last_call_id: null,
    last_response: null,
    ack: 0,
    next_hn: 1,
    updated_at: 0,
    intentText: "",
    requester: "agent",
    opCount: ops.length,
    op_mark: null,
    premises: new Map(),
    ops,
    heads: [],
    resolved: new Set(),
    e1: new Set(),
    checks: null,
    opsFirstDone: false,
    pending: [],
    dirtyJudgments: new Set(),
  };
  for (const p of premises) a.premises.set(`${p.kind}|${p.key}`, p);
  return a;
}

/** classify() narrowed to the single item a test's one premise can produce. */
function item(a: Attempt, before: FileMap, after: FileMap, landers: Array<{ premises: Premise[] }> = []) {
  const c = classify(NO_POOL, a, before, after, setsOf(a, before), landers);
  expect(c.items.length).toBeLessThanOrEqual(1);
  return c.items[0];
}

const MOD_X = "export const x = 1;\n";
const MOD_X2 = "export const x = 2;\n";
// B keeps an import of x (module references) while b2 is what the attempt edits.
const MOD_B = 'import { x } from "./a.js";\nexport const b1 = x;\nexport const b2 = 1;\n';

describe("7.2 decision table", () => {
  // X0: no current operations and the kind-specific row is a triage row -> info heads-up, holds.
  it("X0 no_patch_yet", () => {
    const before = fm({ "a.js": MOD_X });
    const after = fm({ "a.js": MOD_X2 });
    const a = attempt([premise("entity", "a.js#x", before, { read: true })]);
    const it0 = item(a, before, after);
    expect([it0?.rule, it0?.result, it0?.reason]).toEqual(["X0", "info", "no_patch_yet"]);
  });

  // E0: hash unchanged -> holds; not classified, not recorded (no item at all).
  it("E0 unchanged", () => {
    const before = fm({ "a.js": MOD_X });
    const after = fm({ "a.js": MOD_X, "b.txt": "hi" });
    const a = attempt([premise("entity", "a.js#x", after)]);
    expect(item(a, before, after)).toBeUndefined();
  });

  // E1: hash changed, edits -> repair, edited_entity_changed.
  it("E1 edited_entity_changed", () => {
    const before = fm({ "a.js": MOD_X });
    const after = fm({ "a.js": MOD_X2 });
    const a = attempt([premise("entity", "a.js#x", before, { edit: true })]);
    expect(item(a, before, after)).toMatchObject({ rule: "E1", result: "repair", reason: "edited_entity_changed" });
  });

  // E2: hash changed, references -> repair, referenced_entity_changed.
  it("E2 referenced_entity_changed", () => {
    const before = fm({ "a.js": MOD_X });
    const after = fm({ "a.js": MOD_X2 });
    const a = attempt(
      [premise("entity", "a.js#x", before)],
      opsFrom(before, [{ op: "write", path: "b.js", content: 'import { x } from "./a.js";\nexport const b = x;\n' }]),
    );
    expect(item(a, before, after)).toMatchObject({
      rule: "E2",
      result: "repair",
      reason: "referenced_entity_changed",
    });
  });

  // E2m: hash changed, module references -> confirm, module_reference_changed.
  it("E2m module_reference_changed", () => {
    const before = fm({ "a.js": MOD_X, "b.js": MOD_B });
    const after = fm({ "a.js": MOD_X2, "b.js": MOD_B });
    const a = attempt(
      [premise("entity", "a.js#x", before)],
      opsFrom(before, [{ op: "replace", path: "b.js", old: "export const b2 = 1;", new: "export const b2 = 2;" }]),
    );
    expect(item(a, before, after)).toMatchObject({
      rule: "E2m",
      result: "confirm",
      reason: "module_reference_changed",
    });
  });

  // E3: hash changed, read -> triage, read_not_referenced.
  it("E3 read_not_referenced", () => {
    const before = fm({ "a.js": MOD_X });
    const after = fm({ "a.js": MOD_X2 });
    const a = attempt(
      [premise("entity", "a.js#x", before, { read: true })],
      opsFrom(before, [{ op: "write", path: "z.txt", content: "z" }]),
    );
    expect(item(a, before, after)).toMatchObject({ rule: "E3", result: "triage", reason: "read_not_referenced" });
  });

  // E4: hash changed, none of the above -> premise deleted, reference_gone.
  it("E4 reference_gone", () => {
    const before = fm({ "a.js": MOD_X });
    const after = fm({ "a.js": MOD_X2 });
    const a = attempt(
      [premise("entity", "a.js#x", before)],
      opsFrom(before, [{ op: "write", path: "z.txt", content: "z" }]),
    );
    expect(item(a, before, after)).toMatchObject({ rule: "E4", result: "delete", reason: "reference_gone" });
  });

  // F0: blob id unchanged -> holds; not classified.
  it("F0 unchanged", () => {
    const before = fm({ "a.js": MOD_X });
    const after = fm({ "a.js": MOD_X, "b.txt": "hi" });
    const a = attempt([premise("file", "a.js", after)]);
    expect(item(a, before, after)).toBeUndefined();
  });

  // F1: blob id changed, edits (a write on P) -> repair, write_base_changed.
  it("F1 write_base_changed", () => {
    const before = fm({ "a.js": MOD_X });
    const after = fm({ "a.js": MOD_X2 });
    const a = attempt(
      [premise("file", "a.js", before, { edit: true })],
      opsFrom(before, [{ op: "write", path: "a.js", content: "export const x = 3;\n" }]),
    );
    expect(item(a, before, after)).toMatchObject({ rule: "F1", result: "repair", reason: "write_base_changed" });
  });

  // F2: blob id changed, D empty -> holds, cosmetic.
  it("F2 cosmetic", () => {
    const before = fm({ "a.js": MOD_X });
    const after = fm({ "a.js": MOD_X + "// a trailing comment\n" });
    const a = attempt(
      [premise("file", "a.js", before)],
      opsFrom(before, [{ op: "write", path: "z.txt", content: "z" }]),
    );
    expect(item(a, before, after)).toMatchObject({ rule: "F2", result: "holds", reason: "cosmetic" });
  });

  // F3: blob id changed, D non-empty, D intersects NewRefs -> repair, referenced_entity_changed.
  it("F3 referenced_entity_changed", () => {
    const before = fm({ "a.js": MOD_X });
    const after = fm({ "a.js": MOD_X2 });
    const a = attempt(
      [premise("file", "a.js", before)],
      opsFrom(before, [{ op: "write", path: "b.js", content: 'import { x } from "./a.js";\nexport const b = x;\n' }]),
    );
    expect(item(a, before, after)).toMatchObject({
      rule: "F3",
      result: "repair",
      reason: "referenced_entity_changed",
    });
  });

  // F3 through P in NewRefs (a whole-module reference) -> referenced_file_changed.
  it("F3 referenced_file_changed", () => {
    const before = fm({ "a.js": MOD_X });
    const after = fm({ "a.js": MOD_X2 });
    const a = attempt(
      [premise("file", "a.js", before)],
      opsFrom(before, [
        { op: "write", path: "c.js", content: 'import * as A from "./a.js";\nexport const c = A.x;\n' },
      ]),
    );
    expect(item(a, before, after)).toMatchObject({
      rule: "F3",
      result: "repair",
      reason: "referenced_file_changed",
    });
  });

  // F3m: blob id changed, D non-empty, D intersects ModuleRefs -> confirm, module_reference_changed.
  it("F3m module_reference_changed", () => {
    const before = fm({ "a.js": MOD_X, "b.js": MOD_B });
    const after = fm({ "a.js": MOD_X2, "b.js": MOD_B });
    const a = attempt(
      [premise("file", "a.js", before)],
      opsFrom(before, [{ op: "replace", path: "b.js", old: "export const b2 = 1;", new: "export const b2 = 2;" }]),
    );
    expect(item(a, before, after)).toMatchObject({
      rule: "F3m",
      result: "confirm",
      reason: "module_reference_changed",
    });
  });

  // F4: blob id changed, D non-empty, read -> triage, read_not_referenced.
  it("F4 read_not_referenced", () => {
    const before = fm({ "a.js": MOD_X });
    const after = fm({ "a.js": MOD_X2 });
    const a = attempt(
      [premise("file", "a.js", before, { read: true })],
      opsFrom(before, [{ op: "write", path: "z.txt", content: "z" }]),
    );
    expect(item(a, before, after)).toMatchObject({ rule: "F4", result: "triage", reason: "read_not_referenced" });
  });

  // F5: P opaque before or after, P (or an entity of P) referenced -> repair, referenced_file_changed.
  it("F5 referenced_file_changed", () => {
    const before = fm({ "data.txt": "one" });
    const after = fm({ "data.txt": "two" });
    const a = attempt(
      [premise("file", "data.txt", before)],
      opsFrom(before, [
        { op: "write", path: "c.js", content: 'import * as d from "./data.txt";\nexport const c = d;\n' },
      ]),
    );
    expect(item(a, before, after)).toMatchObject({
      rule: "F5",
      result: "repair",
      reason: "referenced_file_changed",
    });
  });

  // F6: P opaque, read -> triage, read_not_referenced.
  it("F6 read_not_referenced", () => {
    const before = fm({ "data.txt": "one" });
    const after = fm({ "data.txt": "two" });
    const a = attempt(
      [premise("file", "data.txt", before, { read: true })],
      opsFrom(before, [{ op: "write", path: "z.txt", content: "z" }]),
    );
    expect(item(a, before, after)).toMatchObject({ rule: "F6", result: "triage", reason: "read_not_referenced" });
  });

  // F7: any change, read = 0 and nothing above -> premise deleted, reference_gone.
  it("F7 reference_gone", () => {
    const before = fm({ "data.txt": "one" });
    const after = fm({ "data.txt": "two" });
    const a = attempt(
      [premise("file", "data.txt", before)],
      opsFrom(before, [{ op: "write", path: "z.txt", content: "z" }]),
    );
    expect(item(a, before, after)).toMatchObject({ rule: "F7", result: "delete", reason: "reference_gone" });
  });

  // L0: entry names unchanged -> holds; not classified.
  it("L0 unchanged", () => {
    const before = fm({ "dir/one.txt": "1", "dir/two.txt": "2" });
    const after = fm({ "dir/one.txt": "one!", "dir/two.txt": "2" });
    const a = attempt([premise("listing", "dir/", after)]);
    expect(item(a, before, after)).toBeUndefined();
  });

  // L1: unshown names exist and the attempt is sweeping -> repair, sweep_incomplete.
  it("L1 sweep_incomplete", () => {
    const before = fm({ "dir/one.txt": "1", "dir/two.txt": "2" });
    const after = fm({ "dir/one.txt": "1", "dir/two.txt": "2", "dir/three.txt": "3" });
    const a = attempt(
      [premise("listing", "dir/", before)],
      opsFrom(before, [
        { op: "write", path: "dir/one.txt", content: "1!" },
        { op: "write", path: "dir/two.txt", content: "2!" },
      ]),
    );
    const it1 = item(a, before, after);
    expect(it1).toMatchObject({ rule: "L1", result: "repair", reason: "sweep_incomplete" });
    expect(it1?.added).toEqual(["three.txt"]);
  });

  // L2: a gained or lost name is a string literal of an added/altered entity -> confirm, listing_named.
  it("L2 listing_named", () => {
    const before = fm({ "dir/one.txt": "1", "dir/two.txt": "2" });
    const after = fm({ "dir/one.txt": "1" });
    const a = attempt(
      [premise("listing", "dir/", before)],
      opsFrom(before, [{ op: "write", path: "c.js", content: 'export const f = "two.txt";\n' }]),
    );
    expect(item(a, before, after)).toMatchObject({ rule: "L2", result: "confirm", reason: "listing_named" });
  });

  // L3: names gained or lost, otherwise -> holds, listing_unused.
  it("L3 listing_unused", () => {
    const before = fm({ "dir/one.txt": "1", "dir/two.txt": "2" });
    const after = fm({ "dir/one.txt": "1", "dir/two.txt": "2", "dir/three.txt": "3" });
    const a = attempt(
      [premise("listing", "dir/", before)],
      opsFrom(before, [{ op: "write", path: "z.txt", content: "z" }]),
    );
    expect(item(a, before, after)).toMatchObject({ rule: "L3", result: "holds", reason: "listing_unused" });
  });

  // QT0: members unchanged -> holds; not classified.
  it("QT0 unchanged", () => {
    const before = fm({ "m.js": "export function f() { return 'needle'; }\n" });
    const after = fm({ "m.js": "export function f() { return 'needle'; }\n", "z.txt": "z" });
    const a = attempt([premise("query", "text:/:needle", after)]);
    expect(item(a, before, after)).toBeUndefined();
  });

  // QT1: a container gained and at least min(2, m) pinned containers are swept -> repair.
  it("QT1 sweep_incomplete", () => {
    const M = "export function f() { return 'needle'; }\n";
    const N = "export function g() { return 'needle'; }\n";
    const before = fm({ "m.js": M, "n.js": N });
    const after = fm({ "m.js": M, "n.js": N, "o.js": "export function h() { return 'needle'; }\n" });
    const a = attempt(
      [premise("query", "text:/:needle", before)],
      opsFrom(before, [
        { op: "replace", path: "m.js", old: "needle", new: "pin" },
        { op: "replace", path: "n.js", old: "needle", new: "pin" },
      ]),
    );
    expect(item(a, before, after)).toMatchObject({ rule: "QT1", result: "repair", reason: "sweep_incomplete" });
  });

  // QT2: a container gained, otherwise -> triage, search_gained_match.
  it("QT2 search_gained_match", () => {
    const M = "export function f() { return 'needle'; }\n";
    const before = fm({ "m.js": M });
    const after = fm({ "m.js": M, "o.js": "export function h() { return 'needle'; }\n" });
    const a = attempt(
      [premise("query", "text:/:needle", before)],
      opsFrom(before, [{ op: "write", path: "z.txt", content: "z" }]),
    );
    expect(item(a, before, after)).toMatchObject({
      rule: "QT2",
      result: "triage",
      reason: "search_gained_match",
    });
  });

  // QT3: containers only lost -> holds, match_lost.
  it("QT3 match_lost", () => {
    const M = "export function f() { return 'needle'; }\n";
    const N = "export function g() { return 'needle'; }\n";
    const before = fm({ "m.js": M, "n.js": N });
    const after = fm({ "m.js": M });
    const a = attempt(
      [premise("query", "text:/:needle", before)],
      opsFrom(before, [{ op: "write", path: "z.txt", content: "z" }]),
    );
    expect(item(a, before, after)).toMatchObject({ rule: "QT3", result: "holds", reason: "match_lost" });
  });

  // QR0: members unchanged and QR4 does not apply -> holds; not classified.
  it("QR0 unchanged", () => {
    const B = 'import { x } from "./a.js";\nexport const b = x;\n';
    const before = fm({ "a.js": MOD_X, "b.js": B });
    const after = fm({ "a.js": MOD_X, "b.js": B, "z.txt": "z" });
    const a = attempt([premise("query", "refs:a.js#x", after)]);
    expect(item(a, before, after)).toBeUndefined();
  });

  // QR1: E in Altered and a referrer key gained -> repair, new_reference_to_altered_entity.
  it("QR1 new_reference_to_altered_entity", () => {
    const before = fm({ "a.js": MOD_X, "c.js": "export const c = 0;\n" });
    const after = fm({ "a.js": MOD_X, "c.js": 'import { x } from "./a.js";\nexport const c = x;\n' });
    const a = attempt(
      [premise("query", "refs:a.js#x", before)],
      opsFrom(before, [{ op: "replace", path: "a.js", old: "export const x = 1;", new: "export const x = 7;" }]),
    );
    expect(item(a, before, after)).toMatchObject({
      rule: "QR1",
      result: "repair",
      reason: "new_reference_to_altered_entity",
    });
  });

  // QR1m: no referrer gained; an entity of a module holding a referrer changed -> confirm.
  it("QR1m referrer_module_changed", () => {
    const B2 = 'import { x } from "./a.js";\nexport const b1 = x;\nexport const b2 = 9;\n';
    const before = fm({ "a.js": MOD_X, "b.js": MOD_B });
    const after = fm({ "a.js": MOD_X, "b.js": B2 });
    const a = attempt(
      [premise("query", "refs:a.js#x", before)],
      opsFrom(before, [{ op: "replace", path: "a.js", old: "export const x = 1;", new: "export const x = 7;" }]),
    );
    expect(item(a, before, after)).toMatchObject({
      rule: "QR1m",
      result: "confirm",
      reason: "referrer_module_changed",
    });
  });

  // QR2: referrers only lost -> holds, match_lost.
  it("QR2 match_lost", () => {
    const B = 'import { x } from "./a.js";\nexport const b = x;\n';
    const B2 = "export const b = 0;\n";
    const before = fm({ "a.js": MOD_X, "b.js": B });
    const after = fm({ "a.js": MOD_X, "b.js": B2 });
    const a = attempt(
      [premise("query", "refs:a.js#x", before)],
      opsFrom(before, [{ op: "replace", path: "a.js", old: "export const x = 1;", new: "export const x = 7;" }]),
    );
    expect(item(a, before, after)).toMatchObject({ rule: "QR2", result: "holds", reason: "match_lost" });
  });

  // QR3: E no longer in Altered -> premise deleted (rule D2).
  it("QR3 delete", () => {
    const B = 'import { x } from "./a.js";\nexport const b = x;\n';
    const B2 = "export const b = 0;\n";
    const before = fm({ "a.js": MOD_X, "b.js": B });
    const after = fm({ "a.js": MOD_X, "b.js": B2 });
    const a = attempt(
      [premise("query", "refs:a.js#x", before)],
      opsFrom(before, [{ op: "write", path: "z.txt", content: "z" }]),
    );
    expect(item(a, before, after)).toMatchObject({ rule: "QR3", result: "delete" });
  });

  // QR4: a landing being classified only read E while this attempt alters E -> triage, reader_landed.
  it("QR4 reader_landed", () => {
    const before = fm({ "a.js": MOD_X });
    const after = fm({ "a.js": MOD_X });
    const a = attempt(
      [premise("query", "refs:a.js#x", before)],
      opsFrom(before, [{ op: "replace", path: "a.js", old: "export const x = 1;", new: "export const x = 7;" }]),
    );
    const lander = { premises: [premise("entity", "a.js#x", before, { read: true })] };
    const it4 = item(a, before, after, [lander]);
    expect(it4).toMatchObject({ rule: "QR4", result: "triage", reason: "reader_landed" });
  });

  // QO0: outline lines unchanged -> holds; not classified.
  it("QO0 unchanged", () => {
    const before = fm({ "a.js": "export const x = 1;\nexport const y = 2;\n" });
    const after = fm({ "a.js": "export const x = 1;\nexport const y = 2;\n", "z.txt": "z" });
    const a = attempt([premise("query", "outline:a.js", after)]);
    expect(item(a, before, after)).toBeUndefined();
  });

  // QO1: lines changed and a changed entity is referenced or edited -> repair.
  it("QO1 outlined_entity_changed", () => {
    // The landing renames y to z: the line for y disappears, the line for z appears, and the
    // attempt's patch edits y (Edited).
    const before = fm({ "a.js": "export const x = 1;\nexport const y = 2;\n" });
    const after = fm({ "a.js": "export const x = 1;\nexport const z = 2;\n" });
    const a = attempt(
      [premise("query", "outline:a.js", before)],
      opsFrom(before, [{ op: "replace", path: "a.js", old: "export const y = 2;", new: "export const y = 3;" }]),
    );
    expect(item(a, before, after)).toMatchObject({
      rule: "QO1",
      result: "repair",
      reason: "outlined_entity_changed",
    });
  });

  // QO2: lines changed, otherwise -> holds, outline_unused.
  it("QO2 outline_unused", () => {
    const before = fm({ "a.js": "export const x = 1;\nexport const y = 2;\n" });
    const after = fm({ "a.js": "export const x = 1;\nconst w = 0;\nexport const y = 2;\n" });
    const a = attempt(
      [premise("query", "outline:a.js", before)],
      opsFrom(before, [{ op: "write", path: "z.txt", content: "z" }]),
    );
    expect(item(a, before, after)).toMatchObject({ rule: "QO2", result: "holds", reason: "outline_unused" });
  });

  // Z1 (V5): a changed premise no row matches -> confirm, unclassified (fail closed).
  it("Z1 unclassified", () => {
    const before = fm({ "a.js": MOD_X });
    const after = fm({ "a.js": MOD_X });
    const p = premise("query", "bogus:key", before, { hash: "stale" });
    const a = attempt([p], opsFrom(before, [{ op: "write", path: "z.txt", content: "z" }]));
    expect(item(a, before, after)).toMatchObject({ rule: "Z1", result: "confirm", reason: "unclassified" });
  });
});

// ---- Rows owned outside classify(): B1 is submit's blind spot (6.4); CKL is the tick's failed
// check (9.4 step 3c). Both go through the real engine on an in-memory store.

function memoryTrunk(seed: Record<string, string>): Trunk {
  const db = new DatabaseSync(":memory:");
  const sql: Sql = {
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
  return Trunk.create(sql, seed, {});
}

describe("7.2 rows outside classify()", () => {
  // B1: blind spot at submit (6.4) -> confirm (vector C09 in miniature: the write references an
  // entity the agent never read).
  it("B1 blind_spot", () => {
    const trunk = memoryTrunk({ "world/energy.js": "export const ENERGY_MAX = 100;\n" });
    trunk.openAttempt("A", { intent: "a crab", agent_kind: "real" });
    trunk.tool({ attempt_id: "A", call_id: "A:1", tool: "outline", args: { path: "world/energy.js" }, ack: 0 });
    trunk.tool({
      attempt_id: "A",
      call_id: "A:2",
      tool: "write",
      args: {
        path: "creatures/crab.js",
        content:
          'import { ENERGY_MAX } from "../world/energy.js";\n' +
          "export function spawn() { return { energy: ENERGY_MAX }; }\n",
      },
      ack: 0,
    });
    const r = trunk.tool({
      attempt_id: "A",
      call_id: "A:3",
      tool: "submit",
      args: { summary: "add a crab" },
      ack: 0,
    });
    expect(r.ok).toBe(true);
    const j = trunk.pool.out.judgments.find((j0) => j0.rule === "B1");
    expect(j).toMatchObject({ kind: "entity", key: "world/energy.js#ENERGY_MAX", result: "confirm" });
  });

  // CKL: a check failed in the tick (9.4 step 3c) -> repair, reason checks_failed_at_landing.
  // The smallest empty change: the attempt's only op writes head content verbatim.
  // Spec row: "| CKL | a check failed in the tick (9.4 step 3c); the item's premise is
  // `{ kind: "check", key: <check name> }` | `repair`, reason `checks_failed_at_landing` |".
  // The engine emits exactly this at tick.ts step 3c, but no reachable run produces it here:
  // an empty change is rejected at submit (CK3 `empty_change`), and every op that stops
  // applying while queued (OP1/OP5) makes the candidate `not_disjoint` at step 3b before 3c
  // runs. it.fails documents the row as specified; the engine's answer today is `not_disjoint`
  // for every constructible input.
  it.fails("CKL checks_failed_at_landing", () => {
    const trunk = memoryTrunk({ "w.txt": "same\n" });
    trunk.openAttempt("A", { intent: "noop", agent_kind: "real" });
    trunk.tool({ attempt_id: "A", call_id: "A:1", tool: "write", args: { path: "w.txt", content: "same\n" }, ack: 0 });
    const r = trunk.tool({
      attempt_id: "A",
      call_id: "A:2",
      tool: "submit",
      args: { summary: "noop" },
      ack: 0,
    });
    expect(r.ok).toBe(true);
    trunk.tick();
    const j = trunk.pool.out.judgments.find((j0) => j0.rule === "CKL");
    expect(j).toMatchObject({ kind: "check", key: "non_empty", result: "repair", reason: "checks_failed_at_landing" });
  });
});
