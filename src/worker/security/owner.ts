// The owner credential of SE2 (01-core 13.2): `Authorization: Bearer <OWNER_KEY>`. The constant-time
// compare has no early return whatever the lengths: both values are hashed to a fixed-length digest
// and the digests are compared with `node:crypto`'s timingSafeEqual, so the answer leaks neither the
// key's length nor the position where two same-length values differ.

import { createHash, timingSafeEqual as digestsEqual } from "node:crypto";
import type { Env } from "../env.ts";

/** The `<key>` of `Authorization: Bearer <key>`, or null when the header is absent or not Bearer. */
export function bearerKey(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length);
}

/** Constant-time string compare: the fixed-length SHA-256 digests of both values, compared with the
 * platform's constant-time check — no early return, whatever the lengths. */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return digestsEqual(left, right);
}

/** True when the request carries `Authorization: Bearer <OWNER_KEY>` (SE2; SE1: no key configured
 * means no request can authenticate). */
export function bearerAuths(request: Request, env: Env): boolean {
  const key = env.OWNER_KEY;
  if (key === undefined) return false;
  const bearer = bearerKey(request);
  return bearer !== null && timingSafeEqual(bearer, key);
}
