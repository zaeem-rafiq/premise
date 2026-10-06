// The `card_action` shell entry of the Trunk Durable Object — the work behind the card route
// of 01-core 13.6 (CD3, CD4, 9.8): the owner's tap on a card. The path names the card; the
// body's `option`, `attempt_id` and `submit_ids` echo are checked against the stored card row,
// and the engine's `owner` entry runs the transition (T13, T14, T21). A repeated `request_id`
// returns the stored answer unchanged.
//
// The entry runs synchronously — validate, engine call, answer-store — so a tap can never
// interleave with a replay of its own `request_id`.

import type { Card } from "../../protocol/cards.ts";
import type { CardActionRequest } from "../../protocol/routes.ts";
import { Trunk as TrunkEngine } from "../../core/trunk/registry.ts";
import { ScriptedTriage } from "../../swarm/scripted-triage.ts";
import { FEATURES } from "../../config/features.ts";
import { text } from "../../copy/strings.ts";
import { metaGet, metaSet } from "./sql.ts";
import type { EntryContext, EntryResult } from "./trunk-do.ts";

/** The meta key under which a request_id's answer is stored (9.8). */
const CARD_REQ = "card_req:";

function cardIdOf(path: string): string | null {
  const match = /^\/api\/pools\/[^/]+\/cards\/([^/]+)$/.exec(path);
  return match === null ? null : (match[1] as string);
}

function invalid(detail: string): EntryResult {
  return { response: { error: { code: "invalid_args", message: detail } }, status: 400 };
}

/** The stored card row's body — a `Card` (the options, `submit_ids` and `attempt_ids` the tap
 * is checked against live in it, not on the row's own columns). */
function readCard(ctx: EntryContext, card_id: string): { state: string; body: Card } | null {
  const row = ctx.sql.exec("SELECT state, body FROM cards WHERE card_id = ?", card_id).toArray()[0];
  if (row === undefined) return null;
  return { state: String(row.state), body: JSON.parse(String(row.body)) as Card };
}

export function cardAction(input: unknown, ctx: EntryContext): EntryResult {
  const card_id = cardIdOf(ctx.path);
  const body = (typeof input === "object" && input !== null ? input : {}) as Partial<CardActionRequest>;
  const request_id = typeof body.request_id === "string" ? body.request_id : "";
  // 9.8: a repeated request_id replays the stored answer and changes nothing.
  if (request_id !== "") {
    const stored = metaGet(ctx.sql, `${CARD_REQ}${request_id}`);
    if (stored !== null) return JSON.parse(stored) as EntryResult;
  }
  const finish = (result: EntryResult): EntryResult => {
    if (request_id !== "") metaSet(ctx.sql, `${CARD_REQ}${request_id}`, JSON.stringify(result));
    return result;
  };

  if (card_id === null || typeof body.option !== "string" || request_id === "") {
    return finish(invalid("a card path, an option and a request_id are required"));
  }
  const card = readCard(ctx, card_id);
  if (card === null) return finish({ response: { error: { code: "card_unknown" } }, status: 404 });
  // C34/9.8: a tap on a card that is not open does nothing.
  if (card.state !== "open") return finish({ response: { ok: true, stale: true, message: text("held.stale") } });
  // CD4: the route accepts no id the card does not offer.
  if (!card.body.options.some((o) => o.id === body.option)) {
    return finish(invalid(`card ${card_id} does not offer ${body.option}`));
  }
  // 13.6: `submit_ids` binds the tap to the submits the owner saw; a tap whose echo names a
  // different submit is stale and changes nothing.
  const echo = typeof body.submit_ids === "object" && body.submit_ids !== null ? body.submit_ids : {};
  for (const [attempt, submit_id] of Object.entries(card.body.submit_ids)) {
    if (echo[attempt] !== submit_id) {
      return finish({ response: { ok: true, stale: true, message: text("held.stale") } });
    }
  }
  // `attempt_id` is required for `choose`; any id it names must be on the card.
  if (body.option === "choose" && body.attempt_id === undefined) return finish(invalid("choose requires attempt_id"));
  if (body.attempt_id !== undefined && !card.body.attempt_ids.includes(body.attempt_id)) {
    return finish(invalid("attempt_id is not on this card"));
  }
  const attempt = body.attempt_id ?? card.body.attempt_ids[0];

  const trunk = TrunkEngine.open(ctx.sql, { now: () => ctx.now, syncTriage: ScriptedTriage, features: FEATURES });
  const answer = trunk.owner({ action: body.option, attempt, reason: body.reason });
  if ((answer as { ok?: unknown }).ok === false) {
    return finish({
      response: { error: (answer as { error?: unknown }).error ?? { code: "invalid_args" } },
      status: 400,
    });
  }
  return finish({ response: { ok: true } });
}
