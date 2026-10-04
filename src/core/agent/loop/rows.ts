// The transcript rows of 01-core.md 3.3 and what their `content` column holds (05-agent.md 4.8, TL14).
// A row is one message, as the model receives it or said it, with the bookkeeping columns beside it.
// `content` is the plain text for `system` and `user` rows; for `assistant` and `tool` rows it is the
// JSON text of `AssistantContent` and `ToolRowBody`. Pure code: no I/O, no clock, no chance.

import type { ModelToolMessage } from "../../../protocol/tools.ts";
import { renderToolMessage } from "./tool-message.ts";

export type RowRole = "system" | "user" | "assistant" | "tool";

/** One tool call of an assistant message, as the model gave it (TL3, TD4). */
export type ToolCall = {
  id: string; // `call_<row>_<index>` when the model gave none (TL3)
  type: "function";
  function: { name: string; arguments: unknown }; // string or object; "{}" when it was not JSON (TD4)
  received?: string; // the first 200 characters of invalid JSON arguments, kept for the tool row
};

/** The `content` JSON of an `assistant` row: the message of TL3 with `finish_reason` (TL14). */
export type AssistantContent = {
  content: string; // always a string on the wire; "" when the model gave none (TL2)
  tool_calls: ToolCall[]; // left off the wire message when empty (4.3)
  finish_reason: string | null;
  reasoning?: string; // stored, never sent back (TL3)
};

/**
 * The `content` JSON of a `tool` row: "the message of MR1, with Trunk's own error text beside it" (TL14).
 * `args` holds the normalized arguments sent to Trunk (TD3) or the model's arguments for a refused call.
 * `model_call_id` is the id the model gave the call; it becomes the wire message's `tool_call_id`.
 */
export type ToolRowBody = {
  message: ModelToolMessage;
  trunk_error: string | null;
  args: object;
  model_call_id: string;
};

/** One transcript row (`transcript` of 01-core 3.3). `step` is also the row number: 1, 2, 3, ... */
export type Row = {
  step: number;
  role: RowRole;
  content: string;
  tool: string | null; // the tool name of a `tool` row
  call_id: string | null; // Trunk `call_id` of a real tool step; null for a TD4 row (TL14)
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  started_at: number;
  ended_at: number | null;
};

export function encodeAssistant(content: AssistantContent): string {
  return JSON.stringify(content);
}

export function decodeAssistant(row: Row): AssistantContent {
  return JSON.parse(row.content) as AssistantContent;
}

export function encodeToolRow(body: ToolRowBody): string {
  return JSON.stringify(body);
}

export function decodeToolRow(row: Row): ToolRowBody {
  return JSON.parse(row.content) as ToolRowBody;
}

/** The message a tool row carries to the model (4.3): role, the model's call id and the MR1 text. */
export function wireToolMessage(row: Row): { role: "tool"; tool_call_id: string; content: string } {
  const body = decodeToolRow(row);
  return { role: "tool", tool_call_id: body.model_call_id, content: renderToolMessage(body.message) };
}
