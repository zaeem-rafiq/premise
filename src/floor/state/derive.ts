// The derived values of 03-floor 4.4 the shell reads, plus the banner list of 3.18 and the
// strip cells of 3.8. Pure functions of `FloorState` and the clock (FL1); every difference
// of times is a difference of `ts` values (FL9). Each has a unit test (4.4).

import { PUSH_STALL_MS, SPEND_NEAR_SHARE } from "../../protocol/constants.ts";
import type { FloorState, AttemptView } from "../../protocol/reducer/state.ts";

/** 4.4 `runClock`: the run clock is the clock minus the ts of the first intent.created,
 * or null while no intent exists (the strip shows `strip.dash` then - 3.8 loading/empty). */
export function runClock(state: FloorState, clock: number): number | null {
  if (state.first_intent_ts === null) return null;
  return Math.max(0, clock - state.first_intent_ts);
}

/** 4.4 `quietFor`: for attempts in working, going_around or needs_confirm (FR1). */
export function quietFor(attempt: AttemptView, clock: number): number {
  return Math.max(0, clock - attempt.last_event_ts);
}

/** 4.4 `sentBack`: go_arounds + pull_backs (01-core GA3). */
export function sentBack(attempt: AttemptView): number {
  return attempt.go_arounds + attempt.pull_backs;
}

/** 4.4 `pushStalled`: a push has been pending longer than PUSH_STALL_MS (FR6, banner 7). */
export function pushStalled(state: FloorState, clock: number): boolean {
  return state.push !== null && clock - state.push.first_accepted_ts > PUSH_STALL_MS;
}

/** 4.4 `capReached`: the gate refused the last request for the cap (SE7, FR8, banner 6). */
export function capReached(state: FloorState): boolean {
  return state.limits?.refusing === true;
}

/** 4.4 `greenRed`: the newest green.verified failed confirmed, and no revert has landed
 * after it (banner 8, strip `green.red`, 7 FR19). */
export function greenRed(state: FloorState): boolean {
  const last = state.green.last;
  if (last === null || last.ok || !last.confirmed) return false;
  for (const seq of state.landed_order) {
    const landing = state.landings[seq];
    if (landing === undefined) continue;
    if (landing.seq <= last.seq) break;
    if (
      landing.kind === "revert" &&
      landing.request_id !== null &&
      (landing.digest === true ? landing.landed_ts !== null : landing.landed !== null)
    )
      return false;
  }
  return true;
}

/** RY23 `quiet pool`: no attempt in flight and no landing arrived in the last 60 s. The
 * start card is shown to a visitor on a quiet pool. */
export const QUIET_POOL_MS = 60_000;

export function quietPool(state: FloorState, clock: number): boolean {
  if (state.working_order.length > 0) return false;
  const newest = state.landed_order[0];
  if (newest === undefined) return true;
  const landing = state.landings[newest];
  if (landing === undefined) return true;
  const ts = landing.digest === true ? landing.landed_ts : (landing.landed?.ts ?? landing.accepted_ts);
  if (ts === null) return true;
  return clock - ts > QUIET_POOL_MS;
}

/** FL3/AC3: the Why card is offered only once `landing.landed` is on the stream - a landing
 * accepted but not landed offers nothing (its card would hold `why.landing` and nothing
 * else, 3.9 held row, and no affordance opens it). */
export function whyOffered(landing: {
  digest?: false | true;
  landed?: { ts: number } | null;
  landed_ts?: number | null;
}): boolean {
  return landing.digest === true
    ? landing.landed_ts === null
      ? false
      : true
    : landing.landed !== null && landing.landed !== undefined;
}

/** Attempts that count as "in flight": every state before landed/stopped/declined etc. */
const IN_FLIGHT = new Set([
  "opened",
  "working",
  "going_around",
  "needs_confirm",
  "held",
  "submitted",
  "validated",
  "accepted",
]);

export function inFlight(attempt: AttemptView): boolean {
  return IN_FLIGHT.has(attempt.state);
}

/** The status word of an attempt (5.3). FL3: the word "Landed" depends only on
 * `landing.landed`. Between `landing.accepted` and `landing.landed` the page says
 * "Landing…" (`status.accepted`), even if an `attempt.state` event already says `landed`. */
