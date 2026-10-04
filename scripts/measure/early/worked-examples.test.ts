// The worked examples of 05-agent.md sections 3.7 and 3.8, driven through the real loop
// (`processCall`, `messageForResponse`, `writeToolRow`) and the in-memory pool of ME3. Every
// asserted value comes from the specification: blob ids, entity `lines`, `added` lists, the
// `heads_up_first` message, the SP5 user message, and the two `submit_id`s of 4.9.

import { describe, it, expect } from "vitest";
import {
  messageForResponse,
  newLoopState,
  nextAction,
  processCall,
  startAttempt,
  toHeadsUpForModel,
  unshownRun,
  writeAssistantRow,
  writeToolRow,
  type LoopState,
  type ToolCall,
} from "../../../src/core/agent/loop/index.ts";
import { toolMessageFor } from "../../../src/core/agent/loop/tool-message.ts";
import type { ToolRequest, ToolResponse, ModelToolMessage, ToolName } from "../../../src/protocol/tools.ts";
import type { HeadsUp } from "../../../src/protocol/headsup.ts";
import { loadSeed } from "../models.ts";
import { newMemPool, type MemPool } from "./mem-pool.ts";
import { buildHeroHeadsUp, landEnergyChange, ENERGY_PATH } from "./heads-up.ts";

const CFG = { model: { options: {}, price: { input: 1, output: 1 } } };

/** `02-tidepool.md` 7.3 row J, verbatim: the jellyfish the model writes in 3.7 (498 bytes). */
const JELLYFISH = `import { SURFACE_Y, FLOOR_Y } from "../world/bounds.js";

const BELL = "purple";

export function spawn() {
  return { vy: -0.4 };
}

export function update(jellyfish) {
  if (jellyfish.y < SURFACE_Y + 40) jellyfish.vy = 0.4;
  if (jellyfish.y > FLOOR_Y - 60) jellyfish.vy = -0.4;
  jellyfish.y += jellyfish.vy;
}

export function draw(jellyfish, pen) {
  pen.alpha(0.8);
  pen.fill(BELL);
  pen.ellipse(0, 0, 16, 10);
  pen.line(-8, 6, -8, 22);
  pen.line(0, 6, 0, 26);
  pen.line(8, 6, 8, 22);
}
`;

/** `02-tidepool.md` 7.3 row C, verbatim: the crab the model writes in 3.8 (660 bytes). */
const CRAB = `import { ENERGY_MAX } from "../world/energy.js";
import { FLOOR_Y, bounce } from "../world/bounds.js";
import { step } from "../world/movement.js";

const SHELL = "orange";

export function spawn() {
  return { y: FLOOR_Y - 10, vx: 1, energy: ENERGY_MAX, hiding: false };
}

export function update(crab) {
  crab.hiding = crab.energy < 30;
  if (crab.hiding) return;
  step(crab);
  bounce(crab);
}

export function draw(crab, pen) {
  pen.fill(SHELL);
  if (crab.hiding) {
    pen.ellipse(0, 2, 16, 9);
    return;
  }
  pen.line(-14, 6, -24, 14);
  pen.line(14, 6, 24, 14);
  pen.circle(-20, -10, 6);
  pen.circle(20, -10, 6);
  pen.ellipse(0, 0, 18, 11);
}
`;

type Sent = { req: ToolRequest | null; response: ToolResponse | null; message: ModelToolMessage };

/**
 * One turn of the worked examples: an assistant row with the calls, then each call run through
 * `nextAction` -> `processCall` -> `pool.call` -> `messageForResponse` -> `writeToolRow`, exactly
 * as `run.ts` does it. Returns the request, response and model-facing message of each call.
 */
