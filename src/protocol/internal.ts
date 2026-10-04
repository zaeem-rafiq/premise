// The internal contracts between the Durable Objects, the Workflows and the routes — the calls
// that never cross the client's wire and that the specification does not itself define
// (01-core.md's public protocol types live in their own files; this file holds only what the
// specification does not name). One definition per call: every lane imports from here.
//
// Choices made where the specification is silent (see the lane reports):
// - The Agent's `/open` is the Swarm launcher's shape (02-tidepool.md 10, TR8): `pool`,
//   `driver`, `pattern`, `seed`, `agent_n`, `truth`, `hold` are the fields the launcher sends.
//   The Agent also accepts `script` + `trunk_url` + `pool_id` for tests and for a driver the
//   launcher does not produce; they are optional here, required or rejected at the object.
// - `pool` is the pool's name on the Agent call (`pool_id` is accepted as the same value).
// - The Trunk's `/internal/open-attempt` names `intent` (not `intent_text`) for the intent's
//   text — the shorter name, matching `OpenArgs` of the engine.
// - The Floor's append answer keeps `appended`/`last_n`/`duplicate`/`error.code` as they were
//   implemented by the stream lane.
// - `FloorRead` is defined once here; the Floor builds it, the app server reads it.

import type { PoolEvent } from "./events.ts";
import type { HeadsUp } from "./headsup.ts";
import type { StreamSource } from "./stream.ts";
import type { ToolName } from "./tools.ts";
import type { FloorState } from "./reducer/index.ts";

// ---- Trunk Durable Object (the routes' and the launcher's internal calls) ----

/** `POST /internal/create-pool` (PL1): the Worker's pool route forwards the creation record and
 * the seed's files — Trunk is the only writer of the pool's tables. `files` is the seed's whole
 * tree (`path` -> contents) because the object cannot read deployment assets inside a transaction. */
export type TrunkCreatePoolRequest = {
  pool: string;
  seed: string;
  summary_only: boolean;
  request_id: string;
  /** The pool repo's remote address, without credentials (pool.state's `remote`). */
  remote: string;
  files: Record<string, string>;
};

export type TrunkCreatePoolResponse = { ok: true; pool?: string; already?: boolean } | { ok: false; error: unknown };

/** `POST /internal/open-attempt`: the launcher opens one attempt in the pool's Trunk before it
 * opens the Agent object (9.2 T1). `attempt_id` doubles as the Durable Object name. */
export type TrunkOpenAttemptRequest = {
  attempt_id: string;
  intent_id?: string;
  intent: string;
  agent_kind?: "real" | "synthetic";
  model?: string | null;
  race?: boolean;
  /** TR8: a synthetic attempt's truth list, `<kind>:<key>` strings. */
  truth?: string[] | null;
  requester?: string;
};

export type TrunkOpenAttemptResponse =
  | { ok: true; attempt_id: string; change_id: string; intent_id: string; already?: boolean }
  | { ok: false; error: string };

// ---- Agent Durable Object (the launcher and the heads-up push) ----

/** One scripted step of a canned agent (02-tidepool.md 10.3): the tool to call and its args.
 * `reapply` marks a step the driver re-issues when its edit was dropped (SW6). */
export type ScriptStep = { tool: ToolName; args: Record<string, unknown>; reapply?: boolean };

/** The canned script an `AgentOpenRequest` may carry directly (the launch POST carries the
 * pattern's fields instead when the Swarm launches; `script` serves tests and later drivers). */
export type Script = {
  pattern: string;
  truth: string[]; // "<kind>:<key>" strings (10.3, TR8)
  steps: ScriptStep[];
  repair?: {
    reread?: boolean; // re-read each truth premise the heads-up named before answering
    statement?: string; // the repair answer's statement (SW6)
    give_up_after?: number; // withdraw after this many repairs (SW7)
  };
  confirm_statement?: string; // the confirm answer's statement; default "not affected" (SW6)
  think_ms?: number; // the wait before answering a heads-up (SW6); default 0
};

