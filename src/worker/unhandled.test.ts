// An exception that no route caught (a Durable Object reset mid-request, a binding that throws):
// the caller gets the API's error shape, `{ "error": { "code": "internal" } }` with status 500
// (01-core 13.6's error form), never the platform's HTML error page. Seen on the test deployment
// on 2026-10-05: POST /api/pools answered Cloudflare's HTML page after the pool was created.

import { describe, expect, it, vi } from "vitest";
import { answerUnhandled } from "./unhandled.ts";

describe("answerUnhandled", () => {
  it("a route that answers is passed through unchanged", async () => {
    const ok = Response.json({ ok: true }, { status: 201 });
    expect(await answerUnhandled(() => ok)).toBe(ok);
  });

  it("a route that throws answers 500 with the API's error shape, not cached", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await answerUnhandled(() => Promise.reject(new Error("Network connection lost.")));
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: { code: "internal" } });
    // The operator's line names the error, never the request (BP7).
    expect(log).toHaveBeenCalledWith("worker: unhandled", "Error: Network connection lost.");
    log.mockRestore();
  });

  it("a synchronous throw is caught the same way", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await answerUnhandled(() => {
      throw new TypeError("Cannot read properties of undefined");
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "internal" } });
    log.mockRestore();
  });
});