function turn(state: LoopState, pool: MemPool, attemptId: string, calls: Array<[ToolName, object]>): Sent[] {
  const toolCalls: ToolCall[] = calls.map(([name, args], i) => ({
    id: `call_${state.rows.length}_${i}`,
    type: "function",
    function: { name, arguments: args },
  }));
  writeAssistantRow(state, {
    answer: { content: "", tool_calls: toolCalls, finish_reason: "tool_calls" },
    model: "test-model",
    tokens_in: 1,
    tokens_out: 1,
    started_at: 0,
    ended_at: 0,
  });
  const out: Sent[] = [];
  for (const call of toolCalls) {
    const action = nextAction(state, CFG);
    expect(action.type).toBe("tool");
    if (action.type !== "tool") break;
    const outcome = processCall(state, action.call, "tool_calls");
    if (outcome.kind === "error") {
      const message = toolMessageFor({
        error: { code: outcome.code, detail: outcome.detail },
        heads_ups: unshownRun(state).show.map((hu) => toHeadsUpForModel(hu)),
      });
      writeToolRow(state, {
        tool: call.function.name,
        call_id: null,
        model_call_id: call.id,
        args: {},
        message,
        counts_step: false,
        started_at: 0,
        ended_at: 0,
      });
      out.push({ req: null, response: null, message });
      continue;
    }
    const req: ToolRequest = {
      attempt_id: attemptId,
      call_id: `${attemptId}:${state.rows.length + 1}`,
      ack: state.meta.shown_hn,
      tool: action.call.function.name as ToolName,
      args: outcome.args,
    };
    const response = pool.call(req);
    if (req.tool === "submit" && response.ok) {
      // TL10, as run.ts does it: `acked_hn` rises to the acknowledged numbers of a processed submit.
      const acks = (req.args as Record<string, unknown>).acknowledge;
      if (Array.isArray(acks)) {
        for (const hn of acks) {
          if (typeof hn === "number" && hn > state.meta.acked_hn) state.meta.acked_hn = hn;
        }
      }
    }
    const { message } = messageForResponse(state, response);
    writeToolRow(state, {
      tool: req.tool,
      call_id: req.call_id,
      model_call_id: call.id,
      args: outcome.args,
      message,
      trunk_error: response.error?.code ?? null,
      counts_step: true,
      started_at: 0,
      ended_at: 0,
    });
    state.meta.state = response.attempt.state;
    out.push({ req, response, message });
  }
  return out;
}

function newRun(attemptId: string, intentText: string): { state: LoopState; pool: MemPool } {
  const state = newLoopState();
  const pool = newMemPool({ attemptId, head: loadSeed() });
  startAttempt(state, intentText, 0);
  return { state, pool };
}