/** `POST /open`: start (or idempotently re-acknowledge) an attempt's Agent (SW4, 9.8).
 * The Swarm's launch shape is the contract: `pool`, `driver`, `pattern`, `seed`, `agent_n`,
 * `truth`, `hold`, `think_ms`. The test/debug fields `script`, `trunk_url`, `pool_id`,
 * `agent_kind`, `model`, `revision`, `started_at` are accepted too. */
export type AgentOpenRequest = {
  attempt_id: string;
  intent_id: string;
  /** The attempt's change id as Trunk's open-attempt answered it (register carries it back). */
  change_id?: string;
  /** The pool, as the Swarm names it. */
  pool?: string;
  /** The pool, as the agent lane's earlier shape named it (`pool` wins when both are sent). */
  pool_id?: string;
  intent_text?: string;
  requester?: string;
  agent_kind?: "real" | "synthetic";
  model?: string | null;
  revision?: number;
  started_at?: number;
  driver?: "scripted";
  pattern?: string;
  seed?: number;
  agent_n?: number;
  truth?: string[];
  hold?: boolean;
  think_ms?: [number, number];
  script?: Script;
  /** Point the Agent's Trunk client at an HTTP endpoint instead of the Trunk object (tests). */
  trunk_url?: string;
};

export type AgentOpenResponse = { ok: true; attempt_id?: string; already?: boolean } | { ok: false; error: unknown };

/** `POST /push`: Trunk delivers heads-ups to the Agent (HU5). `pool` is informational; the object
 * is already named by `attempt_id`. */
export type AgentPushRequest = { attempt_id: string; pool?: string; heads_ups: HeadsUp[] };
export type AgentPushResponse = { ok: true } | { ok: false; error: unknown };

/** `POST /release` (SWR3): a held scripted agent may now call `submit`. */
export type AgentReleaseRequest = { attempt_id: string; pool: string; pattern: string };
export type AgentReleaseResponse = { ok: true } | { ok: false; error: unknown };

// ---- Floor Durable Object (every source's append, the app server's read) ----

/** `POST /internal/events` (EV2): an ordered batch from one source. `source_n` continues the
 * source's sequence inside `epoch`; the Floor answers `appended`, `duplicate` or a `gap` error
 * carrying the `source_n` it expected. */
export type FloorAppendRequest = {
  source: StreamSource;
  epoch: number;
  events: Array<{ source_n: number; event: Omit<PoolEvent, "n" | "t"> }>;
};

export type FloorAppendResponse =
  | { appended: number; last_n: number; duplicate?: boolean }
  | { error: { code: "bad_source" | "bad_append" | "gap"; expected?: number } };

/** `GET /internal/state` (FS2): everything the app server's routes need from the stream — never
 * a call to Trunk (AS16). */
export type FloorRead = {
  n: number;
  pool: {
    state: FloorState["pool"]["state"];
    head_seq: number;
    head_commit: string | null;
    landed_seq: number;
    landed_commit: string | null; // resolves the moving source `main`
  };
  green: { seq: number | null; commit: string | null }; // resolves `green`
  plain: { commit: string; tree: string; through_seq: number } | null; // resolves `plain`
  /** seq of a landing by its commit, while the state holds it (`<40 hex>` sources, AS11 seq). */
  landings_by_commit: Record<string, number>;
  /** seq of the last confirmed landing that changed each path (AS11's "newest paths"). */
  paths: Record<string, number>;
};

// ---- Model gate (the pool route's registration and the launcher's kill check) ----

/** `POST /internal/register-pool` on the `premise` gate object (EV2a). */
export type GateRegisterPoolRequest = { pool: string; request_id: string };
export type GateRegisterPoolResponse = { ok: true } | { ok: false; error: unknown };

/** `GET /killed` (SE10): the kill switch's state; `killed === true` stops all launching. */
export type GateKilledResponse = { killed: boolean };

// ---- Workflows ----

/** The `SWARM` Workflow's `create` params (EV2a): registering a pool with the launcher. */
export type SwarmRegisterPoolParams = { kind: "register_pool"; pool: string; request_id: string };
