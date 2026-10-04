// `POST /api/kill` (SE10-SE12, owner): validates the `KillRequest` body and hands it to the model
// gate's `POST /internal/kill`. The kill state itself lives in the gate's Durable Object — this
// route only forwards; the owner credential check already ran in the Worker's route guard (13.6).

import type { RouteHandler } from "../index.ts";
import type { KillRequest } from "../../protocol/routes.ts";

const GATE_KILL_URL = "https://gate.internal/internal/kill";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export const kill: RouteHandler = async ({ request, env }) => {
  const gate = env.GATE as DurableObjectNamespace | undefined;
  if (gate === undefined) return json({ error: { code: "not_configured" } }, 503);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: { code: "bad_json" } }, 400);
  }
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as KillRequest).killed !== "boolean" ||
    ((body as KillRequest).landings !== undefined && typeof (body as KillRequest).landings !== "boolean")
  ) {
    return json({ error: { code: "invalid_args" } }, 400);
  }
  const response = await gate.get(gate.idFromName("premise")).fetch(GATE_KILL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ killed: (body as KillRequest).killed, landings: (body as KillRequest).landings }),
  });
  return json(await response.json().catch(() => ({ error: { code: "internal_error" } })), response.status);
};
