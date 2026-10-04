// The shell's fallback rail, drawn while `view.rail` is not registered (the floor-rail
// lane's wiring module registers it). It is honest but minimal: the intent box with its
// disabled states (3.1, FL7), the tray of open cards, the three tabs with counts, and one
// row per attempt or landing with its status word (5.3) - enough for AC3 and for a
// recording to be watched. All mutating controls stay absent for a visitor and in Replay.

import { useContext, useState } from "react";
import type { FloorState, AttemptView, LandingEntry } from "../../protocol/reducer/state.ts";
import { ShellContext } from "./context.ts";
import { statusWordId, inFlight, sentBack, whyOffered } from "../state/derive.ts";
import { changeName } from "../../copy/names.ts";
import { landingLabel, timeOfDay } from "../../copy/format.ts";
import { MAX_INTENT_CHARS } from "../../protocol/constants.ts";

export type RailFallbackProps = {
  floor: FloorState;
  mode: "live" | "replay";
  owner: boolean;
  capReached: boolean;
  onSend: (text: string) => void;
};

function intentBlocker(floor: FloorState, mode: string, owner: boolean, cap: boolean): string | null {
  if (mode === "replay") return "intent.replay";
  if (!owner) return "intent.visitor";
  if (floor.limits?.killed === true) return "intent.killed";
  if (floor.pool.state === "paused") return "intent.paused";
  if (floor.pool.state === "rebuilding") return "intent.rebuilding";
  if (cap) return "intent.cap";
  const queued = Object.values(floor.attempts).some((a) => a.state === "opened");
  if (queued) return "intent.queue";
  return null;
}

export function RailFallback(props: RailFallbackProps) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  const { floor } = props;
  const [tab, setTab] = useState<"working" | "landed" | "stopped">("working");
  const [draft, setDraft] = useState("");

  const blocker = intentBlocker(floor, props.mode, props.owner, props.capReached);
  const working = floor.working_order
    .map((id) => floor.attempts[id])
    .filter((a): a is AttemptView => a !== undefined && inFlight(a));
  const landed = floor.landed_order.map((seq) => floor.landings[seq]).filter((l): l is LandingEntry => l !== undefined);
  const stopped = Object.values(floor.attempts).filter((a) => ["stopped", "declined", "not_chosen"].includes(a.state));
  const tray = floor.open_cards.map((id) => floor.cards[id]).filter((c) => c !== undefined && c.open);

  return (
    <aside className="rail" id="rail" aria-label={t("rail.label")}>
      <div className="intent-box">
        <textarea
          className="intent-field"
          placeholder={t("intent.placeholder")}
          maxLength={MAX_INTENT_CHARS}
          value={draft}
          disabled={blocker !== null}
          onChange={(event) => setDraft(event.target.value)}
          aria-label={t("intent.placeholder")}
        />
        {blocker !== null ? (
          <p className="intent-note">{t(blocker)}</p>
        ) : (
          <div className="intent-row">
            <span className="intent-count">{t("intent.count", { n: draft.length, max: MAX_INTENT_CHARS })}</span>
            <button
              type="button"
              className="primary"
              disabled={draft.trim() === ""}
              onClick={() => {
                props.onSend(draft);
                setDraft("");
              }}
            >
              {t("intent.send")}
            </button>
          </div>
        )}
      </div>

      {tray.length > 0 && (
        <div className="tray" role="list">
          {tray.map((view) => (
            <div className="tray-row" role="listitem" key={view!.card.card_id}>
              <span className="tray-title">{view!.card.title}</span>
              <button type="button">{t("card.open")}</button>
            </div>
          ))}
        </div>
      )}

      <div className="tabs" role="tablist">
        {(
          [
            ["working", "rail.tab.working", working.length],
            ["landed", "rail.tab.landed", landed.length],
            ["stopped", "rail.tab.stopped", stopped.length],
          ] as const
        ).map(([key, id, n]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className="tab"
            onClick={() => setTab(key)}
          >
            {t(id, { n })}
          </button>
        ))}
      </div>

      <div className="rail-list" role="tabpanel">
        {tab === "working" &&
          (working.length === 0 ? (
            <p className="rail-empty">{t("rail.empty.working", { visitor: !props.owner })}</p>
          ) : (
            working.map((attempt) => <AttemptRow key={attempt.id} attempt={attempt} floor={floor} />)
          ))}
        {tab === "landed" &&
          (landed.length === 0 ? (
            <p className="rail-empty">{t("rail.empty.landed")}</p>
          ) : (
            landed.map((landing) => <LandedRow key={landing.seq} landing={landing} floor={floor} />)
          ))}
        {tab === "stopped" &&
          (stopped.length === 0 ? (
            <p className="rail-empty">{t("rail.empty.stopped")}</p>
          ) : (
            stopped.map((attempt) => <AttemptRow key={attempt.id} attempt={attempt} floor={floor} />)
          ))}
      </div>
    </aside>
  );
}

