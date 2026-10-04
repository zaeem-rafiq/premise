// The swarm lane's wiring module for the routes seam (04-build-plan 3.2) and the Swarm launcher of
// 01-core SWR1 to SWR4 for a canned cast (SWR2): `POST /api/swarm` takes a `SwarmRequest` and starts
// one scripted Agent Durable Object per entry of `patterns`, in list order.
//
// The Agent Durable Object itself is built by the agent lane; the launch call this route makes is
// `POST /open` on the object named by the attempt id (the same naming the seam uses at dispatch):
// a repeated `/open` for an attempt it already holds is an idempotent no-op (9.8). Because the
// attempt id is derived from `request_id`, a repeated request launches nothing (SWR4).

import type { Env } from "../env.ts";
import type { RouteInput, RouteTable } from "../index.ts";
import { ROUTES } from "../../protocol/routes.ts";
import type { SwarmRequest } from "../../protocol/swarm.ts";
import type {
  AgentOpenRequest,
  AgentOpenResponse,
  TrunkOpenAttemptRequest,
  TrunkOpenAttemptResponse,
} from "../../protocol/internal.ts";
import { patternById } from "../../swarm/pattern.ts";
import { H } from "../../core/sync/h.ts";

/** The launch call's contract lives in `src/protocol/internal.ts`; the local aliases stay so the
 * lane's test keeps its import shape (gap 1's one-definition rule). */
export type { AgentOpenRequest, AgentOpenResponse } from "../../protocol/internal.ts";

/** The requester recorded on a synthetic attempt's intent (CM1's author `SYNTHETIC swarm`). */
const REQUESTER = "swarm";

const AGENT_OPEN_URL = "https://agent/open";
const AGENT_RELEASE_URL = "https://agent/release";
const TRUNK_OPEN_ATTEMPT_URL = "https://trunk/internal/open-attempt";

/** ULID's Crockford base32 alphabet, in order. */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A deterministic `a_<ULID>` (or `i_`, `c_`) for one agent of one request: the 128 bits of
 * `H("swarm|<prefix>|<request_id>|<n>")` base32-encoded. SWR4: a repeated `request_id` names the
 * same Durable Objects, whose `/open` is idempotent, so a retry launches nothing.
 */
function launchId(prefix: "a_" | "i_" | "c_", requestId: string, n: number): string {
  let value = BigInt(`0x${H(`swarm|${prefix}|${requestId}|${n}`)}`);
  let id = "";
  for (let i = 0; i < 26; i += 1) {
    id = B32[Number(value & 0x1fn)] + id;
    value >>= 5n;
  }
  return `${prefix}${id}`;
}

/** The attempt id of agent `n` of `request_id` — the Durable Object's name. */
export function launchAttemptId(requestId: string, n: number): string {
  return launchId("a_", requestId, n);
}

/** Request ids this isolate has already answered (SWR4; DO idempotency covers restarts). */
const answeredRequests = new Set<string>();

/** Which attempts were launched per `pool` and pattern, so `release` (SWR3) finds them. */
const launchedAgents = new Map<string, Map<string, string[]>>();

function recordLaunch(pool: string, pattern: string, attemptId: string): void {
  let byPattern = launchedAgents.get(pool);
  if (byPattern === undefined) {
    byPattern = new Map();
    launchedAgents.set(pool, byPattern);
  }
  const ids = byPattern.get(pattern) ?? [];
  if (!ids.includes(attemptId)) ids.push(attemptId);
  byPattern.set(pattern, ids);
}

function badRequest(code: string): Response {
  return Response.json({ error: { code } }, { status: 400 });
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry !== "");
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Shape-checks the body as `SwarmRequest` (SWR1). A request that starts agents carries all of
 * `SwarmConfig`; a release-only request may carry only `pool`, `running`, `release`, `request_id`
 * (SWR3). Returns the request or a 400 response.
 */
function validate(body: unknown): { request: SwarmRequest } | { response: Response } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { response: badRequest("invalid_args") };
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.pool !== "string" || raw.pool === "") return { response: badRequest("invalid_args") };
  if (typeof raw.running !== "boolean") return { response: badRequest("invalid_args") };
  if (typeof raw.request_id !== "string" || raw.request_id === "") {
    return { response: badRequest("invalid_args") };
  }
  for (const key of ["patterns", "release", "hold_before_submit"] as const) {
    if (raw[key] !== undefined && !isStringList(raw[key])) {
      return { response: badRequest("invalid_args") };
    }
  }
  const request = raw as unknown as SwarmRequest;
  // Every pattern id must be known before anything is launched.
  if ((request.patterns ?? []).some((id) => patternById(id) === undefined)) {
    return { response: badRequest("unknown_pattern") };
  }
  if ((request.release ?? []).some((id) => patternById(id) === undefined)) {
    return { response: badRequest("unknown_pattern") };
  }
  if (request.running === true && (request.patterns?.length ?? 0) > 0) {
    const configOk =
      isNumber(raw.seed) &&
      isNumber(raw.agents) &&
      isNumber(raw.launch_per_second) &&
      isNumber(raw.collision_dial) &&
      isNumber(raw.rescale_every_s) &&
      Array.isArray(raw.think_ms) &&
      raw.think_ms.length === 2 &&
      raw.think_ms.every(isNumber);
    if (!configOk) return { response: badRequest("invalid_args") };
  }
  return { request };
}

