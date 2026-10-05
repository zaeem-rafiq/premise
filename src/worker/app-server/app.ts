// The app server of 02-tidepool section 4: public, read-only GETs that serve a pool's files by
// commit id. Moving sources resolve from the pool's Floor object state (SE19); every repo read names
// a commit id (S7a); Trunk is never reached (AS16) — the deps carry no way to call it.

import type { PoolSource } from "../../protocol/ports.ts";
import { APP_FILE_RATE_PER_MIN, PUBLIC_RATE_PER_MIN } from "../../protocol/constants.ts";
import {
  CACHE_IMMUTABLE,
  CACHE_NO_STORE,
  TYPE_HTML,
  TYPE_JS,
  clientAddress,
  contentTypeOf,
  isServablePath,
  securityHeaders,
} from "./respond.ts";
import { isVersionToken, resolveSource, type PoolFloorRead, type Resolved } from "../adapters/pool-source/resolve.ts";
import { bootModule, headModule, registryModule } from "./modules.ts";

/** The request the seam hands a pool route, plus which route row matched. */
export type AppInput = {
  request: Request;
  params: Record<string, string>;
  route: "page" | "head" | "boot" | "file" | "registry" | "host" | "rest";
};

export type AppDeps = {
  /** The pool's Floor object state (FS2). A throw maps to 503 (AS4). */
  floorState(pool: string): Promise<PoolFloorRead>;
  /** The version-addressed reads (S7): the Artifacts adapter in production, a directory in tests. */
  pools: PoolSource;
  /** The committed host bundle (`~host.<build>.js`); `null` before the bundle is generated. */
  host: { build: string; source: string } | null;
  now(): number;
  /** `caches.default` (SE20); absent in tests. Version-pinned routes only. */
  cache?: {
    match(request: Request): Promise<Response | undefined>;
    put(request: Request, response: Response): Promise<unknown>;
  };
  limiter: { allow(key: string, limit: number, now: number): boolean };
};

const NOT_FOUND_BODY = "not found\n";
const UNAVAILABLE_BODY = "unavailable\n";
const RATE_LIMITED_BODY = "rate limited\n";

