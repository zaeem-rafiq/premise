// The intent box (03-floor 3.1): the owner's way onto the pool. One text field, its character
// count, `intent.send` and `intent.race`, the pre-written menu and the starter button. The state
// table's rows are decided by `model.ts`; every wait and refusal carries a sentence (FL10, 5.9),
// and a visitor or a Replay sees the field disabled with `intent.visitor` / `intent.replay`
// (FL7). The request is the 4.5 create route; the draft clears when its `intent.created`
// arrives, not when the request returns (CO8).

import "./intent-box.css";

import { useContext, useEffect, useRef, useState } from "react";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import type { PrewrittenIntent } from "../../../protocol/floor-json.ts";
import { MAX_INTENT_CHARS, SENT_WAIT_MS } from "../../../protocol/constants.ts";
import { ShellContext } from "../../app/context.ts";
import { errorSentence } from "../../../copy/errors.ts";
import { postJson, requestId, type RequestResult } from "../rail/request.ts";
import { intentBoxState, queueNote } from "./model.ts";

/** The body of `POST /api/pools/{pool}/intents` (03 4.5). */
export type IntentRequest = {
  text: string;
  race: boolean;
  prewritten: boolean;
  request_id: string;
};

/** What a send answers: the intent_id on success, the failure's status and refusal code. */
export type IntentReply = { ok: boolean; intent_id?: string; status?: number | null; code?: string };

export type IntentSend = (request: IntentRequest) => Promise<IntentReply>;

/** The create-intent route of 4.5. `intent_id` comes back in the body (`{ intent_id }`). */
export async function postIntent(pool: string, request: IntentRequest): Promise<IntentReply> {
  const result: RequestResult = await postJson(`/api/pools/${encodeURIComponent(pool)}/intents`, request);
  const intentId =
    result.body !== null && typeof result.body === "object" && "intent_id" in result.body
      ? String((result.body as { intent_id: unknown }).intent_id)
      : undefined;
  return { ok: result.ok, intent_id: intentId, status: result.status, code: result.code };
}

export type IntentBoxProps = {
  floor: FloorState;
  mode: "live" | "replay";
  owner: boolean;
  capReached: boolean;
  /** The send the box performs; the default posts the 4.5 route. Tests inject a fake. */
  onSend?: IntentSend;
};

