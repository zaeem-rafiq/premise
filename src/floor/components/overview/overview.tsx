// The Overview view (03-floor 2.11, owner's design decision of 2026-10-10): the pool as one hero,
// the counters told as one sentence, the work in flight as at most three cards, and one input.
// Every number and word comes from `FloorState` and `src/copy`; the Floor view keeps every detail
// one key away (F).

import "./overview.css";

import type { FloorState } from "../../../protocol/reducer/state.ts";
import { text } from "../../../copy/strings.ts";
import { inFlight } from "../../state/derive.ts";
import type { StripCell } from "../../state/derive.ts";
import { PoolFrame } from "../pool-frame/pool-frame.tsx";
import { IntentBox } from "../intent-box/intent-box.tsx";
import { StatusGlyph } from "../attempt-card/attempt-card.tsx";
import { cardModel } from "../attempt-card/model.ts";

/** 2.11: at most this many cards in flight; the rest are one tap away in the Floor view. */
const OVERVIEW_CARDS = 3;

export type OverviewProps = {
  pool: string;
  floor: FloorState;
  mode: "live" | "replay";
  owner: boolean;
  visitor: boolean;
  clock: number;
  capReached: boolean;
  /** The strip's cells: the facts line under the input reads every cell but the two in the headline. */
  cells: readonly StripCell[];
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
  onCompare?: () => void;
  onTapped?: (path: string) => void;
  onOpenCard: (cardId: string) => void;
  onFloor: () => void;
  /** RY23: on a quiet pool a visitor is offered the recording (the start card's action). */
  replayOffer?: { label: string; onPlay: () => void };
};

/** The headline and its second line (2.11), from the counters of 3.8. */
export function overviewHeadline(floor: FloorState): { title: string; line: string } {
  if (floor.n === 0) return { title: text("overview.loading"), line: "" };
  const landed = floor.counters.landed_changes;
  const title =
    landed === 0
      ? text("overview.landed.none")
      : `${text("overview.landed", { n: landed })} ${text("overview.goarounds", { n: floor.counters.go_arounds })}`;
  const waiting = floor.metrics?.waiting_behind ?? null;
  const line =
    waiting === null || waiting === 0 ? text("overview.waiting.none") : text("overview.waiting", { n: waiting });
  return { title, line };
}

export function Overview(props: OverviewProps) {
  const { floor } = props;
  const head = overviewHeadline(floor);
  const flying = Object.values(floor.attempts)
    .filter(inFlight)
    .sort((a, b) => b.last_event_ts - a.last_event_ts);
  const shown = flying.slice(0, OVERVIEW_CARDS);
  const facts = props.cells
    .filter((cell) => cell.id !== "strip.landed" && cell.id !== "strip.goarounds")
    .map((cell) =>
      cell.sub === undefined || cell.sub === ""
        ? `${cell.label} ${cell.value}`
        : `${cell.label} ${cell.value} — ${cell.sub}`,
    );

  return (
    <section className="overview" aria-label={text("overview.label")}>
      <header className="overview__head">
        <h1 className="overview__title">{head.title}</h1>
        {head.line !== "" && <p className="overview__line">{head.line}</p>}
        {props.replayOffer !== undefined && (
          <button type="button" className="primary overview__play" onClick={props.replayOffer.onPlay}>
            {props.replayOffer.label}
          </button>
        )}
      </header>

      <div className="overview__hero">
        {floor.pool.app === null ? (
          <p className="overview__noapp">{text("frame.no_app")}</p>
        ) : (
          <PoolFrame
            pool={props.pool}
            state={floor}
            mode={props.mode}
            paused={props.paused}
            onPausedChange={props.onPausedChange}
            onCompare={props.onCompare}
            onTapped={props.onTapped}
            selftest={false}
          />
        )}
      </div>

      <aside className="overview__side" aria-label={text("overview.inflight")}>
        <h2 className="overview__side-title">{text("overview.inflight")}</h2>
        {shown.length === 0 && <p className="overview__empty">{text("overview.inflight.none")}</p>}
        {shown.map((attempt) => {
          const model = cardModel(floor, attempt, props.clock, props.visitor);
          const open = model.cardId;
          return (
            <button
              key={attempt.id}
              type="button"
              className={`overview__card overview__card--${model.status.tone}`}
              data-attempt-id={attempt.id}
              onClick={() => (open !== null ? props.onOpenCard(open) : props.onFloor())}
            >
              <span className="overview__status">
                <StatusGlyph shape={model.status.shape} />
                <span>{model.status.word}</span>
              </span>
              <span className="overview__intent" dir="auto">
                &ldquo;{model.intent}&rdquo;
              </span>
              <span className="overview__meta">
                {[model.model, model.elapsed].filter((part) => part !== null && part !== "").join(" · ")}
              </span>
            </button>
          );
        })}
        <button type="button" className="overview__more" onClick={props.onFloor}>
          {text("overview.more")}
        </button>
      </aside>

      <div className="overview__ask">
        <IntentBox floor={floor} mode={props.mode} owner={props.owner} capReached={props.capReached} />
      </div>

      <p className="overview__facts">{facts.join("  ·  ")}</p>
    </section>
  );
}