describe("05-agent 3.7 — a normal creature change (jellyfish, A01)", () => {
  const attemptId = "a_01JB2M7C6E0G4J8L2P6S0U4W8Y";
  const intent = "a jellyfish that drifts up and down";

  it("read GUIDE.md answers the seed blob id and unedited flag (row 4)", () => {
    const { state, pool } = newRun(attemptId, intent);
    const [sent] = turn(state, pool, attemptId, [["read", { path: "GUIDE.md" }]]);
    expect(sent?.message.result).toMatchObject({
      path: "GUIDE.md",
      oid: "e788bed259693c0311c1ac1b6a593ebb0b66e1ae",
      edited_by_you: false,
    });
    const result = sent?.message.result as { content?: string };
    expect(typeof result.content).toBe("string");
    expect((result.content as string).length).toBeGreaterThan(0);
  });

  it("outline world/bounds.js answers the eight entities of the spec table (row 6)", () => {
    const { state, pool } = newRun(attemptId, intent);
    const [sent] = turn(state, pool, attemptId, [["outline", { path: "world/bounds.js" }]]);
    expect(sent?.message.result).toEqual({
      path: "world/bounds.js",
      oid: "c6740fa3895cf3dc197af39cc57e492b7077233e",
      entities: [
        {
          name: "POOL_WIDTH",
          kind: "const",
          exports: ["POOL_WIDTH"],
          signature: "export const POOL_WIDTH",
          lines: [1, 2],
        },
        {
          name: "POOL_HEIGHT",
          kind: "const",
          exports: ["POOL_HEIGHT"],
          signature: "export const POOL_HEIGHT",
          lines: [3, 3],
        },
        {
          name: "SURFACE_Y",
          kind: "const",
          exports: ["SURFACE_Y"],
          signature: "export const SURFACE_Y",
          lines: [5, 6],
        },
        { name: "FLOOR_Y", kind: "const", exports: ["FLOOR_Y"], signature: "export const FLOOR_Y", lines: [8, 9] },
        {
          name: "isInside",
          kind: "function",
          exports: ["isInside"],
          signature: "export function isInside(x, y)",
          lines: [11, 14],
        },
        {
          name: "keepInside",
          kind: "function",
          exports: ["keepInside"],
          signature: "export function keepInside(creature)",
          lines: [16, 20],
        },
        {
          name: "bounce",
          kind: "function",
          exports: ["bounce"],
          signature: "export function bounce(creature)",
          lines: [22, 27],
        },
        {
          name: "wrap",
          kind: "function",
          exports: ["wrap"],
          signature: "export function wrap(creature)",
          lines: [29, 34],
        },
      ],
    });
  });

  it("entity reads answer the spec's source, lines and key (rows 8 and 9)", () => {
    const { state, pool } = newRun(attemptId, intent);
    const [a, b] = turn(state, pool, attemptId, [
      ["read", { path: "world/bounds.js", entity: "SURFACE_Y" }],
      ["read", { path: "world/bounds.js", entity: "FLOOR_Y" }],
    ]);
    expect(a?.message.result).toEqual({
      key: "world/bounds.js#SURFACE_Y",
      kind: "const",
      exports: ["SURFACE_Y"],
      source: "// The water line. Above it is sky.\nexport const SURFACE_Y = 40;",
      lines: [5, 6],
      edited_by_you: false,
    });
    expect(b?.message.result).toEqual({
      key: "world/bounds.js#FLOOR_Y",
      kind: "const",
      exports: ["FLOOR_Y"],
      source: "// The top of the sand. Below it is sand.\nexport const FLOOR_Y = 460;",
      lines: [8, 9],
      edited_by_you: false,
    });
  });

  it("write creatures/jellyfish.js answers the spec's write result (row 11)", () => {
    const { state, pool } = newRun(attemptId, intent);
    turn(state, pool, attemptId, [["read", { path: "GUIDE.md" }]]);
    const [sent] = turn(state, pool, attemptId, [["write", { path: "creatures/jellyfish.js", content: JELLYFISH }]]);
    expect(sent?.message.result).toEqual({
      path: "creatures/jellyfish.js",
      op_seq: 1,
      created: true,
      bytes: 498,
      added: [
        "creatures/jellyfish.js#(import ../world/bounds.js)",
        "creatures/jellyfish.js#BELL",
        "creatures/jellyfish.js#spawn",
        "creatures/jellyfish.js#update",
        "creatures/jellyfish.js#draw",
      ],
      altered: [],
      removed: [],
      relied_on_by: {},
    });
  });

  it("the whole 3.7 run ends validated with submit_id s_c11a9d010a564d48", () => {
    const { state, pool } = newRun(attemptId, intent);
    turn(state, pool, attemptId, [["read", { path: "GUIDE.md" }]]);
    turn(state, pool, attemptId, [["outline", { path: "world/bounds.js" }]]);
    turn(state, pool, attemptId, [
      ["read", { path: "world/bounds.js", entity: "SURFACE_Y" }],
      ["read", { path: "world/bounds.js", entity: "FLOOR_Y" }],
    ]);
    turn(state, pool, attemptId, [["write", { path: "creatures/jellyfish.js", content: JELLYFISH }]]);
    const [sent] = turn(state, pool, attemptId, [["submit", { summary: "Add a jellyfish that drifts up and down" }]]);
    expect(sent?.req?.ack).toBe(0);
    expect((sent?.req?.args as { acknowledge?: number[] }).acknowledge).toEqual([]);
    expect(sent?.message.result).toMatchObject({
      status: "validated",
      submit_id: "s_c11a9d010a564d48",
      tier: "auto",
    });
    // TL6: the state is validated, the loop makes no further model call.
    const action = nextAction(state, CFG);
    expect(action).toEqual({ type: "idle", why: "waiting" });
    // Six tool steps, five model calls (the spec's own count).
    expect(state.meta.tool_steps).toBe(6);
    expect(state.meta.model_calls).toBe(5);
  });
});

