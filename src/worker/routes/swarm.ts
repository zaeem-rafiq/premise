// The swarm lane's wiring module for the routes seam (04-build-plan 3.2). A line registers a route
// of `protocol/routes.ts`; the lane edits this file, never `../index.ts`.

import type { RouteTable } from "../index.ts";

export function wire(_table: RouteTable): void {
  // Empty while the swarm lane's slice is not built (Slice 0). The lane registers its routes here.
}
