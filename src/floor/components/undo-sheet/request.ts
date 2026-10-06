// The undo sheet's GET twin of the rail's `postJson` (03-floor 4.5): `GET .../undo-plan` — status,
// refusal `code` and parsed body out, `status: null` when the request never reached the server.

import type { RequestResult } from "../rail/request.ts";

export async function getJson(path: string): Promise<RequestResult> {
  try {
    const response = await fetch(path);
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
