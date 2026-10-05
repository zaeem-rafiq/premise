// `wrap-b` (02-tidepool.md 8.6, 10.5): the canned row verbatim — the informational side of a
// search catch, so it takes the SW6 defaults like `gold-b`.

import { describe, expect, it } from "vitest";
import { RAY_FILE } from "./canned.ts";
import { WRAP_B } from "./wrap-b.ts";
import { bag, ok, step } from "./testkit.ts";

describe("wrap-b (02-tidepool.md 10.5)", () => {
  it("carries the intent and truth list of the table", () => {
    expect(WRAP_B.id).toBe("wrap-b");
    expect(WRAP_B.intent).toBe("a ray that swims out one side and back in the other");
    expect(WRAP_B.truth).toEqual(["entity:world/bounds.js#wrap", "entity:world/movement.js#step"]);
  });

  it("issues the calls of 8.6 in order and writes the canned ray verbatim", () => {
    const b = bag();
    expect(step(WRAP_B, b, null)).toMatchObject({ kind: "tool", tool: "list", args: { path: "creatures/" } });
    expect(step(WRAP_B, b, ok())).toMatchObject({ tool: "read", args: { path: "GUIDE.md" } });
    expect(step(WRAP_B, b, ok())).toMatchObject({ tool: "read", args: { path: "world/bounds.js", entity: "wrap" } });
    expect(step(WRAP_B, b, ok())).toMatchObject({ tool: "read", args: { path: "world/movement.js", entity: "step" } });
    expect(step(WRAP_B, b, ok())).toMatchObject({
      tool: "write",
      args: { path: "creatures/ray.js", content: RAY_FILE },
    });
    expect(step(WRAP_B, b, ok())).toMatchObject({
      tool: "submit",
      args: { summary: "a ray that swims out one side and back in the other" },
    });
  });
});
