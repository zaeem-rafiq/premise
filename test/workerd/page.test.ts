// SE14a (the security review's M1): the Floor document carries its own Content-Security-Policy on
// every path the assets answer with `index.html` — `/`, `/p/{pool}`, `/replay/{id}` and every
// single-page fallback — while other assets keep their headers and a `/pool/…` frame keeps the
// app server's own policy unchanged (SE14).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorker, type LocalWorker } from "../support/workerd.ts";

const EXPECTED_CSP =
  "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; " +
  "frame-src http://premise.test; connect-src 'self' wss://premise.test";

describe("SE14a: the Floor document's own Content-Security-Policy", () => {
  let worker: LocalWorker;

  beforeAll(async () => {
    worker = await startWorker();
  }, 60_000);

  afterAll(async () => {
    await worker?.dispose();
  });

  it.each(["/", "/p/tidepool", "/replay/hero-canned", "/any/other/route"])(
    "%s answers the Floor document with the SE14a policy",
    async (path) => {
      const response = await worker.fetch(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("content-security-policy")).toBe(EXPECTED_CSP);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.text()).toContain('<div id="root"></div>');
    },
  );

  it("/floor.json keeps its headers: no document policy on a JSON asset", async () => {
    const response = await worker.fetch("/floor.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBeNull();
  });

  it("the built script asset keeps its headers", async () => {
    const page = await worker.fetch("/");
    const src = /src="(\/assets\/[^"]+\.js)"/.exec(await page.text())?.[1];
    expect(src).toBeDefined();
    const asset = await worker.fetch(src ?? "");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("content-security-policy")).toBeNull();
  });

  it("a pool frame keeps the app server's own policy unchanged (SE14)", async () => {
    const response = await worker.fetch("/pool/tidepool/main/");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("default-src 'self'");
  });
});
