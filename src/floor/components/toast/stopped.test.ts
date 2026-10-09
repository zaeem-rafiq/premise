import { expect, it } from "vitest";
import { stoppedToast } from "./stopped.ts";
it("D20 FR4: only failure stops toast; choosing another attempt does not", () => {
  for (const reason of ["model_error", "tool_timeout", "stalled", "timeout", "budget", "spend_cap", "killed", "lost"])
    expect(stoppedToast(reason)).toBeTypeOf("string");
  for (const reason of [null, "not_chosen", "cancelled", "declined", "go_around_limit", "revert_limit"])
    expect(stoppedToast(reason)).toBeNull();
});