/** SE10: the kill switch stops launching. Asks the model gate's `killed` state; an unreachable or
 * not-yet-built gate means unknown, which is not killed. */
async function killed(env: Env): Promise<boolean> {
  try {
    const response = await env.GATE.get(env.GATE.idFromName("premise")).fetch("https://gate/killed");
    if (!response.ok) return false;
    const body = (await response.json()) as { killed?: unknown };
    return body.killed === true;
  } catch {
    return false;
  }
}

async function handleSwarm(input: RouteInput): Promise<Response> {
  let body: unknown;
  try {
    body = await input.request.json();
  } catch {
    return badRequest("invalid_json");
  }
  const checked = validate(body);
  if ("response" in checked) return checked.response;
  const { request } = checked;
  if (answeredRequests.has(request.request_id)) {
    return Response.json({ ok: true, already: true, launched: [], released: [] });
  }

  const launched: string[] = [];
  const released: string[] = [];

  // SWR2: one scripted agent per entry of `patterns`, in list order; agent n is entry n.
  if (request.running && (request.patterns?.length ?? 0) > 0) {
    if (await killed(input.env)) {
      return Response.json({ ok: true, killed: true, launched, released });
    }
    const hold = new Set(request.hold_before_submit ?? []);
    for (const [n, id] of request.patterns!.entries()) {
      const pattern = patternById(id);
      if (pattern === undefined) return badRequest("unknown_pattern");
      const attemptId = launchAttemptId(request.request_id, n);
      const intentId = launchId("i_", request.request_id, n);
      // SWR2/9.2 T1: the attempt opens in the pool's Trunk first — `attempt.opened` (and EM1a's
      // `pool.state` on the first synthetic) precede everything the agent does.
      const openAttempt: TrunkOpenAttemptRequest = {
        attempt_id: attemptId,
        intent_id: intentId,
        intent: pattern.intent,
        agent_kind: "synthetic",
        truth: [...pattern.truth],
        requester: REQUESTER,
      };
      let trunkAnswer: TrunkOpenAttemptResponse;
      try {
        const response = await input.env.TRUNK.get(input.env.TRUNK.idFromName(request.pool)).fetch(
          TRUNK_OPEN_ATTEMPT_URL,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(openAttempt),
          },
        );
        trunkAnswer = (await response.json()) as TrunkOpenAttemptResponse;
      } catch {
        return Response.json({ error: { code: "trunk_open_failed" } }, { status: 502 });
      }
      if (!trunkAnswer.ok) {
        return Response.json({ error: { code: "trunk_open_failed", detail: trunkAnswer.error } }, { status: 502 });
      }
      const open: AgentOpenRequest = {
        pool: request.pool,
        attempt_id: attemptId,
        intent_id: intentId,
        change_id: trunkAnswer.change_id,
        intent_text: pattern.intent,
        requester: REQUESTER,
        driver: "scripted",
        pattern: pattern.id,
        seed: request.seed as number,
        agent_n: n,
        truth: [...pattern.truth],
        hold: hold.has(pattern.id),
        think_ms: request.think_ms as [number, number],
      };
      let answer: AgentOpenResponse;
      try {
        const response = await input.env.AGENT.get(input.env.AGENT.idFromName(attemptId)).fetch(AGENT_OPEN_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(open),
        });
        answer = (await response.json()) as AgentOpenResponse;
      } catch {
        return Response.json({ error: { code: "agent_open_failed" } }, { status: 502 });
      }
      if (!answer.ok) {
        return Response.json({ error: { code: "agent_open_failed", detail: answer.error } }, { status: 502 });
      }
      recordLaunch(request.pool, pattern.id, attemptId);
      if (answer.already !== true) launched.push(attemptId);
    }
  }

  // SWR3: a release names held patterns whose agents may now call `submit`.
  for (const id of request.release ?? []) {
    const ids = launchedAgents.get(request.pool)?.get(id) ?? [];
    for (const attemptId of ids) {
      try {
        await input.env.AGENT.get(input.env.AGENT.idFromName(attemptId)).fetch(AGENT_RELEASE_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attempt_id: attemptId, pool: request.pool, pattern: id }),
        });
        released.push(attemptId);
      } catch {
        return Response.json({ error: { code: "agent_release_failed" } }, { status: 502 });
      }
    }
  }

  answeredRequests.add(request.request_id);
  return Response.json({ ok: true, launched, released });
}

export function wire(table: RouteTable): void {
  const route = ROUTES.find((entry) => entry.paths.includes("/api/swarm"));
  // The seam's key of `routeKey(route)`: "<method> <first path>" — "POST /api/swarm".
  if (route !== undefined) table.handlers.set(`${route.method} ${route.paths[0]}`, handleSwarm);
}
