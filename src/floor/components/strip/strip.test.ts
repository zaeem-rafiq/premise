// CO29: a counter that changes is underlined for 1 s. The run clock is not a counter, and a value
// that only arrives in place of the dash (3.8 loading/empty) is not a change.

import { describe, expect, it } from "vitest";
import type { StripCell } from "../../state/derive.ts";
import { FLASH_MS, flashUntil } from "./strip.tsx";

const DASH = "–";
const cell = (id: string, value: string) => ({ id, label: id, value }) as StripCell;

describe("flashUntil (03-floor CO29, 3.8)", () => {
  it("CO29: a counter that goes from 1 to 2 is underlined for FLASH_MS", () => {
    const out = flashUntil(new Map([["strip.landed", "1"]]), new Map(), [cell("strip.landed", "2")], DASH, 5000);
    expect(out).toEqual(new Map([["strip.landed", 5000 + FLASH_MS]]));
  });

  it("CO29/3.8: a value that replaces the dash, or a first render, is not a change", () => {
    expect(flashUntil(new Map([["strip.landed", DASH]]), new Map(), [cell("strip.landed", "0")], DASH, 0).size).toBe(0);
    expect(flashUntil(new Map(), new Map(), [cell("strip.landed", "4")], DASH, 0).size).toBe(0);
  });

  it("CO29: the run clock is never underlined", () => {
    const out = flashUntil(
      new Map([["strip.clock", "00:00:01"]]),
      new Map(),
      [cell("strip.clock", "00:00:02")],
      DASH,
      0,
    );
    expect(out.size).toBe(0);
  });

  it("CO29: an underline survives an unrelated render until its second is over, then ends", () => {
    const running = new Map([["strip.landed", 1000]]);
    const prev = new Map([["strip.landed", "2"]]);
    expect(flashUntil(prev, running, [cell("strip.landed", "2")], DASH, 600)).toEqual(
      new Map([["strip.landed", 1000]]),
    );
    expect(flashUntil(prev, running, [cell("strip.landed", "2")], DASH, 1001).size).toBe(0);
  });
});
