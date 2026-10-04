// The Worker's canned answers. `not_built` is the fail-closed answer of every route and class that
// has no implementation yet; the guards of 13.6 answer with the other codes (SE1, SE3).

/** The fail-closed code (the stub classes and the not-built adapters answer with it). */
export const NOT_BUILT = "not_built";

/** An error that carries the `not_built` code, for a port method or a Workflow that is not built yet. */
export class NotBuiltError extends Error {
  override readonly name = "NotBuiltError";
  readonly code = NOT_BUILT;
  constructor() {
    super(NOT_BUILT);
  }
}

/** The fail-closed answer of a route or a class that is not built yet: HTTP 503, code `not_built`. */
export function notBuilt(): Response {
  return Response.json({ error: { code: NOT_BUILT } }, { status: 503 });
}

/** The same code as an error, for a Workflow or a port that is not built yet. */
export function notBuiltError(): NotBuiltError {
  return new NotBuiltError();
}

/** SE1: no `OWNER_KEY` is configured — every mutating route answers 503 and the Worker logs the reason. */
export function notConfigured(): Response {
  return Response.json({ error: { code: "not_configured" } }, { status: 503 });
}

/** No owner credential was sent, or one was sent that does not check out (SE2). */
export function unauthorized(): Response {
  return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
}

/** SE3: a request with a body whose content type is not `application/json` is rejected before
 * authentication. */
export function unsupportedMediaType(): Response {
  return Response.json({ error: { code: "unsupported_media_type" } }, { status: 415 });
}

/** The path matches no route of `protocol/routes.ts`. */
export function notFound(): Response {
  return Response.json({ error: { code: "not_found" } }, { status: 404 });
}
