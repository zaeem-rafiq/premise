// Owner-only routes of 13.6. The Worker applies authentication before these handlers.
import { FEATURES } from "../../config/features.ts";
import type { RouteInput } from "../index.ts";
import type { UndoRequest } from "../../protocol/routes.ts";

const invalid = (): Response => Response.json({ error: { code: "invalid_args" } }, { status: 400 });
const off = (): Response => Response.json({ error: { code: "feature_off" } }, { status: 404 });
const seqNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export async function undoPlan(input: RouteInput): Promise<Response> {
  if (!FEATURES.undo) return off();
  const url = new URL(input.request.url);
  const raw = url.searchParams.get("seq");
  const seq = raw !== null && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : 0;
  if (!seqNumber(seq)) return invalid();
  // The shell's GET entry envelope is `q`; only this validated sequence crosses the seam.
  url.search = new URLSearchParams({ q: JSON.stringify({ seq }) }).toString();
  return input.env.TRUNK.get(input.env.TRUNK.idFromName(input.params.pool ?? "")).fetch(url.toString());
}

export async function undo(input: RouteInput): Promise<Response> {
  if (!FEATURES.undo) return off();
  const body: unknown = await input.request.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body)) return invalid();
  const request = body as Partial<UndoRequest>;
  if (
    !seqNumber(request.seq) ||
    !Array.isArray(request.expect_reverted) ||
    !request.expect_reverted.every(seqNumber) ||
    typeof request.request_id !== "string" ||
    request.request_id === ""
  )
    return invalid();
  return input.env.TRUNK.get(input.env.TRUNK.idFromName(input.params.pool ?? "")).fetch(input.request.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
}