export function createApp(deps: AppDeps) {
  const originOf = (request: Request) => new URL(request.url).origin;

  const answer = (
    request: Request,
    status: number,
    body: string | Uint8Array,
    type: string,
    cache: string,
    moduleFile = false,
  ) => {
    const headers = securityHeaders(originOf(request), moduleFile);
    headers.set("Content-Type", type);
    headers.set("Cache-Control", cache);
    return new Response(body, { status, headers });
  };

  const notFound = (request: Request) =>
    answer(request, 404, NOT_FOUND_BODY, "text/plain; charset=utf-8", CACHE_NO_STORE);
  /** IR7: a pool whose `pool.state.app` is `null` has no live picture — every `/pool/<pool>/…`
   * route answers 404 with code `no_app`. */
  const noApp = (request: Request) =>
    answer(request, 404, JSON.stringify({ error: { code: "no_app" } }), "application/json", CACHE_NO_STORE);
  const unavailable = (request: Request) =>
    answer(request, 503, UNAVAILABLE_BODY, "text/plain; charset=utf-8", CACHE_NO_STORE);
  const rateLimited = (request: Request) =>
    answer(request, 429, RATE_LIMITED_BODY, "text/plain; charset=utf-8", CACHE_NO_STORE);

  /** AS8: the no-store routes count against PUBLIC_RATE_PER_MIN on every request. */
  const publicRateOk = (request: Request) =>
    deps.limiter.allow(`public:${clientAddress(request)}`, PUBLIC_RATE_PER_MIN, deps.now());

  /** AS8: version-pinned routes count against APP_FILE_RATE_PER_MIN on cache misses only. */
  const fileRateOk = (request: Request) =>
    deps.limiter.allow(`file:${clientAddress(request)}`, APP_FILE_RATE_PER_MIN, deps.now());

  /**
   * Resolve a `<source>` segment (4.1). Moving sources read the pool's Floor state once (SE19);
   * commit sources need no resolution — a `null` seq is corrected only where `seq` is served
   * (`~head.js` uses `resolveForModule`, which reads the state for `landings_by_commit`).
   */
  const NO_APP = "no_app" as const;
  const resolve = async (pool: string, source: string): Promise<Resolved | null | typeof NO_APP> => {
    const read = await deps.floorState(pool);
    if (read.pool.app === null) return NO_APP;
    return resolveSource(read, source);
  };

  // ---- The route rows of 4.2 plus the `/pool/{rest}` catch-all ----

  /** `GET /pool/{pool}/{source}/` — the page: `index.html` of the resolved version. */
  const page = async ({ request, params }: AppInput): Promise<Response> => {
    const url = new URL(request.url);
    if (!url.pathname.endsWith("/")) {
      // 4.2: without the final slash, 308 to the same path with it (query strings are the host's, AS7).
      const headers = securityHeaders(originOf(request), false);
      headers.set("Location", `${url.pathname}/${url.search}`);
      return new Response(null, { status: 308, headers });
    }
    if (!publicRateOk(request)) return rateLimited(request);
    const pool = params.pool ?? "";
    let resolved: Resolved | null | typeof NO_APP;
    try {
      resolved = await resolve(pool, params.source ?? "");
    } catch {
      return unavailable(request);
    }
    if (resolved === NO_APP) return noApp(request);
    if (resolved === null) return notFound(request);
    try {
      const file = await deps.pools.read(pool, resolved.version, "index.html");
      if (file === null) return notFound(request);
      return answer(request, 200, file.bytes, TYPE_HTML, CACHE_NO_STORE);
    } catch {
      return unavailable(request);
    }
  };

  /** `GET /pool/{pool}/{source}/~head.js` — the `landed` module (4.4). */
  const head = async ({ request, params }: AppInput): Promise<Response> => {
    if (!publicRateOk(request)) return rateLimited(request);
    const pool = params.pool ?? "";
    const source = params.source ?? "";
    let resolved: Resolved | null | typeof NO_APP;
    try {
      resolved = await resolve(pool, source);
    } catch {
      return unavailable(request);
    }
    if (resolved === NO_APP) return noApp(request);
    if (resolved === null) return notFound(request);
    return answer(request, 200, headModule(pool, source, resolved), TYPE_JS, CACHE_NO_STORE, true);
  };

  /** `GET /pool/{pool}/{source}/~boot.js` — loads the host bundle and hands it `landed`. */
  const boot = async ({ request, params }: AppInput): Promise<Response> => {
    if (!publicRateOk(request)) return rateLimited(request);
    if (deps.host === null) return unavailable(request);
    const pool = params.pool ?? "";
    let resolved: Resolved | null | typeof NO_APP;
    try {
      resolved = await resolve(pool, params.source ?? "");
    } catch {
      return unavailable(request);
    }
    if (resolved === NO_APP) return noApp(request);
    if (resolved === null) return notFound(request);
    return answer(request, 200, bootModule(deps.host.build), TYPE_JS, CACHE_NO_STORE, true);
  };

  /** `/pool/{pool}/v/{version}/~registry.js` — the kinds registry of the version (4.4, AS9–AS11). */
  const registry = async (request: Request, pool: string, version: string): Promise<Response> => {
    if (!isVersionToken(version)) return notFound(request);
    let read: PoolFloorRead;
    try {
      read = await deps.floorState(pool); // AS11's newest-paths cut needs `paths` even on a commit route
    } catch {
      return unavailable(request);
    }
    if (read.pool.app === null) return noApp(request);
    let module: string | null;
    try {
      module = await registryModule(deps.pools, pool, version, read.paths);
    } catch {
      return unavailable(request);
    }
    if (module === null) return notFound(request);
    return answer(request, 200, module, TYPE_JS, CACHE_IMMUTABLE, true);
  };

  /** `/pool/{pool}/v/{version}/{path}` (one segment, or the rest of `{rest}`) — the file bytes. */
  const file = async (request: Request, pool: string, version: string, path: string): Promise<Response> => {
    // `~registry.js` shares this route row: `{path}` matches it before the registry row is tried.
    if (path === "~registry.js") return registry(request, pool, version);
    if (!isVersionToken(version) || !isServablePath(path)) return notFound(request);
    const type = contentTypeOf(path);
    if (type === null) return notFound(request);
    // IR7: an imported pool has no live picture — its files are not served, whatever the token.
    try {
      if ((await deps.floorState(pool)).pool.app === null) return noApp(request);
    } catch {
      return unavailable(request);
    }
    let bytes: Uint8Array;
    try {
      const found = await deps.pools.read(pool, version, path);
      if (found === null) return notFound(request);
      bytes = found.bytes;
    } catch {
      return unavailable(request);
    }
    return answer(request, 200, bytes, type, CACHE_IMMUTABLE, type === TYPE_JS);
  };

  /** `/pool/~host.{build}.js` — the host bundle (a platform asset, immutable). */
  const host = async ({ request, params }: AppInput): Promise<Response> => {
    if (deps.host === null || params.build !== deps.host.build) return notFound(request);
    return answer(request, 200, deps.host.source, TYPE_JS, CACHE_IMMUTABLE, true);
  };

  /** `/pool/{rest}` — nested repo paths (`<pool>/v/<version>/<dir>/<file>`); all else is 404. */
  const rest = async ({ request, params }: AppInput): Promise<Response> => {
    const segments = (params.rest ?? "").split("/");
    if (segments.length < 4 || segments[1] !== "v") {
      // IR7: `/pool/<pool>/` and every malformed shape under an imported pool's name is still a
      // pool-scoped answer — `no_app`, not the generic 404. A missing pool keeps `not_found`.
      try {
        if ((await deps.floorState(segments[0] ?? "")).pool.app === null) return noApp(request);
      } catch {
        /* a pool that is not there answers 404 as before */
      }
      return notFound(request);
    }
    return fileChecked(request, segments[0] ?? "", segments[2] ?? "", segments.slice(3).join("/"));
  };

  /** The immutable-route wrapper: cache first (SE20), rate-limit the misses (AS8), store 200s. */
  const cached = async (request: Request, produce: () => Promise<Response>): Promise<Response> => {
    const hit = await deps.cache?.match(request);
    if (hit !== undefined) return hit;
    if (!fileRateOk(request)) return rateLimited(request);
    const response = await produce();
    if (response.status === 200) await deps.cache?.put(request, response.clone());
    return response;
  };

  const fileChecked = (request: Request, pool: string, version: string, path: string) =>
    cached(request, () => file(request, pool, version, path));

  return {
    async handle(input: AppInput): Promise<Response> {
      switch (input.route) {
        case "page":
          return page(input);
        case "head":
          return head(input);
        case "boot":
          return boot(input);
        case "file":
          return fileChecked(
            input.request,
            input.params.pool ?? "",
            input.params.version ?? "",
            input.params.path ?? "",
          );
        case "registry":
          return cached(input.request, () =>
            registry(input.request, input.params.pool ?? "", input.params.version ?? ""),
          );
        case "host":
          return cached(input.request, () => host(input));
        case "rest":
          return rest(input);
      }
    },
  };
}
