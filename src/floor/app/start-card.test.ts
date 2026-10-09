import { expect, it } from "vitest";
import { showStartCard } from "./start-card.ts";

it("D5 RY23: only a visitor on a quiet live pool gets the start card", () => {
  expect(showStartCard(false, false, true, false)).toBe(true);
  expect(showStartCard(true, false, true, false)).toBe(false);
  expect(showStartCard(false, true, true, false)).toBe(false);
  expect(showStartCard(false, false, false, false)).toBe(false);
  expect(showStartCard(false, false, true, true)).toBe(false);
});
