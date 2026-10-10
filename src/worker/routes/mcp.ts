// Outside agents over MCP (docs/spec/07-mcp.md): the token route of MC5 and the MCP endpoint of MC1
// to MC23. The endpoint is Streamable HTTP answered with plain JSON — one JSON-RPC message per POST,
// no event stream — and keeps no state of its own: the token and the session id are signed with
// OWNER_KEY (src/worker/mcp/credentials.ts), the attempt id comes from the session id (MC11), and
// everything about the attempt lives in its Agent. Nothing here logs a request or a header (MC8).

import { FEATURES } from "../../config/features.ts";
import { GUIDE_PATH } from "../../protocol/agent-prompt.ts";
import { MAX_INTENT_CHARS } from "../../protocol/constants.ts";
import { FEATURE_OFF } from "../../protocol/routes.ts";
import { redact } from "../../protocol/redact.ts";
import { TOOL_NAMES, type ModelToolMessage } from "../../protocol/tools.ts";
import type { ImportedPrompt, TrunkOpenAttemptRequest, TrunkOpenAttemptResponse } from "../../protocol/internal.ts";
import { renderToolMessage } from "../../core/agent/loop/index.ts";
import type { GateClaimResponse } from "../../core/gate/index.ts";
import type { Env } from "../env.ts";
import type { RouteHandler } from "../index.ts";
import { clientName, mintSession, mintToken, sessionIds, verifySession, verifyToken } from "../mcp/credentials.ts";
import type { McpSession, McpToken } from "../mcp/credentials.ts";
import { OUTSIDE_PATHS, type OutsideAnswer } from "../mcp/outside.ts";
import { BAD_REQUEST, MCP_INSTRUCTIONS, MCP_TOOL_LIST, TEXTS, startNext, type McpTexts } from "../mcp/texts.ts";
import { POOL_NAME } from "./pools.ts";

/** MC3: the protocol revisions whose subset this endpoint speaks; the second is the default. */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "premise", version: "07-mcp/1" };

const AGENT_ORIGIN = "https://agent.internal";
const NO_STORE = { "cache-control": "no-store" };

type RpcId = string | number;
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

function featureOff(): Response {
  return json({ error: { code: FEATURE_OFF } }, 404);
}

function rpcResult(id: RpcId, result: unknown, headers: Record<string, string> = {}): Response {
  return json({ jsonrpc: "2.0", id, result }, 200, headers);
}

function rpcError(
  status: number,
  id: RpcId | null,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return json({ jsonrpc: "2.0", id, error: { code, message } }, status, headers);
}

/** MC16: a message as the one text item of a tool result. */
function toolResult(message: ModelToolMessage): ToolResult {
  return { content: [{ type: "text", text: renderToolMessage(message) }], isError: message.error !== undefined };
}

/** MC16: a text of `mcp-texts` answered as an error message under its own key. */
function textResult(key: keyof Omit<McpTexts, "status_next">, text: string = TEXTS[key]): ToolResult {
  return toolResult({ error: { code: key, message: text } });
}

/** The Agent's answer as a tool result: a message, MC18's interrupted pair, or a text. */
function answerResult(answer: OutsideAnswer): ToolResult {
  if (answer.kind === "message") return toolResult(answer.message);
  if (answer.kind === "interrupted") {
    return {
      content: [
        { type: "text", text: TEXTS.interrupted },
        { type: "text", text: renderToolMessage(answer.message) },
      ],
      isError: true,
    };
  }
  return textResult(answer.key);
}

function agentOf(env: Env, attemptId: string): DurableObjectStub {
  return env.AGENT.get(env.AGENT.idFromName(attemptId));
}

