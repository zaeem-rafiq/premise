// The Worker entry and the routes seam (04-build-plan 3.2). The Worker matches every request against
// the route table of `protocol/routes.ts`, applies the route's role (SE1, SE3), and hands the request
// to the handler a wiring module registered — or, while a lane has registered none, to the target the
// route names, every one of which answers `not_built`.
//
// This file also re-exports the seven class files `wrangler.jsonc` names (Slice 0).

import type { Env } from "./env.ts";
import { forbidden, notBuilt, notConfigured, notFound, unauthorized, unsupportedMediaType } from "./not-built.ts";
import { PUBLIC_RATE_PER_MIN } from "../protocol/constants.ts";
import { serveFloorAsset } from "./security/floor-page.ts";
import { clientAddress, publicReads } from "./security/rate-limit.ts";
import { credentialKind, originOkFor } from "./security/session.ts";
import { APP_ROUTES, ROUTES, type Route } from "../protocol/routes.ts";
import { wire as wireTrunk } from "./routes/wiring.ts";
import { wire as wireSwarm } from "./routes/swarm.ts";
import { wire as wireFloor } from "./floor/wiring.ts";
import { wire as wirePool } from "./app-server/wiring.ts";
import { answerUnhandled } from "./unhandled.ts";

// The classes that wrangler.jsonc names. Wrangler finds them as exports of this module.
export { Trunk } from "./trunk/trunk-do.ts";
export { Agent } from "./agent/agent-do.ts";
export { Floor } from "./floor/floor-do.ts";
export { ModelGate } from "./gate/gate-do.ts";
export { SwarmWorkflow } from "./workflows/swarm.ts";
export { GreenLineWorkflow } from "./workflows/green-line.ts";
export { AttemptRepoWorkflow } from "./workflows/attempt-repo.ts";

// ---- The seam's table ----

export type RouteInput = {
  request: Request;
  env: Env;
  params: Record<string, string>;
  route: Route;
};

export type RouteHandler = (input: RouteInput) => Response | Promise<Response>;

export type RouteTable = { handlers: Map<string, RouteHandler> };

/** The key a wiring module registers a route's handler under: `<method> <first path>`. */
export function routeKey(route: Route): string {
  return `${route.method} ${route.paths[0]}`;
}

/** The seam builds the table by calling one wiring module per lane (04-build-plan 3.2). */
function routeTable(): RouteTable {
  const table: RouteTable = { handlers: new Map() };
  wireTrunk(table);
  wireSwarm(table);
  wireFloor(table);
  wirePool(table);
  return table;
}

const ROUTE_TABLE = routeTable();

// ---- Route matching ----

/** The last row of `ROUTES` is the pool-files row: the app server's routes of `APP_ROUTES` live under
 * `/pool/`, so the specific templates of both tables are tried first and the catch-all last. */
const MATCH_ORDER: readonly Route[] = [...ROUTES.slice(0, -1), ...APP_ROUTES, ...ROUTES.slice(-1)];

/** One template segment: `{name}` matches one non-empty segment part (also inside a segment, as in
 * `~host.{build}.js`). */
function matchSegment(template: string, segment: string, params: Record<string, string>): boolean {
  if (!template.includes("{")) return template === segment;
  const names: string[] = [];
  const pattern = template
    .replace(/\{(\w+)\}/g, (_match, name: string) => {
      names.push(name);
      return " ";
    })
    .replace(/[.*+?^$()|[\]\\]/g, "\\$&")
    .replace(/ /g, "([^/]+)");
  const match = new RegExp(`^${pattern}$`).exec(segment);
  if (match === null) return false;
  names.forEach((name, index) => {
    const value = match[index + 1];
    if (value !== undefined) params[name] = value;
  });
  return true;
}

/** A path template against a path. A trailing `{rest}` matches the rest of the path, empty included. */
function matchPath(template: string, path: string): Record<string, string> | null {
  const parts = template.split("/").filter((part) => part !== "");
  const segments = path.split("/").filter((part) => part !== "");
  const params: Record<string, string> = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) return null;
    if (part === "{rest}") {
      params.rest = segments.slice(index).join("/");
      return params;
    }
    const segment = segments[index];
    if (segment === undefined || !matchSegment(part, segment, params)) return null;
  }
  return parts.length === segments.length ? params : null;
}

