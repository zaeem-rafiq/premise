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

/** An ArtifactsError-shaped failure the fake POOLS throws: only `.code` is read. */
function artifactsError(code: string): Error {
  const cause = new Error(`artifacts ${code}`);
  (cause as { code?: string }).code = code;
  return cause;
}

function fakeEnv(over: {
  gateResponse?: Response;
  gateThrows?: boolean;
  swarmThrows?: Error;
  noGate?: boolean;
  noSwarm?: boolean;
  trunkResponse?: Response;
  repoToken?: string;
  pools?: {
    create?: (name: string, opts: unknown) => Promise<unknown>;
    import?: (params: unknown) => Promise<unknown>;
    get?: (name: string) => Promise<unknown>;
  };
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
  if (over.pools !== undefined) {
    const pools = over.pools;
    env.POOLS = {
      create: async (name: string, opts: unknown) => {
        calls.push({ kind: "pools.create", opts: { name, opts } });
        return pools.create !== undefined
          ? pools.create(name, opts)
          : { id: "r1", name, remote: `https://artifacts.test/${name}.git`, token: "art_v1_dropped" };
      },
      import: async (params: unknown) => {
        calls.push({ kind: "pools.import", opts: params });
        return pools.import !== undefined
          ? pools.import(params)
          : { id: "r1", name: "tp-repo", remote: "https://artifacts.test/tp-repo.git", token: "art_v1_dropped" };
      },
      get: async (name: string) => {
        calls.push({ kind: "pools.get", opts: { name } });
        return pools.get !== undefined
          ? pools.get(name)
          : {
              info: async () => ({ remote: `https://artifacts.test/${name}.git` }),
              [Symbol.dispose]: () => {},
            };
      },
    };
  }
  if (over.repoToken !== undefined) {
    env.POOLS = {
      get: async () => ({
        createToken: async (...args: unknown[]) => {
          calls.push({ kind: "token", opts: { args } });
          return { id: "t1", plaintext: over.repoToken, scope: args[0], expiresAt: "" };
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

describe("POST /api/pools with source (IR1, IR2)", () => {
  const good = { pool: "tp-repo", source: { url: "https://github.com/octo/app" }, request_id: "r9" };

  it("imports through the binding at depth 1 under the pool's repo name, drops the token", async () => {
    const { env, calls } = fakeEnv({ pools: {} });
    const res = await createPool(
      input(post("/api/pools", { ...good, source: { url: "https://gitlab.com/octo/app.git", branch: "dev/x" } }), env),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pool: "tp-repo" });
    const imp = calls.find((c) => c.kind === "pools.import");
    expect(imp?.opts).toEqual({
      source: { url: "https://gitlab.com/octo/app.git", branch: "dev/x", depth: 1 },
      target: { name: "tp-repo" },
    });
    // SE5: the creation token is nowhere in the response or the Trunk call.
    const text = await createPool(input(post("/api/pools", good), fakeEnv({ pools: {} }).env));
    const trunk = calls.find((c) => c.kind === "trunk");
    expect(JSON.parse((trunk?.init as { body: string }).body)).toMatchObject({
      pool: "tp-repo",
      source: { url: "https://gitlab.com/octo/app.git", branch: "dev/x" },
      remote: "https://artifacts.test/tp-repo.git",
    });
    expect((trunk?.init as { body: string }).body).not.toContain("art_v1_dropped");
    expect(text.status).toBe(200);
  });

  it("accepts every supported host and owner/name character of IR1", async () => {
    const { env, calls } = fakeEnv({ pools: {} });
    for (const url of [
      "https://github.com/o/r",
      "https://gitlab.com/a.b/c_d",
      "https://codeberg.org/a-b/c.d_e",
      "https://github.com/O123/r-.git",
    ]) {
      const res = await createPool(
        input(post("/api/pools", { pool: "tp-repo", source: { url }, request_id: "r" }), env),
      );
      expect(res.status, url).toBe(200);
    }
    expect(calls.filter((c) => c.kind === "pools.import")).toHaveLength(4);
  });

  it("passes the import the address rebuilt from its checked parts, the host in lower case", async () => {
    const { env, calls } = fakeEnv({ pools: {} });
    const res = await createPool(
      input(post("/api/pools", { ...good, source: { url: "https://GitHub.com/octo/app.git" } }), env),
    );
    expect(res.status).toBe(200);
    const imp = calls.find((c) => c.kind === "pools.import");
    expect(imp?.opts).toEqual({
      source: { url: "https://github.com/octo/app.git", depth: 1 },
      target: { name: "tp-repo" },
    });
  });

  it("refuses every other address form of IR1 with 400 invalid_args", async () => {
    const { env, calls } = fakeEnv({ pools: {} });
    const bad = [
      "http://github.com/o/r", // not https
      "https://bitbucket.org/o/r", // unsupported host
      "https://user@github.com/o/r", // user name
      "https://user:pw@github.com/o/r", // password
      "https://github.com:8443/o/r", // port
      "https://github.com:443/o/r", // even the default port
      "https://github.com/o/r?x=1", // query
      "https://github.com/o/r#frag", // fragment
      "https://github.com/o/r/extra", // a third segment
      "https://github.com/o", // one segment
      "https://github.com/o/", // a missing name
      "https://github.com/o//r", // an empty segment
      "https://github.com/o has space/r", // a bad owner
      "https://github.com/o/r!bang", // a bad name
      "https://github.com/o/%2e%2e", // an encoded name
      "git@github.com:o/r.git", // not https at all
      "https://github.com/o/r/", // a trailing slash
      "https://github.com/o/r\n", // a line break, which `new URL` would drop
      "https://git\thub.com/o/r", // a tab inside the host, which `new URL` would drop
      " https://github.com/o/r", // a leading space
      "",
    ];
    for (const url of bad) {
      const res = await createPool(
        input(post("/api/pools", { pool: "tp-repo", source: { url }, request_id: "r" }), env),
      );
      expect(res.status, url).toBe(400);
      expect(await res.json(), url).toEqual({ error: { code: "invalid_args" } });
    }
    // Bad branches of IR1.
    for (const branch of ["a..b", "no space", "", "a:b"]) {
      const res = await createPool(
        input(
          post("/api/pools", { pool: "tp-repo", source: { url: "https://github.com/o/r", branch }, request_id: "r" }),
          env,
        ),
      );
      expect(res.status, branch).toBe(400);
      expect(await res.json(), branch).toEqual({ error: { code: "invalid_args" } });
    }
    // seed and source together, or neither.
    for (const body of [
      { pool: "tp-repo", seed: "tidepool", source: { url: "https://github.com/o/r" }, request_id: "r" },
      { pool: "tp-repo", request_id: "r" },
      { pool: "tp-repo", source: "https://github.com/o/r", request_id: "r" },
      { pool: "tp-repo", source: { url: 42 }, request_id: "r" },
    ]) {
      const res = await createPool(input(post("/api/pools", body), env));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { code: "invalid_args" } });
    }
    expect(calls.filter((c) => c.kind === "pools.import")).toHaveLength(0);
  });

  it("maps every binding error of IR2 to its code and status", async () => {
    const table: [string, number, string][] = [
      ["REMOTE_AUTH_REQUIRED", 400, "repo_private"],
      ["NOT_FOUND", 404, "repo_not_found"],
      ["MEMORY_LIMIT", 413, "repo_too_large"],
      ["UPSTREAM_UNAVAILABLE", 502, "upstream_unavailable"],
      ["INVALID_URL", 400, "invalid_args"],
      ["INVALID_INPUT", 400, "invalid_args"],
    ];
    for (const [code, status, want] of table) {
      const { env } = fakeEnv({
        pools: {
          import: async () => {
            throw artifactsError(code);
          },
        },
      });
      const res = await createPool(input(post("/api/pools", good), env));
      expect(res.status, code).toBe(status);
      expect(await res.json(), code).toEqual({ error: { code: want } });
    }
    // An unlisted code is an upstream failure, not a 400.
    const { env } = fakeEnv({
      pools: {
        import: async () => {
          throw artifactsError("INTERNAL_ERROR");
        },
      },
    });
    const res = await createPool(input(post("/api/pools", good), env));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: "upstream_unavailable" } });
  });

  it("a retried create (repo already imported) reads the remote like the seed path", async () => {
    const { env, calls } = fakeEnv({
      pools: {
        import: async () => {
          throw artifactsError("ALREADY_EXISTS");
        },
      },
    });
    const res = await createPool(input(post("/api/pools", good), env));
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.kind === "pools.get")).toBe(true);
    const trunk = calls.find((c) => c.kind === "trunk");
    expect(JSON.parse((trunk?.init as { body: string }).body)).toMatchObject({
      remote: "https://artifacts.test/tp-repo.git",
    });
  });

  it("a Trunk pool_exists answers 409 to a second request_id for the pool", async () => {
    const { env } = fakeEnv({
      pools: {},
      trunkResponse: new Response(JSON.stringify({ error: { code: "pool_exists" } }), { status: 409 }),
    });
    const res = await createPool(input(post("/api/pools", good), env));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "pool_exists" } });
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
    // `args` is the recorded argument list verbatim: ["read", ttl] proves the scope was passed
    // explicitly — a scope-less call records fewer arguments and fails this (SE5c).
    expect(calls.find((c) => c.kind === "token")?.opts).toEqual({ args: ["read", READ_TOKEN_TTL_S] });
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
