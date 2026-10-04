// The `Driver` adapter for the Swarm's canned patterns (02-tidepool.md 10.3, SW4 to SW8): wraps
// a `Pattern` of `src/swarm` — the pure state machine — so the Agent Durable Object's pump can
// drive it exactly like a `ScriptedDriver` or a `ModelDriver`.
//
// Durable state: the pattern's own `state` plus the count of draws consumed from the agent's
// generator stream (SW1) — a restart fast-forwards the stream to the stored count, so the replay
// of a turn draws the same values the first run drew. `hold` is the launch's flag (SW8);
// `released` is read live every turn (SWR3 — a `/release` changes it while the object sleeps).
//
// SW6's `think_ms`: one wait before answering a heads-up — drawn from the launch's `[lo, hi]`
// range on the agent's own stream, awaited here (outside any transaction, AL4).

import type { Driver } from "../../protocol/ports.ts";
import type { AgentStopReason } from "../../protocol/attempt.ts";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { ModelToolMessage, ToolName } from "../../protocol/tools.ts";
import { agentRandom } from "../../swarm/prng.ts";
import type { Pattern } from "../../swarm/pattern.ts";

/** What the Agent stores in `driver_last`: the model's view plus the raw heads-ups a `Pattern`
 * consumes (`PatternTurn.heads_ups` is the `HeadsUp` shape, not `HeadsUpForModel`). */
export type PatternDriverLast = ModelToolMessage & { raw_heads_ups?: HeadsUp[] };

/** The durable form carried in the pump's `driver_state`: pattern state + stream position. */
type PatternDriverState = { p: unknown; draws: number };

export class PatternDriver implements Driver {
  readonly #pattern: Pattern;
  readonly #hold: boolean;
  readonly #thinkMs: [number, number];
  readonly #released: () => boolean;
  readonly #rand: () => number;
  #draws: number;

  constructor(
    pattern: Pattern,
    opts: {
      seed: number;
      agent_n: number;
      hold: boolean;
      think_ms?: [number, number];
      /** Reads the Agent's current released flag — live, so `/release` takes effect at the next turn. */
      released: () => boolean;
    },
  ) {
    this.#pattern = pattern;
    this.#hold = opts.hold;
    this.#thinkMs = opts.think_ms ?? [0, 0];
    this.#released = opts.released;
    this.#rand = agentRandom(opts.seed, opts.agent_n);
    this.#draws = 0;
  }

  #draw(): number {
    this.#draws += 1;
    return this.#rand();
  }

  /** One turn: feed the driver_last's raw heads-ups and the live hold/release flags to the
   * pattern; return its decision with the durable state (`PatternStep.state` is the wrapper's —
   * the pattern's own state plus the draw count at the decision). */
  async next(input: {
    last: ModelToolMessage | null;
    state: unknown;
  }): Promise<
    | { kind: "tool"; tool: ToolName; args: object; state: unknown }
    | { kind: "wait"; state: unknown }
    | { kind: "stop"; reason: AgentStopReason; state: unknown }
  > {
    const stored = (input.state ?? null) as PatternDriverState | null;
    const patternState = stored === null ? null : (stored.p ?? null);
    const target = stored === null ? 0 : typeof stored.draws === "number" ? stored.draws : 0;
    while (this.#draws < target) this.#draw();

    const last = input.last as PatternDriverLast | null;
    const heads_ups = last?.raw_heads_ups ?? [];
    if (heads_ups.length > 0) {
      // SW6: a heads-up is answered after one think_ms wait, drawn on the agent's stream.
      const [lo, hi] = this.#thinkMs;
      const think = lo + this.#draw() * Math.max(0, hi - lo);
      if (think > 0) await new Promise((resolve) => setTimeout(resolve, think));
    }

    const step = this.#pattern.next({
      last,
      heads_ups,
      hold: this.#hold,
      released: this.#released(),
      state: patternState,
      rand: () => this.#draw(),
    });
    const durable: PatternDriverState = { p: step.state, draws: this.#draws };
    switch (step.kind) {
      case "tool":
        return { kind: "tool", tool: step.tool, args: step.args, state: durable };
      case "wait":
        return { kind: "wait", state: durable };
      case "stop":
        return { kind: "stop", reason: step.reason, state: durable };
    }
  }
}