export function statusWordId(attempt: AttemptView, state: FloorState): string {
  const seq = attempt.landed_seq;
  if (seq !== null) {
    const landing = state.landings[seq];
    const confirmed =
      landing !== undefined && (landing.digest === true ? landing.landed_ts !== null : landing.landed !== null);
    return confirmed ? "status.landed" : "status.accepted";
  }
  return `status.${attempt.state}`;
}

/** The strip cells of 3.8. Values are already display strings; `null` means `strip.dash`. */
export type StripCell = {
  id: string; // the label's copy id
  label: string;
  value: string;
  /** The value is a sentence, not a number: it draws at status size so a long string
   * keeps the strip's fixed height instead of overflowing the counter cell (3.8). */
  text?: boolean;
  sub?: string;
  /** 3.18 spend indicator: the bar's fill, 0..1 of the cap. */
  bar?: number;
  /** Hover or focus lists these lines (the `spend.model_line` of each model). */
  tip?: string[];
  tone: "neutral" | "confirm" | "changed" | "holds" | "checking" | "synthetic";
  title?: string;
};

import { STRINGS, text } from "../../copy/strings.ts";
import { fill } from "../../copy/fill.ts";
import { money, clock as clockText, duration } from "../../copy/format.ts";
import { modelName } from "../../copy/names.ts";

/** The `alt` form of a copy id (5.11), or its `text` when it has none. */
export function altText(id: string, vars: Parameters<typeof text>[1] = {}): string {
  const alt = STRINGS[id]?.alt;
  return alt === undefined ? text(id, vars) : fill(alt, vars);
}

/** The capitals word a `banner.*` id carries (5.11). */
export function bannerWord(id: string): string {
  const word = STRINGS[id]?.word;
  if (word === undefined) throw new Error(`copy: "${id}" has no banner word`);
  return word;
}

