// The built Worker bundle inside local workerd (docs/spec/04-build-plan.md 1.4).
//
// The scaffold checks: the bundle wrangler builds starts in workerd, the classes wrangler.jsonc
// names are exported, the guards of 13.6 fail closed (SE1 to SE3), and everything not built
// answers not_built (plan 2.1 items 5 and 8).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DURABLE_OBJECTS, startWorker } from "../support/workerd.ts";
import type { DurableObjectBinding, LocalWorker } from "../support/workerd.ts";

const NOT_BUILT_BODY = { error: { code: "not_built" } };
const NOT_CONFIGURED_BODY = { error: { code: "not_configured" } };
const NOT_FOUND_BODY = { error: { code: "not_found" } };

describe("the Worker bundle in workerd, deployed with no OWNER_KEY", () => {
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
    ["POST", "/api/kill"],
    ["POST", "/api/session"],
    ["DELETE", "/api/session"],
    ["POST", "/api/swarm"],
    ["POST", "/api/pools/tidepool/intents"],
    ["GET", "/api/pools/tidepool/undo-plan"],
  ])("SE1: %s %s is a mutating or owner route: 503 not_configured with no key configured", async (method, path) => {
    const response = await worker.fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" ? undefined : "{}",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(NOT_CONFIGURED_BODY);
  });

  // The Floor Durable Object is built since track 1E: its routes (`/api/pools/{pool}/stream`,
  // `/api/pools/{pool}/landings/{seq}/note`) are tested under test/workerd/floor/ and no longer answer
  // not_built. A route leaves this list when its lane lands.
  it.each([
    ["GET", "/api/session"], // the Worker route, unregistered
    ["GET", "/pool/x/main/"], // the app server
    ["GET", "/pool/x/main/world/energy.js"], // a pool file
  ])("%s %s is not built: 503 with the code not_built, never the page", async (method, path) => {
    const response = await worker.fetch(path, { method });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(NOT_BUILT_BODY);
  });

  it.each([
    ["GET", "/api"],
    ["POST", "/api/health"],
    ["GET", "/api/nope"],
  ])("%s %s matches no route of 13.6: 404 not_found", async (method, path) => {
    const response = await worker.fetch(path, { method });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
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

// Acceptance item 5 of plan 2.1, run in local workerd instead of `npm run dev` (which the lead runs
// against the real service): POST /api/pools answers 503 with no key configured, 401 with a key set
// and none sent, and 415 when the content type is text/plain.
describe("the guards of SE1 to SE3 with OWNER_KEY configured", () => {
  let worker: LocalWorker;
  const ownerKey = "test-owner-key-32-bytes-of-randomness!";

  beforeAll(async () => {
    worker = await startWorker({ ownerKey });
  });

  afterAll(async () => {
    await worker?.dispose();
  });

  it("POST /api/pools with a JSON body and no key sent answers 401", async () => {
    const response = await worker.fetch("/api/pools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  it("POST /api/pools with a wrong key sent answers 401", async () => {
    const response = await worker.fetch("/api/pools", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  it("POST /api/pools with content type text/plain answers 415, before authentication", async () => {
    const response = await worker.fetch("/api/pools", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not json",
    });
    expect(response.status).toBe(415);
  });

  it("POST /api/pools with the right key reaches the unbuilt Worker route: 503 not_built", async () => {
    const response = await worker.fetch("/api/pools", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerKey}`,
      },
      body: "{}",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(NOT_BUILT_BODY);
  });

  it("POST /api/kill with the right key reaches the stub gate: 503 not_built", async () => {
    const response = await worker.fetch("/api/kill", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerKey}`,
      },
      body: "{}",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(NOT_BUILT_BODY);
  });
});
