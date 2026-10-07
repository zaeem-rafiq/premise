import { describe, expect, it } from "vitest";
import { classify } from "./table.ts";
import { keyHash, type Attempt, type FileMap, type Op, type Premise } from "../trunk/sets.ts";

function premise(kind: Premise["kind"], key: string, files: FileMap, flags: Partial<Premise> = {}): Premise {
  const current = keyHash(files, kind, key);
  return {
    kind,
    key,
    hash: current.hash,
    seq: 0,
    members: current.members,
    shown: current.members,
    read: false,
    edit: false,
    derived: false,
    status: "holds",
    ...flags,
  };
}

function attempt(premises: Premise[], ops: Op[] = []): Attempt {
  return {
    id: "altering",
    intent_id: "intent",
    change_id: "change",
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
    approved_at: null,
    approved_option: null,
    policy_risk: null,
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
    intentText: "Alter the shared value",
    requester: "agent",
    opCount: ops.length,
    op_mark: null,
    premises: new Map(premises.map((p) => [`${p.kind}|${p.key}`, p])),
    ops,
    heads: [],
    resolved: new Set(),
    e1: new Set(),
    checks: null,
    opsFirstDone: false,
    pending: [],
    dirtyJudgments: new Set(),
  };
}

const source = "export const value = 1;\n";
const files = (): FileMap => new Map([["a.js", source]]);
const edit = (path = "a.js", op_seq = 1): Op => ({
  op_seq,
  op: "replace",
  path,
  old: "1",
  new: "2",
  targets: [`${path}#value`],
  dropped: false,
});

/** Replaying on after remains allowed. Unneeded analysis of the before view does not. */
function forbidBeforeView(files: FileMap): void {
  Object.defineProperty(files, Symbol.iterator, {
    value: () => {
      throw new Error("constructed an unnecessary pre-change attempt view");
    },
  });
}