export function stripCells(
  state: FloorState,
  clock: number,
  opts: { greenFeature: "none" | "static" | "full" },
): StripCell[] {
  const dash = text("strip.dash");
  const run = runClock(state, clock);
  const cells: StripCell[] = [];

  cells.push({
    id: "strip.clock",
    label: text("strip.clock"),
    value: run === null ? dash : clockText(run),
    tone: "neutral",
  });

  // 3.8: `{n} of {max}` with the limit line; in a synthetic pool with no real attempt in
  // flight the cell reads `strip.agents.synthetic` (CO30).
  const realInFlight = Object.values(state.attempts).filter((a) => a.agent === "real" && inFlight(a)).length;
  const synthInFlight = Object.values(state.attempts).filter((a) => a.agent === "synthetic" && inFlight(a)).length;
  const agentsValue =
    state.pool.synthetic && realInFlight === 0
      ? text("strip.agents.synthetic", { n: synthInFlight })
      : text("strip.agents.value", { n: state.pool.real_agents, max: state.pool.max_real_agents });
  cells.push({
    id: "strip.agents",
    label: text("strip.agents"),
    value: state.n === 0 ? dash : agentsValue,
    text: state.pool.synthetic && realInFlight === 0 && state.n !== 0,
    sub: state.pool.synthetic && realInFlight === 0 ? undefined : text("strip.agents.limit"),
    tone: "neutral",
  });

  cells.push({
    id: "strip.landed",
    label: text("strip.landed"),
    value: state.n === 0 ? dash : `${state.counters.landed_changes}`,
    tone: "holds",
  });

  cells.push({
    id: "strip.goarounds",
    label: text("strip.goarounds"),
    value: state.n === 0 ? dash : `${state.counters.go_arounds}`,
    tone: "neutral",
  });

  const waiting = state.metrics?.waiting_behind ?? null;
  const backlog = state.metrics?.push_backlog ?? 0;
  cells.push({
    id: "strip.waiting",
    label: text("strip.waiting"),
    value: waiting === null ? dash : `${waiting}`,
    sub: backlog > 0 ? text("strip.waiting.backlog", { n: backlog }) : undefined,
    tone: "neutral",
  });

  // 3.8: the green-line cell, first matching row.
  const green = state.green;
  let greenCell: StripCell;
  if (opts.greenFeature === "none") {
    greenCell = {
      id: "strip.green",
      label: text("strip.green"),
      value: text("green.none"),
      text: true,
      tone: "neutral",
    };
  } else if (greenRed(state)) {
    greenCell = {
      id: "strip.green",
      label: text("strip.green"),
      value: text("green.red", { seq: green.last!.seq }),
      text: true,
      tone: "changed",
    };
  } else if (green.last !== null && !green.last.ok && !green.last.confirmed) {
    greenCell = {
      id: "strip.green",
      label: text("strip.green"),
      value: text("green.checking", { seq: green.last.seq }),
      text: true,
      tone: "checking",
    };
  } else if (green.seq === null) {
    greenCell = { id: "strip.green", label: text("strip.green"), value: dash, tone: "neutral" };
  } else if (green.runtime === "static") {
    greenCell = {
      id: "strip.green",
      label: text("strip.green"),
      value: text("green.static", { seq: green.seq }),
      text: true,
      tone: "holds",
    };
  } else {
    greenCell = {
      id: "strip.green",
      label: text("strip.green"),
      value: text("green.at", { seq: green.seq }),
      text: true,
      tone: "holds",
    };
  }
  cells.push(greenCell);

  // 3.18: the spend indicator - `spend.value` over a bar whose fill is the share of the
  // cap; near the cap the pair reads in the confirm tone and `spend.near` shows, at the
  // cap they are `changed` with `spend.reached` (FR7, FR8). Hover or focus on the cell
  // lists each model's use (`spend.model_line`).
  const limits = state.limits;
  if (limits === null) {
    cells.push({
      id: "strip.spend",
      label: text("strip.spend"),
      value: text("spend.unknown"),
      text: true,
      tone: "neutral",
    });
  } else {
    const share = limits.cap_usd > 0 ? limits.spend_usd / limits.cap_usd : 0;
    const reached = limits.refusing;
    const near = !reached && share >= SPEND_NEAR_SHARE;
    cells.push({
      id: "strip.spend",
      label: text("strip.spend"),
      value: text("spend.value", { spent: money(limits.spend_usd), cap: money(limits.cap_usd) }),
      text: true,
      sub: reached ? text("spend.reached") : near ? text("spend.near") : undefined,
      bar: Math.min(1, Math.max(0, share)),
      tip:
        limits.models.length === 0
          ? undefined
          : limits.models.map((m) =>
              text("spend.model_line", {
                model: modelName(m.model),
                used: m.used_last_minute,
                limit: m.per_minute,
              }),
            ),
      tone: reached ? "changed" : near ? "confirm" : "neutral",
    });
  }

  return cells;
}

/** One row of the banner stack (3.18, 5.11). `button` names the one action it may carry. */
export type BannerRow = {
  id: string; // the copy id the sentence comes from
  word: string; // the capitals word (5.11)
  sentence: string;
  button?: {
    id: string;
    label: string;
    action: "kill.allow" | "pool.rebuild";
    /** FR10/CO3: an owner action is off while the connection is lost. */
    disabled?: boolean;
  };
  tone: "synthetic" | "replay" | "changed" | "confirm";
};

/**
 * The banner list of 3.18, in the fixed order of the table. `view.swarm` picks the Swarm
 * variant of banner 1; `mode.replay` always lights banner 2 (RY3). Banners 1 and 2 are
 * drawn unconditionally when present; of the rest at most the first two (CO50). The
 * returned list is the full order - the component draws the first three and counts the
 * rest in `banner.more`.
 */
