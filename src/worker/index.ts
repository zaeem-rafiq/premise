// The Worker entry (Slice 0a, the toolchain scaffold).
//
// This file becomes the routes seam of the build plan (docs/spec/04-build-plan.md 3.2) when the `protocol`
// module exists. Until then it answers one probe and fails closed on everything that is not built.

import type { Env } from "./env.ts";
import { notBuilt } from "./not-built.ts";

// The classes that wrangler.jsonc names. Wrangler finds them as exports of this module.
export { Trunk } from "./trunk/trunk-do.ts";
export { Agent } from "./agent/agent-do.ts";
export { Floor } from "./floor/floor-do.ts";
export { ModelGate } from "./gate/gate-do.ts";
export { SwarmWorkflow } from "./workflows/swarm.ts";
export { GreenLineWorkflow } from "./workflows/green-line.ts";
export { AttemptRepoWorkflow } from "./workflows/attempt-repo.ts";

/** A scaffold probe: the Worker runs. It is not a route of 01-core 13.6. */
const HEALTH_PATH = "/api/health";

/** Paths that the API (01-core 13.6) and the app server (02-tidepool 4.2) answer. Never static files. */
function isWorkerPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/") || pathname === "/pool" || pathname.startsWith("/pool/");
}

export default {
  fetch(request, env): Response | Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === HEALTH_PATH && request.method === "GET") {
      return Response.json({ ok: true });
    }
    if (isWorkerPath(pathname)) {
      return notBuilt();
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
