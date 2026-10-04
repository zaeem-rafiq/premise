// `gold-a` (02-tidepool.md 8.2, 10.5): the repaint sweep verbatim — first colour constant
// `"gold"`, the rest `"#b8860b"` — the L1 `repair` that reads each `added` member and repaints
// it the same way, and SW7's `withdrawn` at a second `repair`.

import { describe, expect, it } from "vitest";
import { GOLD_A } from "./gold-a.ts";
import { bag, err, hu, item, listingDiff, ok, step } from "./testkit.ts";

const L = (key: string) => ({ kind: "listing" as const, key });
const FISH = `const BODY = "pink";
const FIN = "pink";
export function draw() {}
`;

describe("gold-a (02-tidepool.md 10.5)", () => {
  it("carries the intent and truth list of the table", () => {
    expect(GOLD_A.id).toBe("gold-a");
    expect(GOLD_A.intent).toBe("repaint every creature in gold");
    expect(GOLD_A.truth).toEqual(["listing:creatures/"]);
  });

  it("lists, reads each file the listing names and repaints gold then #b8860b (8.2)", () => {
    const b = bag();
    expect(step(GOLD_A, b, null)).toMatchObject({ kind: "tool", tool: "list", args: { path: "creatures/" } });
    expect(
      step(
        GOLD_A,
        b,
        ok({
          entries: [
            { name: "fish.js", type: "file" },
            { name: "minnow.js", type: "file" },
          ],
        }),
      ),
    ).toMatchObject({
      tool: "read",
      args: { path: "creatures/fish.js" },
    });
    // the read's own repaints go ahead of the next file's read (the row is per-file).
    const r1 = step(GOLD_A, b, ok({ content: FISH }));
    expect(r1).toMatchObject({
      tool: "replace",
      args: { path: "creatures/fish.js", old: 'const BODY = "pink";', new: 'const BODY = "gold";' },
    });
    const r2 = step(GOLD_A, b, ok());
    expect(r2).toMatchObject({
      tool: "replace",
      args: { path: "creatures/fish.js", old: 'const FIN = "pink";', new: 'const FIN = "#b8860b";' },
    });
    expect(step(GOLD_A, b, ok())).toMatchObject({ tool: "read", args: { path: "creatures/minnow.js" } });
    expect(step(GOLD_A, b, ok({ content: 'const BODY = "teal";' }))).toMatchObject({
      tool: "replace",
      args: { path: "creatures/minnow.js", old: 'const BODY = "teal";', new: 'const BODY = "gold";' },
    });
    expect(step(GOLD_A, b, ok())).toMatchObject({ tool: "submit" });
  });

  it("an L1 `repair` queues a read of each `added` member ahead of the script (8.3)", () => {
    const b = bag();
    step(GOLD_A, b, null);
    const next = step(GOLD_A, b, ok({ entries: [{ name: "fish.js", type: "file" }] }), [
      hu(1, "repair", [item(L("creatures/"), listingDiff(["seahorse.js"]), "repair", "L1")]),
    ]);
    expect(next).toMatchObject({ tool: "read", args: { path: "creatures/seahorse.js" } });
    expect(step(GOLD_A, b, ok({ content: 'const BODY = "pink";' }))).toMatchObject({
      tool: "replace",
      args: { path: "creatures/seahorse.js", old: 'const BODY = "pink";', new: 'const BODY = "gold";' },
    });
    expect(step(GOLD_A, b, ok())).toMatchObject({ tool: "read", args: { path: "creatures/fish.js" } });
    step(GOLD_A, b, ok({ content: FISH }));
    step(GOLD_A, b, ok());
    step(GOLD_A, b, ok());
    const s = step(GOLD_A, b, ok());
    expect((s as { args: { acknowledge?: number[]; statement?: string } }).args).toMatchObject({
      acknowledge: [1],
      statement: "A seahorse arrived during the repaint. Painted it gold too.",
    });
  });

  it("a second `repair` stops `withdrawn` (SW7)", () => {
    const b = bag();
    step(GOLD_A, b, null);
    step(GOLD_A, b, ok({ entries: [] }), [
      hu(1, "repair", [item(L("creatures/"), listingDiff(["a.js"]), "repair", "L1")]),
    ]);
    const out = step(GOLD_A, b, ok(), [
      hu(2, "repair", [item(L("creatures/"), listingDiff(["b.js"]), "repair", "L1")]),
    ]);
    expect(out).toMatchObject({ kind: "stop", reason: "withdrawn" });
  });

  it("re-reads a dropped repaint op instead of withdrawing (SW6 handled)", () => {
    const b = bag();
    step(GOLD_A, b, null);
    step(GOLD_A, b, ok({ entries: [{ name: "fish.js", type: "file" }] }));
    step(GOLD_A, b, ok({ content: FISH }));
    const out = step(GOLD_A, b, ok(), [
      hu(
        1,
        "repair",
        [item(L("creatures/"), listingDiff(["seahorse.js"]), "repair", "L1")],
        [{ op_seq: 1, path: "creatures/fish.js", rule: "OP3" }],
      ),
    ]);
    expect(out.kind).toBe("tool"); // the pending second repaint still runs first
    expect(step(GOLD_A, b, ok())).toMatchObject({ tool: "read", args: { path: "creatures/seahorse.js" } });
    expect(step(GOLD_A, b, ok())).toMatchObject({ tool: "read", args: { path: "creatures/fish.js" } }); // the re-read
  });

  it("a failure the script cannot fix stops `withdrawn` (SW6)", () => {
    const b = bag();
    step(GOLD_A, b, null);
    step(GOLD_A, b, ok({ entries: [{ name: "fish.js", type: "file" }] }));
    expect(step(GOLD_A, b, err("no_match"))).toMatchObject({ kind: "stop", reason: "withdrawn" });
  });
});
