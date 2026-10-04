// The conductor of 02-tidepool.md 7.11: the pure state machine that paces the hero conflict
// with the canned cast. Its input is the pool's event stream as the events arrive; its output
// is the next actions of the row it is on — start these patterns with these holds, tap this
// option on the open card, release these patterns, open the Compare view, send `probe` with
// `selftest` — and what it waits for next. It holds no clock and makes no call itself: the
// driver that plays it (a Node test, or the rehearsal script) performs each action and feeds
// every stream event back through `observe`.
//
// A row's waits are counted conditions over the events seen since the row began. `pattern` in
// a match resolves the event's attempt through `bind` (the driver binds each started pattern
// to its attempt id; `attempt.opened` carries no pattern name). `"*"` matches any present
// value.

import type { CardOption } from "../protocol/cards.ts";

/** One thing the conductor asks its driver to do. */
export type ConductorAction =
  | { type: "start"; patterns: string[]; hold_before_submit: string[] }
  | { type: "release"; patterns: string[] }
  | { type: "tap"; option: CardOption }
  | { type: "open_compare" }
  | { type: "probe"; selftest: true; frames: ["main", "plain"] };

/** One counted condition of a row's `until` (7.11's "Then waits for" cells). */
export type WaitCond = {
  /** The event's `type` (`op.recorded`, `card.opened`, `headsup.sent`, `landing.landed`, …). */
  event: string;
  /** Field equality; `"*"` matches any present value; `pattern` resolves via `bind`. */
  match?: Record<string, unknown>;
  /** How many matching events the row needs (default 1). */
  count?: number;
};

/** One row of the conductor's script: its actions, and what they wait for. */
export type ConductorRow = {
  actions: ConductorAction[];
  until: WaitCond[];
};

export type Conductor = {
  /** The row it is on; `script.length` when the run is over. */
  readonly row: number;
  readonly done: boolean;
  /** The actions the current row asks for; drains the queue (perform each once). */
  takeActions(): ConductorAction[];
  /** Record which attempt a started pattern opened as (the driver learns it first). */
  bind(pattern: string, attemptId: string): void;
  /** Feed one stream event. Advances the row when its `until` is complete. */
  observe(event: Record<string, unknown>): void;
};

export function createConductor(script: readonly ConductorRow[]): Conductor {
  let row = 0;
  const seen: Record<string, unknown>[] = [];
  const queue: ConductorAction[] = [...(script[0]?.actions ?? [])];
  const patterns = new Map<string, string>(); // attempt_id -> pattern id
  const cardOwners = new Map<string, string>(); // card_id -> its one attempt (from card.opened)
  const seqOwners = new Map<number, string>(); // landing seq -> attempt (from landing.accepted)
  // `card.closed` carries `attempt_id: null` (CD1); its card is resolved through the opened map.
  const attemptOf = (event: Record<string, unknown>): string | null => {
    const direct = event.attempt_id;
    if (typeof direct === "string") return direct;
    const card = event.card;
    if (typeof card === "object" && card !== null) {
      const ids = (card as { attempt_ids?: unknown }).attempt_ids;
      if (Array.isArray(ids) && ids.length === 1 && typeof ids[0] === "string") return ids[0];
    }
    const cardId = event.card_id;
    if (typeof cardId === "string") return cardOwners.get(cardId) ?? null;
    // `landing.landed` names no attempt: its `seq` resolves through the `landing.accepted`
    // of the same landing (EV5).
    const seq = event.seq;
    if (typeof seq === "number") return seqOwners.get(seq) ?? null;
    return null;
  };
  const complete = (): boolean => {
    if (row >= script.length) return true;
    return script[row]!.until.every((cond) => {
      const need = cond.count ?? 1;
      let got = 0;
      for (const e of seen) {
        if (e.type !== cond.event) continue;
        let ok = true;
        for (const [k, want] of Object.entries(cond.match ?? {})) {
          const have =
            k === "pattern"
              ? patterns.get(attemptOf(e) ?? "")
              : // `card.opened`/`card.updated` carry the card's fields under `card`.
                (e[k] ??
                (typeof e.card === "object" && e.card !== null ? (e.card as Record<string, unknown>)[k] : undefined));
          if (want === "*" ? have === undefined || have === null : have !== want) ok = false;
        }
        if (ok) got += 1;
      }
      return got >= need;
    });
  };
  return {
    get row() {
      return row;
    },
    get done() {
      return row >= script.length;
    },
    takeActions() {
      return queue.splice(0);
    },
    bind(pattern, attemptId) {
      patterns.set(attemptId, pattern);
    },
    observe(event) {
      if (this.done) return;
      const card = event.card;
      if (typeof card === "object" && card !== null) {
        const c = card as { card_id?: unknown; attempt_ids?: unknown };
        if (typeof c.card_id === "string" && Array.isArray(c.attempt_ids) && c.attempt_ids.length === 1) {
          cardOwners.set(c.card_id, c.attempt_ids[0] as string);
        }
      }
      if (event.type === "landing.accepted") {
        const seq = event.seq;
        const attempt = event.attempt_id;
        if (typeof seq === "number" && typeof attempt === "string") seqOwners.set(seq, attempt);
      }
      seen.push(event);
      while (complete() && row < script.length) {
        row += 1;
        seen.length = 0;
        if (row < script.length) queue.push(...script[row]!.actions);
        // A row with no waits completes at once; a later row may already hold events it
        // needs — `seen` resets, so no: only events after the row begins count.
      }
    },
  };
}

