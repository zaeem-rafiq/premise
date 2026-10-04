// The model call itself (TL2, TL3, TL4) and the money arithmetic of SE6: parse a Workers AI answer
// into an `AssistantContent`, build the request body, and count tokens and cost. Pure functions.

import { TOOL_DEFINITIONS } from "../../../protocol/agent-prompt.ts";
import { MODEL_MAX_TOKENS } from "../../../protocol/constants.ts";
import type { ToolCall } from "./rows.ts";

export type ModelPrice = { input: number; output: number }; // USD per million tokens (MG2)

export type ParsedAnswer = {
  content: string;
  tool_calls: ToolCall[];
  finish_reason: string | null;
  reasoning?: string;
  usage: { prompt_tokens: number; completion_tokens: number } | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usageOf(raw: unknown): ParsedAnswer["usage"] {
  if (!isRecord(raw)) return null;
  const inTok = raw.prompt_tokens;
  const outTok = raw.completion_tokens;
  if (typeof inTok === "number" && Number.isFinite(inTok) && typeof outTok === "number" && Number.isFinite(outTok)) {
    return { prompt_tokens: inTok, completion_tokens: outTok };
  }
  return null;
}

function contentOf(raw: unknown): string | null {
  if (raw === undefined || raw === null) return "";
  return typeof raw === "string" ? raw : null;
}

function callOf(raw: unknown, row: number, index: number): ToolCall | null {
  if (!isRecord(raw)) return null;
  const fn = raw.function;
  if (!isRecord(fn) || typeof fn.name !== "string" || fn.name === "") return null;
  let args: unknown = fn.arguments;
  let received: string | undefined;
  if (typeof args === "string") {
    try {
      JSON.parse(args);
    } catch {
      // TD4: the assistant row stores "{}" as the arguments and the first 200 characters as `received`.
      received = args.slice(0, 200);
      args = "{}";
    }
  } else if (args === undefined) {
    args = "{}";
  }
  const call: ToolCall = {
    id: typeof raw.id === "string" && raw.id !== "" ? raw.id : `call_${row}_${index}`,
    type: "function",
    function: { name: fn.name, arguments: args },
  };
  if (received !== undefined) call.received = received;
  return call;
}

/**
 * TL3: read a Workers AI answer — `choices[0].message` with `content`, `tool_calls`,
 * `finish_reason`, `usage`, or the older `{ response, tool_calls }` shape. A tool call without an
 * `id` gets `call_<row>_<index>` (`row` is the step the assistant row will get). Any other answer
 * is `model_bad_output` (TL12): `null`.
 */
export function parseModelAnswer(raw: unknown, row: number): ParsedAnswer | null {
  if (!isRecord(raw)) return null;
  const usage = usageOf(raw.usage);
  if (Array.isArray(raw.choices)) {
    const first = raw.choices[0];
    if (!isRecord(first) || !isRecord(first.message)) return null;
    const message = first.message;
    const content = contentOf(message.content);
    if (content === null) return null;
    const rawCalls = message.tool_calls;
    if (rawCalls !== undefined && !Array.isArray(rawCalls)) return null;
    const calls: ToolCall[] = [];
    for (const [index, item] of (rawCalls ?? []).entries()) {
      const call = callOf(item, row, index);
      if (call === null) return null;
      calls.push(call);
    }
    const finish = typeof first.finish_reason === "string" ? first.finish_reason : null;
    const answer: ParsedAnswer = { content, tool_calls: calls, finish_reason: finish, usage };
    if (typeof message.reasoning === "string" && message.reasoning !== "") answer.reasoning = message.reasoning;
    return answer;
  }
  if (typeof raw.response === "string" || Array.isArray(raw.tool_calls)) {
    const content = contentOf(raw.response);
    if (content === null) return null;
    const rawCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
    const calls: ToolCall[] = [];
    for (const [index, item] of rawCalls.entries()) {
      if (!isRecord(item) || typeof item.name !== "string" || item.name === "") return null;
      const call = callOf({ function: { name: item.name, arguments: item.arguments } }, row, index);
      if (call === null) return null;
      calls.push(call);
    }
    const answer: ParsedAnswer = { content, tool_calls: calls, finish_reason: null, usage };
    if (typeof raw.reasoning === "string" && raw.reasoning !== "") answer.reasoning = raw.reasoning;
    return answer;
  }
  return null;
}

/** TL2: the request body of MP1 — `messages`, the tool definitions, `max_tokens`, the model options. */
export function buildModelRequest(opts: { messages: object[]; options?: object }): Record<string, unknown> {
  return {
    messages: opts.messages,
    // TOOL_DEFINITIONS is the block of 05-agent as text (its hash is pinned); the model takes the array.
    tools: JSON.parse(TOOL_DEFINITIONS) as object[],
    max_tokens: MODEL_MAX_TOKENS,
    ...(opts.options ?? {}),
  };
}

/** TL4: `cost_usd` from counted tokens and the model's prices (per million tokens). */
export function costUsd(tokensIn: number, tokensOut: number, price: ModelPrice): number {
  return (tokensIn * price.input + tokensOut * price.output) / 1_000_000;
}

/** SE6: a reservation's bound is `request_bytes` of input plus `max_tokens` of output. */
export function reservationBound(requestBytes: number, maxTokens: number, price: ModelPrice): number {
  return (requestBytes * price.input + maxTokens * price.output) / 1_000_000;
}
