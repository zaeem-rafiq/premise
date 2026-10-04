// test/workerd/trunk/session.test.ts — the session routes and the security module in local workerd.
//
// Proved here:
//   SE1   every mutating route answers 503 while OWNER_KEY is unset
//   SE2   the right key unlocks and mints the signed premise_owner cookie; a wrong key answers 401
//   SE2a  the eleventh wrong key within a minute from one address answers 429 — and so does the
//         right key in that minute; another address is not limited by the first one's failures
//   SE3   a non-JSON body answers 415 before authentication
//   SE21  the session read is limited to PUBLIC_RATE_PER_MIN per client address

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_RATE_PER_MIN, UNLOCK_FAILS_PER_MIN } from "../../../src/protocol/constants.ts";
import { startTrunkWorker, type TrunkWorker } from "./harness.ts";

const KEY = "owner-key-for-tests-0123456789abcdef";
const OTHER = "other-key-for-tests-0123456789abcdef";

function post(
  path: string,
  body: unknown,
  init?: { key?: string; address?: string; contentType?: string },
): RequestInit {
  const headers: Record<string, string> = { "content-type": init?.contentType ?? "application/json" };
  if (init?.key !== undefined) headers.authorization = `Bearer ${init.key}`;
  if (init?.address !== undefined) headers["cf-connecting-ip"] = init.address;
  return { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) };
}

describe("the session routes in workerd", () => {
  let open: TrunkWorker;

  beforeAll(async () => {
    open = await startTrunkWorker();
  }, 60_000);
  afterAll(async () => {
    await open.dispose();
  });

  it("SE1: every mutating route answers 503 while OWNER_KEY is unset", async () => {
    for (const path of ["/api/session", "/api/pools", "/api/pools/tp/read-token"]) {
      const response = await open.fetch(path, post(path, {}));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: "not_configured" } });
    }
    // …and so does the owner's own mutating route on a Durable Object target.
    const response = await open.fetch(
      "/api/pools/tp/intents",
      post("/api/pools/tp/intents", { intent: "x", request_id: "r" }),
    );
    expect(response.status).toBe(503);
  });
});

describe("the session routes with a configured OWNER_KEY", () => {
  let worker: TrunkWorker;

  beforeAll(async () => {
    worker = await startTrunkWorker({ ownerKey: KEY });
  }, 60_000);
  afterAll(async () => {
    await worker.dispose();
  });

  it("SE2: a wrong key answers 401 and the right key mints the HMAC-signed premise_owner cookie", async () => {
    const wrong = await worker.fetch("/api/session", post("/api/session", { key: "wrong" }, { address: "10.0.0.1" }));
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: { code: "unauthorized" } });

    const right = await worker.fetch("/api/session", post("/api/session", { key: KEY }, { address: "10.0.0.1" }));
    expect(right.status).toBe(200);
    expect(await right.json()).toEqual({ owner: true });

    const setCookie = right.headers.get("set-cookie") ?? "";
    expect(setCookie.startsWith("premise_owner=")).toBe(true);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=43200"]) {
      expect(setCookie).toContain(flag);
    }
    const cookie = setCookie.split(";")[0] ?? "";
    // v1.<expiry>.<64-hex hmac> — the HMAC-signed value of SE2.
    expect(cookie).toMatch(/^premise_owner=v1\.\d+\.[0-9a-f]{64}$/);

    // The minted cookie is a credential: GET /api/session reports owner.
    const session = await worker.fetch("/api/session", {
      headers: { cookie, "cf-connecting-ip": "10.0.0.1" },
    });
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ owner: true });

    // A forged cookie is none; the Bearer key is one.
    const forged = await worker.fetch("/api/session", {
      headers: { cookie: "premise_owner=v1.9999999999.deadbeef", "cf-connecting-ip": "10.0.0.1" },
    });
    expect(await forged.json()).toEqual({ owner: false });
    const bearer = await worker.fetch("/api/session", { headers: { authorization: `Bearer ${KEY}` } });
    expect(await bearer.json()).toEqual({ owner: true });
  });

  it("SE2: DELETE /api/session clears the cookie", async () => {
    const res = await worker.fetch("/api/session", {
      method: "DELETE",
      headers: { authorization: `Bearer ${KEY}`, "cf-connecting-ip": "10.0.0.2" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ owner: false });
    expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });

  it("SE3: a body that is not application/json answers 415 before authentication", async () => {
    for (const path of ["/api/session", "/api/pools"]) {
      const response = await worker.fetch(path, post(path, "key=x", { contentType: "text/plain" }));
      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: { code: "unsupported_media_type" } });
    }
    // No credential at all and the answer is still 415 — the check runs before authentication.
    const response = await worker.fetch("/api/session", post("/api/session", "key=x", { contentType: "text/plain" }));
    expect(response.status).toBe(415);
  });

  it("SE2a: the eleventh wrong key in a minute answers 429 — and so does the right key", async () => {
    const address = "10.0.0.10";
    // At most UNLOCK_FAILS_PER_MIN (10) failed unlocks are accepted per address per minute.
    for (let i = 0; i < UNLOCK_FAILS_PER_MIN; i += 1) {
      const res = await worker.fetch("/api/session", post("/api/session", { key: `wrong-${i}` }, { address }));
      expect(res.status).toBe(401);
    }
    // The eleventh answers 429 before the key is compared…
    const eleventh = await worker.fetch("/api/session", post("/api/session", { key: "wrong" }, { address }));
    expect(eleventh.status).toBe(429);
    expect(await eleventh.json()).toEqual({ error: { code: "rate_limited" } });
    // …and so does the right key in that minute.
    const right = await worker.fetch("/api/session", post("/api/session", { key: KEY }, { address }));
    expect(right.status).toBe(429);

    // A different address is not limited by the first one's failures.
    const other = await worker.fetch("/api/session", post("/api/session", { key: KEY }, { address: "10.0.0.11" }));
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual({ owner: true });
  });

  it("SE21: the session read is limited to PUBLIC_RATE_PER_MIN per client address", async () => {
    const address = "10.0.0.20";
    for (let i = 0; i < PUBLIC_RATE_PER_MIN; i += 1) {
      const res = await worker.fetch("/api/session", { headers: { "cf-connecting-ip": address } });
      expect(res.status).toBe(200);
    }
    const limited = await worker.fetch("/api/session", { headers: { "cf-connecting-ip": address } });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: { code: "rate_limited" } });
    // Another address still reads.
    const other = await worker.fetch("/api/session", { headers: { "cf-connecting-ip": "10.0.0.21" } });
    expect(other.status).toBe(200);
  });

  it("SE2: POST /api/session without a key field is a wrong key", async () => {
    const res = await worker.fetch("/api/session", post("/api/session", { not_key: 1 }, { address: "10.0.0.30" }));
    expect(res.status).toBe(401);
    const badJson = await worker.fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "10.0.0.30" },
      body: "{",
    });
    expect(badJson.status).toBe(400);
  });
});
