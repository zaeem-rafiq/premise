// The built Worker bundle inside local workerd (docs/spec/04-build-plan.md 1.4).
//
// This is the scaffold's check that the bundle wrangler builds starts in workerd, that the classes
// wrangler.jsonc names are exported, and that everything not built fails closed (plan 2.1).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DURABLE_OBJECTS, startWorker } from "../support/workerd.ts";
import type { DurableObjectBinding, LocalWorker } from "../support/workerd.ts";

const NOT_BUILT_BODY = { error: { code: "not_built" } };

describe("the Worker bundle in workerd", () => {
  let worker: LocalWorker;

  beforeAll(async () => {
    worker = await startWorker();
  });

  afterAll(async () => {
    await worker?.dispose();
  });

  it("answers the probe", async () => {
    const response = await worker.fetch("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it.each([
    ["POST", "/api/pools"],
    ["GET", "/api/pools/x/stream"],
    ["GET", "/api/session"],
    ["POST", "/api/kill"],
    ["POST", "/api/health"],
    ["GET", "/api"],
    ["GET", "/pool/x/main/"],
    ["GET", "/pool/x/main/world/energy.js"],
  ])("%s %s is not built: 503 with the code not_built, never the page", async (method, path) => {
    const response = await worker.fetch(path, { method });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(NOT_BUILT_BODY);
  });

  it("serves the Floor page", async () => {
    const response = await worker.fetch("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain('<div id="root"></div>');
  });

  it("serves the Floor page for a client route such as /replay/{id}", async () => {
    const response = await worker.fetch("/replay/hero");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<div id="root"></div>');
  });

  it("serves /floor.json", async () => {
    const response = await worker.fetch("/floor.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toBeTypeOf("object");
  });

  it.each(Object.entries(DURABLE_OBJECTS) as Array<[DurableObjectBinding, string]>)(
    "the %s binding reaches the stub class %s, which answers not_built",
    async (binding) => {
      const response = await worker.fetchDurableObject(binding, "x", "/");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(NOT_BUILT_BODY);
    },
  );
});
