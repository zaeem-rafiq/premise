// The stream lane's wiring module for the routes seam (04-build-plan 3.2). A line registers a route
// of `protocol/routes.ts`; the lane edits this file, never `../index.ts`.
//
// The Floor's three routes of 13.6 — the stream socket, the landing note and the Replay export —
// all name `floor` in "Answered by", so the seam's default dispatch already forwards them to the
// Floor Durable Object of `{pool}` with the pool name as the object id. Nothing is registered here.

import type { RouteTable } from "../index.ts";

export function wire(_table: RouteTable): void {
  // Empty: the default dispatch of `../index.ts` forwards the Floor's routes to the object.
}
