// The response plumbing of 02-tidepool 4.2: the SE14 header set on every answer, the AS5 content
// types, the AS8/SE21 fixed-window rate limit, and the 404/503/308 forms of AS4.

export const TYPE_JS = "text/javascript; charset=utf-8";
export const TYPE_HTML = "text/html; charset=utf-8";
export const TYPE_JSON = "application/json";
export const TYPE_TEXT = "text/plain; charset=utf-8";

export const CACHE_NO_STORE = "no-store";
export const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * The header set of SE14, on every app-server response of every status (AS15). `origin` is the
 * request's own origin: the app-server origin of `script-src` is the host answering, and the Floor
 * origin of `frame-ancestors` is the same host while `APP_HOST` is unset (SE14b — this deployment).
 * `moduleFile` is set for the JavaScript responses the frame imports: the opaque origin needs
 * `Access-Control-Allow-Origin: *` to load them.
 */
export function securityHeaders(origin: string, moduleFile: boolean): Headers {
  const headers = new Headers();
  headers.set(
    "Content-Security-Policy",
    `sandbox allow-scripts; default-src 'none'; script-src ${origin}; img-src data:; ` +
      `style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; ` +
      `frame-ancestors ${origin}`,
  );
  headers.set("X-Content-Type-Options", "nosniff");
  if (moduleFile) headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

/** AS5: the only served types. `index.html` is HTML only at the repo root; every other `.html` 404s. */
export function contentTypeOf(path: string): string | null {
  if (path === "index.html") return TYPE_HTML;
  if (path.endsWith(".js") || path.endsWith(".mjs")) return TYPE_JS;
  if (path.endsWith(".json")) return TYPE_JSON;
  if (path.endsWith(".md")) return TYPE_TEXT;
  return null;
}

/** A `~` segment can never be a repo path (AS3); `.premise/` is never served (AS5). */
export function isServablePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.endsWith("/")) return false;
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || segment.startsWith("~")) return false;
  }
  return !(segments[0] === ".premise" || path.startsWith(".premise/"));
}

/** One counter window per address per route class (SE21: PUBLIC_RATE_PER_MIN / APP_FILE_RATE_PER_MIN). */
export class RateLimiter {
  private buckets = new Map<string, { start: number; count: number }>();

  allow(key: string, limit: number, now: number): boolean {
    const bucket = this.buckets.get(key);
    if (bucket === undefined || now - bucket.start >= 60_000) {
      this.buckets.set(key, { start: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= limit;
  }
}

/** The client address a limit bucket is tagged by (same convention as the Floor's sockets). */
export function clientAddress(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "local";
}
