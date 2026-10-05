// From a model's tool call to a `ToolRequest` (TD3, TD4, TD5, TD6, TD7): argument parsing,
// the three normalizations N1 to N3, the calls the Agent refuses itself, and the envelope.
// Pure functions; they decide, the caller sends.

import { GUIDE_PATH } from "../../../protocol/agent-prompt.ts"; // the tide pool's guide; imported pools carry their own in `state.fills`
import { MAX_STATEMENT_CHARS, MODEL_MAX_TOKENS } from "../../../protocol/constants.ts";
import { PATH_PATTERN } from "../../../protocol/premise.ts";
import { TOOL_NAMES, type ToolName } from "../../../protocol/tools.ts";
import type { ToolCall } from "./rows.ts";
import type { LoopState } from "./state.ts";

export type ArgProblem = "not_json" | "missing" | "wrong_type" | "empty" | "conflict" | "too_long";

/** One refused call's outcome (TD4): the error code the model reads and its `detail`. */
export type CallOutcome = { kind: "request"; args: object } | { kind: "error"; code: string; detail: object };

/** N1: a leading `./` or `/` of a file path is removed; the single character `/` stays. */
function stripLeading(path: string): string {
  if (path === "/") return path;
  let out = path;
  while (out.startsWith("./") || (out.startsWith("/") && out !== "/")) {
    out = out.startsWith("./") ? out.slice(2) : out.slice(1);
  }
  return out;
}

/**
 * TD3: exactly the three normalizations of the table and no other, plus TD2's `delete: false` drop.
 * `path` arguments of `outline`, `read`, `list`, `search`, `write` and `replace` are file or directory
 * paths (N1); `list` gets its trailing `/` (N2); a `#` in the `path` of `read` or `outline` splits
 * (N3). Unknown arguments are kept (they are ignored later, TD4).
 */
export function normalizeArgs(tool: ToolName, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if (typeof out.path === "string") out.path = stripLeading(out.path);
  if (tool === "list" && typeof out.path === "string" && !out.path.endsWith("/")) {
    out.path = `${out.path}/`;
  }
  if (
    (tool === "read" || tool === "outline") &&
    typeof out.path === "string" &&
    out.path.includes("#") &&
    out.entity === undefined
  ) {
    const at = out.path.indexOf("#");
    const entity = out.path.slice(at + 1);
    out.path = out.path.slice(0, at);
    if (tool === "read") out.entity = entity;
  }
  if (tool === "write" && out.delete === false) delete out.delete;
  return out;
}

const REQUIRED_STRINGS: Record<ToolName, string[]> = {
  outline: ["path"],
  read: ["path"],
  list: ["path"],
  search: ["query"],
  write: ["path"],
  replace: ["path", "old", "new"],
  submit: ["summary"],
};

const OPTIONAL_STRINGS: Record<ToolName, string[]> = {
  outline: [],
  read: ["entity"],
  list: [],
  search: ["path"],
  write: ["content"],
  replace: [],
  submit: ["statement"],
};

function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Validate normalized arguments (TD4): the first `{ argument, problem }` that fails, or null.
 * A `path` argument is also checked against the path pattern — the model's `invalid_path` would
 * otherwise come back from Trunk; refusing it here is the same refusal with the same code family.
 */
export function validateArgs(
  tool: ToolName,
  args: Record<string, unknown>,
): { argument: string; problem: ArgProblem } | null {
  for (const name of REQUIRED_STRINGS[tool]) {
    const value = args[name];
    if (value === undefined) return { argument: name, problem: "missing" };
    if (typeof value !== "string") return { argument: name, problem: "wrong_type" };
    if (value === "") return { argument: name, problem: "empty" };
  }
  for (const name of OPTIONAL_STRINGS[tool]) {
    const value = args[name];
    if (value !== undefined && typeof value !== "string") return { argument: name, problem: "wrong_type" };
  }
  if (tool === "write") {
    const hasContent = typeof args.content === "string";
    const hasDelete = args.delete !== undefined;
    if (hasDelete && typeof args.delete !== "boolean") return { argument: "delete", problem: "wrong_type" };
    if (hasContent && args.delete === true) return { argument: "content", problem: "conflict" };
    if (!hasContent && args.delete !== true) {
      return {
        argument: "content",
        problem: args.content === undefined && args.delete === undefined ? "missing" : "wrong_type",
      };
    }
  }
  if (tool === "submit") {
    const statement = args.statement;
    if (typeof statement === "string" && statement.length > MAX_STATEMENT_CHARS) {
      return { argument: "statement", problem: "too_long" };
    }
  }
  return null;
}

