// The thirty-six pre-written intents of `src/config/prewritten.ts` against the tables of
// 02-tidepool.md section 9, word for word (plan 2.7 item: the texts are the rows, verbatim).
// The spec is read out of the file itself (BP1); a mismatch is reported by id with both texts
// and never patched over in `src/config`.

import { describe, expect, it } from "vitest";
import { PREWRITTEN } from "../../../src/config/prewritten.ts";
import { specText } from "../spec.ts";

/** The `{ id, text }` of every table row of section 9 (`| A01 | "text" | …`), in order. */
function specIntents(): Array<{ id: string; text: string }> {
  const text = specText();
  const start = text.indexOf("\n## 9. Seeded intents");
  const end = text.indexOf("\n## 10.", start);
  if (start === -1 || end === -1) throw new Error("section 9 bounds not found in 02-tidepool.md");
  const rows: Array<{ id: string; text: string }> = [];
  for (const line of text.slice(start, end).split("\n")) {
    const m = /^\|\s*([A-Za-z]\w*)\s*\|\s*"((?:[^"\\]|\\.)*)"\s*\|/.exec(line);
    if (m !== null) rows.push({ id: m[1] as string, text: m[2] as string });
  }
  return rows;
}

describe("the prewritten intents equal section 9 word for word", () => {
  it("every spec row is in PREWRITTEN with the same text, in table order", () => {
    const spec = specIntents();
    expect(spec.length).toBe(36);
    expect(PREWRITTEN.map((r) => r.id)).toEqual(spec.map((r) => r.id));
    for (const row of spec) {
      const got = PREWRITTEN.find((r) => r.id === row.id);
      expect(
        got?.text,
        `${row.id}: spec says "${row.text}", prewritten says "${got?.text ?? "<missing>"}"`,
      ).toBe(row.text);
    }
  });
});