export function IntentBox({ floor, mode, owner, capReached, onSend }: IntentBoxProps) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  const [draft, setDraft] = useState("");
  const [phase, setPhase] = useState<"idle" | "sending" | "sent">("idle");
  const [waited, setWaited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Intent ids of answered requests whose `intent.created` has not arrived yet (CO8), and the
  // draft text each was sent with so its arrival clears only an unchanged draft.
  const awaiting = useRef(new Map<string, string>());
  const [, bumpAwaiting] = useState(0);

  const state = intentBoxState({ floor, mode, owner, capReached, phase, waited, error });
  const interactive = state.kind === "live" || state.kind === "error" || state.kind === "waiting";

  // CO8: a draft clears when the `intent.created` of the returned intent_id arrives.
  useEffect(() => {
    if (awaiting.current.size === 0) return;
    let cleared = false;
    for (const [id, sentText] of awaiting.current) {
      if (floor.intents[id] !== undefined) {
        awaiting.current.delete(id);
        if (sentText === draft) setDraft("");
        cleared = true;
      }
    }
    if (awaiting.current.size === 0 && phase === "sent") setPhase("idle");
    if (cleared) bumpAwaiting((n) => n + 1);
  }, [floor, floor.n, draft, phase]);

  // 3.1: after the request answered, `intent.sent_waiting` appears once SENT_WAIT_MS has passed
  // without the event (the field is usable again then; the buttons stay off).
  useEffect(() => {
    if (phase !== "sent") {
      setWaited(false);
      return;
    }
    const timer = window.setTimeout(() => setWaited(true), SENT_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const send = onSend ?? ((request: IntentRequest) => postIntent(floor.pool.id, request));

  /** One create request; `false` when it failed (the caller may stop a batch). */
  async function sendOne(text: string, race: boolean, prewritten: boolean): Promise<boolean> {
    setPhase("sending");
    setError(null);
    setWaited(false);
    const request: IntentRequest = { text, race, prewritten, request_id: requestId() };
    const reply = await send(request);
    if (reply.ok) {
      if (reply.intent_id !== undefined) awaiting.current.set(reply.intent_id, text);
      setPhase("sent");
      bumpAwaiting((n) => n + 1);
      return true;
    }
    setPhase("idle");
    setError(errorSentence(reply.status ?? null, reply.code));
    return false;
  }

  /** A send uses the draft. CO7: text that is a pre-written request goes with `prewritten: true`. */
  const prewrittenMatch = (text: string): PrewrittenIntent | undefined =>
    shell.settings.prewritten.find((item) => item.text === text);

  async function sendDraft(race: boolean): Promise<void> {
    const text = draft;
    if (text.trim() === "") return;
    const match = prewrittenMatch(text);
    await sendOne(text, race || match?.race === true, match !== undefined);
  }

  /** CO7: the starter set — one request per `group: "starter"` item, in `/floor.json` order. */
  const starters = shell.settings.prewritten.filter((item) => item.group === "starter");
  const starterSeen = starters.some((item) => Object.values(floor.intents).some((intent) => intent.text === item.text));
  async function sendStarterSet(): Promise<void> {
    for (const item of starters) {
      const ok = await sendOne(item.text, item.race, true);
      if (!ok) break;
    }
  }

  const canType = state.kind === "live" || state.kind === "error" || state.kind === "waiting";
  const canSend = state.kind === "live" || state.kind === "error"; // `waiting` leaves the field alone
  const text = draft;
  const atLimit = text.length >= MAX_INTENT_CHARS;

  return (
    <div className="intent-box">
      {state.kind === "replay" ? (
        <p className="intent-note intent-note--solo">{t("intent.replay")}</p>
      ) : (
        <textarea
          className="intent-field"
          rows={2}
          placeholder={t("intent.placeholder")}
          maxLength={MAX_INTENT_CHARS}
          value={draft}
          disabled={state.kind === "blocked"}
          readOnly={!canType}
          onChange={(event) => {
            setDraft(event.target.value.slice(0, MAX_INTENT_CHARS));
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (canSend) void sendDraft(false);
            }
          }}
          aria-label={t("intent.placeholder")}
        />
      )}

      {state.kind === "blocked" && <p className="intent-note">{t(state.id)}</p>}
      {(state.kind === "sending" || state.kind === "sent") && <p className="intent-note">{t("intent.sending")}</p>}
      {state.kind === "waiting" && <p className="intent-note">{t("intent.sent_waiting")}</p>}
      {state.kind === "error" && <p className="intent-error">{state.sentence}</p>}
      {queueNote(floor, state) && (
        <p className="intent-note">{t("intent.queue", { max: floor.pool.max_real_agents })}</p>
      )}

      {state.kind !== "replay" && state.kind !== "blocked" && (
        <div className="intent-row">
          <span className={`intent-count${atLimit ? " intent-count--limit" : ""}`}>
            {t("intent.count", { n: text.length, max: MAX_INTENT_CHARS })}
          </span>
          {shell.settings.prewritten.length > 0 && (
            <select
              className="intent-prewritten"
              aria-label={t("intent.prewritten")}
              value=""
              disabled={!interactive}
              onChange={(event) => {
                const item = shell.settings.prewritten.find((entry) => entry.id === event.target.value);
                if (item !== undefined) setDraft(item.text);
              }}
            >
              <option value="" disabled>
                {t("intent.prewritten")}
              </option>
              {shell.settings.prewritten.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.text}
                </option>
              ))}
            </select>
          )}
          {starters.length > 0 && !starterSeen && (
            <button
              type="button"
              className="intent-starter"
              disabled={!interactive}
              onClick={() => void sendStarterSet()}
            >
              {t("intent.starter", { n: starters.length })}
            </button>
          )}
          <span className="intent-actions">
            <button
              type="button"
              className="primary"
              disabled={!canSend || text.trim() === ""}
              onClick={() => void sendDraft(false)}
            >
              {state.kind === "sending" || state.kind === "sent" ? t("intent.sending") : t("intent.send")}
            </button>
            {shell.settings.features.race && (
              <button
                type="button"
                title={t("intent.race.tip")}
                disabled={!canSend || text.trim() === ""}
                onClick={() => void sendDraft(true)}
              >
                {t("intent.race")}
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