function attemptName(attempt: AttemptView, floor: FloorState): string {
  const intent = floor.intents[attempt.intent_id];
  return changeName({
    intentText: intent?.text ?? "",
    race: attempt.race,
    model: attempt.model,
    premises: Object.values(attempt.premises).map((p) => ({ kind: p.kind, key: p.key, edit: p.edit })),
  });
}

function AttemptRow({ attempt, floor }: { attempt: AttemptView; floor: FloorState }) {
  const shell = useContext(ShellContext)!;
  const word = statusWordId(attempt, floor);
  return (
    <div className="attempt-row" data-state={attempt.state}>
      <div className="attempt-line">
        <span className="attempt-name" dir="auto">
          {attemptName(attempt, floor)}
        </span>
        <span className="attempt-status">{shell.t(word)}</span>
      </div>
      <div className="attempt-sub">
        {attempt.agent === "synthetic" && <span className="tag tag-synthetic">{shell.t("attempt.tag.synthetic")}</span>}
        {floor.intents[attempt.intent_id]?.prewritten === true && (
          <span className="tag">{shell.t("attempt.tag.prewritten")}</span>
        )}
        {sentBack(attempt) > 0 && (
          <span className="attempt-sentback">{shell.t("attempt.sent_back_n", { n: sentBack(attempt) })}</span>
        )}
        {attempt.model !== null && <span className="attempt-model">{shell.model(attempt.model)}</span>}
      </div>
    </div>
  );
}

function LandedRow({ landing, floor }: { landing: LandingEntry; floor: FloorState }) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  const attempt = landing.attempt_id === null ? undefined : floor.attempts[landing.attempt_id];
  const intent = landing.intent_id === null ? undefined : floor.intents[landing.intent_id];
  const name =
    attempt !== undefined
      ? attemptName(attempt, floor)
      : intent !== undefined
        ? changeName({ intentText: intent.text })
        : landingLabel(landing.seq);
  // FL3/AC3: a landing accepted but not landed is a row with no Why card - not a button.
  if (!whyOffered(landing)) {
    return (
      <div className="landed-row landed-pending">
        <span className="landed-seq">{landingLabel(landing.seq)}</span>
        <span className="landed-name" dir="auto">
          {name}
        </span>
        <span className="attempt-status">{t("status.accepted")}</span>
      </div>
    );
  }
  return (
    <button type="button" className="landed-row" data-kind={landing.kind}>
      <span className="landed-seq">{landingLabel(landing.seq)}</span>
      <span className="landed-name" dir="auto">
        {name}
      </span>
      <span className="landed-time">
        {landing.digest === true
          ? landing.landed_ts === null
            ? ""
            : timeOfDay(landing.landed_ts)
          : landing.landed === null
            ? ""
            : timeOfDay(landing.landed.ts)}
      </span>
    </button>
  );
}
