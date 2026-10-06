// A Swarm run paces its ticks with `step.waitForEvent`'s timeout (src/worker/workflows/swarm.ts):
// the timeout is the tick, never a failure. The two shapes come from the two engines: local
// workerd's `WorkflowTimeoutError`, and the deployed engine's plain Error, recorded on the test
// deployment on 2026-10-05 as "Error: Execution timed out after 1000ms" (a run died at its first
// tick because only the first shape was known).

import { describe, expect, it } from "vitest";
import { isWaitTimeout } from "./wait-timeout.ts";

describe("isWaitTimeout: the tick of a run's loop", () => {
  it("local workerd's WorkflowTimeoutError is a tick", () => {
    const local = new Error("timed out");
    local.name = "WorkflowTimeoutError";
    expect(isWaitTimeout(local)).toBe(true);
  });

  it("the deployed engine's plain Error 'Execution timed out after 1000ms' is a tick", () => {
    expect(isWaitTimeout(new Error("Execution timed out after 1000ms"))).toBe(true);
  });

  it("any other error is a failure, and so is a thrown non-Error", () => {
    expect(isWaitTimeout(new Error("launch 3: trunk_open_failed"))).toBe(false);
    expect(isWaitTimeout(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isWaitTimeout("Execution timed out after 1000ms")).toBe(false);
  });
});
