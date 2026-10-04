// The scripted pattern abstraction of 02-tidepool.md 10.3 to 10.5 (SW4 to SW8) and its registry.
// A pattern is the synchronous core that a `ScriptedDriver` (ports.ts) wraps: each turn it sees what
// the last call answered and the heads-ups that arrived, and it names the next tool call, a wait, or
// a stop. It holds no clock, no network and no chance: draws come from the agent's generator (SW1),
// passed in as `rand`.

import type { AgentStopReason } from "../protocol/attempt.ts";
import type { HeadsUp } from "../protocol/headsup.ts";
import type { ModelToolMessage, ToolName } from "../protocol/tools.ts";
import { ADD_ENERGY } from "./patterns/add-energy.ts";
import { ADD_PLAIN } from "./patterns/add-plain.ts";
import { ADD_RELATIVE } from "./patterns/add-relative.ts";
import { COSMETIC } from "./patterns/cosmetic.ts";
import { RESCALE_ENERGY } from "./patterns/rescale-energy.ts";

/** What a pattern asks for at one turn. The three kinds mirror `Driver.next` of `ports.ts`. */
export type PatternStep =
  | { kind: "tool"; tool: ToolName; args: object; state: unknown }
  | { kind: "wait"; state: unknown }
  | { kind: "stop"; reason: AgentStopReason; state: unknown };

/** One turn of a scripted agent. */
export type PatternTurn = {
  /** What the last tool call answered, as the driver recorded it; `null` before the first call. */
  last: ModelToolMessage | null;
  /** Heads-ups that arrived since the previous turn, raw `HeadsUp` form, ascending `hn`. */
  heads_ups: HeadsUp[];
  /** SW8: the launch held this pattern's agents before their first `submit`. */
  hold: boolean;
  /** SWR3: the launcher released this pattern's agents; once set it stays set. */
  released: boolean;
  /** The pattern's state, carried by the driver between turns; `null` before the first turn. */
  state: unknown;
  /** The agent's draw stream: `agentRandom(seed, n)` (SW1). */
  rand: () => number;
};

/** One canned edit pattern of 02-tidepool.md 10.3. */
export type Pattern = {
  /** The id `patterns` of `SwarmRequest` names, for example `"add-plain"`. */
  readonly id: string;
  /** The intent text the synthetic attempt is opened with. */
  readonly intent: string;
  /** The truth list (TR8): `<kind>:<key>` strings the canned change truly depends on. */
  readonly truth: readonly string[];
  /** The next synchronous step. */
  next(turn: PatternTurn): PatternStep;
};

/** The patterns the launcher knows, in table order of 02-tidepool.md 10.3. */
const PATTERNS: readonly Pattern[] = [ADD_PLAIN, ADD_ENERGY, ADD_RELATIVE, RESCALE_ENERGY, COSMETIC];

const BY_ID = new Map<string, Pattern>(PATTERNS.map((pattern) => [pattern.id, pattern]));

/** The pattern of an id of `SwarmRequest.patterns`, or `undefined` when the id is unknown. */
export function patternById(id: string): Pattern | undefined {
  return BY_ID.get(id);
}

/** Every known pattern id. */
export function patternIds(): readonly string[] {
  return PATTERNS.map((pattern) => pattern.id);
}
