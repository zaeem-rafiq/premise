import { expect, it } from "vitest";
import { showStartCard } from "./start-card.ts";

it("D5 RY23: only a visitor on a quiet live pool gets the start card", () => {
  expect(showStartCard(false, false, true, false)).toBe(true);
  expect(showStartCard(true, false, true, false)).toBe(false);
  expect(showStartCard(false, true, true, false)).toBe(false);
  expect(showStartCard(false, false, false, false)).toBe(false);
  expect(showStartCard(false, false, true, true)).toBe(false);
});

// Beat 10 (03-floor 1.2): the owner locks and plays the Replay. Found in every real-agent rehearsal
// on 2026-10-11: agents were still finishing, the pool was not quiet, and the card never came.
it("RY23 amended: the person who has just locked gets the card on a busy pool too", () => {
  expect(showStartCard(false, false, false, false, true)).toBe(true);
  expect(showStartCard(false, false, false, true, true)).toBe(false);
  expect(showStartCard(true, false, false, false, true)).toBe(false);
});