describe("05-agent 3.8 — repair after a heads-up (crab, P1a)", () => {
  const attemptId = "a_01JB2M7B5D9F3H7K1N5R9T3V7X";
  const intent = "a crab that hides in its shell when its energy drops below 30";

  it("the ENERGY_MAX entity read answers the spec's exact source (row of call_2)", () => {
    const { state, pool } = newRun(attemptId, intent);
    const [sent] = turn(state, pool, attemptId, [["read", { path: "world/energy.js", entity: "ENERGY_MAX" }]]);
    expect(sent?.message.result).toEqual({
      key: "world/energy.js#ENERGY_MAX",
      kind: "const",
      exports: ["ENERGY_MAX"],
      source: "// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 100;",
      lines: [1, 2],
      edited_by_you: false,
    });
  });

  it("write creatures/crab.js answers the spec's write result (row of call_6)", () => {
    const { state, pool } = newRun(attemptId, intent);
    turn(state, pool, attemptId, [["read", { path: "GUIDE.md" }]]);
    const [sent] = turn(state, pool, attemptId, [["write", { path: "creatures/crab.js", content: CRAB }]]);
    expect(sent?.message.result).toEqual({
      path: "creatures/crab.js",
      op_seq: 1,
      created: true,
      bytes: 660,
      added: [
        "creatures/crab.js#(import ../world/energy.js)",
        "creatures/crab.js#(import ../world/bounds.js)",
        "creatures/crab.js#(import ../world/movement.js)",
        "creatures/crab.js#SHELL",
        "creatures/crab.js#spawn",
        "creatures/crab.js#update",
        "creatures/crab.js#draw",
      ],
      altered: [],
      removed: [],
      relied_on_by: {},
    });
  });

  it("heads_up_first blocks the submit, carries the heads-up first, and marks it shown (MR1, HE1)", () => {
    const { state, pool } = newRun(attemptId, intent);
    turn(state, pool, attemptId, [["read", { path: "GUIDE.md" }]]);
    const [written] = turn(state, pool, attemptId, [["write", { path: "creatures/crab.js", content: CRAB }]]);
    expect(written?.response?.ok).toBe(true);

    // Landing 1 while the model's reply is in flight: the energy change lands, Trunk pushes the
    // heads-up of 3.8, and the attempt goes around (T8).
    const before = pool.fileAt("creatures/crab.js") as string;
    pool.landHead(ENERGY_PATH, landEnergyChange(pool.fileAt(ENERGY_PATH) as string));
    const hu = buildHeroHeadsUp({
      attemptId,
      creaturePath: "creatures/crab.js",
      creatureSource: before,
      now: 1_791_655_421_000,
    });
    expect(hu).not.toBeNull();
    pool.pushHeadsUp(hu as HeadsUp);

    const [sent] = turn(state, pool, attemptId, [
      ["submit", { summary: "Add a crab that hides in its shell when its energy is low" }],
    ]);
    expect(sent?.req?.ack).toBe(0);
    expect(sent?.response?.error?.code).toBe("heads_up_first");
    // MR1 key order: heads_ups first, then error; the exact because/what/your_lines of the spec.
    expect(sent?.message).toEqual({
      heads_ups: [
        {
          hn: 1,
          action: "repair",
          because:
            "Another change landed while you were working and changed something your change depends on, so check all of your work against the new version, fix what relied on the old one, and call submit with a statement.",
          changed_by: "make energy a fraction from 0 to 1",
          items: [
            {
              what: "`ENERGY_MAX` in world/energy.js changed, and your code references it. Anything in your files that relied on its old value or behaviour must change too, not only the lines in your_lines.",
              before:
                "// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 100;",
              after: "// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 1;",
              your_lines: [
                'creatures/crab.js:1 [(import ../world/energy.js)] import { ENERGY_MAX } from "../world/energy.js";',
                "creatures/crab.js:8 [spawn]   return { y: FLOOR_Y - 10, vx: 1, energy: ENERGY_MAX, hiding: false };",
              ],
            },
          ],
          dropped_edits: [],
        },
      ],
      error: {
        code: "heads_up_first",
        message:
          "Your call was not made, because a heads-up was waiting for you. Read heads_ups in this message first. Then make the call again if it is still right.",
      },
    });
    // HE1: the tool row carried it, so shown_hn is 1 and the row's step is recorded.
    expect(state.meta.shown_hn).toBe(1);
    expect(state.inbox[0]?.shown_step).toBe(state.rows.length);
    expect(state.rows.at(-1)?.role).toBe("tool");
  });

  it("the repair and the acknowledged submit end validated with submit_id s_263731a65dcf31da", () => {
    const { state, pool } = newRun(attemptId, intent);
    turn(state, pool, attemptId, [["read", { path: "GUIDE.md" }]]);
    turn(state, pool, attemptId, [["write", { path: "creatures/crab.js", content: CRAB }]]);
    const before = pool.fileAt("creatures/crab.js") as string;
    pool.landHead(ENERGY_PATH, landEnergyChange(pool.fileAt(ENERGY_PATH) as string));
    const hu = buildHeroHeadsUp({
      attemptId,
      creaturePath: "creatures/crab.js",
      creatureSource: before,
      now: 1_791_655_421_000,
    }) as HeadsUp;
    pool.pushHeadsUp(hu);

    // The heads-up blocks the first submit (ack 0)...
    turn(state, pool, attemptId, [
      ["submit", { summary: "Add a crab that hides in its shell when its energy is low" }],
    ]);
    // ...then a submit without a statement is refused by the Agent itself (TD6).
    const [refused] = turn(state, pool, attemptId, [
      ["submit", { summary: "Add a crab that hides in its shell when its energy is low" }],
    ]);
    expect(refused?.req).toBeNull();
    expect(refused?.message.error).toMatchObject({ code: "statement_required" });

    const [repaired] = turn(state, pool, attemptId, [
      ["replace", { path: "creatures/crab.js", old: "crab.energy < 30", new: "crab.energy < 0.3" }],
    ]);
    expect(repaired?.req?.ack).toBe(1);
    expect(repaired?.message.result).toEqual({
      path: "creatures/crab.js",
      op_seq: 2,
      targets: ["creatures/crab.js#update"],
      altered: [],
      added: [
        "creatures/crab.js#(import ../world/energy.js)",
        "creatures/crab.js#(import ../world/bounds.js)",
        "creatures/crab.js#(import ../world/movement.js)",
        "creatures/crab.js#SHELL",
        "creatures/crab.js#spawn",
        "creatures/crab.js#update",
        "creatures/crab.js#draw",
      ],
      removed: [],
      relied_on_by: {},
    });

    const [done] = turn(state, pool, attemptId, [
      [
        "submit",
        {
          summary: "Add a crab that hides in its shell when its energy is low",
          statement: "Energy is now a fraction from 0 to 1, so the crab hides below 0.3.",
        },
      ],
    ]);
    // TD6: the Agent added `acknowledge: [1]`; ack was 1 going out.
    expect(done?.req?.ack).toBe(1);
    expect((done?.req?.args as { acknowledge?: number[] }).acknowledge).toEqual([1]);
    expect(done?.message.result).toMatchObject({
      status: "validated",
      submit_id: "s_263731a65dcf31da",
      tier: "auto",
    });
    expect(state.meta.acked_hn).toBe(1); // TL10: the acknowledged heads-up is recorded
  });
});
