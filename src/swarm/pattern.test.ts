// src/swarm/pattern.test.ts — the SW6 audit over the whole pattern registry.
//
// A tool answer with `error.code === "timeout"` — the reset error of the
// soak — reaches a pattern only when its retries are spent; nothing will ask
// the question again. SW6: a failure the script cannot fix ends the attempt
// with `stop` `withdrawn`. A pattern that answered the error with `wait`
// would wait forever — the consumed answer is never re-asked. This file
// drives every registered pattern through a canned run and probes every
// state a call was issued under with the `timeout` answer.

import { describe, expect, it } from "vitest";
import type { HeadsUp } from "../protocol/headsup.ts";
import type { ModelToolMessage, ToolName } from "../protocol/tools.ts";
import { patternById, patternIds, type Pattern, type PatternStep } from "./pattern.ts";
import { agentRandom } from "./prng.ts";

const TIMEOUT: ModelToolMessage = { error: { code: "timeout", message: "call timed out" } };

// The tidepool seed's shape: two creatures already exist, the world files
// carry the constants the canned patterns read, and every call succeeds.
const GENERIC_SOURCE = `export const ENERGY_MAX = 100;
export const REST_TICKS = 300;
export const MAX_SPEED = 3;
export const FOOD_EVERY = 30;
export const DAY_TICKS = 3600;
export const SPEED = 1;
export const WANDER_MAX = 8;
export const COLOUR = "red";
export function spawn() { return { speed: SPEED }; }
export function update(p) { if (creature.energy < 30) p.speed = SPEED; return p; }
`;

function respond(tool: ToolName, args: Record<string, unknown>): ModelToolMessage {
  switch (tool) {
    case "list":
      return {
        result: {
          path: args.path,
          entries: [
            { name: "s0000.js", type: "file", bytes: 100 },
            { name: "s0001.js", type: "file", bytes: 100 },
          ],
          truncated: false,
        },
      };
    case "read":
      return args.entity === undefined
        ? { result: { path: args.path, oid: "0".repeat(40), content: GENERIC_SOURCE, edited_by_you: false } }
        : {
            result: {
              key: `${args.path}#${args.entity}`,
              kind: "entity",
              exports: [args.entity],
              source: GENERIC_SOURCE,
              lines: [1, 6] as [number, number],
              edited_by_you: false,
            },
          };
    case "outline":
      return {
        result: {
          path: args.path,
          oid: "0".repeat(40),
          entities: [
            { name: "spawn", line: 5 },
            { name: "update", line: 6 },
          ],
          edited_by_you: false,
        },
      };
    case "search":
      return { result: { matches: [{ path: "creatures/s0000.js", entity: "update", line: 1, text: "update" }] } };
    case "write":
      return {
        result: {
          path: args.path,
          op_seq: 1,
          created: true,
          bytes: 0,
          added: [],
          altered: [],
          removed: [],
          relied_on_by: {},
        },
      };
    case "replace":
      return {
        result: {
          path: args.path,
          op_seq: 2,
          targets: [],
          relied_on_by: { "world/energy.js#ENERGY_MAX": ["creatures/s0000.js#update"] },
        },
      };
    case "submit":
      return { result: { status: "validated", submit_id: "s_1", tier: "auto", checks: [] } };
    default:
      return { result: {} };
  }
}

/** The states under which the pattern had a call in flight, from a run of
 * canned answers — the soak saw its failures mid-script, so each is probed. */
function issuedStates(pattern: Pattern): { state: unknown; tool: ToolName }[] {
  const issued: { state: unknown; tool: ToolName }[] = [];
  const rand = agentRandom(1, 0);
  let state: unknown = null;
  let last: ModelToolMessage | null = null;
  for (let i = 0; i < 40; i += 1) {
    const step: PatternStep = pattern.next({
      last,
      heads_ups: [] as HeadsUp[],
      hold: false,
      released: true,
      attempt_id: "a_probe",
      state,
      rand,
    });
    state = step.state;
    if (step.kind !== "tool") break;
    issued.push({ state: JSON.parse(JSON.stringify(state)) as unknown, tool: step.tool });
    last = respond(step.tool, step.args as Record<string, unknown>);
  }
  return issued;
}

describe("SW6: every pattern answers a `timeout` tool error with stop withdrawn", () => {
  it.each(patternIds())("%s", (id) => {
    const pattern = patternById(id);
    expect(pattern).toBeDefined();
    const issued = issuedStates(pattern as Pattern);
    expect(issued.length).toBeGreaterThan(0);
    for (const [i, point] of issued.entries()) {
      const probe = (pattern as Pattern).next({
        last: TIMEOUT,
        heads_ups: [],
        hold: false,
        released: true,
        attempt_id: "a_probe",
        state: JSON.parse(JSON.stringify(point.state)) as unknown,
        rand: agentRandom(1, 0),
      });
      // A `wait` here waits forever: the answer was consumed and nothing asks again.
      expect(probe.kind, `state ${i} after ${point.tool}`).toBe("stop");
      if (probe.kind === "stop") expect(probe.reason).toBe("withdrawn");
    }
  });
});
