// The model gate's Durable Object shell — one object per deployment, named "premise" (MG1). It is
// the durable wrapper around the pure gate of `src/core/gate/**`: every internal call loads the
// stored `GateState`, runs `apply` against it with the deployment's `MODEL_PLAN` and prices, stores
// the returned state in the same transaction BEFORE any effect runs, and arms the alarm at
// `nextWakeup` (the earliest reservation expiry, SE6a, or a held-back `limits` flush, SE9 —
// whichever a delivery retry comes first).
//
// The calls (each typed in `src/protocol/internal.ts`): `POST /internal/reserve` (SE6),
// `POST /internal/settle` (SE6a), `POST /internal/release` (the attempt's agent slot),
// `POST /internal/may-start` (SE8), `POST /internal/register-pool` (EV2a — the pool's first
// `limits` event is owed at once), `POST /internal/kill` and the owner route's `POST /api/kill`
// (SE10-SE12), `GET /killed` (SE10, the swarm launcher's check). `/internal/state` and
// `/internal/alarm` are the shell's own test and observability paths, same as Trunk's; the alarm
// path accepts an optional `{now}` so a test drives the sweep at a chosen time without sleeping.
//
// `emit` effects leave through the per-pool outbox of `deliver.ts` (EV2a: source "gate", the
// gate's `epoch`, that pool's own `source_n`; a row deleted only when the pool's Floor confirmed
// it; retries ride the alarm). `pause_pool`/`resume_pool` go to `effects.ts` — Trunk answers no
// entry for an owner pause today, so they deliberately deliver nothing.
//
// The spend cap is the environment's `SPEND_CAP_USD`, read on every load: the stored state keeps
// what was spent and reserved, never the cap, so a deployment that lowers the cap is bound by it
// at once. A variable that is absent, not a number or negative gives a cap of 0: every model call
// is refused with `spend_cap` (SE7). The gate guards the owner's budget, so it fails closed.
// `GET /killed` reads the stored state only: an uninitialized gate is not killed (SE10).

import { DurableObject } from "cloudflare:workers";
import { apply, initialState, nextWakeup } from "../../core/gate/index.ts";
import type {
  GateAnswer,
  GateCall,
  GateEffect,
  GateMayStartRequest,
  GateRegisterPoolRequest,
  GateReleaseRequest,
  GateReserveRequest,
  GateSettleRequest,
  GateState,
} from "../../core/gate/index.ts";
import { MODEL_PLAN } from "../../config/model-plan.ts";
import type { KillRequest } from "../../protocol/routes.ts";
import type { Sql } from "../../protocol/ports.ts";
import type { Env } from "../env.ts";
import { notBuilt } from "../not-built.ts";
import { sqlOver } from "../sql-port.ts";
import { deliverDue, nextRetryAt } from "./deliver.ts";
import { pausePoolForOwner, resumePoolForOwner } from "./effects.ts";
import { applyGateSchema, gateMetaGet, gateMetaSet, outboxAll, outboxAppend, outboxPoolAll } from "./store.ts";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asReserve(body: unknown): GateReserveRequest | null {
  if (
    !isRecord(body) ||
    typeof body.attempt_id !== "string" ||
    typeof body.pool !== "string" ||
    typeof body.model !== "string" ||
    typeof body.request_bytes !== "number" ||
    typeof body.max_tokens !== "number"
  ) {
    return null;
  }
  return {
    attempt_id: body.attempt_id,
    pool: body.pool,
    model: body.model,
    request_bytes: body.request_bytes,
    max_tokens: body.max_tokens,
  };
}

function asSettle(body: unknown): GateSettleRequest | null {
  if (!isRecord(body) || typeof body.reservation_id !== "string") return null;
  const usage = body.usage;
  if (usage === undefined || usage === null) return { reservation_id: body.reservation_id, usage: null };
  if (!isRecord(usage) || typeof usage.tokens_in !== "number" || typeof usage.tokens_out !== "number") {
    return null;
  }
  return {
    reservation_id: body.reservation_id,
    usage: { tokens_in: usage.tokens_in, tokens_out: usage.tokens_out },
  };
}

function asRelease(body: unknown): GateReleaseRequest | null {
  if (!isRecord(body) || typeof body.attempt_id !== "string") return null;
  return { attempt_id: body.attempt_id };
}

function asRegisterPool(body: unknown): GateRegisterPoolRequest | null {
  if (!isRecord(body) || typeof body.pool !== "string") return null;
  if (body.request_id !== undefined && typeof body.request_id !== "string") return null;
  return { pool: body.pool, request_id: body.request_id };
}

function asMayStart(body: unknown): GateMayStartRequest {
  if (isRecord(body) && typeof body.attempt_id === "string") return { attempt_id: body.attempt_id };
  return {};
}

function asKill(body: unknown): KillRequest | null {
  if (!isRecord(body) || typeof body.killed !== "boolean") return null;
  if (body.landings !== undefined && typeof body.landings !== "boolean") return null;
  return { killed: body.killed, landings: body.landings };
}

export class ModelGate extends DurableObject<Env> {
  readonly #sql: Sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = sqlOver(ctx.storage);
    applyGateSchema(this.#sql);
  }

