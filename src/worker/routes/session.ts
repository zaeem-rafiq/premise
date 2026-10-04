// The session routes of 13.6 (01-core): the unlock of SE2 and its brake of SE2a, the session read,
// and the end of a session. The Worker applies the route's role first (index.ts): `GET` is `anyone`,
// `POST` is `key` (only the `OWNER_KEY` guard applies — the key itself is compared here, inside the
// brake of SE2a), `DELETE` is `owner`.
//
// The answers keep the fixed codes of the rest of the Worker (SE5b): `unauthorized`, `rate_limited`,
// `bad_json`.

import { PUBLIC_RATE_PER_MIN } from "../../protocol/constants.ts";
import type { SessionResponse } from "../../protocol/routes.ts";
import { notConfigured, unauthorized } from "../not-built.ts";
import type { RouteHandler } from "../index.ts";
import type { Env } from "../env.ts";
import { timingSafeEqual } from "../security/owner.ts";
import { clearSessionCookie, credentialKind, mintSessionCookie } from "../security/session.ts";
import { clientAddress, publicReads, unlockBraked, unlockFails } from "../security/rate-limit.ts";

function json(body: unknown, status = 200, headers?: Headers): Response {
  return Response.json(body, { status, headers });
}

/** `GET /api/session` (anyone): `{ owner }` for the credential the request carries — Bearer key or a
 * valid `premise_owner` cookie (SE2). Counted under `PUBLIC_RATE_PER_MIN` per address (SE21). */
export const sessionGet: RouteHandler = ({ request, env }) => {
  if (publicReads.record(clientAddress(request)) > PUBLIC_RATE_PER_MIN) {
    return json({ error: { code: "rate_limited" } }, 429);
  }
  const response: SessionResponse = { owner: credentialKind(request, env) !== "none" };
  return json(response);
};

/**
 * `POST /api/session` `{ key }` (SE2): the unlock. The brake of SE2a runs before the key is compared:
 * an address that already failed `UNLOCK_FAILS_PER_MIN` times this minute answers 429, right key
 * included. A wrong key records a failure and answers 401; the right key answers `{ owner: true }`
 * and sets the HMAC-signed `premise_owner` cookie. A success never resets the count.
 */
export const sessionPost: RouteHandler = async ({ request, env }) => {
  const key = env.OWNER_KEY;
  if (key === undefined) return notConfigured();
  const address = clientAddress(request);
  if (unlockBraked(address)) return json({ error: { code: "rate_limited" } }, 429);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: { code: "bad_json" } }, 400);
  }
  const offered = typeof body === "object" && body !== null ? (body as { key?: unknown }).key : undefined;
  if (typeof offered !== "string" || !timingSafeEqual(offered, key)) {
    unlockFails.record(address);
    return unauthorized();
  }

  const headers = new Headers({ "content-type": "application/json" });
  headers.append("set-cookie", mintSessionCookie(env));
  const response: SessionResponse = { owner: true };
  return json(response, 200, headers);
};

/** `DELETE /api/session` (owner): ends the session — the cookie is cleared. The Bearer credential the
 * guard required is unaffected (the key itself cannot expire). */
export const sessionDelete: RouteHandler = () => {
  const headers = new Headers({ "content-type": "application/json" });
  headers.append("set-cookie", clearSessionCookie());
  const response: SessionResponse = { owner: false };
  return json(response, 200, headers);
};
