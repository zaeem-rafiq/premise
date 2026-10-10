// HO6: browserEnv hands the host a canvas whose `rect()` is the element's
// `getBoundingClientRect()`. A real <canvas> has no `rect()`; passing the element itself made every
// tap throw, so no creature tap opened a Why card (scripted rehearsal on `test`, 2026-10-10).

import { afterEach, describe, expect, it } from "vitest";
import { browserEnv } from "../../../src/host/env.ts";

const saved = { document: (globalThis as { document?: unknown }).document };

afterEach(() => {
  (globalThis as { document?: unknown }).document = saved.document;
});

describe("browserEnv's canvas (HO5, HO6)", () => {
  it("HO6: rect() answers the element's getBoundingClientRect(), and size reads and writes reach the element", () => {
    const element = {
      width: 300,
      height: 150,
      clientWidth: 600,
      clientHeight: 338,
      getContext: () => null,
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 600, height: 338 }),
    };
    (globalThis as { document?: unknown }).document = {
      querySelector: (selector: string) => (selector === "canvas#pool" ? element : null),
    };
    const env = browserEnv(async () => ({}));
    expect(env.canvas).not.toBeNull();
    expect(env.canvas!.rect()).toEqual({ left: 10, top: 20, width: 600, height: 338 });
    expect([env.canvas!.clientWidth, env.canvas!.clientHeight]).toEqual([600, 338]);
    env.canvas!.width = 1200;
    env.canvas!.height = 676;
    expect([element.width, element.height]).toEqual([1200, 676]);
  });

  it("HO6: a page without canvas#pool gives no canvas", () => {
    (globalThis as { document?: unknown }).document = { querySelector: () => null };
    expect(browserEnv(async () => ({})).canvas).toBeNull();
  });
});
