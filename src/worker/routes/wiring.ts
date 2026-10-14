// The trunk lane's wiring module for the routes seam (04-build-plan 3.2). A line registers a route
// of `protocol/routes.ts`; the lane edits this file, never `../index.ts`.
//
// Slice 1 (track 1D): the session routes (SE2, SE2a) and the pool routes the Worker answers (PL1,
// SE5c). Undo routes validate the owner request and forward it to the engine table.

import { MCP_ROUTES, ROUTES, TRY_ROUTES } from "../../protocol/routes.ts";
import { routeKey, type RouteTable } from "../index.ts";
import { createPool, readToken } from "./pools.ts";
import { sessionDelete, sessionGet, sessionPost } from "./session.ts";
import { kill } from "./kill.ts";
import { createIntent } from "./intents.ts";
import { stopAttempt } from "./stop.ts";
import { handleCard } from "./cards.ts";
import { rebuild } from "./rebuild.ts";
import { undo, undoPlan } from "./undo.ts";
import { mcpNotAllowed, mcpPost, mintMcpToken } from "./mcp.ts";
import { handleTry } from "./try.ts";

/** The seam key of the `ROUTES` row for `method`+`path`: keyed on the row, not a retyped string. */
function key(method: string, path: string): string {
  const route = [...ROUTES, ...MCP_ROUTES, ...TRY_ROUTES].find(
    (row) => row.method === method && row.paths.includes(path),
  );
  if (route === undefined) throw new Error(`route ${method} ${path} is not in protocol/routes.ts`);
  return routeKey(route);
}

export function wire(table: RouteTable): void {
  table.handlers.set(key("GET", "/api/session"), sessionGet);
  table.handlers.set(key("POST", "/api/session"), sessionPost);
  table.handlers.set(key("DELETE", "/api/session"), sessionDelete);
  table.handlers.set(key("POST", "/api/kill"), kill);
  table.handlers.set(key("POST", "/api/pools"), createPool);
  table.handlers.set(key("POST", "/api/pools/{pool}/read-token"), readToken);
  table.handlers.set(key("POST", "/api/pools/{pool}/intents"), createIntent);
  table.handlers.set(key("POST", "/api/pools/{pool}/attempts/{attempt_id}/stop"), stopAttempt);
  table.handlers.set(key("POST", "/api/pools/{pool}/cards/{card_id}"), handleCard);
  table.handlers.set(key("POST", "/api/pools/{pool}/rebuild"), rebuild);
  table.handlers.set(key("GET", "/api/pools/{pool}/undo-plan"), undoPlan);
  table.handlers.set(key("POST", "/api/pools/{pool}/undo"), undo);
  // 07-mcp: outside agents over MCP (each handler answers feature_off while `features.mcp` is false).
  table.handlers.set(key("POST", "/api/pools/{pool}/mcp-tokens"), mintMcpToken);
  table.handlers.set(key("POST", "/mcp/{pool}"), mcpPost);
  table.handlers.set(key("GET", "/mcp/{pool}"), mcpNotAllowed);
  table.handlers.set(key("DELETE", "/mcp/{pool}"), mcpNotAllowed);
  // 09-try TY2: a visitor's try (answers feature_off while `features.try` is false).
  table.handlers.set(key("POST", "/api/try"), handleTry);
}
