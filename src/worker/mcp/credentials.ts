// The MCP token and the MCP session id (docs/spec/07-mcp.md MC6, MC7, MC9 to MC11). Both are signed
// with `OWNER_KEY` like the owner session of src/worker/security/session.ts, so nothing is stored:
// rotating the key revokes every token and every session at once. The HMAC runs on `node:crypto`
// (the deployment has `nodejs_compat`), synchronously.

import { createHmac, timingSafeEqual } from "node:crypto";
import { H } from "../../core/sync/h.ts";
import { MCP_CLIENT_NAME_CHARS, MCP_TOKEN_TTL_S } from "./constants.ts";

const TOKEN_PREFIX = "pmcp1_";
const SESSION_PREFIX = "ms1_";
const TOKEN_DOMAIN = "premise_mcp_token.v1.";
const SESSION_DOMAIN = "premise_mcp_session.v1.";
const BODY = /^[A-Za-z0-9_-]+$/;
const SIG = /^[0-9a-f]{64}$/;

/** What a verified token says (MC6). */
export type McpToken = { pool: string; expires_s: number; nonce: string };

/** What a verified session id says (MC9). */
export type McpSession = { id: string; pool: string; token_nonce: string; client: string };

function sign(key: string, domain: string, body: string): string {
  return createHmac("sha256", key).update(`${domain}${body}`).digest("hex");
}

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** `<prefix><body>.<sig>` with a valid signature: the body's JSON object, or null. */
function opened(key: string, prefix: string, domain: string, value: string): Record<string, unknown> | null {
  if (!value.startsWith(prefix)) return null;
  const [body, sig, ...rest] = value.slice(prefix.length).split(".");
  if (rest.length > 0 || body === undefined || sig === undefined || !BODY.test(body) || !SIG.test(sig)) return null;
  if (!sameHex(sig, sign(key, domain, body))) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** MC5/MC6: a new token for `pool`, expiring `MCP_TOKEN_TTL_S` from `now`. */
export function mintToken(key: string, pool: string, now = Date.now()): { token: string; expires_at: number } {
  const expires_s = Math.floor(now / 1000) + MCP_TOKEN_TTL_S;
  const body = encode({ p: pool, e: expires_s, n: randomHex(16) });
  return { token: `${TOKEN_PREFIX}${body}.${sign(key, TOKEN_DOMAIN, body)}`, expires_at: expires_s * 1000 };
}

/** MC7: the token of `Authorization: Bearer <token>` for `pool`, or null for every refusal. */
export function verifyToken(
  key: string | undefined,
  authorization: string | null,
  pool: string,
  now = Date.now(),
): McpToken | null {
  if (key === undefined || key === "" || authorization === null || !authorization.startsWith("Bearer ")) return null;
  const body = opened(key, TOKEN_PREFIX, TOKEN_DOMAIN, authorization.slice("Bearer ".length));
  if (body === null) return null;
  const { p, e, n } = body;
  if (typeof p !== "string" || typeof e !== "number" || typeof n !== "string") return null;
  if (p !== pool || !Number.isSafeInteger(e) || e * 1000 <= now) return null;
  return { pool: p, expires_s: e, nonce: n };
}

/** MC9: the client name — characters outside `A-Z a-z 0-9 . _ -` become `-`, at most
 * `MCP_CLIENT_NAME_CHARS`, `mcp-client` when nothing is left. */
export function clientName(raw: unknown): string {
  const name = (typeof raw === "string" ? raw : "").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, MCP_CLIENT_NAME_CHARS);
  return name === "" ? "mcp-client" : name;
}

/** MC9: a new session id for a verified token. */
export function mintSession(key: string, token: McpToken, client: string): string {
  const body = encode({ p: token.pool, t: token.nonce, c: client, n: randomHex(16) });
  return `${SESSION_PREFIX}${body}.${sign(key, SESSION_DOMAIN, body)}`;
}

/** MC10: the session the header names, when it verifies and belongs to this pool and token. */
export function verifySession(key: string, header: string, token: McpToken): McpSession | null {
  const body = opened(key, SESSION_PREFIX, SESSION_DOMAIN, header);
  if (body === null) return null;
  const { p, t, c } = body;
  if (typeof p !== "string" || typeof t !== "string" || typeof c !== "string") return null;
  if (p !== token.pool || t !== token.nonce) return null;
  return { id: header, pool: p, token_nonce: t, client: c };
}

/** ULID's Crockford base32 alphabet, in order (the intents route's ids). */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function idOf(prefix: "a_" | "i_", seed: string): string {
  let value = BigInt(`0x${H(seed)}`);
  let id = "";
  for (let i = 0; i < 26; i += 1) {
    id = B32[Number(value & 0x1fn)] + id;
    value >>= 5n;
  }
  return `${prefix}${id}`;
}

/** MC11: the one attempt (and intent) a session can have. */
export function sessionIds(sessionId: string): { attempt_id: string; intent_id: string } {
  return { attempt_id: idOf("a_", `mcp|attempt|${sessionId}`), intent_id: idOf("i_", `mcp|intent|${sessionId}`) };
}
