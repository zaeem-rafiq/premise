// The swarm lane's wiring module for the routes seam (04-build-plan 3.2) and the Swarm launcher
// of 01-core SWR1 to SWR4: `POST /api/swarm` takes a `SwarmRequest` and starts scripted Agent
// Durable Objects — one per `patterns` entry for a canned cast (SWR2), or a paced run of
// `agents` drawn by `collision_dial` for a full `SwarmConfig` (SWR1, the `run-<pool>` Workflow
// instance). `running: false` stops the run; a bare `collision_dial` moves its dial (CO44a).
//
// Every change of what is running is reported by `swarm.state` (SWR4/EM6): the run instance and
// `emit-<request_id>` instances deliver it to every registered pool on the `swarm` source
// (EV2a). Because the launcher's attempt ids derive from `request_id`, a repeated request
// launches nothing, and a re-sent state is deduplicated by content at each Floor.

import type { Env } from "../env.ts";
import type { RouteInput, RouteTable } from "../index.ts";
import { ROUTES } from "../../protocol/routes.ts";
import type { SwarmRequest } from "../../protocol/swarm.ts";
import type { SwarmEmitParams, SwarmRunParams } from "../../protocol/internal.ts";
import { SWARM_CONTROL_EVENT } from "../../protocol/internal.ts";
import { patternById } from "../../swarm/pattern.ts";
import { heldAttempts, launchAgent, launchId, releaseAgent } from "../swarm/launch.ts";
import { notBuilt } from "../not-built.ts";

/** The first run instance of a pool — `run-<pool>` (SWR1). A Workflow instance id cannot be
 * used again, even after its instance is deleted, so each later run of the pool gets
 * `run-<pool>-<time>`, and the pool's Trunk records which id is current (`/internal/swarm-run`). */
const runInstanceId = (pool: string) => `run-${pool}`;

/** The pool's current run instance id: the one its Trunk recorded, else `run-<pool>`. */
async function currentRunId(env: Env, pool: string): Promise<string> {
  try {
    const response = await env.TRUNK.get(env.TRUNK.idFromName(pool)).fetch("https://trunk/internal/swarm-run");
    if (response.ok) {
      const { id } = (await response.json()) as { id?: unknown };
      if (typeof id === "string" && id !== "") return id;
    }
  } catch {
    /* an unreadable record leaves the first id */
  }
  return runInstanceId(pool);
}

