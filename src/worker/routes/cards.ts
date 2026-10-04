// The trunk lane's card route of 01-core 13.6 (CD3, CD4): `POST /api/pools/{pool}/cards/{card_id}`
// takes the owner's `CardActionRequest` and hands it to the pool's Trunk Durable Object, whose
// `card_action` entry runs the engine's `owner` entry on it. The Worker validates the request's
// shape — a card option, the `submit_ids` echo and a `request_id` (9.8) — and the object decides
// the tap: the option the card offers, a closed card's no-op, the submits the owner saw.

import type { RouteInput } from "../index.ts";
import type { CardActionRequest } from "../../protocol/routes.ts";
import { CARD_OPTIONS } from "../../protocol/cards.ts";

function bad(detail: string): Response {
  return Response.json({ error: { code: "invalid_args", message: detail } }, { status: 400 });
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

/** The route's body must be a `CardActionRequest` exactly (CD4). */
function validate(body: unknown): CardActionRequest | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  if (typeof raw.option !== "string" || !(CARD_OPTIONS as readonly string[]).includes(raw.option)) return null;
  if (!isStringRecord(raw.submit_ids)) return null;
  if (raw.attempt_id !== undefined && (typeof raw.attempt_id !== "string" || raw.attempt_id === "")) return null;
  if (raw.reason !== undefined && typeof raw.reason !== "string") return null;
  if (typeof raw.request_id !== "string" || raw.request_id === "") return null;
  return raw as unknown as CardActionRequest;
}

export async function handleCard(input: RouteInput): Promise<Response> {
  const body = await input.request.json().catch(() => null);
  const request = validate(body);
  if (request === null) return bad("a CardActionRequest is required");
  // The card's `card_id` is in the path, so the original request goes through unchanged.
  const stub = input.env.TRUNK.get(input.env.TRUNK.idFromName(input.params.pool ?? ""));
  const url = new URL(input.request.url);
  return stub.fetch(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    }),
  );
}
