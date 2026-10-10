// The contract between the gate's pure core and its Durable Object shell: the request and answer
// types of every call `apply` takes, the `limits` event body, and the effects the shell performs.
// All plain JSON. Sources: 05-agent 5.2 (the reserve/settle/release types verbatim), 01-core 12.1
// (`limits` event), 13.6 (KillRequest), EV2a (pool registration, source_n).

import type { PoolEvent } from "../../protocol/events.ts";
import type { KillRequest } from "../../protocol/routes.ts";
import type { GateState } from "./state.ts";

/** The price table of the model plan: USD per million tokens, input and output (MG2, S5). */
export type PriceTable = Record<string, { in: number; out: number }>;

// ---- The calls of 05-agent.md 5.2 ----

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

/** `POST /internal/claim` (07-mcp MC20): an outside attempt takes an agent slot with no model call. */
export type GateClaimRequest = { attempt_id: string; pool: string };

export type GateClaimResponse = { ok: true } | { ok: false; refused: "killed" } | { ok: false; retry_after_ms: number };

// ---- The rest of the shell's protocol (pool registration, kill, may-start, sweep) ----

/** `POST /internal/register-pool` (PL1, EV2a): the pool's id; `request_id` rides along so the route
 * can retry a registration without a second pool. */
export type GateRegisterPoolRequest = { pool: string; request_id?: string };

/** SE8/MG5: may a new real agent start? `attempt_id`, when given, is the asker: an attempt that
 * already holds a slot always may. */
export type GateMayStartRequest = { attempt_id?: string };

/** The expiry sweep (SE6a) and the throttled `limits` flush (SE9). No body. */
export type GateSweepRequest = Record<string, never>;

export type GateSettleResponse = {
  ok: true;
  charged_usd: number; // what the ledger took: the real cost, or the full bound (SE6a)
  found: boolean; // false: unknown or already settled — nothing changed (idempotent settle)
};

export type GateReleaseResponse = { ok: true; released: boolean };

export type GateRegisterPoolResponse = { ok: true; pool: string };

export type GateKillResponse = { ok: true; killed: boolean };

export type GateMayStartResponse =
  | { ok: true; real_agents: number; max_real_agents: number }
  | { ok: false; retry_after_ms: number; real_agents: number; max_real_agents: number };

export type GateSweepResponse = { ok: true; expired: number };

// ---- Events and effects ----

/** The `limits` event body as the Floor's append path takes it (EV2a): `PoolEvent` without `n`
 * and `t`, which the Floor assigns on append. Exactly the fields of the `limits` variant. */
export type LimitsEventBody = Omit<Extract<PoolEvent, { type: "limits" }>, "n" | "t">;

/** What the shell must do around the pure functions:
 * - `emit`: append `event` to `pool`'s stream through the source outbox of EV2a (`source` "gate",
 *   `epoch`, `source_n`), resending until the Floor confirms it.
 * - `pause_pool`: SE11 — `{"killed":true,"landings":false}` asks Trunk of `pool` to pause with
 *   reason `owner`. The pause itself is Trunk's.
 * - `resume_pool`: SE12 — `{"killed":false}` asks Trunk of `pool` to resume, but only when the
 *   pool is paused with `reason` `owner`. */
export type GateEffect =
  | { kind: "emit"; pool: string; epoch: number; source_n: number; event: LimitsEventBody }
  | { kind: "pause_pool"; pool: string; reason: "owner" }
  | { kind: "resume_pool"; pool: string; reason: "owner" };

// ---- The dispatch envelope ----

export type GateCall =
  | { call: "reserve"; request: GateReserveRequest }
  | { call: "settle"; request: GateSettleRequest }
  | { call: "release"; request: GateReleaseRequest }
  | { call: "claim"; request: GateClaimRequest }
  | { call: "register-pool"; request: GateRegisterPoolRequest }
  | { call: "kill"; request: KillRequest }
  | { call: "may-start"; request: GateMayStartRequest }
  | { call: "sweep"; request?: GateSweepRequest };

export type GateAnswer =
  | GateReserveResponse
  | GateSettleResponse
  | GateReleaseResponse
  | GateClaimResponse
  | GateRegisterPoolResponse
  | GateKillResponse
  | GateMayStartResponse
  | GateSweepResponse;

export type GateResult = { state: GateState; answer: GateAnswer; effects: GateEffect[] };