async function recordRunId(env: Env, pool: string, id: string): Promise<void> {
  await env.TRUNK.get(env.TRUNK.idFromName(pool)).fetch("https://trunk/internal/swarm-run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
}
/** A route-asked emission instance — `emit-<request_id>`; `create` refuses its repeat (SWR4). */
const emitInstanceId = (requestId: string) => `emit-${requestId}`;

/** Request ids this isolate has already answered (SWR4; DO idempotency covers restarts). */
const answeredRequests = new Set<string>();

function badRequest(code: string): Response {
  return Response.json({ error: { code } }, { status: 400 });
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry !== "");
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Every field of `SwarmConfig` present — a run's shape (SWR1), not a dial-only request. */
function hasFullConfig(raw: Record<string, unknown>): boolean {
  return (
    isNumber(raw.seed) &&
    isNumber(raw.agents) &&
    isNumber(raw.launch_per_second) &&
    isNumber(raw.collision_dial) &&
    isNumber(raw.rescale_every_s) &&
    Array.isArray(raw.think_ms) &&
    raw.think_ms.length === 2 &&
    (raw.think_ms as unknown[]).every(isNumber)
  );
}

/**
 * Shape-checks the body as `SwarmRequest` (SWR1). A request that starts agents carries all of
 * `SwarmConfig`; a release-only request may carry only `pool`, `running`, `release`, `request_id`
 * (SWR3); a dial move during a run carries `pool`, `running`, `collision_dial`, `request_id`
 * (CO44a). Returns the request or a 400 response.
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
  const hasPatterns = (request.patterns?.length ?? 0) > 0;
  const hasRelease = (request.release?.length ?? 0) > 0;
  if (request.running === true && hasPatterns && !hasFullConfig(raw)) {
    return { response: badRequest("invalid_args") };
  }
  // A `running` request that launches nothing must still be shaped: a full config (a run), a
  // bare `collision_dial` (the dial move of CO44a) or a `release` list (SWR3).
  if (
    request.running === true &&
    !hasPatterns &&
    !hasRelease &&
    !hasFullConfig(raw) &&
    raw.collision_dial === undefined
  ) {
    return { response: badRequest("invalid_args") };
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

/** One `emit-<request_id>` instance delivers `patch` as `swarm.state` to every pool (EM6, EV2a).
 * A repeated request id is refused by `create` — the emission already exists (SWR4). */
async function spawnEmit(env: Env, pool: string, requestId: string, patch: SwarmEmitParams["patch"]): Promise<void> {
  const swarm = env.SWARM;
  if (swarm === undefined) return;
  try {
    await swarm.create({
      id: emitInstanceId(requestId),
      params: { kind: "emit", pool, request_id: requestId, patch } satisfies SwarmEmitParams,
    });
  } catch {
    // A duplicate instance id is the repeated request — the first emit still stands (SWR4).
  }
}

/** Sends the live `run-<pool>` instance a control event: `sent`, `no_run` when no run lives, or
 * `failed` when a live run refused it (then the caller must not pretend the run heard it). */
async function controlRun(
  env: Env,
  pool: string,
  payload: object,
): Promise<{ outcome: "sent" | "no_run" } | { outcome: "failed"; terminate(): Promise<void> }> {
  const swarm = env.SWARM;
  if (swarm === undefined) return { outcome: "no_run" };
  let instance: Awaited<ReturnType<NonNullable<Env["SWARM"]>["get"]>>;
  try {
    instance = await swarm.get(await currentRunId(env, pool));
    const status = (await instance.status()).status;
    if (status !== "running" && status !== "waiting" && status !== "queued") return { outcome: "no_run" };
  } catch {
    return { outcome: "no_run" }; // no instance by that id
  }
  try {
    await instance.sendEvent({ type: SWARM_CONTROL_EVENT, payload });
    return { outcome: "sent" };
  } catch (cause) {
    console.error("swarm control refused", cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown");
    return { outcome: "failed", terminate: () => instance.terminate() };
  }
}

/** Stops the pool's run (SWR1): the run hears `stop` and emits its last state; with no live run the
 * route emits `running: false` itself; a run that refused the event is terminated, then the same. */
async function stopRun(env: Env, pool: string, requestId: string): Promise<boolean> {
  const control = await controlRun(env, pool, { op: "stop" });
  if (control.outcome === "sent") return true;
  if (control.outcome === "failed") {
    try {
      await control.terminate();
    } catch {
      return false;
    }
  }
  await spawnEmit(env, pool, requestId, { running: false });
  return true;
}

/** Starts the pool's run: the launcher instance of a run request (SWR1). A live run is answered
 * `already` (the launch list is empty). Otherwise the run gets a fresh instance id — the first
 * id when no run ever used it, else `run-<pool>-<time>` — and the Trunk records it. */
async function startRun(
  env: Env,
  pool: string,
  requestId: string,
  request: SwarmRequest,
): Promise<"started" | "already" | "no_binding"> {
  const swarm = env.SWARM;
  if (swarm === undefined) return "no_binding";
  const current = await currentRunId(env, pool);
  let used = false;
  try {
    const status = (await (await swarm.get(current)).status()).status;
    if (status === "running" || status === "waiting" || status === "queued") return "already";
    used = true;
  } catch {
    /* no instance by that id */
  }
  const fresh = () => `${runInstanceId(pool)}-${Date.now().toString(36)}`;
  let id = used ? fresh() : current;
  const params: SwarmRunParams = {
    kind: "run",
    pool,
    request_id: requestId,
    config: {
      seed: request.seed as number,
      agents: request.agents as number,
      launch_per_second: request.launch_per_second as number,
      collision_dial: request.collision_dial as number,
      think_ms: request.think_ms as [number, number],
      rescale_every_s: request.rescale_every_s as number,
      hold_before_submit: request.hold_before_submit,
    },
  };
  try {
    await swarm.create({ id, params });
  } catch (cause) {
    // An id whose instance was deleted is still taken (seen on production, 2026-10-14).
    if (id !== current) throw cause;
    id = fresh();
    await swarm.create({ id, params });
  }
  await recordRunId(env, pool, id);
  return "started";
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

  // IR7: no Swarm for a pool imported from a repository — `meta.source` names it. A state read
  // that fails does not block the launch: the `open_attempt` call below reports a missing or
  // unready pool exactly as before.
  try {
    const state = await input.env.TRUNK.get(input.env.TRUNK.idFromName(request.pool)).fetch(
      "https://trunk/internal/state",
    );
    if (state.ok) {
      const meta = ((await state.json()) as { meta?: Record<string, string> }).meta ?? {};
      if ((meta.source ?? "") !== "") return badRequest("invalid_args");
    }
  } catch {
    /* a transport failure leaves the launch to its own checks */
  }

  const launched: string[] = [];
  const released: string[] = [];

  // The kill switch stops launching (SE10): a killed start launches nothing, stops the live run
  // and reports the change (SWR4/EM6).
  const willLaunch =
    request.running === true &&
    ((request.patterns?.length ?? 0) > 0 || hasFullConfig(request as unknown as Record<string, unknown>));
  if (willLaunch && (await killed(input.env))) {
    await stopRun(input.env, request.pool, `${request.request_id}-kill`);
    answeredRequests.add(request.request_id);
    return Response.json({ ok: true, killed: true, launched, released });
  }

  // SWR2: one scripted agent per entry of `patterns`, in list order; agent n is entry n.
  if (request.running && (request.patterns?.length ?? 0) > 0) {
    const hold = new Set(request.hold_before_submit ?? []);
    for (const [n, id] of request.patterns!.entries()) {
      const pattern = patternById(id);
      if (pattern === undefined) return badRequest("unknown_pattern");
      const attemptId = launchId("a_", request.request_id, n);
      const intentId = launchId("i_", request.request_id, n);
      const result = await launchAgent(input.env, {
        pool: request.pool,
        attemptId,
        intentId,
        pattern: { id: pattern.id, intent: pattern.intent, truth: pattern.truth },
        seed: request.seed as number,
        agentN: n,
        hold: hold.has(pattern.id),
        thinkMs: request.think_ms as [number, number],
      });
      if (!result.ok) {
        return Response.json(
          { error: { code: result.code, detail: "detail" in result ? result.detail : undefined } },
          { status: 502 },
        );
      }
      if (!result.already) launched.push(attemptId);
    }
    // SWR4/EM6: the cast changed what is running — the stream of every pool reports it.
    await spawnEmit(input.env, request.pool, request.request_id, { agents: launched.length });
  } else if (request.running === true && hasFullConfig(request as unknown as Record<string, unknown>)) {
    // SWR1: a run. The `run-<pool>` instance emits `swarm.state` itself.
    const started = await startRun(input.env, request.pool, request.request_id, request);
    if (started === "no_binding") return notBuilt();
    if (started === "already") {
      return Response.json({ ok: true, already: true, launched, released });
    }
  } else if (request.running === true && request.collision_dial !== undefined) {
    // CO44a: moving the dial during a run sends the new collision_dial; the run instance emits
    // the state. With no live run the dial still lands in `swarm.state` for the next start.
    const control = await controlRun(input.env, request.pool, {
      op: "dial",
      collision_dial: request.collision_dial,
    });
    if (control.outcome === "failed") return Response.json({ error: { code: "control_failed" } }, { status: 502 });
    if (control.outcome === "no_run") {
      await spawnEmit(input.env, request.pool, request.request_id, {
        collision_dial: request.collision_dial,
      });
    }
  } else if (request.running === false) {
    // SWR1: stop launching in this pool; agents in flight finish.
    if (!(await stopRun(input.env, request.pool, request.request_id))) {
      return Response.json({ error: { code: "control_failed" } }, { status: 502 });
    }
  }

  // SWR3: a release names held patterns whose agents may now call `submit`.
  for (const id of request.release ?? []) {
    let ids: string[];
    try {
      ids = await heldAttempts(input.env, request.pool, id);
    } catch {
      return Response.json({ error: { code: "agent_release_failed" } }, { status: 502 });
    }
    for (const attemptId of ids) {
      try {
        await releaseAgent(input.env, request.pool, id, attemptId);
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

// The `AgentOpenRequest`/`AgentOpenResponse` contract lives in `src/protocol/internal.ts`; the
// local aliases stay so the lane's test keeps its import shape (gap 1's one-definition rule).
export type { AgentOpenRequest, AgentOpenResponse } from "../../protocol/internal.ts";

/** The attempt id of agent `n` of `request_id` — the Durable Object's name. */
export function launchAttemptId(requestId: string, n: number): string {
  return launchId("a_", requestId, n);
}
