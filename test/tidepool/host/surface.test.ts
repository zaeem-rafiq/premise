// The surface of 02-tidepool 3.3 and its guards: PN6 (exactly the twelve members) and PN7 (a call
// that fails a listed check is ignored — colours, finiteness, depth, clip reach, op count), plus the
// host-side sizing of HO5.

import { describe, expect, it } from "vitest";
import { createSurface } from "../../../src/host/surface.ts";
import { HOST_MAX_OPS, HOST_MAX_REACH } from "../../../src/protocol/constants.ts";
import { FakeCanvas } from "./harness.ts";

function surfaceOf(canvas = new FakeCanvas()) {
  const { surface, fit } = createSurface(canvas, () => 1);
  fit(200, 100);
  return { canvas, ctx: canvas.ctx, surface, fit };
}

describe("the pen surface (3.3, PN6, PN7, HO5)", () => {
  it("PN6: the surface carries exactly the twelve members of table 3.3", () => {
    const { surface } = surfaceOf();
    expect(Object.keys(surface).sort()).toEqual(
      ["arc", "circle", "ellipse", "flip", "line", "poly", "pop", "push", "rect", "reset", "style", "turn"].sort(),
    );
    expect(Object.isFrozen(surface)).toBe(true);
  });

  it("PN7: a non-hex colour or a non-finite number is ignored; the call does not draw", () => {
    const { ctx, surface } = surfaceOf();
    const mark = ctx.mark();
    surface.style("red" as string, null, 2, 1); // not a hex colour — the whole call is dropped
    surface.push(0, 0, 60);
    surface.circle(Number.NaN, 0, 4);
    surface.line(0, 0, Number.POSITIVE_INFINITY, 1);
    const ops = ctx.since(mark);
    expect(ops.filter((op) => op[0] === "arc" && op[3] === 4)).toEqual([]); // NaN circle never drew
    expect(ops.filter((op) => op[0] === "lineTo")).toEqual([]); // infinite line never drew
  });

  it("PN7: pushes deeper than two are dropped but still pop; clip reach past HOST_MAX_REACH is dropped", () => {
    const { ctx, surface } = surfaceOf();
    surface.push(0, 0, 60);
    surface.push(1, 1, 60);
    const mark = ctx.mark();
    surface.push(2, 2, 60); // depth three — dropped: no save/translate/clip lands
    expect(ctx.since(mark)).toEqual([]);
    surface.pop(); // balanced anyway
    surface.pop();
    surface.pop();
    const mark2 = ctx.mark();
    surface.push(0, 0, HOST_MAX_REACH + 1); // over reach — dropped
    expect(ctx.since(mark2)).toEqual([]);
    surface.pop();
  });

  it("PN7: shape calls past HOST_MAX_OPS inside one push are ignored", () => {
    const { ctx, surface } = surfaceOf();
    surface.push(0, 0, 60);
    for (let i = 0; i < HOST_MAX_OPS + 10; i += 1) surface.circle(i, 0, 1);
    surface.pop();
    const draws = ctx.ops.filter((op) => op[0] === "arc" && op[3] === 1);
    expect(draws).toHaveLength(HOST_MAX_OPS);
  });

  it("HO5: the backing store tracks the box at the device pixel ratio and letterboxes the pool", () => {
    const canvas = new FakeCanvas(); // 400x300 element
    const { surface, fit } = createSurface(canvas, () => 2);
    fit(200, 100); // a 2:1 pool
    surface.reset();
    expect(canvas.width).toBe(800); // clientWidth 400 × dpr 2
    expect(canvas.height).toBe(600);
    expect(canvas.ctx.ops).toContainEqual(["clearRect", 0, 0, 800, 600]);
    // scale = min(400/200, 300/100) = 2; centred: x0 = 0, y0 = (600 - 100*2*2)/2 = 100
    expect(canvas.ctx.ops).toContainEqual(["setTransform", 4, 0, 0, 4, 0, 100]);
  });
});
