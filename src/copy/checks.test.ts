import { expect, it } from "vitest";
import { submitCheckLabel } from "./checks.ts";

it("D34 FL5: the derived submit check explains CK7 in plain words", () => {
  // 01-core CK7 records dependencies and affected readers; CK8 checks whether premises hold.
  expect(submitCheckLabel("derived")).toBe("What the change uses and affects is recorded");
  expect(submitCheckLabel("premises_hold")).toBe("Everything it relied on is still true");
});
