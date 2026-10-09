import { expect, it } from "vitest";
import { wallLayout, wallShape, wallSummary } from "./wall.tsx";
import { emptyFloorState, type AttemptView } from "../../../protocol/reducer/state.ts";

it("D8 CO41: all 1,024 cells fit without scrolling at both reference sizes", () => {
  for (const [width, height] of [
    [1872, 480],
    [1408, 320],
  ]) {
    for (const n of [1, 64, 256, 1024, 2048]) {
      const { columns, rows, size } = wallLayout(n, width!, height!);
      expect(columns * rows).toBeGreaterThanOrEqual(n);
      expect(columns * size).toBeLessThanOrEqual(width!);
      expect(rows * size).toBeLessThanOrEqual(height!);
      expect(size).toBeGreaterThan(0);
    }
  }
});
it("D8 CO41 VD2: states use shapes and landed fill lasts one second", () => {
  const floor = emptyFloorState();
  const a = { state: "working", landed_seq: null } as AttemptView;
  expect(wallShape(a, floor, 0)).toBe("outline");
  expect(wallShape({ ...a, state: "going_around" }, floor, 0)).toBe("diamond");
  expect(wallShape({ ...a, state: "stopped" }, floor, 0)).toBe("cross");
  expect(wallShape({ ...a, state: "accepted" }, floor, 0)).toBe("half");
  const landed = { ...a, state: "landed" as const, landed_seq: 1 };
  expect(wallShape(landed, floor, 100)).toBe("half");
  floor.landings[1] = { digest: true, landed_ts: 100 } as FloorLanding;
  expect(wallShape(landed, floor, 1099)).toBe("fill");
  expect(wallShape(landed, floor, 1099, true)).toBe("tick");
  expect(wallShape(landed, floor, 1100)).toBe("outline");
});
type FloorLanding = ReturnType<typeof emptyFloorState>["landings"][number];

it("D8 CO41 AX9: a finished landed flash never makes the summary count a working agent", () => {
  const floor = emptyFloorState();
  floor.attempts.a = { id: "a", agent: "synthetic", state: "landed", landed_seq: 1 } as AttemptView;
  floor.landings[1] = { digest: true, landed_ts: 100 } as FloorLanding;
  expect(wallSummary(floor, 1100)).toEqual({ n: 1, a: 0, b: 0, c: 0 });
});
