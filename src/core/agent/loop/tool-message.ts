// The tool message a model receives (MR1 to MR4): `ModelToolMessage` built from a `ToolResponse`
// plus the heads-up run the Agent is showing, and its compact-JSON text with the fixed key order.

import type { HeadsUpForModel, ModelToolMessage } from "../../../protocol/tools.ts";
import { errorSentence, type AgentTexts, TEXTS } from "./texts.ts";

/**
 * The `error` a model sees for `code`: its own code and `detail`, the sentence of 3.6 as `message`
 * (MR3, MR10). Trunk's own message is kept in the transcript row beside it, never sent.
 */
export function errorForModel(
  code: string,
  detail?: object,
  texts: AgentTexts = TEXTS,
): { code: string; message: string; detail?: object } {
  const error: { code: string; message: string; detail?: object } = { code, message: errorSentence(code, texts) };
  if (detail !== undefined) error.detail = detail;
  return error;
}

/**
 * Build a `ModelToolMessage`: `heads_ups` (each already a `HeadsUpForModel`) first when non-empty,
 * then exactly one of `result` (unchanged, MR2) and `error` (MR3).
 */
export function toolMessageFor(parts: {
  result?: object;
  error?: { code: string; detail?: object };
  heads_ups?: HeadsUpForModel[];
  texts?: AgentTexts;
}): ModelToolMessage {
  const message: ModelToolMessage = {};
  if (parts.heads_ups !== undefined && parts.heads_ups.length > 0) message.heads_ups = parts.heads_ups;
  if (parts.error !== undefined) {
    message.error = errorForModel(parts.error.code, parts.error.detail, parts.texts ?? TEXTS);
  } else {
    message.result = parts.result ?? {};
  }
  return message;
}

/** MR1: the compact JSON text, keys in the order `heads_ups`, `result`, `error`. */
export function renderToolMessage(message: ModelToolMessage): string {
  const out: Record<string, unknown> = {};
  if (message.heads_ups !== undefined && message.heads_ups.length > 0) out.heads_ups = message.heads_ups;
  if (message.result !== undefined) out.result = message.result;
  if (message.error !== undefined) out.error = message.error;
  return JSON.stringify(out);
}
