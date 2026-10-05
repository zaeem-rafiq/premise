// `assembleMessages` (4.3) and the trimming of 4.4 (CX1 to CX6): the `messages` sent to the model,
// rebuilt from the transcript each call; read results are left out in CX4's order until the request
// is at or under CONTEXT_TARGET_CHARS, and CX5's hard limit stops the attempt instead.

import { CONTEXT_HARD_CHARS, CONTEXT_KEEP_TURNS, CONTEXT_TARGET_CHARS } from "../../../protocol/constants.ts";
import { firstUserMessage, systemPrompt, TIDE_FILLS, type PromptFills } from "../../../protocol/agent-prompt.ts";
import { TEXTS, type AgentTexts } from "./texts.ts";
import { decodeAssistant, decodeToolRow, type Row } from "./rows.ts";
import { renderToolMessage } from "./tool-message.ts";
import type { LoopState } from "./state.ts";

export type WireMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: object[] }
  | { role: "tool"; tool_call_id: string; content: string };

const READ_TOOLS = new Set(["outline", "read", "list", "search"]);

function wireOf(row: Row, elidedResult: object | undefined): WireMessage {
  switch (row.role) {
    case "system":
    case "user":
      return { role: row.role, content: row.content };
    case "assistant": {
      const body = decodeAssistant(row);
      const message: WireMessage = { role: "assistant", content: body.content };
      if (body.tool_calls.length > 0) {
        (message as { tool_calls?: object[] }).tool_calls = body.tool_calls.map((call) => ({
          id: call.id,
          type: "function",
          function: call.function,
        }));
      }
      return message;
    }
    case "tool": {
      const body = decodeToolRow(row);
      const message = { ...body.message };
      if (elidedResult !== undefined) message.result = elidedResult;
      return { role: "tool", tool_call_id: body.model_call_id, content: renderToolMessage(message) };
    }
  }
}

/** A `tool` row that can be elided (CX1): a read tool that was answered with a `result`. */
function elidable(row: Row): boolean {
  if (row.role !== "tool" || row.tool === null || !READ_TOOLS.has(row.tool)) return false;
  return decodeToolRow(row).message.result !== undefined;
}

/** `target` of TL14, stored on the tool row body at write time. */
function targetOf(row: Row): string | null {
  const body = decodeToolRow(row) as { args?: Record<string, unknown> };
  const args = body.args ?? {};
  switch (row.tool) {
    case "outline":
    case "write":
    case "replace":
    case "list":
      return typeof args.path === "string" ? args.path : null;
    case "read": {
      const path = typeof args.path === "string" ? args.path : null;
      return typeof args.entity === "string" && path !== null ? `${path}#${args.entity}` : path;
    }
    case "search":
      return typeof args.query === "string" ? args.query : null;
    default:
      return null;
  }
}

/** Same tool and same arguments (CX4): the `args` JSON sent to Trunk, compared as text. */
function sameCall(a: Row, b: Row): boolean {
  const bodyA = decodeToolRow(a) as { args?: object };
  const bodyB = decodeToolRow(b) as { args?: object };
  return a.tool === b.tool && JSON.stringify(bodyA.args ?? {}) === JSON.stringify(bodyB.args ?? {});
}

function isGuideRead(row: Row, guide: string): boolean {
  if (row.tool !== "read") return false;
  const args = (decodeToolRow(row) as { args?: Record<string, unknown> }).args ?? {};
  return args.path === guide && args.entity === undefined;
}

export type Assembled =
  | {
      ok: true;
      messages: WireMessage[];
      elided_steps: number[]; // row numbers left out by CX4 (journal.request, TL14)
    }
  | { ok: false; code: "context_overflow" };

/**
 * Build the `messages` of TL2 from the transcript (4.3), with the trimming of CX1 to CX5.
 * Nothing else is a source. Rows are never reordered or dropped; only a read `result` is replaced
 * by the stub of CX1, which keeps `heads_ups` and `error`.
 */
export function assembleMessages(state: LoopState, texts: AgentTexts = TEXTS): Assembled {
  const rows = state.rows;
  const replaced = new Set<number>();

  // CX3 (pins): the newest answered whole-file read of the pool's guide — the imported
  // repository's own `guide_path` (IR9); a guide-less pool pins nothing — and every read result
  // of the last CONTEXT_KEEP_TURNS turns. A turn is one assistant row and the tool rows that
  // follow it, so "the last N turns" is the tail after the Nth assistant row from the end.
  const pinned = new Set<number>();
  const guide = state.fills.guide;
  if (guide !== null) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row !== undefined && isGuideRead(row, guide) && elidable(row)) {
        pinned.add(row.step);
        break;
      }
    }
  }
  let turns = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row === undefined) continue;
    if (row.role === "assistant") {
      turns++;
      if (turns >= CONTEXT_KEEP_TURNS) break;
    }
    if (elidable(row)) pinned.add(row.step);
  }

  // CX4, first group: read results a later answered call with the same tool and same arguments
  // replaced, oldest first. A row whose own result was already left out still counts as "later"
  // only when it was itself answered — elision never removes the knowledge that it happened.
  const replacedBy = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    const earlier = rows[i];
    if (earlier === undefined || !elidable(earlier)) continue;
    for (let j = i + 1; j < rows.length; j++) {
      const later = rows[j];
      if (later !== undefined && elidable(later) && sameCall(earlier, later)) {
        replacedBy.add(earlier.step);
        break;
      }
    }
  }
  const first: Row[] = rows.filter((row) => replacedBy.has(row.step) && !pinned.has(row.step));
  const second: Row[] = rows.filter((row) => elidable(row) && !replacedBy.has(row.step) && !pinned.has(row.step));
  const order = [...first, ...second];

  const messages = () =>
    rows.map((row) =>
      wireOf(
        row,
        replaced.has(row.step)
          ? { elided: true, tool: row.tool, target: targetOf(row), note: texts.elided }
          : undefined,
      ),
    );
  for (const row of order) {
    if (JSON.stringify(messages()).length <= CONTEXT_TARGET_CHARS) break;
    replaced.add(row.step);
  }
  const out = messages();
  if (JSON.stringify(out).length > CONTEXT_HARD_CHARS) {
    return { ok: false, code: "context_overflow" };
  }
  return { ok: true, messages: out, elided_steps: [...replaced].sort((a, b) => a - b) };
}

/** CX1 of a fresh attempt: the first two rows — system prompt, then the request (SP1, SP2),
 * filled by the pool's own context (IR9 to IR11); a seed pool's rows are the tide pool's. */
export function firstRows(
  intentText: string,
  fills: PromptFills = TIDE_FILLS,
): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: systemPrompt(fills) },
    { role: "user", content: firstUserMessage(intentText, fills) },
  ];
}
