// src/core/agent/inbox.test.ts — the five inbox cases of
// docs/spec/premise-cases.json (I01–I05, rule HU6a). The expected `show` run
// and `sync` flag come from the spec file, not from this implementation.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inboxNext } from "./inbox.ts";

type InboxCase = {
  id: string;
  rule: string;
  shown_hn: number;
  inbox: number[];
  expect: { show: number[]; sync: boolean };
};

const path = fileURLToPath(new URL("../../../docs/spec/premise-cases.json", import.meta.url));
const doc = JSON.parse(readFileSync(path, "utf8")) as { cases?: unknown };
const all: InboxCase[] = [];
const walk = (v: unknown): void => {
  if (Array.isArray(v)) {
    for (const x of v) walk(x);
    return;
  }
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if (typeof o.id === "string" && /^I0\d$/.test(o.id)) {
      all.push(o as unknown as InboxCase);
      return;
    }
    for (const x of Object.values(o)) walk(x);
  }
};
walk(doc);

describe("inboxNext (HU6a): the shown run and the sync flag", () => {
  it("loads all five cases I01–I05 from docs/spec/premise-cases.json", () => {
    expect(all.map((c) => c.id).sort()).toEqual(["I01", "I02", "I03", "I04", "I05"]);
  });
  for (const c of all) {
    it(`${c.id} (${c.rule}): shown_hn ${c.shown_hn}, inbox ${JSON.stringify(c.inbox)}`, () => {
      expect(inboxNext(c.shown_hn, c.inbox)).toEqual(c.expect);
    });
  }
});
