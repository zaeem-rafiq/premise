// The trunk lane's wiring module for the routes seam (04-build-plan 3.2). A line registers a route
// of `protocol/routes.ts`; the lane edits this file, never `../index.ts`.
//
// Slice 1 (track 1D): the session routes (SE2, SE2a) and the pool routes the Worker answers (PL1,
// SE5c). The owner routes `intents`, `cards`, `undo*`, `rebuild` stay unregistered so the Worker's
// dispatch hands them to the Trunk Durable Object, whose shell answers from the engine table.

import { ROUTES } from "../../protocol/routes.ts";
import { routeKey, type RouteTable } from "../index.ts";
import { createPool, readToken } from "./pools.ts";
import { sessionDelete, sessionGet, sessionPost } from "./session.ts";

/** The seam key of the `ROUTES` row for `method`+`path`: keyed on the row, not a retyped string. */
function key(method: string, path: string): string {
  const route = ROUTES.find((row) => row.method === method && row.paths.includes(path));
  if (route === undefined) throw new Error(`route ${method} ${path} is not in protocol/routes.ts`);
  return routeKey(route);
}

export function wire(table: RouteTable): void {
  table.handlers.set(key("GET", "/api/session"), sessionGet);
  table.handlers.set(key("POST", "/api/session"), sessionPost);
  table.handlers.set(key("DELETE", "/api/session"), sessionDelete);
  table.handlers.set(key("POST", "/api/pools"), createPool);
  table.handlers.set(key("POST", "/api/pools/{pool}/read-token"), readToken);
}
