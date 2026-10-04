// The owner's per-attempt stop route of 13.6: `POST /api/pools/{pool}/attempts/
// {attempt_id}/stop` (owner role, applied by the seam's dispatch). The Agent
// Durable Object named by `attempt_id` receives `/stop`; inside, the pending
// `cancelled` reason makes the pump call Trunk's `stop` (TA9a), and a repeated
// call on a stopped attempt changes nothing (TA9).

import type { RouteHandler } from "../index.ts";

const AGENT_ORIGIN = "https://agent.internal";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** `POST /api/pools/{pool}/attempts/{attempt_id}/stop` (`StopAttemptRequest`). */
export const stopAttempt: RouteHandler = async ({ env, params }) => {
  const attempt_id = params.attempt_id ?? "";
  if (attempt_id === "") return json({ error: { code: "invalid_args" } }, 400);
  try {
    const response = await env.AGENT.get(env.AGENT.idFromName(attempt_id)).fetch(`${AGENT_ORIGIN}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attempt_id }),
    });
    if (!response.ok) return json(await response.json().catch(() => ({ error: { code: "agent_error" } })), response.status);
  } catch {
    return json({ error: { code: "agent_error" } }, 502);
  }
  return json({ ok: true });
};
