// The Worker's last line: an exception that no route caught (a Durable Object reset mid-request, a
// binding that throws) answers the API's error shape, `{ "error": { "code": "internal" } }` with
// status 500, not the platform's HTML error page, and leaves an operator's line with the error's
// name and message only (BP7: never the request, which can carry a key).

export async function answerUnhandled(route: () => Response | Promise<Response>): Promise<Response> {
  try {
    return await route();
  } catch (cause) {
    console.error("worker: unhandled", cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown");
    return Response.json({ error: { code: "internal" } }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