export function bannerList(
  state: FloorState,
  clock: number,
  opts: {
    replay: { active: boolean; synthetic: boolean; title: string; date: string };
    view: "floor" | "compare" | "swarm";
    connection: "connecting" | "open" | "lost";
    connectionTries: number;
    staleFor: number | null; // ms since the newest applied event's ts (banner.offline)
    owner: boolean;
    /** FR10/CO3: connection lost - owner controls of a banner are off. */
    offline?: boolean;
  },
): BannerRow[] {
  const rows: BannerRow[] = [];
  const syntheticCount = Object.values(state.attempts).filter((a) => a.agent === "synthetic").length;
  // CO48: in Swarm view the count names what the newest swarm.state runs, not the wall cells —
  // a summary_only pool's stream need not hold one attempt per agent before they open.
  const bannerCount = opts.view === "swarm" ? (state.swarm?.agents ?? syntheticCount) : syntheticCount;

  if (opts.view === "swarm" || opts.replay.synthetic || state.pool.synthetic) {
    const id = opts.view === "swarm" ? "banner.synthetic.swarm" : "banner.synthetic";
    rows.push({
      id,
      word: bannerWord(id),
      sentence: text(id, { n: bannerCount }),
      tone: "synthetic",
    });
  }
  if (opts.replay.active) {
    rows.push({
      id: "banner.replay",
      word: bannerWord("banner.replay"),
      sentence: text("banner.replay", { date: opts.replay.date, title: opts.replay.title }),
      tone: "replay",
    });
  }
  if (state.limits?.killed === true) {
    const landingsPaused = state.pool.state === "paused" && state.pool.reason === "owner";
    const id = landingsPaused ? "banner.killed.landings" : "banner.killed";
    rows.push({
      id,
      word: bannerWord(id),
      sentence: text(id),
      button: opts.owner
        ? { id: "kill.allow", label: text("kill.allow"), action: "kill.allow", disabled: opts.offline === true }
        : undefined,
      tone: "changed",
    });
  }
  if (state.pool.state === "paused") {
    const reason = state.pool.reason ?? "owner";
    const id = `banner.paused.${reason}`;
    rows.push({
      id,
      word: bannerWord(id),
      sentence: text(id),
      button:
        opts.owner && (reason === "diverged" || reason === "push_rejected")
          ? { id: "pool.rebuild", label: text("pool.rebuild"), action: "pool.rebuild", disabled: opts.offline === true }
          : opts.owner && reason === "owner"
            ? { id: "kill.allow", label: text("kill.allow"), action: "kill.allow", disabled: opts.offline === true }
            : undefined,
      tone: "changed",
    });
  }
  if (state.pool.state === "rebuilding") {
    rows.push({
      id: "banner.rebuilding",
      word: bannerWord("banner.rebuilding"),
      sentence:
        state.pool.rebuild === null
          ? altText("banner.rebuilding")
          : text("banner.rebuilding", { done: state.pool.rebuild.done, total: state.pool.rebuild.total }),
      tone: "confirm",
    });
  }
  if (capReached(state)) {
    rows.push({
      id: "banner.cap",
      word: bannerWord("banner.cap"),
      sentence: text("banner.cap", { cap: money(state.limits!.cap_usd) }),
      tone: "changed",
    });
  }
  if (pushStalled(state, clock)) {
    const push = state.push!;
    const pending = state.landed_order.filter((seq) => {
      const landing = state.landings[seq];
      return landing !== undefined && landing.batch_id === push.batch_id;
    }).length;
    rows.push({
      id: "banner.push",
      word: bannerWord("banner.push"),
      sentence: text("banner.push", {
        n: pending,
        tries: push.tries,
        seconds: Math.max(0, Math.ceil(((push.next_try_ts ?? clock) - clock) / 1000)),
      }),
      tone: "confirm",
    });
  }
  if (greenRed(state)) {
    const last = state.green.last!;
    const revert = Object.values(state.undo).find((entry) => entry.cause === "revert");
    const failed = last.failed.map((check) => check.name).join(", ");
    rows.push({
      id: "banner.green_red",
      word: bannerWord("banner.green_red"),
      sentence:
        revert === undefined
          ? altText("banner.green_red", { landing: last.seq, "failed checks": failed })
          : text("banner.green_red", {
              landing: last.seq,
              "failed checks": failed,
              landings: revert.reverted.map((seq) => `#${seq}`).join(", "),
            }),
      tone: "confirm",
    });
  }
  if (opts.connection === "lost") {
    rows.push({
      id: "banner.offline",
      word: bannerWord("banner.offline"),
      sentence: text("banner.offline", {
        n: opts.connectionTries,
        duration: opts.staleFor === null ? "0 s" : duration(opts.staleFor),
      }),
      tone: "confirm",
    });
  }
  return rows;
}
