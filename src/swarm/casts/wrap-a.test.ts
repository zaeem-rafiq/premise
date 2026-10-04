// `wrap-a` (02-tidepool.md 8.6, 10.5): the `wrap(` search sweep verbatim — `wrap(<name>)` ->
// `bounce(<name>)` plus the import line — the QT1 `repair` that rewrites the gained container
// from the item's source with no read, and SW7's `withdrawn` at a second `repair`.

import { describe, expect, it } from "vitest";
import { WRAP_A } from "./wrap-a.ts";
import { bag, hu, item, ok, queryDiff, step } from "./testkit.ts";

const Q = (key: string) => ({ kind: "query" as const, key });
const WRAP_LINE = 'import { wrap } from "../world/bounds.js";';
const RAY_UPDATE = `export function update(ray) {
  wrap(ray);
  step(ray);
}`;

describe("wrap-a (02-tidepool.md 10.5)", () => {
  it("carries the intent and truth list of the table", () => {
    expect(WRAP_A.id).toBe("wrap-a");
    expect(WRAP_A.intent).toBe("make every creature that swims out one side and back in the other turn around at the walls instead");
    expect(WRAP_A.truth).toEqual(["query:text:creatures/:wrap(", "entity:world/bounds.js#bounce"]);
  });

  it("searches `wrap(` then replaces the call and the import in each file found (8.6)", () => {
    const b = bag();
    expect(step(WRAP_A, b, null)).toMatchObject({ kind: "tool", tool: "search", args: { query: "wrap(", path: "creatures/" } });
    const next = step(WRAP_A, b, ok({ lines: [{ path: "creatures/ray.js", text: "  wrap(ray);" }] }));
    expect(next).toMatchObject({ tool: "replace", args: { path: "creatures/ray.js", old: "wrap(ray);", new: "bounce(ray);" } });
    expect(step(WRAP_A, b, ok())).toMatchObject({
      tool: "replace", args: { path: "creatures/ray.js", old: WRAP_LINE, new: 'import { bounce } from "../world/bounds.js";' },
    });
    expect(step(WRAP_A, b, ok())).toMatchObject({ tool: "submit" });
  });

  it("a QT1 `repair` rewrites the gained container from its source, no read (8.6)", () => {
    const b = bag();
    step(WRAP_A, b, null);
    const next = step(WRAP_A, b, ok({ lines: [] }), [
      hu(1, "repair", [item(Q("text:creatures/:wrap("), queryDiff([{ key: "creatures/ray.js#update", source: RAY_UPDATE }]))]),
    ]);
    expect(next).toMatchObject({ tool: "replace", args: { path: "creatures/ray.js", old: "wrap(ray)", new: "bounce(ray)" } });
    expect(step(WRAP_A, b, ok())).toMatchObject({
      tool: "replace", args: { path: "creatures/ray.js", old: WRAP_LINE, new: 'import { bounce } from "../world/bounds.js";' },
    });
    const s = step(WRAP_A, b, ok());
    expect((s as { args: { acknowledge?: number[]; statement?: string } }).args).toMatchObject({
      acknowledge: [1],
      statement: "the sweep gained a match; changed it too",
    });
  });

  it("a second `repair` stops `withdrawn` (SW7)", () => {
    const b = bag();
    step(WRAP_A, b, null);
    step(WRAP_A, b, ok({ lines: [] }), [
      hu(1, "repair", [item(Q("text:creatures/:wrap("), queryDiff([{ key: "creatures/ray.js#update", source: RAY_UPDATE }]))]),
    ]);
    const out = step(WRAP_A, b, ok(), [
      hu(2, "repair", [item(Q("text:creatures/:wrap("), queryDiff([{ key: "creatures/eel.js#update", source: "wrap(eel);" }]))]),
    ]);
    expect(out).toMatchObject({ kind: "stop", reason: "withdrawn" });
  });
});
