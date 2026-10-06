// The rail of the Floor view (03-floor 3.2): the intent box with its disabled states (3.1,
// FL7), the tray of open cards, and the three tabs with counts — Working, Landed, Stopped.
// Every attempt is drawn by the floor-rail lane's `AttemptCard`; landings are rows, one per
// `landing.*` of the stream, that offer the Why card once `landing.landed` is on it
// (FL3/AC3). All mutating controls stay absent for a visitor and in Replay.
//
// The Working tab is the reduced stream read as CO9 orders it: attempts of one intent move
// as one group, intents with an attempt in a top state (`going_around`, `needs_confirm`)
// come first by entry time, the rest newest intent first. The reducer's `working_order`
// holds that order for the attempts it keeps; an `accepted` attempt leaves the order yet
// is still in flight — it must keep its card, reading "Landing…", until `landing.landed`
// (3.2, FL3). The list is therefore built from `state.attempts` with the same rules, not
// read off `working_order` alone. A `landed` attempt whose landing is confirmed dwells in
// place for the beat of 3.2 (1.2 s; 2 s with reduced motion) before it moves to Landed.

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { FloorState, AttemptView, LandingEntry } from "../../../protocol/reducer/state.ts";
import { ShellContext } from "../../app/context.ts";
import { inFlight, whyOffered } from "../../state/derive.ts";
import { landingConfirmed } from "../attempt-card/model.ts";
import { AttemptCard } from "../attempt-card/attempt-card.tsx";
import { changeName } from "../../../copy/names.ts";
import { landingLabel, timeOfDay } from "../../../copy/format.ts";
import { IntentBox } from "../intent-box/intent-box.tsx";
import { Tray } from "../tray/tray.tsx";

export type RailProps = {
  floor: FloorState;
  mode: "live" | "replay";
  owner: boolean;
  /** CP7: a visitor, and everyone in Replay (the owner sees `false`). */
  visitor: boolean;
  /** The page clock: the stream clock live, the recorded clock in Replay (FL9). */
  clock: number;
  /** The dwell of 3.2 the Working tab gives a landed card: 1.2 s, 2 s with reduced motion. */
  dwellMs: number;
  capReached: boolean;
  onSend: (text: string) => void;
  /** Opens the attempt's card sheet (`attempt.open_card` on a held card). */
  onOpenCard: (cardId: string) => void;
  /** Opens the Why card of a landed row (CO12). */
  onOpenWhy?: (seq: number) => void;
};

/** An attempt that still belongs to the Working tab: in flight (which counts `accepted`),
 * or `landed` while its `landing.landed` has not arrived — it reads "Landing…" too (FL3). */
function workingAttempt(floor: FloorState, attempt: AttemptView): boolean {
  return inFlight(attempt) || (attempt.state === "landed" && !landingConfirmed(floor, attempt));
}

/** The Working tab's order (CO9), built over every working attempt — including `accepted`,
 * which the reducer has already taken out of `working_order` (its own bookkeeping) but not
 * off the rail. */
export function workingOrder(floor: FloorState): AttemptView[] {
  const topGroupTs = new Map<string, number>();
  for (const attempt of Object.values(floor.attempts)) {
    if (attempt.top_ts === null) continue;
    topGroupTs.set(attempt.intent_id, Math.min(topGroupTs.get(attempt.intent_id) ?? attempt.top_ts, attempt.top_ts));
  }
  const rank = new Map<string, number>(Object.keys(floor.intents).map((id, index) => [id, index]));
  const working = Object.values(floor.attempts).filter((a) => workingAttempt(floor, a));
  const top = working
    .filter((a) => topGroupTs.has(a.intent_id))
    .sort((a, b) => (topGroupTs.get(a.intent_id) ?? 0) - (topGroupTs.get(b.intent_id) ?? 0));
  const rest = working
    .filter((a) => !topGroupTs.has(a.intent_id))
    .sort((a, b) => (rank.get(b.intent_id) ?? 0) - (rank.get(a.intent_id) ?? 0));
  return [...top, ...rest];
}

/**
 * One Working-tab row (3.14): a single attempt, or one race group — the intent text and
 * `race.group` over a compact row per candidate. Stopped candidates of reason `not_chosen`
 * stay in the group while a candidate still works (CO40).
 */
type WorkingItem =
  { kind: "attempt"; attempt: AttemptView } | { kind: "race"; intentId: string; members: AttemptView[] };

function workingItems(floor: FloorState, ordered: AttemptView[]): WorkingItem[] {
  const items: WorkingItem[] = [];
  const grouped = new Set<string>();
  for (const attempt of ordered) {
    if (!attempt.race) {
      items.push({ kind: "attempt", attempt });
      continue;
    }
    if (grouped.has(attempt.intent_id)) continue;
    grouped.add(attempt.intent_id);
    const members = ordered.filter((a) => a.intent_id === attempt.intent_id);
    const notChosen = Object.values(floor.attempts).filter(
      (a) => a.intent_id === attempt.intent_id && a.state === "stopped" && a.stop_reason === "not_chosen",
    );
    items.push({ kind: "race", intentId: attempt.intent_id, members: [...members, ...notChosen] });
  }
  return items;
}

/** A stopped `not_chosen` candidate belongs to its race group (CO40), not the Stopped tab. */
function inRaceGroup(floor: FloorState, attempt: AttemptView): boolean {
  return (
    attempt.stop_reason === "not_chosen" &&
    Object.values(floor.attempts).some((a) => a.intent_id === attempt.intent_id && a.race)
  );
}