/**
 * TD5, derived from the transcript: whether a whole-file `read` of the pool's guide — the tide
 * pool's `GUIDE.md` or the imported repository's own `guide_path` (06-repos IR9) — was answered
 * by Trunk. The file or an error both count; a TD4 refusal row (no `call_id`) does not. An
 * imported pool with no guide file has no guide rule: the rule reads satisfied for it.
 */
export function guideRead(state: LoopState): boolean {
  const guide = state.fills.guide;
  if (guide === null) return true;
  for (const row of state.rows) {
    if (row.role !== "tool" || row.tool !== "read" || row.call_id === null) continue;
    const args = (JSON.parse(row.content) as { args?: Record<string, unknown> }).args ?? {};
    if (args.path === guide && args.entity === undefined) return true;
  }
  return false;
}

/** `function.arguments` to an object (TD3): a JSON object, or `not_json` with `received` kept. */
export function parseCallArguments(
  raw: unknown,
): { ok: true; args: Record<string, unknown> } | { ok: false; received: string } {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return { ok: true, args: raw as Record<string, unknown> };
  }
  const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { ok: true, args: parsed as Record<string, unknown> };
    }
  } catch {
    // not JSON
  }
  return { ok: false, received: text.slice(0, 200) };
}

/** The `acknowledge` list a `submit` is given (TD6): unacknowledged `confirm`/`repair` heads-ups shown. */
export function submitAcknowledge(state: LoopState): number[] {
  return state.inbox
    .filter(
      (entry) =>
        entry.heads_up.hn > state.meta.acked_hn &&
        entry.heads_up.hn <= state.meta.shown_hn &&
        (entry.heads_up.result === "confirm" || entry.heads_up.result === "repair"),
    )
    .map((entry) => entry.heads_up.hn)
    .sort((a, b) => a - b);
}

/**
 * Process one model tool call: normalize (TD3), then refuse it itself (TD4, in the order of the
 * table's rows) or produce the arguments to send (TD2, TD5, TD6). `finishReason` decides
 * `output_cut` over `bad_arguments` (TD4).
 */
export function processCall(state: LoopState, call: ToolCall, finishReason: string | null): CallOutcome {
  const name = call.function.name;
  if (!isToolName(name)) {
    return { kind: "error", code: "unknown_tool", detail: { name } };
  }
  const parsed = parseCallArguments(call.function.arguments);
  if (!parsed.ok) {
    if (finishReason === "length") {
      return { kind: "error", code: "output_cut", detail: { max_tokens: MODEL_MAX_TOKENS } };
    }
    return {
      kind: "error",
      code: "bad_arguments",
      detail: { argument: "arguments", problem: "not_json", received: parsed.received },
    };
  }
  const normalized = normalizeArgs(name, parsed.args);
  const problem = validateArgs(name, normalized);
  if (problem !== null) {
    if (finishReason === "length") {
      return { kind: "error", code: "output_cut", detail: { max_tokens: MODEL_MAX_TOKENS } };
    }
    return { kind: "error", code: "bad_arguments", detail: problem };
  }
  if ((name === "write" || name === "replace" || name === "submit") && !guideRead(state)) {
    return { kind: "error", code: "guide_first", detail: { path: state.fills.guide } };
  }
  const out: Record<string, unknown> = { ...normalized };
  if (name === "submit") {
    const acknowledge = submitAcknowledge(state);
    out.acknowledge = acknowledge;
    const statement = out.statement;
    if (acknowledge.length > 0 && (typeof statement !== "string" || statement === "")) {
      return { kind: "error", code: "statement_required", detail: { heads_ups: acknowledge } };
    }
  }
  return { kind: "request", args: out };
}

/**
 * The `target` of a call for the tool row's bookkeeping and for `elided` stubs (TL14):
 * path, `path#entity`, directory key, query text or null.
 */
export function callTarget(tool: string, args: Record<string, unknown>): string | null {
  const path = typeof args.path === "string" ? args.path : null;
  switch (tool) {
    case "outline":
    case "write":
    case "replace":
      return path;
    case "read":
      return typeof args.entity === "string" && path !== null ? `${path}#${args.entity}` : path;
    case "list":
      return path;
    case "search":
      return typeof args.query === "string" ? args.query : null;
    default:
      return null;
  }
}

/** A `path` argument looks like a pool path (01-core 2.1); `invalid_path` is Trunk's check for it. */
export function looksLikePath(path: string): boolean {
  return PATH_PATTERN.test(path);
}
