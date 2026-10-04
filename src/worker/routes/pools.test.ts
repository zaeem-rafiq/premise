// Unit checks of `POST /api/pools` and `POST /api/pools/{pool}/read-token` against local fakes —
// the two registration calls of PL1/EV2a, the not_built tolerance of the build order, the fixed
// error codes (SE5b) and the read scope of SE5c. The workerd tests prove the same end to end.

import { describe, expect, it } from "vitest";
import { READ_TOKEN_TTL_S } from "../../protocol/constants.ts";
import type { Env } from "../env.ts";
import { notBuiltError } from "../not-built.ts";
import { createPool, readToken, registerPool } from "./pools.ts";

const KEY = "owner-key-for-tests-0123456789abcdef";

type Call = { kind: string; url?: string; init?: unknown; opts?: unknown };

function fakeEnv(over: {
  gateResponse?: Response;
  gateThrows?: boolean;
  swarmThrows?: Error;
  noGate?: boolean;
  noSwarm?: boolean;
  trunkResponse?: Response;
  repoToken?: string;
}): { env: Env; calls: Call[] } {
  const calls: Call[] = [];
  const env: Record<string, unknown> = { OWNER_KEY: KEY };
  if (!over.noGate) {
    env.GATE = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (url: string, init: unknown) => {
          calls.push({ kind: "gate", url, init });
          if (over.gateThrows) throw new Error("gate down");
          return over.gateResponse ?? new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      }),
    };
  }
  if (!over.noSwarm) {
    env.SWARM = {
      create: async (opts: unknown) => {
        calls.push({ kind: "swarm", opts });
        if (over.swarmThrows !== undefined) throw over.swarmThrows;
      },
    };
  }
  env.TRUNK = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (url: string, init: unknown) => {
        calls.push({ kind: "trunk", url, init });
        return over.trunkResponse ?? new Response(JSON.stringify({ ok: true, pool: "tp" }), { status: 200 });
      },
    }),
  };
  if (over.repoToken !== undefined) {
    env.POOLS = {
      get: async () => ({
        createToken: async (scope: string, ttl: number) => {
          calls.push({ kind: "token", opts: { scope, ttl } });
          return { id: "t1", plaintext: over.repoToken, scope, expiresAt: "" };
        },
        [Symbol.dispose]: () => {},
      }),
    };
  }
  return { env: env as unknown as Env, calls };
}

