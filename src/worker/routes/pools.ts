// The pool routes of 13.6 the Worker answers itself (01-core): `POST /api/pools` (PL1) and
// `POST /api/pools/{pool}/read-token` (SE5c). The owner routes that act on a pool's contents
// (`intents`, `cards`, `undo*`, `rebuild`) are answered by the Trunk Durable Object, not here.
//
// SE5: the write token Artifacts hands back at repo creation is dropped where it is returned — it is
// never stored, logged, sent to an event or put in a response. Trunk mints its own when it needs one.

import { READ_TOKEN_TTL_S } from "../../protocol/constants.ts";
import { SEEDS } from "../../config/pools.ts";
import type { CreatePoolRequest, ReadTokenResponse } from "../../protocol/routes.ts";
import { notBuilt } from "../not-built.ts";
import { poolRepoName } from "../repos.ts";
import type { RouteHandler } from "../index.ts";
import type { Env } from "../env.ts";

const TRUNK_ORIGIN = "https://trunk.internal";
const GATE_ORIGIN = "https://gate.internal";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** Pool names: a Durable Object name and an Artifacts repo name both take them — lowercase, short. */
const POOL_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

type ParsedPool = { pool: string; seed: string; summary_only: boolean; request_id: string };

function parseCreate(body: unknown): ParsedPool | null {
  if (typeof body !== "object" || body === null) return null;
  const request = body as Partial<CreatePoolRequest>;
  if (
    typeof request.pool !== "string" ||
    !POOL_NAME.test(request.pool) ||
    typeof request.seed !== "string" ||
    !(SEEDS as readonly string[]).includes(request.seed) ||
    typeof request.request_id !== "string" ||
    request.request_id.length === 0 ||
    (request.summary_only !== undefined && typeof request.summary_only !== "boolean")
  ) {
    return null;
  }
  return {
    pool: request.pool,
    seed: request.seed,
    summary_only: request.summary_only ?? false,
    request_id: request.request_id,
  };
}