async function postJson(stub: DurableObjectStub, origin: string, path: string, body: unknown): Promise<Response> {
  return stub.fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function gate(env: Env): DurableObjectStub {
  return env.GATE.get(env.GATE.idFromName("premise"));
}

/** MC22: the kill switch, failing closed — a gate that cannot be asked counts as switched off. */
async function killed(env: Env): Promise<boolean> {
  try {
    const response = await gate(env).fetch("https://gate.internal/killed");
    if (!response.ok) return true;
    return ((await response.json()) as { killed?: unknown }).killed !== false;
  } catch {
    return true;
  }
}

// ---- MC5: minting a token ----

/** `POST /api/pools/{pool}/mcp-tokens` (owner): `{ token, expires_at, path }`, answered once. */
export const mintMcpToken: RouteHandler = async ({ env, params }) => {
  if (!FEATURES.mcp) return featureOff();
  const pool = params.pool ?? "";
  if (!POOL_NAME.test(pool)) return json({ error: { code: "invalid_args" } }, 400);
  let exists: boolean;
  try {
    const response = await env.TRUNK.get(env.TRUNK.idFromName(pool)).fetch("https://trunk.internal/internal/state");
    exists = response.ok && ((await response.json()) as { meta?: { pool_id?: unknown } }).meta?.pool_id === pool;
  } catch {
    return json({ error: { code: "trunk_unavailable" } }, 502);
  }
  if (!exists) return json({ error: { code: "pool_not_found" } }, 404);
  const { token, expires_at } = mintToken(env.OWNER_KEY ?? "", pool);
  return json({ token, expires_at, path: `/mcp/${pool}` });
};

// ---- MC1: the methods the endpoint does not take ----

/** `GET` and `DELETE /mcp/{pool}`: no event stream, no session to delete (MC1). */
export const mcpNotAllowed: RouteHandler = () => {
  if (!FEATURES.mcp) return featureOff();
  return new Response(null, { status: 405, headers: { ...NO_STORE, allow: "POST" } });
};

// ---- MC1 to MC23: the endpoint ----

export const mcpPost: RouteHandler = async ({ request, env, params }) => {
  if (!FEATURES.mcp) return featureOff();
  const pool = params.pool ?? "";
  const key = env.OWNER_KEY ?? "";
  const token = verifyToken(env.OWNER_KEY, request.headers.get("authorization"), pool);
  if (token === null) {
    return rpcError(401, null, -32001, "unauthorized", { "www-authenticate": "Bearer" });
  }
  const sessionHeader = request.headers.get("mcp-session-id");
  const session = sessionHeader === null ? null : verifySession(key, sessionHeader, token);

  if (await killed(env)) {
    if (session !== null) {
      // MC22: the session's attempt stops with `killed`. Best effort: the watchdog stops it anyway.
      await postJson(agentOf(env, sessionIds(session.id).attempt_id), AGENT_ORIGIN, OUTSIDE_PATHS.kill, {}).catch(
        () => undefined,
      );
    }
    return rpcError(503, null, -32002, TEXTS.killed);
  }

  let message: unknown;
  try {
    message = JSON.parse(await request.text());
  } catch {
    return rpcError(400, null, -32700, "parse error");
  }
  if (Array.isArray(message)) return rpcError(400, null, -32600, "batches are not supported");
  if (!isRecord(message) || message.jsonrpc !== "2.0") return rpcError(400, null, -32600, "invalid request");
  // MC2: a notification or a response is accepted with no body.
  if (typeof message.method !== "string" || message.id === undefined) return new Response(null, { status: 202 });
  const id = message.id;
  if (typeof id !== "string" && typeof id !== "number") return rpcError(400, null, -32600, "invalid id");
  const params_ = isRecord(message.params) ? message.params : {};

  if (message.method === "initialize") return initialize(key, token, id, params_);
  if (sessionHeader === null) return rpcError(400, id, -32600, "Mcp-Session-Id is required");
  if (session === null) return rpcError(404, id, -32001, "session not found");

  switch (message.method) {
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: MCP_TOOL_LIST });
    case "tools/call":
      return callTool(env, session, id, params_);
    default:
      return rpcError(200, id, -32601, "method not found");
  }
};

/** MC9: the answer, and a new session id for this token and client. */
function initialize(key: string, token: McpToken, id: RpcId, params: Record<string, unknown>): Response {
  const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
  const protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : DEFAULT_PROTOCOL_VERSION;
  const client = clientName(isRecord(params.clientInfo) ? params.clientInfo.name : undefined);
  return rpcResult(
    id,
    {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: MCP_INSTRUCTIONS,
    },
    { "mcp-session-id": mintSession(key, token, client) },
  );
}

const SEVEN = new Set<string>(TOOL_NAMES);

