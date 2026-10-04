// The one POST helper of the rail lane's controls (03-floor 4.5): JSON in, the response's
// status, refusal `code` and parsed body out. A request that never reached the server answers
// `status: null`, which `errorSentence` (5.9) turns into the network sentence.

export type RequestResult = {
  ok: boolean;
  status: number | null;
  /** A refusal code of the response body (`feature_off`, `killed`, `spend_cap`, SE5b). */
  code?: string;
  /** The parsed JSON body, or null when the answer carries none. */
  body: unknown;
};

export async function postJson(path: string, body: Record<string, unknown>): Promise<RequestResult> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // A non-JSON answer carries no refusal code; the status still drives the sentence.
    }
    const code =
      payload !== null && typeof payload === "object" && "code" in payload
        ? String((payload as { code: unknown }).code)
        : undefined;
    return { ok: response.ok, status: response.status, code, body: payload };
  } catch {
    return { ok: false, status: null, body: null };
  }
}

/** A fresh `request_id` for every request a button sends (CO2, 01-core 9.8). */
export function requestId(): string {
  return crypto.randomUUID();
}