describe("classification computes sets only when a decision needs them", () => {
  it("keeps unchanged premises without analysing the pre-change attempt view", () => {
    const before = files();
    const after = new Map(before);
    after.set("unrelated.txt", "A separate landing\n");
    const a = attempt([premise("entity", "a.js#value", before, { read: true })], [edit()]);
    forbidBeforeView(before);
    expect(classify(null, a, before, after, null)).toEqual({ items: [], failed: [] });
  });

  it("still reports OP2 when hashes hold but the replaced text now occurs twice", () => {
    const before = files();
    const after = new Map([["a.js", `${source}// Previous value: 1\n`]]);
    const p = premise("entity", "a.js#value", before, { edit: true });
    expect(keyHash(after, p.kind, p.key).hash).toBe(p.hash);
    const a = attempt([p], [edit()]);
    forbidBeforeView(before);
    expect(classify(null, a, before, after, null)).toEqual({
      items: [],
      failed: [{ op_seq: 1, path: "a.js", rule: "OP2" }],
    });
  });

  it("uses pre-change edits for E1 before reporting the failed replay", () => {
    const before = files();
    const after = new Map([["a.js", "export const value = 3;\n"]]);
    const a = attempt([premise("entity", "a.js#value", before, { edit: true })], [edit()]);
    const classified = classify(null, a, before, after, null);
    expect(classified.items).toMatchObject([{ rule: "E1", result: "repair", reason: "edited_entity_changed" }]);
    expect(classified.failed).toEqual([{ op_seq: 1, path: "a.js", rule: "OP1" }]);
    expect(a.ops[0]!.dropped).toBe(false);
  });

  it.each(["entity", "file"] as const)("keeps QR4 for a frozen %s reader when query members do not change", (kind) => {
    const before = files();
    const after = new Map(before);
    after.set("reader.txt", "This landing read the shared value.\n");
    const p = premise("query", "refs:a.js#value", before, { derived: true });
    const a = attempt([p], [edit()]);
    const read = premise(kind, kind === "entity" ? "a.js#value" : "a.js", before, { read: true });
    const classified = classify(null, a, before, after, null, [
      { attempt_id: "reader-first", premises: [read] },
      { attempt_id: "reader-second", premises: [read] },
    ]);
    expect(classified.items).toMatchObject([
      {
        key: "refs:a.js#value",
        old_hash: p.hash,
        new_hash: p.hash,
        rule: "QR4",
        result: "triage",
        reason: "reader_landed",
        decider: "reader-first",
      },
    ]);
    expect(classified.failed).toEqual([]);
  });

  it.each(["edit", "derived"] as const)("excludes a file reader whose entity premise is %s", (flag) => {
    const before = files();
    const after = new Map(before);
    const p = premise("query", "refs:a.js#value", before, { derived: true });
    const a = attempt([p], [edit()]);
    const lander = {
      attempt_id: "not-a-reader",
      premises: [
        premise("file", "a.js", before, { read: true }),
        premise("entity", "a.js#value", before, { [flag]: true }),
      ],
    };
    forbidBeforeView(before);
    expect(classify(null, a, before, after, null, [lander])).toEqual({ items: [], failed: [] });
  });

  it.each(["edit", "derived"] as const)("excludes an entity reader marked %s", (flag) => {
    const before = files();
    const after = new Map(before);
    const p = premise("query", "refs:a.js#value", before, { derived: true });
    const a = attempt([p], [edit()]);
    const lander = {
      attempt_id: "not-a-reader",
      premises: [premise("entity", "a.js#value", before, { read: true, [flag]: true })],
    };
    forbidBeforeView(before);
    expect(classify(null, a, before, after, null, [lander])).toEqual({ items: [], failed: [] });
  });

  it("does not apply QR4 to an operation that fails replay", () => {
    const before = files();
    const after = new Map([["a.js", `${source}// Previous value: 1\n`]]);
    const a = attempt([premise("query", "refs:a.js#value", before, { derived: true })], [edit()]);
    const classified = classify(null, a, before, after, null, [
      { attempt_id: "reader", premises: [premise("entity", "a.js#value", before, { read: true })] },
    ]);
    expect(classified).toEqual({ items: [], failed: [{ op_seq: 1, path: "a.js", rule: "OP2" }] });
  });

  it("keeps a rule-based repair when QR4 has a reader too", () => {
    const before = files();
    const after = new Map(before);
    after.set("reader.js", 'import { value } from "./a.js";\nexport const readValue = value;\n');
    const a = attempt([premise("query", "refs:a.js#value", before, { derived: true })], [edit()]);
    const classified = classify(null, a, before, after, null, [
      { attempt_id: "reader", premises: [premise("entity", "a.js#value", before, { read: true })] },
    ]);
    expect(classified.items).toMatchObject([
      { rule: "QR1", result: "repair", reason: "new_reference_to_altered_entity" },
    ]);
    expect(classified.items[0]!.decider).toBeUndefined();
  });

  it("keeps QR4 item order from Altered rather than the premise map", () => {
    const before = new Map([
      ["a.js", source],
      ["b.js", source],
    ]);
    const after = new Map(before);
    const a = attempt(
      [
        premise("query", "refs:a.js#value", before, { derived: true }),
        premise("query", "refs:b.js#value", before, { derived: true }),
      ],
      [edit("b.js", 1), edit("a.js", 2)],
    );
    const classified = classify(null, a, before, after, null, [
      {
        attempt_id: "reader",
        premises: [
          premise("entity", "a.js#value", before, { read: true }),
          premise("entity", "b.js#value", before, { read: true }),
        ],
      },
    ]);
    expect(classified.items.map((item) => ({ key: item.key, rule: item.rule }))).toEqual([
      { key: "refs:b.js#value", rule: "QR4" },
      { key: "refs:a.js#value", rule: "QR4" },
    ]);
  });
});
