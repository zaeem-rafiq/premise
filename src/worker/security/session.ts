// The `premise_owner` session cookie of SE2 (01-core 13.2): `POST /api/session` with the key mints it;
// owner routes then accept it next to the Bearer key. The value is `v1.<expiry unix s>.<hmac>` with
// the hmac computed over `premise_owner.v1.<expiry>` keyed by OWNER_KEY, so a cookie this Worker never
// minted — or one edited — is no credential.
//
// The HMAC uses `node:crypto` (the deployment runs with `nodejs_compat`) so the check can be
// synchronous: the Worker's `hasOwnerCredential` guard of src/worker/index.ts can call
// `credentialKind` without becoming async.

import { createHmac, timingSafeEqual } from "node:crypto";
import { SESSION_TTL_S } from "../../protocol/constants.ts";
import type { Env } from "../env.ts";
import { bearerAuths } from "./owner.ts";

export const SESSION_COOKIE = "premise_owner";
const VERSION = "v1";

/** What proved the request: the Bearer key, the session cookie, or nothing (SE2). */
export type OwnerCredential = "bearer" | "cookie" | "none";

function sign(key: string, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("hex");
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/** True when the request's `premise_owner` cookie verifies and is unexpired (SE2). */
export function sessionCookieAuths(request: Request, env: Env, now = Date.now()): boolean {
  const key = env.OWNER_KEY;
  if (key === undefined) return false;
  const value = cookieValue(request, SESSION_COOKIE);
  if (value === null) return false;
  const [version, expiryText, signature, ...rest] = value.split(".");
  if (rest.length > 0 || version !== VERSION || expiryText === undefined || signature === undefined) return false;
  const expiry = Number(expiryText);
  if (!Number.isSafeInteger(expiry) || expiry * 1000 <= now) return false;
  const expected = sign(key, `${version}.${expiryText}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Which of SE2's two credentials the request carries — Bearer first, the cookie second. */
export function credentialKind(request: Request, env: Env, now = Date.now()): OwnerCredential {
  if (bearerAuths(request, env)) return "bearer";
  if (sessionCookieAuths(request, env, now)) return "cookie";
  return "none";
}

/**
 * SE3: a cookie-authenticated mutating request must carry `Origin` equal to the Floor's origin (the
 * origin the request was sent to); a Bearer request needs none. `credential` is the result of
 * `credentialKind`, so the caller decides the order of its own checks.
 */
export function originOkFor(request: Request, credential: OwnerCredential): boolean {
  if (credential !== "cookie") return true;
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

/** The `Set-Cookie` header value of a fresh session (SE2: HttpOnly, Secure, SameSite=Strict). */
export function mintSessionCookie(env: Env, now = Date.now()): string {
  const expiry = Math.floor(now / 1000) + SESSION_TTL_S;
  const payload = `${VERSION}.${expiry}`;
  const value = `${payload}.${sign(env.OWNER_KEY ?? "", payload)}`;
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_S}`;
}

/** The `Set-Cookie` header value that removes the cookie (DELETE /api/session). */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
