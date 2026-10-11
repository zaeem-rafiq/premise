// The tool API between the Agent and Trunk: request and response envelopes, the seven tools' arguments
// and results, the four calls that are not tools, and the shapes the model sees.
// Source: 01-core 4.1 (envelopes), 4.3-4.9 (tools), 4.10-4.11 (sync), 4.12 (register), TA9 (stop),
// RS1 (resume), 8.2 (HeadsUpForModel); 05-agent 5.2 (the gate calls, on the model plane).

import type { PremiseRef, EntityKind } from "./premise.ts";
import type { AttemptState, AgentStopReason } from "./attempt.ts";
import type { Operation } from "./operations.ts";
import type { HeadsUp, HeadsUpItem } from "./headsup.ts";
import type { PremiseKind } from "./premise.ts";

export const TOOL_NAMES = ["outline", "read", "list", "search", "write", "replace", "submit"] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const ERROR_CODES = [
  "invalid_path",
  "invalid_args",
  "not_found",
  "not_a_module",
  "binary",
  "too_large",
  "read_first",
  "no_match",
  "ambiguous",
  "no_change",
  "parse_error",
  "heads_up_first",
  "limit_reached",
  "attempt_unknown",
  "attempt_closed",
  "pool_not_ready",
  "timeout",
] as const;

/** The fixed error code list of 01-core 4.1 (a response error is a code, not a sentence; SE5b). */
export type ErrorCode = (typeof ERROR_CODES)[number];

export type ToolError = { code: ErrorCode; message: string; detail?: object };

export type ToolRequest = {
  attempt_id: string;
  call_id: string; // unique per attempt; "<attempt_id>:<step>"
  ack: number; // highest heads-up number already placed in the model's context (HU6a)
  tool: ToolName;
  args: object;
  usage?: { model_calls: number; tokens_in: number; tokens_out: number }; // TA10; real agents only
};

export type ToolResponse = {
  call_id: string;
  ok: boolean;
  head_seq: number; // head when the call was served
  result?: object; // present when ok
  error?: ToolError;
  premises: PremiseRef[]; // see TA7
  heads_ups: HeadsUp[]; // heads-ups with hn > ack, ascending, from ack + 1 with no gap (TA8)
  heads_ups_more: boolean; // true when some heads-ups with hn > ack did not fit (TA8)
  attempt: { state: AttemptState; go_arounds: number; pull_backs: number };
};

// ---- The seven tools: arguments and results (01-core 4.3 to 4.9) ----

/** 4.3 `outline`: one module's entities. */
export type OutlineArgs = { path: string };
export type OutlineEntity = {
  name: string;
  kind: EntityKind;
  exports: string[];
  signature: string;
  lines: [number, number];
};
export type OutlineResult = { path: string; oid: string; entities: OutlineEntity[] };

/** 4.4 `read`: a whole file, or one entity when `entity` is given. */
export type ReadArgs = { path: string; entity?: string };
export type ReadFileResult = { path: string; oid: string; content: string; edited_by_you: boolean };
export type ReadEntityResult = {
  key: string;
  kind: EntityKind;
  exports: string[];
  source: string;
  lines: [number, number];
  edited_by_you: boolean;
};
export type ReadResult = ReadFileResult | ReadEntityResult;

/** 4.5 `list`: one directory, not recursive. A missing directory lists empty. */
export type ListArgs = { path: string }; // a directory key: ends in `/`, or `/` for the root
export type ListEntry = { name: string; type: "file" | "dir"; bytes?: number; yours?: true };
export type ListResult = { path: string; entries: ListEntry[]; truncated: boolean };

/** 4.6 `search`: a text search. `path` is a directory key or a file path (default `/`). */
export type SearchArgs = { query: string; path?: string };
export type SearchLine = { path: string; line: number; text: string; entity: string | null };
export type SearchResult = {
  query: string;
  in: string;
  lines: SearchLine[];
  containers: string[];
  truncated: boolean;
};

/** 4.7 `write`: create or replace a whole file, or `{ path, delete: true }`. */
export type WriteArgs = { path: string; content?: string; delete?: true };
export type WriteResult = {
  path: string;
  op_seq: number;
  created: boolean;
  bytes: number;
  added: string[];
  altered: string[];
  removed: string[];
  relied_on_by: Record<string, string[]>;
};

/** 4.8 `replace`: `old` must match the attempt view exactly once. */
export type ReplaceArgs = { path: string; old: string; new: string };
export type ReplaceResult = {
  path: string;
  op_seq: number;
  targets: string[];
  altered: string[];
  added: string[];
  removed: string[];
  relied_on_by: Record<string, string[]>;
};

/** 4.9 `submit`. `acknowledge` is the in-API field; the model's tool has only `summary` and `statement`. */
export type SubmitArgs = { summary: string; acknowledge?: number[]; statement?: string };

export type Check = { name: string; ok: boolean; detail?: string };

