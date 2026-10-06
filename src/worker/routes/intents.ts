// 13.6 / RC1: Trunk freezes every candidate before any Agent starts. Repeated
// request ids replay that launch; each Agent open is itself idempotent (9.8).

import { H } from "../../core/sync/h.ts";
import { MAX_INTENT_CHARS } from "../../protocol/constants.ts";
import { FEATURES } from "../../config/features.ts";
import { MODEL_PLAN } from "../../config/model-plan.ts";
import type { CreateIntentRequest, CreateIntentResponse } from "../../protocol/routes.ts";
import type {
  AgentOpenRequest,
  AgentOpenResponse,
  TrunkCreateIntentRequest,
  TrunkCreateIntentResponse,
} from "../../protocol/internal.ts";
import type { RouteHandler } from "../index.ts";

const AGENT_OPEN_URL = "https://agent.internal/open";

/** ULID's Crockford base32 alphabet, in order (same scheme as the swarm launcher). */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A deterministic request id (9.8). Additional candidates use separate hash domains,
 * so a request id containing a candidate suffix cannot alias another intent's attempt. */
function intentId(prefix: "i_" | "a_", requestId: string, candidate = 0): string {
  const domain = candidate === 0 ? "intents" : `intents-race-${candidate}`;
  let value = BigInt(`0x${H(`${domain}|${prefix}|${requestId}`)}`);
  let id = "";
  for (let i = 0; i < 26; i += 1) {
    id = B32[Number(value & 0x1fn)] + id;
    value >>= 5n;
  }
  return `${prefix}${id}`;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `POST /api/pools/{pool}/intents`: `{ text, race, prewritten, request_id }` →
 * `{ intent_id }`. The attempt's id is derived from `request_id`, so the
 * repeated call returns the first answer without opening anything new.
 * An ordinary attempt uses the workhorse; a race uses the ordered race models.
 * Model calls go through the gate inside each Agent object.
 */
export const createIntent: RouteHandler = async ({ request, env, params }) => {
  const pool = params.pool ?? "";
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: { code: "bad_json" } }, 400);
  }
  if (!isRecord(body)) return json({ error: { code: "invalid_args" } }, 400);
  const req = body as Partial<CreateIntentRequest>;
  if (
    typeof req.text !== "string" ||
    req.text === "" ||
    req.text.length > MAX_INTENT_CHARS ||
    typeof req.race !== "boolean" ||
    typeof req.prewritten !== "boolean" ||
    typeof req.request_id !== "string" ||
    req.request_id === ""
  ) {
    return json({ error: { code: "invalid_args" } }, 400);
  }
  // FJ1: a disabled race changes nothing.
  if (req.race && !FEATURES.race) return json({ error: { code: "feature_off" } }, 404);

  const requestId = req.request_id;
  const intent_id = intentId("i_", requestId);
  const models = req.race ? MODEL_PLAN.race : [MODEL_PLAN.workhorse];
  const launch: TrunkCreateIntentRequest = {
    text: req.text,
    race: req.race,
    prewritten: req.prewritten,
    request_id: req.request_id,
    intent_id,
    candidates: models.map((model, index) => ({
      // Preserve the existing single-attempt id for the first candidate.
      attempt_id: intentId("a_", requestId, index),
      model,
    })),
  };
  let trunkAnswer: TrunkCreateIntentResponse;
  try {
    const response = await env.TRUNK.get(env.TRUNK.idFromName(pool)).fetch(
      "https://trunk.internal/internal/open-intent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(launch),
      },
    );
    if (!response.ok) return json({ error: { code: "trunk_open_failed" } }, 502);
    trunkAnswer = (await response.json()) as TrunkCreateIntentResponse;
  } catch {
    return json({ error: { code: "trunk_open_failed" } }, 502);
  }
  if (!trunkAnswer.ok) {
    return json({ error: { code: "trunk_open_failed", detail: trunkAnswer.error } }, 502);
  }

  for (const candidate of trunkAnswer.launches) {
    const open: AgentOpenRequest = {
      ...candidate,
      ...(trunkAnswer.imported !== undefined ? { imported: trunkAnswer.imported } : {}),
    };
    let answer: AgentOpenResponse;
    try {
      const response = await env.AGENT.get(env.AGENT.idFromName(open.attempt_id)).fetch(AGENT_OPEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(open),
      });
      if (!response.ok) return json({ error: { code: "agent_open_failed" } }, 502);
      answer = (await response.json()) as AgentOpenResponse;
    } catch {
      return json({ error: { code: "agent_open_failed" } }, 502);
    }
    if (!answer.ok) {
      return json({ error: { code: "agent_open_failed", detail: answer.error } }, 502);
    }
  }
  const response: CreateIntentResponse = { intent_id: trunkAnswer.intent_id };
  return json(response);
};
