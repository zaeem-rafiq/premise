// The owner's typed-intent route of 13.6 (Slice 4): `POST /api/pools/{pool}/intents`
// takes a `CreateIntentRequest` and launches a real agent — the attempt opens at
// Trunk as `agent_kind: "real"` on the model plan's workhorse, then the Agent
// Durable Object named by the attempt id is opened with the `model` driver.
//
// Ids derive from `request_id`: a repeated request names the same attempt, whose
// `open_attempt` at Trunk and `/open` at the Agent are both idempotent, so the
// retry returns the first answer and launches nothing (9.8). `race` is a SHOULD
// feature that stays off in this slice — such a request is `feature_off` (FJ1).

import { H } from "../../core/sync/h.ts";
import { MAX_INTENT_CHARS } from "../../protocol/constants.ts";
import { FEATURES } from "../../config/features.ts";
import { WORKHORSE_MODEL } from "../../config/model-plan.ts";
import type { CreateIntentRequest, CreateIntentResponse } from "../../protocol/routes.ts";
import type {
  AgentOpenRequest,
  AgentOpenResponse,
  TrunkOpenAttemptRequest,
  TrunkOpenAttemptResponse,
} from "../../protocol/internal.ts";
import type { RouteHandler } from "../index.ts";

const TRUNK_OPEN_ATTEMPT_URL = "https://trunk.internal/internal/open-attempt";
const AGENT_OPEN_URL = "https://agent.internal/open";
const REQUESTER = "owner";

/** ULID's Crockford base32 alphabet, in order (same scheme as the swarm launcher). */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A deterministic `i_`/`a_` id for a request: the 128 bits of
 * `H("intents|<prefix>|<request_id>")` base32-encoded (9.8). */
function intentId(prefix: "i_" | "a_", requestId: string): string {
  let value = BigInt(`0x${H(`intents|${prefix}|${requestId}`)}`);
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
 * A real attempt rides the model plan's workhorse; the model calls themselves
 * go through the gate inside the Agent object.
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
  // FJ1: race is a SHOULD feature, off in this build.
  if (req.race && !FEATURES.race) return json({ error: { code: "feature_off" } }, 404);

  const attempt_id = intentId("a_", req.request_id);
  const intent_id = intentId("i_", req.request_id);

  // 9.2 T1: the attempt opens at Trunk first — `intent.created` and
  // `attempt.opened` precede everything the agent does.
  const openAttempt: TrunkOpenAttemptRequest = {
    attempt_id,
    intent_id,
    intent: req.text,
    agent_kind: "real",
    model: WORKHORSE_MODEL,
    race: req.race,
    requester: REQUESTER,
  };
  let trunkAnswer: TrunkOpenAttemptResponse;
  try {
    const response = await env.TRUNK.get(env.TRUNK.idFromName(pool)).fetch(TRUNK_OPEN_ATTEMPT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(openAttempt),
    });
    trunkAnswer = (await response.json()) as TrunkOpenAttemptResponse;
  } catch {
    return json({ error: { code: "trunk_open_failed" } }, 502);
  }
  if (!trunkAnswer.ok) {
    return json({ error: { code: "trunk_open_failed", detail: trunkAnswer.error } }, 502);
  }

  const open: AgentOpenRequest = {
    pool,
    attempt_id,
    intent_id,
    change_id: trunkAnswer.change_id,
    intent_text: req.text,
    requester: REQUESTER,
    agent_kind: "real",
    driver: "model",
    model: WORKHORSE_MODEL,
  };
  let answer: AgentOpenResponse;
  try {
    const response = await env.AGENT.get(env.AGENT.idFromName(attempt_id)).fetch(AGENT_OPEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(open),
    });
    answer = (await response.json()) as AgentOpenResponse;
  } catch {
    return json({ error: { code: "agent_open_failed" } }, 502);
  }
  if (!answer.ok) {
    return json({ error: { code: "agent_open_failed", detail: answer.error } }, 502);
  }
  const response: CreateIntentResponse = { intent_id };
  return json(response);
};