/** `tools/call` (MC13 to MC19). */
async function callTool(env: Env, session: McpSession, id: RpcId, params: Record<string, unknown>): Promise<Response> {
  const name = params.name;
  if (typeof name !== "string" || (name !== "premise_start" && name !== "premise_status" && !SEVEN.has(name))) {
    return rpcError(200, id, -32602, `unknown tool: ${typeof name === "string" ? name.slice(0, 64) : ""}`);
  }
  if (params.arguments !== undefined && !isRecord(params.arguments)) {
    return rpcError(200, id, -32602, "arguments must be an object");
  }
  const args = isRecord(params.arguments) ? params.arguments : {};
  const { attempt_id } = sessionIds(session.id);
  if (name === "premise_start") return rpcResult(id, await start(env, session, args));

  const agent = agentOf(env, attempt_id);
  const response =
    name === "premise_status"
      ? await postJson(agent, AGENT_ORIGIN, OUTSIDE_PATHS.status, { wait: args.wait === true })
      : await postJson(agent, AGENT_ORIGIN, OUTSIDE_PATHS.call, { tool: name, args });
  const body = (await response.json()) as { ok?: boolean; answer?: OutsideAnswer };
  if (body.ok !== true || body.answer === undefined) return rpcResult(id, textResult("not_started"));
  return rpcResult(id, answerResult(body.answer));
}

/** MC14: `premise_start`. */
async function start(env: Env, session: McpSession, args: Record<string, unknown>): Promise<ToolResult> {
  const text = args.request;
  if (typeof text !== "string" || text.trim() === "" || text.length > MAX_INTENT_CHARS) {
    return textResult("bad_request", BAD_REQUEST);
  }
  const { attempt_id, intent_id } = sessionIds(session.id);
  const agent = agentOf(env, attempt_id);
  // MC8: a request text is written to events as the intent's text, so it is redacted first (AG7).
  const intent = redact(text, env.OWNER_KEY === undefined ? [] : [env.OWNER_KEY]);

  // Step 1: the session's attempt exists already.
  const existing = (await (await postJson(agent, AGENT_ORIGIN, OUTSIDE_PATHS.status, { wait: false })).json()) as {
    ok?: boolean;
    answer?: OutsideAnswer;
  };
  if (existing.ok === true && existing.answer?.kind === "message") {
    const message = existing.answer.message;
    return toolResult({ ...message, result: { ...(message.result ?? {}), attempt_id, next: TEXTS.already } });
  }

  // Step 2: the agent slot (MC20).
  const pool = session.pool;
  let claimed: GateClaimResponse;
  try {
    const response = await postJson(gate(env), "https://gate.internal", "/internal/claim", { attempt_id, pool });
    if (!response.ok) return textResult("busy");
    claimed = (await response.json()) as GateClaimResponse;
  } catch {
    return textResult("busy");
  }
  if (!claimed.ok) return "refused" in claimed ? textResult("killed") : textResult("busy");
  const release = () =>
    postJson(gate(env), "https://gate.internal", "/internal/release", { attempt_id }).catch(() => undefined);

  // Step 3: the attempt in Trunk (MC12).
  const model = `mcp/${session.client}`;
  const open: TrunkOpenAttemptRequest = {
    attempt_id,
    intent_id,
    intent,
    agent_kind: "real",
    model,
    race: false,
    requester: "owner",
  };
  let opened: TrunkOpenAttemptResponse;
  try {
    const response = await postJson(
      env.TRUNK.get(env.TRUNK.idFromName(pool)),
      "https://trunk.internal",
      "/internal/open-attempt",
      open,
    );
    opened = (await response.json()) as TrunkOpenAttemptResponse;
  } catch {
    await release();
    return textResult("start_failed");
  }
  if (!opened.ok) {
    await release();
    return textResult(opened.error === "pool_not_ready" ? "pool_not_ready" : "start_failed");
  }

  // Step 4: the Agent, with the outside driver.
  const imported: ImportedPrompt | undefined = opened.imported;
  try {
    const response = await postJson(agent, AGENT_ORIGIN, "/open", {
      attempt_id,
      intent_id: opened.intent_id,
      change_id: opened.change_id,
      pool,
      intent_text: intent,
      requester: "owner",
      agent_kind: "real",
      driver: "outside",
      model,
      ...(imported !== undefined ? { imported } : {}),
    });
    if (!response.ok || ((await response.json()) as { ok?: boolean }).ok !== true) throw new Error("open");
  } catch {
    await release();
    return textResult("start_failed");
  }

  // Step 5: the answer.
  const guide = imported === undefined ? GUIDE_PATH : imported.guide_path === "" ? null : imported.guide_path;
  return toolResult({ result: { attempt_id, state: "opened", guide, next: startNext(guide) } });
}
