// Route parsing (AC25, FR30) and the pool-route helper (FE7).

import { describe, expect, it } from "vitest";
import { parseRoute, poolRoute } from "./route.ts";

describe("parseRoute (AC25)", () => {
  it("/ is the default pool of /floor.json", () => {
    expect(parseRoute("/")).toEqual({ kind: "floor", pool: null });
  });
  it("/p/{pool} names the pool as the main pool", () => {
    expect(parseRoute("/p/tidepool-auto")).toEqual({ kind: "floor", pool: "tidepool-auto" });
    expect(parseRoute("/p/a%20b")).toEqual({ kind: "floor", pool: "a b" });
  });
  it("/replay/{id} loads that recording (RY18)", () => {
    expect(parseRoute("/replay/tracer")).toEqual({ kind: "replay", id: "tracer" });
  });
  it("anything else is the default pool", () => {
    expect(parseRoute("/elsewhere")).toEqual({ kind: "floor", pool: null });
  });
});

describe("poolRoute (FE7)", () => {
  it("the default pool's address is /", () => {
    expect(poolRoute("tidepool", "tidepool")).toBe("/");
  });
  it("another pool's address is /p/{pool}", () => {
    expect(poolRoute("x", "tidepool")).toBe("/p/x");
  });
});