function post(path: string, body: unknown, key = KEY): Request {
  return new Request(`https://premise.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

const input = (request: Request, env: Env, params: Record<string, string> = {}) =>
  ({ request, env, params, route: undefined }) as unknown as Parameters<typeof createPool>[0];

describe("PL1/EV2a: the two registration calls of pool creation", () => {
  it("calls the model gate and the Swarm launcher, and tolerates their not_built stubs", async () => {
    const { env, calls } = fakeEnv({
      gateResponse: new Response(JSON.stringify({ error: { code: "not_built" } }), { status: 503 }),
      swarmThrows: notBuiltError(),
    });
    const result = await registerPool(env, "tp", "r1");
    expect(result).toEqual({ ok: true });
    const gate = calls.find((c) => c.kind === "gate");
    const swarm = calls.find((c) => c.kind === "swarm");
    expect(gate?.url).toBe("https://gate.internal/internal/register-pool");
    expect((gate?.init as { method: string }).method).toBe("POST");
    expect(JSON.parse((gate?.init as { body: string }).body)).toEqual({ pool: "tp", request_id: "r1" });
    expect((swarm?.opts as { id: string }).id).toBe("register-pool-tp-r1");
    expect(swarm?.opts).toMatchObject({ params: { pool: "tp", request_id: "r1" } });
  });

  it("a built gate's failure fails the registration (and so the creation)", async () => {
    const { env } = fakeEnv({ gateResponse: new Response("nope", { status: 500 }) });
    expect(await registerPool(env, "tp", "r1")).toEqual({ ok: false, target: "gate" });
    const thrown = fakeEnv({ gateThrows: true });
    expect(await registerPool(thrown.env, "tp", "r1")).toEqual({ ok: false, target: "gate" });
  });

  it("a built launcher's failure fails the registration", async () => {
    const { env } = fakeEnv({ swarmThrows: new Error("launcher down") });
    expect(await registerPool(env, "tp", "r1")).toEqual({ ok: false, target: "swarm" });
  });

  it("missing bindings are the unbuilt case: registration is skipped, not failed", async () => {
    const { env, calls } = fakeEnv({ noGate: true, noSwarm: true });
    expect(await registerPool(env, "tp", "r1")).toEqual({ ok: true });
    expect(calls.filter((c) => c.kind === "gate" || c.kind === "swarm")).toHaveLength(0);
  });
});

describe("POST /api/pools (PL1, SE5)", () => {
  const good = { pool: "tp1", seed: "tidepool", summary_only: true, request_id: "r1" };

  it("rejects a malformed body, a bad seed and a bad pool name with fixed codes", async () => {
    const { env } = fakeEnv({});
    const badJson = new Request("https://premise.test/api/pools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect((await createPool(input(badJson, env))).status).toBe(400);
    for (const body of [
      { ...good, seed: "elsewhere" },
      { ...good, pool: "Not A Pool" },
      { ...good, request_id: "" },
      { ...good, summary_only: "yes" },
      "nope",
    ]) {
      const res = await createPool(input(post("/api/pools", body), env));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { code: "invalid_args" } });
    }
  });

  it("creates through Trunk with summary_only stored, registers, and returns no token (SE5)", async () => {
    const { env, calls } = fakeEnv({});
    const res = await createPool(input(post("/api/pools", good), env));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, pool: "tp1" });
    // SE5: no token of any shape in the pool-create response.
    expect(text).not.toMatch(/token/i);
    expect(text).not.toMatch(/art_v\d+_/);

    const trunk = calls.find((c) => c.kind === "trunk");
    expect(trunk?.url).toBe("https://trunk.internal/internal/create-pool");
    expect(JSON.parse((trunk?.init as { body: string }).body)).toMatchObject({
      pool: "tp1",
      seed: "tidepool",
      summary_only: true,
      request_id: "r1",
    });
    // And the two PL1 registrations ran in the same request.
    expect(calls.some((c) => c.kind === "gate")).toBe(true);
    expect(calls.some((c) => c.kind === "swarm")).toBe(true);
  });

  it("forwards Trunk's pool_exists and fails creation when a built emitter fails", async () => {
    const exists = fakeEnv({
      trunkResponse: new Response(JSON.stringify({ error: { code: "pool_exists" } }), { status: 409 }),
    });
    const res = await createPool(input(post("/api/pools", good), exists.env));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "pool_exists" } });

    const broken = fakeEnv({ gateResponse: new Response("no", { status: 500 }) });
    const failed = await createPool(input(post("/api/pools", good), broken.env));
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: { code: "registration_failed", target: "gate" } });
  });
});

describe("POST /api/pools/{pool}/read-token (SE5c)", () => {
  it("mints a token with explicit scope read and READ_TOKEN_TTL_S, returned to the owner", async () => {
    const { env, calls } = fakeEnv({ repoToken: "read-tok-0123456789abcdef" });
    const res = await readToken(
      input(post("/api/pools/tp1/read-token", {}), env, { pool: "tp1" }) as unknown as Parameters<typeof readToken>[0],
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: "read-tok-0123456789abcdef" });
    expect(calls.find((c) => c.kind === "token")?.opts).toEqual({ scope: "read", ttl: READ_TOKEN_TTL_S });
  });

  it("answers not_built while no Artifacts binding exists, and invalid_args for a bad name", async () => {
    const { env } = fakeEnv({});
    expect((await readToken(input(post("/api/pools/tp/read-token", {}), env, { pool: "tp" }) as never)).status).toBe(
      503,
    );
    expect(
      (await readToken(input(post("/api/pools/x/read-token", {}), env, { pool: "Bad Name" }) as never)).status,
    ).toBe(400);
  });
});