export const SUBMIT_ERRORS = [
  "empty_change",
  "parse_error",
  "import_unresolved",
  "banned_global",
  "banned_import",
  "too_large",
  "unknown_colour",
  "selftest_failed",
] as const;

export type SubmitError = (typeof SUBMIT_ERRORS)[number];

export type SubmitResult =
  | { status: "validated"; submit_id: string; tier: "auto"; checks: Check[]; duplicate?: true }
  | {
      status: "submitted";
      submit_id: string;
      waiting_for: Array<"clef_risk" | "triage">;
      checks: Check[];
      duplicate?: true;
    }
  | {
      status: "held";
      submit_id: string;
      card_id: string;
      tier: "held";
      checks: Check[];
      duplicate?: true;
    }
  | { status: "needs_confirm"; unresolved: number[] } // heads-up numbers
  | { status: "go_around"; unresolved: number[] }
  | { status: "rejected"; errors: Array<{ code: SubmitError; detail: object }> }
  | { status: "accepted"; seq: number } // in the outbox, not yet confirmed on main
  | { status: "landed"; seq: number; commit: string } // confirmed on main (LP9)
  | { status: "stopped"; reason: string };

// ---- The calls that are not tools (01-core 4.10 to 4.12, TA9, RS1) ----

/** 4.10 `sync`: Agent -> Trunk. Records no premise and costs no step. */
export type SyncRequest = { attempt_id: string; ack: number };
export type SyncResponse = {
  heads_ups: HeadsUp[];
  heads_ups_more: boolean;
  head_seq: number;
  attempt: { state: AttemptState; go_arounds: number; pull_backs: number };
};

/** 4.12 `register`: Agent -> Trunk, after a rebuild from Artifacts (3.6 step 6). */
export type RegisterRequest = {
  attempt_id: string;
  intent_id: string;
  change_id: string;
  revision: number;
  agent_kind: "real" | "synthetic";
  model: string | null;
  ops: Operation[]; // current operations, in op_seq order
  read_premises: Array<{ kind: PremiseKind; key: string; hash: string; seq: number }>;
  truth?: string[]; // synthetic attempts only (TR8)
};
export type RegisterResponse =
  | { ok: true; heads_ups: HeadsUp[]; attempt: SyncResponse["attempt"] }
  | { ok: false; error: "attempt_closed" | "pool_not_ready" | "invalid_args" };

/** TA9 `stop`: Agent -> Trunk. Idempotent. */
export type StopRequest = { attempt_id: string; reason: AgentStopReason };
export type StopResponse =
  | { ok: true; stop_reason: string; attempt: SyncResponse["attempt"] }
  | { ok: false; error: "attempt_unknown" | "attempt_closed" | "invalid_args" };

/** RS1 `resume`: Trunk -> Agent Durable Object, after the transaction of T19 or T21 has committed. */
export type ResumeRequest = {
  attempt_id: string;
  revision: number;
  cause: "retry" | "undo" | "revert";
  resume_n: number; // attempts.resumes after the transition: 1, 2, 3, ...
};
export type ResumeResponse =
  { ok: true; resume_n: number } | { ok: false; error: "model_unavailable" | "budget" | "attempt_unknown" };

// ---- What the model sees (01-core 4.11, 8.2) ----

/** The `tool` message the Agent sends the model for one tool call. `heads_ups` is the first key; omitted when empty. */
export type ModelToolMessage = {
  heads_ups?: HeadsUpForModel[];
  result?: object;
  error?: { code: string; message: string; detail?: object };
};

/** A heads-up as the model receives it (8.2): the model never sees `PremiseRef`, hashes or seqs. */
export type HeadsUpForModel = {
  hn: number;
  action: "none" | "confirm" | "repair"; // from HeadsUp.result: info, confirm, repair
  because: string; // one plain sentence built from the rule and the cause
  changed_by: string | null; // the other change's intent text
  items: Array<{
    what: string;
    before: string | null;
    after: string | null;
    added?: string[];
    removed?: string[];
    context?: Array<{ key: string; source: string }>; // 8.2
    checking?: true; // a triage answer is still awaited
    your_lines: string[];
  }>;
  dropped_edits: Array<{ path: string; why: string }>;
};

export type { HeadsUpItem };

// ---- The model gate, from the Agent's side (05-agent 5.2) ----

export type GateReserveRequest = {
  attempt_id: string;
  pool: string;
  model: string;
  request_bytes: number; // bytes of the JSON request body: the input-token bound of SE6
  max_tokens: number; // MODEL_MAX_TOKENS
};
export type GateReserveResponse =
  | { ok: true; reservation_id: string; expires_at: number }
  | { ok: false; refused: "spend_cap" | "killed" }
  | { ok: false; retry_after_ms: number }; // a rate bucket, or no free agent slot (SE8)
export type GateSettleRequest = {
  reservation_id: string;
  usage: { tokens_in: number; tokens_out: number } | null; // null: no usage was reported (SE6a)
};
export type GateReleaseRequest = { attempt_id: string };
