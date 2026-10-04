// The owner credential of SE2 (01-core 13.2): `Authorization: Bearer <OWNER_KEY>`. The constant-time
// compare is the same algorithm the Worker's guard uses (src/worker/index.ts): equal length required,
// then a fixed loop over every byte — the timing never depends on where the strings differ.

import type { Env } from "../env.ts";

/** The `<key>` of `Authorization: Bearer <key>`, or null when the header is absent or not Bearer. */
export function bearerKey(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length);
}

/** Constant-time string compare: same length and a fixed loop, so the answer does not leak position. */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

/** True when the request carries `Authorization: Bearer <OWNER_KEY>` (SE2; SE1: no key configured
 * means no request can authenticate). */
export function bearerAuths(request: Request, env: Env): boolean {
  const key = env.OWNER_KEY;
  if (key === undefined) return false;
  const bearer = bearerKey(request);
  return bearer !== null && timingSafeEqual(bearer, key);
}
