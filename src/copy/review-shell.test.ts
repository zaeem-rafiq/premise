import { expect, it } from "vitest";
import { SHORTCUT_ROWS, text } from "./strings.ts";
it("D9 FL4 RY27: start copy makes no real-agent claim about a recording", () => {
  expect(text("start.body")).toBe("This plays a recorded run through this same page. You need no account and no key.");
});

it("D34 FL5: the key list gives plain instructions without rule ids", () => {
  expect(SHORTCUT_ROWS.find((row) => row.key === "R")?.does).toBe("Open the default recording, paused");
  expect(SHORTCUT_ROWS.some((row) => /\b[A-Z]{1,3}\d+\b/.test(row.does))).toBe(false);
});