const OP = "op.recorded";
const HS = "headsup.sent";
const LANDED = "landing.landed";

/**
 * The rows of 7.11 for the canned hero conflict. `order` is the landing order; `seed` is the
 * pool's seed — on `tidepool` the held card paces S, on `tidepool-auto` (world/ is `auto`
 * there) the conductor paces it by holding `hero-s` instead (7.11's last table row).
 */
export function heroConductor(order: 1 | 2, seed: "tidepool" | "tidepool-auto"): Conductor {
  return createConductor(heroScript(order, seed));
}

/** The script rows, exported so a test can check the table itself. */
export function heroScript(order: 1 | 2, seed: "tidepool" | "tidepool-auto"): ConductorRow[] {
  const creatures = ["hero-j", "hero-c", "hero-h"];
  const stats = (selftest: boolean): WaitCond[] => [
    { event: "stats", match: selftest ? { frame: "main", selftest: "*" } : { frame: "main" } },
    { event: "stats", match: selftest ? { frame: "plain", selftest: "*" } : { frame: "plain" } },
  ];
  const compareProbe: ConductorRow[] = [
    { actions: [{ type: "open_compare" }], until: stats(false) },
    { actions: [{ type: "probe", selftest: true, frames: ["main", "plain"] }], until: stats(true) },
  ];
  const e2s: WaitCond[] = [
    { event: HS, match: { result: "repair", pattern: "hero-c" } },
    { event: HS, match: { result: "repair", pattern: "hero-h" } },
  ];
  const landed = (pattern: string): WaitCond => ({ event: LANDED, match: { pattern } });

  if (order === 1 && seed === "tidepool") {
    return [
      {
        actions: [{ type: "start", patterns: creatures, hold_before_submit: creatures }],
        until: [
          { event: OP, match: { path: "creatures/crab.js" } },
          { event: OP, match: { path: "creatures/shrimp.js" } },
        ],
      },
      {
        actions: [{ type: "start", patterns: ["hero-s"], hold_before_submit: [] }],
        until: [{ event: "card.opened", match: { kind: "held" } }],
      },
      compareProbe[0]!,
      {
        actions: [{ type: "tap", option: "land" }],
        until: [...e2s, landed("hero-s")],
      },
      {
        actions: [{ type: "release", patterns: creatures }],
        until: [
          landed("hero-c"),
          landed("hero-h"),
          landed("hero-j"),
          { event: "plain.updated", match: { through_seq: 4 } },
        ],
      },
      compareProbe[1]!,
    ];
  }

  if (order === 2 && seed === "tidepool") {
    return [
      {
        actions: [{ type: "start", patterns: ["hero-s"], hold_before_submit: [] }],
        until: [{ event: "submit.result", match: { status: "held", pattern: "hero-s" } }],
      },
      {
        actions: [{ type: "start", patterns: ["hero-c", "hero-h", "hero-j"], hold_before_submit: [] }],
        until: [
          landed("hero-c"),
          landed("hero-h"),
          landed("hero-j"),
          { event: HS, match: { result: "repair", pattern: "hero-s" } },
          { event: "card.closed", match: { action: "stale", pattern: "hero-s" } },
          { event: "card.opened", match: { kind: "held", pattern: "hero-s" } },
        ],
      },
      { actions: [{ type: "tap", option: "land" }], until: [landed("hero-s")] },
    ];
  }

  // `tidepool-auto` (7.11's last row): no card paces the run — the shared rule is `auto`
  // there — so `hero-s` itself is held and released.
  if (order === 1) {
    return [
      {
        actions: [{ type: "start", patterns: creatures, hold_before_submit: creatures }],
        until: [
          { event: OP, match: { path: "creatures/crab.js" } },
          { event: OP, match: { path: "creatures/shrimp.js" } },
        ],
      },
      {
        actions: [{ type: "start", patterns: ["hero-s"], hold_before_submit: ["hero-s"] }],
        until: [{ event: OP, match: { path: "world/energy.js", pattern: "hero-s" } }],
      },
      compareProbe[0]!,
      {
        actions: [{ type: "release", patterns: ["hero-s"] }],
        until: [...e2s, landed("hero-s")],
      },
      {
        actions: [{ type: "release", patterns: creatures }],
        until: [
          landed("hero-c"),
          landed("hero-h"),
          landed("hero-j"),
          { event: "plain.updated", match: { through_seq: "*" } },
        ],
      },
      compareProbe[1]!,
    ];
  }
  return [
    {
      actions: [{ type: "start", patterns: ["hero-s"], hold_before_submit: ["hero-s"] }],
      until: [{ event: OP, match: { path: "world/energy.js", pattern: "hero-s" } }],
    },
    {
      actions: [{ type: "start", patterns: ["hero-c", "hero-h", "hero-j"], hold_before_submit: [] }],
      until: [
        landed("hero-c"),
        landed("hero-h"),
        landed("hero-j"),
        { event: HS, match: { result: "repair", pattern: "hero-s" } },
      ],
    },
    { actions: [{ type: "release", patterns: ["hero-s"] }], until: [landed("hero-s")] },
  ];
}
