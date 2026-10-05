// `POST /api/pools/{pool}/rebuild` (13.6, RB1): the owner's RebuildRequest —
// `{ request_id }` (9.8 makes it the job's idempotency key) — forwarded to the pool's
// Trunk object, where the `rebuild` entry arms the resumable job's cursor and timer.
// The route's own work is the request's shape: a missing or non-string `request_id`
// is `invalid_args` before the object sees anything.

import type { RebuildRequest } from "../../protocol/routes.ts";
import type { RouteHandler } from "../index.ts";

const TRUNK_ORIGIN = "https://trunk.internal";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const rebuild: RouteHandler = async ({ request, env, params }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: { code: "bad_json" } }, { status: 400 });
  }
  const request_id = isRecord(body) ? body.request_id : undefined;
  if (typeof request_id !== "string" || request_id === "") {
    return Response.json({ error: { code: "invalid_args" } }, { status: 400 });
  }
  const pool = params.pool ?? "";
  const forward: RebuildRequest = { request_id };
  return env.TRUNK.get(env.TRUNK.idFromName(pool)).fetch(`${TRUNK_ORIGIN}/api/pools/${pool}/rebuild`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(forward),
  });
};