  /** The deployment's cap: `SPEND_CAP_USD`, or 0 when it is absent, not a number or negative. */
  #cap(): number {
    const raw = this.env.SPEND_CAP_USD as unknown;
    const cap = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
    return Number.isFinite(cap) && cap >= 0 ? cap : 0;
  }

  /** The stored state under the deployment's present cap, or a fresh `initialState` (see this
   * file's head). */
  #loadState(): GateState {
    const raw = gateMetaGet(this.#sql, "state");
    if (raw === null) return initialState(this.#cap());
    return { ...(JSON.parse(raw) as GateState), cap_usd: this.#cap() };
  }

  /** `killed` without touching the cap: an uninitialized gate is not killed (SE10). */
  #killed(): boolean {
    const raw = gateMetaGet(this.#sql, "state");
    return raw !== null && (JSON.parse(raw) as GateState).killed === true;
  }

  /**
   * One call, one transaction (SY2): load, `apply`, store — the returned state is durable before
   * any effect runs. `emit` effects become outbox rows inside the same transaction; the rest are
   * handed back for the post-commit effect pass.
   */
  #runCall(call: GateCall, now: number): { answer: GateAnswer; effects: GateEffect[] } {
    return this.ctx.storage.transactionSync(() => {
      const result = apply(this.#loadState(), call, now, MODEL_PLAN, MODEL_PLAN.prices_usd_per_mtok);
      gateMetaSet(this.#sql, "state", JSON.stringify(result.state));
      const effects: GateEffect[] = [];
      for (const effect of result.effects) {
        if (effect.kind === "emit") {
          // EV2a: the pool's owed event is durable in the same transaction as the state, so a
          // crash between `apply` and delivery cannot lose it — the outbox delivers it later.
          outboxAppend(this.#sql, effect.pool, effect.epoch, effect.source_n, effect.event);
        } else {
          effects.push(effect);
        }
      }
      return { answer: result.answer, effects };
    });
  }

  /** The post-commit pass: every owed `limits` delivery (the freshly appended rows have no retry
   * position, so they are due now), then the Trunk-facing effects. */
  async #runEffects(now: number, effects: readonly GateEffect[]): Promise<void> {
    await deliverDue(this.env, this.#sql, now);
    for (const effect of effects) {
      if (effect.kind === "pause_pool") await pausePoolForOwner(this.env, effect.pool);
      else if (effect.kind === "resume_pool") await resumePoolForOwner(this.env, effect.pool);
    }
  }

  /** The alarm's work: the sweep (SE6a + the due `limits` flush of SE9), then owed deliveries. */
  async #runAlarm(now: number): Promise<void> {
    const { effects } = this.#runCall({ call: "sweep", request: {} }, now);
    await this.#runEffects(now, effects);
  }

  /** Arm at the earliest of `nextWakeup` (expiry / limits flush) and an owed delivery retry. */
  async #arm(): Promise<void> {
    const now = Date.now();
    let at = nextWakeup(this.#loadState(), now);
    const retry = nextRetryAt(this.#sql, now);
    if (retry !== null && (at === null || retry < at)) at = retry;
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }

  /** The call a path maps to: `call` null + `invalid` on a malformed body, `null` for a path the
   * gate does not answer. */
  #callFor(pathname: string, body: unknown): { call: GateCall | null; invalid: boolean } | null {
    switch (pathname) {
      case "/internal/reserve": {
        const request = asReserve(body);
        return { call: request === null ? null : { call: "reserve", request }, invalid: request === null };
      }
      case "/internal/settle": {
        const request = asSettle(body);
        return { call: request === null ? null : { call: "settle", request }, invalid: request === null };
      }
      case "/internal/release": {
        const request = asRelease(body);
        return { call: request === null ? null : { call: "release", request }, invalid: request === null };
      }
      case "/internal/register-pool": {
        const request = asRegisterPool(body);
        return { call: request === null ? null : { call: "register-pool", request }, invalid: request === null };
      }
      case "/internal/may-start":
        return { call: { call: "may-start", request: asMayStart(body) }, invalid: false };
      case "/internal/kill":
      case "/api/kill": {
        const request = asKill(body);
        return { call: request === null ? null : { call: "kill", request }, invalid: request === null };
      }
      default:
        return null;
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (request.method === "GET" && pathname === "/internal/state") {
        const stored = gateMetaGet(this.#sql, "state");
        return json({
          state: stored === null ? null : (JSON.parse(stored) as GateState),
          outbox: outboxAll(this.#sql).map((row) => ({ ...row, event: JSON.parse(row.event) as unknown })),
          delivery: outboxPoolAll(this.#sql),
        });
      }
      if (request.method === "GET" && (pathname === "/killed" || pathname === "/internal/killed")) {
        return json({ killed: this.#killed() });
      }
      if (request.method !== "POST") {
        return notBuilt();
      }
      let body: unknown = null;
      const raw = await request.text();
      if (raw !== "") {
        try {
          body = JSON.parse(raw);
        } catch {
          return json({ error: { code: "bad_json" } }, 400);
        }
      }
      if (pathname === "/internal/alarm") {
        // The test path (the task's "drive the alarm through a test path"): the same work the
        // alarm does, at `now` — Date.now() unless the body names a time.
        const at = isRecord(body) && typeof body.now === "number" ? body.now : Date.now();
        await this.#runAlarm(at);
        return json({ ok: true });
      }
      const mapped = this.#callFor(pathname, body);
      if (mapped === null) return notBuilt();
      if (mapped.invalid) return json({ error: { code: "invalid_args" } }, 400);
      const now = Date.now();
      if (mapped.call === null) return json({ error: { code: "invalid_args" } }, 400);
      const { answer, effects } = this.#runCall(mapped.call, now);
      await this.#runEffects(now, effects);
      return json(answer);
    } catch (cause) {
      console.error("gate call failed", cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown");
      return json({ error: { code: "internal_error" } }, 500);
    } finally {
      await this.#arm();
    }
  }

  /** The alarm (SE6a, SE9, EV2a): the sweep, then every delivery that is owed, then re-arm. */
  override async alarm(): Promise<void> {
    try {
      await this.#runAlarm(Date.now());
    } catch (cause) {
      console.error("gate alarm failed", cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown");
    } finally {
      await this.#arm();
    }
  }
}
