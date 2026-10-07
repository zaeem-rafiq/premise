// SE21 (the security review's M2): the Floor page and the stream handshake are counted per client
// address under PUBLIC_RATE_PER_MIN — the session read's own limiter and its own 429 answer. The
// ninth-socket rule (MAX_SOCKETS_PER_ADDR) is unchanged.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_RATE_PER_MIN } from "../../src/protocol/constants.ts";
import { appendBody, poolState } from "./floor/harness.ts";
import { startTrunkWorker, type TrunkWorker } from "./trunk/harness.ts";

let worker: TrunkWorker;

beforeAll(async () => {
  worker = await startTrunkWorker();
}, 60_000);

afterAll(async () => {
  await worker?.dispose();
});

const page = (address: string) => worker.fetch("/", { headers: { "cf-connecting-ip": address } });
const handshake = (pool: string, address: string) =>
  worker.fetch(`/api/pools/${pool}/stream`, { headers: { "cf-connecting-ip": address } });
const upgrade = (pool: string, address: string) =>
  worker.fetch(`/api/pools/${pool}/stream`, {
    headers: { "cf-connecting-ip": address, upgrade: "websocket" },
  });

describe("SE21: the Floor page is limited to PUBLIC_RATE_PER_MIN per client address", () => {
  it("the 121st page request in a minute from one address answers 429; another address is unaffected", async () => {
    const address = "10.2.0.1";
    for (let i = 0; i < PUBLIC_RATE_PER_MIN; i += 1) {
      const res = await page(address);
      expect(res.status).toBe(200);
    }
    const limited = await page(address);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: { code: "rate_limited" } });
    // Client routes count too: /replay/{id} serves the same document under the same address.
    const clientRoute = await worker.fetch("/replay/hero-canned", {
      headers: { "cf-connecting-ip": address },
    });
    expect(clientRoute.status).toBe(429);
    const other = await page("10.2.0.2");
    expect(other.status).toBe(200);
  });
});

describe("SE21: the stream handshake is limited to PUBLIC_RATE_PER_MIN per client address", () => {
  it("the 121st handshake in a minute from one address answers 429; another address is unaffected", async () => {
    // Seed the pool's stream so the handshake answers its 200 probe ({pool, stream}).
    const seeded = await worker.floor("rate-pool").fetch("/internal/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: appendBody("trunk", 1, [{ source_n: 1, event: { ...poolState(1), pool: "rate-pool" } }]),
    });
    expect(seeded.status).toBe(200);

    const address = "10.2.0.11";
    for (let i = 0; i < PUBLIC_RATE_PER_MIN; i += 1) {
      const res = await handshake("rate-pool", address);
      expect(res.status).toBe(200);
    }
    const limited = await handshake("rate-pool", address);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: { code: "rate_limited" } });
    // The upgrade itself counts the same: 429, not 101 — while MAX_SOCKETS_PER_ADDR still applies.
    const blocked = await upgrade("rate-pool", address);
    expect(blocked.status).toBe(429);
    // Another address still opens the stream.
    const other = await upgrade("rate-pool", "10.2.0.12");
    expect(other.status).toBe(101);
    const socket = (other as unknown as { webSocket: (WebSocket & { accept(): void }) | null }).webSocket;
    socket?.accept();
    socket?.close();
  });
});