function artifactsCode(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return null;
  const code = (cause as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * The pool repo (PL1): created under the `POOLS` Artifacts binding and named after the pool. The
 * creation token of `ArtifactsCreateRepoResult` is discarded immediately (SE5); `remote` — the clone
 * address without credentials — is all Trunk is told. Tolerated by the build order: while no
 * Artifacts binding exists (a local test deployment) the pool still registers with `remote: ""`.
 */
async function poolRemote(env: Env, pool: string): Promise<string> {
  const pools = env.POOLS as Artifacts | undefined;
  if (pools === undefined) return "";
  try {
    const created = await pools.create(pool, { description: `premise pool ${pool}` });
    return created.remote;
  } catch (cause) {
    if (artifactsCode(cause) !== "ALREADY_EXISTS") throw cause;
  }
  const repo = await pools.get(pool);
  try {
    return (await repo.info()).remote;
  } finally {
    repo[Symbol.dispose]();
  }
}

/** What a not-yet-built registration target answers (Slice 0 stubs): the pool create ignores it
 * until the emitter is built (the track's acceptance); every other failure then fails creation. */
function isNotBuiltBody(body: unknown): boolean {
  return (
    typeof body === "object" && body !== null && (body as { error?: { code?: unknown } }).error?.code === "not_built"
  );
}

function isNotBuiltError(cause: unknown): boolean {
  return artifactsCode(cause) === "not_built" || (cause instanceof Error && cause.name === "NotBuiltError");
}

export type RegistrationResult = { ok: true } | { ok: false; target: "gate" | "swarm" };

/**
 * The two registrations of PL1/EV2a. The model gate is the `premise` Durable Object: a
 * not_built answer (its Slice-0 stub) is ignored until Slice 4 builds it. The Swarm launcher is a
 * Workflow — registration is a `register-pool-<pool>-<request_id>` instance; a missing binding or a
 * NotBuiltError (the Slice-0 stub) is ignored until Slice 8 builds it.
 */
export async function registerPool(env: Env, pool: string, requestId: string): Promise<RegistrationResult> {
  const gate = env.GATE as DurableObjectNamespace | undefined;
  if (gate !== undefined) {
    try {
      const response = await gate.get(gate.idFromName("premise")).fetch(`${GATE_ORIGIN}/internal/register-pool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pool, request_id: requestId }),
      });
      if (!response.ok && !(response.status === 503 && isNotBuiltBody(await response.json()))) {
        return { ok: false, target: "gate" };
      }
    } catch {
      return { ok: false, target: "gate" };
    }
  }

  const swarm = env.SWARM as Workflow | undefined;
  if (swarm !== undefined) {
    try {
      await swarm.create({
        id: `register-pool-${pool}-${requestId}`,
        params: { kind: "register_pool", pool, request_id: requestId },
      });
    } catch (cause) {
      if (!isNotBuiltError(cause)) return { ok: false, target: "swarm" };
    }
  }
  return { ok: true };
}

/**
 * `POST /api/pools` (PL1): `{ pool, seed, summary_only?, request_id }` → `{ ok: true, pool }`.
 * The route creates the Artifacts repo, hands Trunk the creation record (which stores
 * `summary_only` in `meta` and emits the first `pool.state`), then registers the pool with the
 * model gate and the Swarm launcher. A repeated `request_id` is a no-op on the Trunk side; the
 * registrations still run, so a retry repairs a registration that failed the first time.
 * The response carries no token (SE5).
 */
export const createPool: RouteHandler = async ({ request, env }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: { code: "bad_json" } }, 400);
  }
  const parsed = parseCreate(body);
  if (parsed === null) return json({ error: { code: "invalid_args" } }, 400);

  let remote: string;
  try {
    remote = await poolRemote(env, parsed.pool);
  } catch (cause) {
    return json({ error: { code: artifactsCode(cause)?.toLowerCase() ?? "upstream" } }, 502);
  }

  const trunk = env.TRUNK as DurableObjectNamespace;
  const created = await trunk.get(trunk.idFromName(parsed.pool)).fetch(`${TRUNK_ORIGIN}/internal/create-pool`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pool: parsed.pool,
      seed: parsed.seed,
      summary_only: parsed.summary_only,
      request_id: parsed.request_id,
      remote,
    }),
  });
  if (!created.ok) {
    const error = (await created.json().catch(() => null)) as { error?: { code?: string } } | null;
    return json(error ?? { error: { code: "trunk_error" } }, created.status);
  }

  const registered = await registerPool(env, parsed.pool, parsed.request_id);
  if (!registered.ok) {
    return json({ error: { code: "registration_failed", target: registered.target } }, 502);
  }
  return json({ ok: true, pool: parsed.pool });
};

/**
 * `POST /api/pools/{pool}/read-token` (SE5c): mints a repo token with explicit scope `read` and a
 * `READ_TOKEN_TTL_S` lifetime, and returns it to the owner only. `createToken` is never called
 * without an explicit scope.
 */
export const readToken: RouteHandler = async ({ env, params }) => {
  const pool = params.pool ?? "";
  if (!POOL_NAME.test(pool)) return json({ error: { code: "invalid_args" } }, 400);
  const pools = env.POOLS as Artifacts | undefined;
  if (pools === undefined) return notBuilt();
  let repo: ArtifactsRepo;
  try {
    repo = await pools.get(poolRepoName(pool));
  } catch (cause) {
    return json(
      { error: { code: artifactsCode(cause)?.toLowerCase() ?? "upstream" } },
      artifactsCode(cause) === "NOT_FOUND" ? 404 : 502,
    );
  }
  try {
    const token = await repo.createToken("read", READ_TOKEN_TTL_S);
    const response: ReadTokenResponse = { token: token.plaintext };
    return json(response);
  } catch (cause) {
    return json({ error: { code: artifactsCode(cause)?.toLowerCase() ?? "upstream" } }, 502);
  } finally {
    repo[Symbol.dispose]();
  }
};