export function Rail(props: RailProps) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  const { floor } = props;
  const [tab, setTab] = useState<"working" | "landed" | "stopped">("working");
  // The card sheet is the shell's: `onOpenCard` sets `SheetTarget.card`, which `app.tsx`
  // draws through the registered `sheet.card` entry — the one place it renders.
  const working = useMemo(() => workingOrder(floor), [floor, floor.n]);
  const landed = floor.landed_order.map((seq) => floor.landings[seq]).filter((l): l is LandingEntry => l !== undefined);
  const stopped = Object.values(floor.attempts).filter((a) => a.state === "stopped" && !inRaceGroup(floor, a));

  // The 3.2 dwell: a card whose `landing.landed` arrived keeps its place for `dwellMs`
  // before it moves to the Landed tab, so the "Landed" state reads in place.
  const landedAt = useRef(new Map<string, number>());
  const [now, setNow] = useState(() => Date.now());
  const dwelling = useMemo(() => {
    const out: AttemptView[] = [];
    for (const attempt of Object.values(floor.attempts)) {
      if (attempt.state !== "landed" || !landingConfirmed(floor, attempt)) {
        landedAt.current.delete(attempt.id);
        continue;
      }
      const seen = landedAt.current.get(attempt.id);
      if (seen === undefined) {
        landedAt.current.set(attempt.id, Date.now());
        out.push(attempt);
      } else if (now - seen < props.dwellMs) {
        out.push(attempt);
      }
    }
    return out;
    // `floor.n` ticks on every applied event; `now` re-reads the dwell map at deadlines.
  }, [floor, floor.n, now, props.dwellMs]);

  useEffect(() => {
    const timers: number[] = [];
    for (const seen of landedAt.current.values()) {
      const wait = props.dwellMs - (Date.now() - seen);
      if (wait > 0) timers.push(window.setTimeout(() => setNow(Date.now()), wait));
    }
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [floor.n, now, props.dwellMs]);

  const workingTab = [...working, ...dwelling];
  const items = workingItems(floor, workingTab);
  // CO10: the compact card form when more than five cards are on the rail.
  const compact = workingTab.length > 5;

  return (
    <aside className="rail" id="rail" aria-label={t("rail.label")}>
      <IntentBox floor={floor} mode={props.mode} owner={props.owner} capReached={props.capReached} />

      <Tray floor={floor} onOpenCard={props.onOpenCard} />

      <div className="tabs" role="tablist">
        {(
          [
            ["working", "rail.tab.working", workingTab.length],
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
          (workingTab.length === 0 ? (
            <p className="rail-empty">{t("rail.empty.working", { visitor: !props.owner })}</p>
          ) : (
            <>
              {items.map((item) =>
                item.kind === "attempt" ? (
                  <AttemptCard
                    key={item.attempt.id}
                    attempt={item.attempt}
                    state={floor}
                    clock={props.clock}
                    visitor={props.visitor}
                    compact={compact}
                    onOpenCard={props.onOpenCard}
                  />
                ) : (
                  <section className="race-group" key={item.intentId}>
                    <p className="race-group__intent" dir="auto">
                      &ldquo;{floor.intents[item.intentId]?.text ?? ""}&rdquo;
                    </p>
                    <p className="race-group__label">{t("race.group", { n: item.members.length })}</p>
                    {item.members.map((attempt) => (
                      <AttemptCard
                        key={attempt.id}
                        attempt={attempt}
                        state={floor}
                        clock={props.clock}
                        visitor={props.visitor}
                        compact
                        onOpenCard={props.onOpenCard}
                      />
                    ))}
                  </section>
                ),
              )}
              {/* CO10: past nine cards the list scrolls and the footer counts the rest. */}
              {workingTab.length > 9 && <p className="rail-more">{t("rail.more", { n: workingTab.length - 9 })}</p>}
            </>
          ))}
        {tab === "working" && floor.pool.summary_only && <p className="rail-summary">{t("rail.summary_only")}</p>}
        {tab === "landed" &&
          (landed.length === 0 ? (
            <p className="rail-empty">{t("rail.empty.landed")}</p>
          ) : (
            landed.map((landing) => (
              <div key={landing.seq}>
                <LandedRow landing={landing} floor={floor} onOpenWhy={props.onOpenWhy} />
                {Object.values(floor.attempts)
                  .filter(
                    (a) =>
                      a.intent_id === landing.intent_id &&
                      landing.intent_id !== null &&
                      a.state === "stopped" &&
                      a.stop_reason === "not_chosen",
                  )
                  .map((attempt) => (
                    <AttemptCard
                      key={attempt.id}
                      attempt={attempt}
                      state={floor}
                      clock={props.clock}
                      visitor={props.visitor}
                      compact
                    />
                  ))}
              </div>
            ))
          ))}
        {tab === "stopped" &&
          (stopped.length === 0 ? (
            <p className="rail-empty">{t("rail.empty.stopped")}</p>
          ) : (
            stopped.map((attempt) => (
              <AttemptCard
                key={attempt.id}
                attempt={attempt}
                state={floor}
                clock={props.clock}
                visitor={props.visitor}
                compact={compact}
                onOpenCard={props.onOpenCard}
              />
            ))
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

function LandedRow({
  landing,
  floor,
  onOpenWhy,
}: {
  landing: LandingEntry;
  floor: FloorState;
  onOpenWhy?: (seq: number) => void;
}) {
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
  const content = (
    <>
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
    </>
  );
  return onOpenWhy === undefined ? (
    <div className="landed-row" data-kind={landing.kind}>
      {content}
    </div>
  ) : (
    <button type="button" className="landed-row" data-kind={landing.kind} onClick={() => onOpenWhy(landing.seq)}>
      {content}
    </button>
  );
}
