// The ports: the interfaces by which the engine and the Durable Objects reach storage, git, models and
// files. Implementations live under `src/worker/adapters/` or are scripted/test doubles; the pure core
// codes against these.
// Sources: 04-build-plan 1.3 (Sql, Driver), 01-core S1 (Pusher, NotesReader), S2 (TokenSource),
// S3 (AttemptRepoProvisioner), S5 (ModelPlan), S6 (Triage, SyncTriage, RiskJudge, TriageInput,
// TriageAnswers), 11.5 (Verifier), 02-tidepool 4.9 (PoolSource, Version).

import type { ErrCode } from "./events.ts";
import type { PremiseKind } from "./premise.ts";
import type { ToolRequest, ModelToolMessage } from "./tools.ts";
import type { AgentStopReason } from "./attempt.ts";
import type { VerifyResult } from "./green.ts";
import type { RiskAnswers } from "./cards.ts";

/** The engine's only door to storage. Synchronous. `transaction` maps to `ctx.storage.transactionSync`. */
export interface Sql {
  exec(
    query: string,
    ...bindings: Array<string | number | null | Uint8Array>
  ): { toArray(): Array<Record<string, unknown>> };
  transaction<T>(run: () => T): T;
}

/** What decides an agent's next step. `ModelDriver` asks a Workers AI model. `ScriptedDriver` wraps a
 * pattern of `src/swarm`. Both drive the same Agent Durable Object and the same seven Trunk tools. */
export interface Driver {
  next(input: { last: ModelToolMessage | null; state: unknown }): Promise<
    | { kind: "tool"; tool: ToolRequest["tool"]; args: object; state: unknown }
    | { kind: "wait"; state: unknown } // an exempt wait (AG3)
    | { kind: "stop"; reason: AgentStopReason; state: unknown } // the Agent then calls `stop` on Trunk (TA9)
  >;
}

// ---- S1. Push path ----

export type RefUpdate = { ref: string; old: string; new: string }; // old = 40 zeros to create

export type PushResult =
  | { ok: true; refs: Record<string, "ok"> }
  | { ok: false; kind: "rejected"; refs: Record<string, "ok" | "ng"> } // the reason text is not interpreted (LP5)
  | {
      ok: false;
      kind: "transport";
      code: ErrCode;
      http_status: number | null;
      retry_after_ms: number | null;
    };

export interface Pusher {
  push(input: {
    remote: string;
    token: string;
    updates: RefUpdate[];
    pack: Uint8Array;
    atomic: boolean;
    signal: AbortSignal;
  }): Promise<PushResult>; // aborted at PUSH_TIMEOUT_MS (LP5c)
  /** Reads the refs from the remote's ref advertisement (info/refs of receive-pack), never from a
   * binding read that may lag a push. */
  readRefs(input: {
    remote: string;
    token: string;
    refs: string[];
    signal: AbortSignal;
  }): Promise<Record<string, string | null>>;
}

export interface NotesReader {
  readNote(commit: string): Promise<string | null>;
  listNotes(): AsyncIterable<{ commit: string; blob: string }>;
}

// ---- S2. Token source ----

export interface TokenSource {
  /** Where to push now. `repo` and `remote` may change between calls only under option B (rotation). */
  writeTarget(pool_id: string): Promise<{ remote: string; repo: string; token: string; expires_at: number | null }>;
}

// ---- S3. Attempt repos ----

export interface AttemptRepoProvisioner {
  provision(attempt_id: string): Promise<{ repo: string } | { error: string; retry_after_ms: number }>;
}

// ---- S5. Model mix ----

export type ModelPlan = {
  workhorse: string; // "@cf/openai/gpt-oss-120b"
  race: string[]; // RACE_SIZE models
  per_minute: Record<string, number>; // enforced by the gate
  max_real_agents: number;
  prices_usd_per_mtok: Record<string, { in: number; out: number }>;
};

// ---- S6. Clef triage and risk ----

export type TriageInput = {
  attempt_id: string;
  intent: string;
  patch: Array<{ key: string; source: string }>; // added and altered entities, as in the attempt view
  premises: Record<
    string, // one entry per pending premise; the key is the question id
    {
      kind: PremiseKind;
      key: string;
      rule: string; // the triage row: E3, F4, F6, QT2 or QR4
      read_then: string | null;
      is_now: string | null;
      changed_by_intent: string | null;
      added?: Array<{ key: string; source: string | null }>; // listing and query premises: the gained members
      changed: string[]; // for a file premise: the entity keys of D (7.2); else []
    }
  >;
  truth: string[] | null; // synthetic attempts only (TR8); for QR4 the landed change's list
};

export type TriageAnswers = {
  answers: Record<string, number | null>; // one entry per premise id; null = unavailable
  model: string;
};

/** Asynchronous: Clef. Called after the transaction (TR2). One call per attempt per batch (7.3). */
export interface Triage {
  judge(input: TriageInput): Promise<TriageAnswers & { ms: number; error?: ErrCode }>;
}

/** Synchronous: answers inside the accept transaction (TR5). No promise, no `await`. */
export interface SyncTriage {
  judgeNow(input: TriageInput): TriageAnswers;
}

/** The `state` object of 01-core 10.4. */
export type RiskInput = {
  intent: string;
  summary: string;
  held_paths: string[];
  files: Array<{
    path: string;
    tier: "auto" | "held";
    entities: Array<{ key: string; before: string; after: string }>;
  }>;
};

export interface RiskJudge {
  judge(input: RiskInput): Promise<RiskAnswers>;
}

// ---- 11.5. The verifier ----

export interface Verifier {
  verify(input: { pool_id: string; seq: number; commit: string }): Promise<VerifyResult>;
}

// ---- S7. Reading pool files (02-tidepool 4.9) ----

export type Version = string; // "c-<40 hex>" | "p-<40 hex>"

export interface PoolSource {
  /** A moving source is resolved from the pool's Floor Durable Object state (SE19, FS2). A commit
   * source resolves to itself. */
  resolve(pool: string, source: string): Promise<{ version: Version; seq: number | null } | null>;
  /** `oid` is the git blob id of the bytes. */
  read(pool: string, version: Version, path: string): Promise<{ bytes: Uint8Array; oid: string } | null>;
  list(
    pool: string,
    version: Version,
    dir: string,
  ): Promise<Array<{ name: string; type: "file" | "dir"; oid: string }> | null>;
}
