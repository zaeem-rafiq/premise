/**
 * HTTP routing for the Worker. Pure module (standard Request/Response only),
 * so the same code is tested locally.
 *
 * Routes (every one needs the x-spike-key header):
 *   GET  /            list of experiment ids
 *   POST /run/<id>    run one experiment
 *
 * The handler never throws: every outcome is a JSON response.
 *
 * The request body is capped at MAX_BODY_BYTES. The largest useful body (a list of
 * model ids or ref names) is a few kilobytes.
 */
import { KEY_HEADER, checkSpikeKey } from "./auth";
import { redactText, type ExperimentResult } from "./recorder";

export interface RouterDeps {
  /** Value of the SPIKE_KEY secret (may be missing). */
  spikeKey: unknown;
  experimentIds: readonly string[];
  /** Runs the experiment (in production: an RPC call into the Durable Object). */
  run(id: string, body: Record<string, unknown>, meta: Record<string, unknown>): Promise<ExperimentResult>;
  /** Context to attach to results, for example the colo that received the request. */
  meta?: Record<string, unknown>;
}

/** Largest request body the router reads. Anything bigger is answered with 413 and never parsed. */
export const MAX_BODY_BYTES = 16 * 1024;

/**
 * Read the request body as text, giving up as soon as it exceeds `limit` bytes.
 * A declared Content-Length over the limit is refused without reading anything.
 */
async function readBodyText(request: Request, limit: number): Promise<{ text: string } | { tooLarge: true }> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) return { tooLarge: true };
  if (request.body === null) return { text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      // Stop reading: the rest of the body is never buffered.
      await reader.cancel().catch(() => undefined);
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes) };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function failureResult(experiment: string, error: string, observation: string): ExperimentResult {
  return { experiment, ok: false, observations: [observation], timings_ms: {}, http: [], error };
}

export async function handleRequest(request: Request, deps: RouterDeps): Promise<Response> {
  // Fail closed: nothing below runs without the key.
  const decision = await checkSpikeKey(request.headers.get(KEY_HEADER), deps.spikeKey);
  if (!decision.allowed) return json({ error: decision.error }, decision.status);

  const url = new URL(request.url);
  if (url.pathname === "/") {
    if (request.method !== "GET") return json({ error: "use GET" }, 405);
    return json({ experiments: deps.experimentIds, usage: "POST /run/<experiment id> with an optional JSON body" });
  }

  const match = /^\/run\/([A-Za-z0-9-]+)$/.exec(url.pathname);
  if (!match) return json({ error: "not found" }, 404);
  const id = match[1]!;
  if (request.method !== "POST") return json({ error: "use POST" }, 405);
  if (!deps.experimentIds.includes(id)) {
    return json(failureResult(id, `unknown experiment "${id}"`, `known experiments: ${deps.experimentIds.join(", ")}`), 404);
  }

  let body: Record<string, unknown> = {};
  try {
    const read = await readBodyText(request, MAX_BODY_BYTES);
    if ("tooLarge" in read) {
      return json(failureResult(id, `request body is larger than ${MAX_BODY_BYTES} bytes`, "the request body was refused without being parsed; nothing was run"), 413);
    }
    const text = read.text;
    if (text.trim().length > 0) {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be a JSON object");
      body = parsed as Record<string, unknown>;
    }
  } catch (e) {
    return json(failureResult(id, `invalid request body: ${String(e)}`, "the request body must be empty or a JSON object"), 400);
  }

  try {
    const result = await deps.run(id, body, { ...deps.meta, started_at: new Date().toISOString() });
    return json(result);
  } catch (e) {
    // The call into the Durable Object itself failed (for example the instance was reset).
    return json(failureResult(id, redactText(String(e)), "the call into the Durable Object threw before a result came back"), 500);
  }
}
