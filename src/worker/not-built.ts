import { NOT_BUILT } from "../protocol/placeholder.ts";

/** The fail-closed answer of a route or a class that is not built yet: HTTP 503 with the code `not_built`. */
export function notBuilt(): Response {
  return Response.json({ error: { code: NOT_BUILT } }, { status: 503 });
}

/** The same code as an error, for a Workflow that is not built yet. */
export function notBuiltError(): Error {
  return new Error(NOT_BUILT);
}