function matchRoute(route: Route, method: string, path: string): Record<string, string> | null {
  // A HEAD runs its GET row (SE14's headers included) — the entry then answers it with no body.
  const effective = method === "HEAD" ? "GET" : method;
  const methodOk = route.method === "WS" ? effective === "GET" : route.method === effective;
  if (!methodOk) return null;
  for (const template of route.paths) {
    const params = matchPath(template, path);
    if (params !== null) return params;
  }
  return null;
}

// ---- The role guards of 13.6 ----

const JSON_MEDIA = "application/json";
const BODY_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

/**
 * The guards a route's role imposes, in order: a mutating route in a deployment with no `OWNER_KEY`
 * answers 503 (SE1); a request with a body and a content type that is not `application/json` is
 * rejected with 415 before authentication (SE3); an owner route with no credential answers 401.
 * `null` lets the request through.
 */
function guard(route: Route, request: Request, env: Env): Response | null {
  if (route.role !== "anyone" && env.OWNER_KEY === undefined) return notConfigured();
  const contentType = request.headers.get("content-type");
  if (BODY_METHODS.has(request.method) && contentType !== null && !contentType.startsWith(JSON_MEDIA)) {
    return unsupportedMediaType();
  }
  if (route.role !== "owner") return null;
  // SE2/SE3: either credential proves the owner — the Bearer key or the signed `premise_owner`
  // cookie — but a cookie-authenticated mutating request must also name this origin in `Origin`.
  const credential = credentialKind(request, env);
  if (credential === "none") return unauthorized();
  if (BODY_METHODS.has(request.method) && !originOkFor(request, credential)) return forbidden();
  return null;
}

// ---- The default answer, while no lane has registered a handler ----

/** Where a route with no registered handler goes: the target its "answered by" names — a Durable
 * Object stub, the assets, or `not_built` for the Worker and the Swarm (a Workflow has no `fetch`). */
function dispatch(
  route: Route,
  request: Request,
  env: Env,
  params: Record<string, string>,
): Response | Promise<Response> {
  switch (route.answeredBy) {
    case "assets":
      return serveFloorAsset(request, env);
    case "floor":
      return env.FLOOR.get(env.FLOOR.idFromName(params.pool ?? "")).fetch(request);
    case "trunk":
      return env.TRUNK.get(env.TRUNK.idFromName(params.pool ?? "")).fetch(request);
    case "agent":
      return env.AGENT.get(env.AGENT.idFromName(params.attempt_id ?? "")).fetch(request);
    case "gate":
      return env.GATE.get(env.GATE.idFromName("premise")).fetch(request);
    default:
      return notBuilt();
  }
}

// ---- The Worker's entry ----

/** A scaffold probe: the Worker runs. It is not a route of 01-core 13.6. */
const HEALTH_PATH = "/api/health";

/** Paths that the API (01-core 13.6) and the app server (02-tidepool 4.2) answer. Never static files. */
function isWorkerPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/") || pathname === "/pool" || pathname.startsWith("/pool/");
}

function routeRequest(request: Request, env: Env): Response | Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === HEALTH_PATH && (request.method === "GET" || request.method === "HEAD")) {
    return Response.json({ ok: true });
  }
  for (const route of MATCH_ORDER) {
    const params = matchRoute(route, request.method, pathname);
    if (params === null) continue;
    const blocked = guard(route, request, env);
    if (blocked !== null) return blocked;
    // SE21: the stream handshake is counted per client address under PUBLIC_RATE_PER_MIN — the
    // session read's own limiter and its own 429 answer. (The page is counted where it is served,
    // in `serveFloorAsset`; the ninth-socket rule of `openSocket` is unchanged.)
    if (route.method === "WS" && publicReads.record(`stream:${clientAddress(request)}`) > PUBLIC_RATE_PER_MIN) {
      return Response.json({ error: { code: "rate_limited" } }, { status: 429 });
    }
    const handler = ROUTE_TABLE.handlers.get(routeKey(route));
    if (handler !== undefined) {
      return handler({ request, env, params, route });
    }
    return dispatch(route, request, env, params);
  }
  if (isWorkerPath(pathname)) return notFound();
  return serveFloorAsset(request, env);
}

export default {
  async fetch(request, env): Promise<Response> {
    const response = await answerUnhandled(() => routeRequest(request, env));
    // HEAD answers what GET answers: the same status and headers, and no body.
    return request.method === "HEAD" ? new Response(null, response) : response;
  },
} satisfies ExportedHandler<Env>;
