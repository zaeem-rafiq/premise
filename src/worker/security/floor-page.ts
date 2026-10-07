// The Floor document's own security policy (SE14a) and its public rate limit (SE21). The Worker
// runs before the assets binding (wrangler's `run_worker_first`), so every HTML document the assets
// answer — the page at `/`, `/p/{pool}`, `/replay/{id}` and every unknown path's single-page
// fallback — passes through `serveFloorAsset`, which counts the page per client address and sets
// the policy on it. Every other asset (scripts, styles, JSON, recordings) keeps the headers the
// binding gave it.

import { PUBLIC_RATE_PER_MIN } from "../../protocol/constants.ts";
import type { Env } from "../env.ts";
import { clientAddress, publicReads } from "./rate-limit.ts";

/**
 * The SE14a Content-Security-Policy of the Floor document. `frame-src` is the app server's origin
 * as SE14b configures it — the `APP_HOST` origin when the deployment has a second hostname, else
 * the request's own — and `connect-src` adds the Floor host's `wss:` origin to `'self'`.
 */
export function floorDocumentPolicy(request: Request, env: Env): string {
  const url = new URL(request.url);
  const appOrigin = env.APP_HOST === undefined ? url.origin : `${url.protocol}//${env.APP_HOST}`;
  return (
    `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; ` +
    `frame-src ${appOrigin}; connect-src 'self' wss://${url.host}`
  );
}

/** Serves one asset: the Floor's HTML documents count against PUBLIC_RATE_PER_MIN per client
 * address (SE21 — the session read's own limiter and its own 429 answer) and carry the SE14a
 * policy (and `nosniff`); every other asset keeps the headers the binding gave it. */
export async function serveFloorAsset(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (!response.headers.get("content-type")?.startsWith("text/html")) return response;
  if (publicReads.record(`page:${clientAddress(request)}`) > PUBLIC_RATE_PER_MIN) {
    return Response.json({ error: { code: "rate_limited" } }, { status: 429 });
  }
  const out = new Response(response.body, response);
  out.headers.set("Content-Security-Policy", floorDocumentPolicy(request, env));
  out.headers.set("X-Content-Type-Options", "nosniff");
  return out;
}
