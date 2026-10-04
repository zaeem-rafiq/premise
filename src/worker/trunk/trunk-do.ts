// The Trunk Durable Object — one per pool (01-core 3.1): the shell around the engine table
// (src/core/trunk/engine.ts). Every request and every timer resolves to an entry by name. An
// engine entry is called with the pool's `Trunk` facade (src/core/trunk/registry.ts) — its
// methods open their own transaction through `wrapCall`, run to commit with no `await` (SY2)
// and leave `events_out`, the `outbox` and `heads_ups` to the after-commit pipeline (9.4 step 6):
// events to the Floor first, then the push, then the heads-up delivery (HU5b).
//
// The shell's own entries are `pool_create` (PL1: the seed's files arrive with the call — the
// object cannot read deployment assets inside a transaction) and `_probe`, the fake engine
// entry the SY2 acceptance drives.

import { DurableObject } from "cloudflare:workers";
import { engineTable, type EngineTable } from "../../core/trunk/engine.ts";
import { Trunk as TrunkEngine } from "../../core/trunk/registry.ts";
import type { Sql } from "../../protocol/ports.ts";
import type { Env } from "../env.ts";
import { notBuilt } from "../not-built.ts";
import { deliverEvents, recordTrunkError, runEffects, type EffectRef } from "./after-commit.ts";
import { deliverHeadsUps, outboxRow, pushOutbox, reconcileOnStart } from "./push.ts";
import { armAlarm, runAlarm } from "./alarm.ts";
import { applyShellSchema, metaAll, metaGet, metaSet, pendingEvents, sqlOf, timerList, timerPut } from "./sql.ts";

/** The context the shell's own entries get: storage, identity and the request they serve. */
export type EntryContext = {
  sql: Sql;
  pool: string;
  env: Env;
  now: number;
  path: string;
  query: URLSearchParams;
};

/** The shape an entry returns: `{ response, status?, effects? }`; a bare value is the response. */
type EntryResult = { response?: unknown; status?: number; effects?: EffectRef[] };

const BAD_JSON = Symbol("bad_json");

/** How many times one request runs the after-commit pipeline before the `push` timer takes over.
 * One landing needs two passes (the push, then the events of `push_ok`); the bound only keeps a
 * long outbox from holding one request open. */
const POST_COMMIT_PASSES = 4;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function normalizeResult(result: unknown): { response: unknown; status: number; effects: EffectRef[] } {
  if (
    typeof result === "object" &&
    result !== null &&
    ("response" in result || "effects" in result || "status" in result)
  ) {
    const entry = result as EntryResult;
    return { response: entry.response ?? { ok: true }, status: entry.status ?? 200, effects: entry.effects ?? [] };
  }
  return { response: result ?? { ok: true }, status: 200, effects: [] };
}

/** `input` of `pool_create` — forwarded by `POST /api/pools` (PL1), with the seed's whole tree. */
type CreatePoolInput = {
  pool: string;
  seed: string;
  summary_only: boolean;
  request_id: string;
  remote: string;
  /** When absent, the object reads the named seed through ASSETS before the transaction (PL1). */
  files?: Record<string, string>;
};

function asCreatePoolInput(input: unknown): CreatePoolInput | null {
  if (typeof input !== "object" || input === null) return null;
  const body = input as Partial<CreatePoolInput>;
  if (
    typeof body.pool !== "string" ||
    typeof body.seed !== "string" ||
    typeof body.summary_only !== "boolean" ||
    typeof body.request_id !== "string" ||
    typeof body.remote !== "string" ||
    (body.files !== undefined &&
      (typeof body.files !== "object" ||
        body.files === null ||
        !Object.values(body.files).every((v) => typeof v === "string")))
  ) {
    return null;
  }
  return body as CreatePoolInput;
}

/** The named seed's files, read through ASSETS (PL1, gap 3): `dist/client/seeds.json`, the bundle
 * `npm run build:seeds` writes. Null when the binding or the seed is unavailable; undefined when
 * the bundle answers but names no such seed. */
async function seedFiles(env: Env, seed: string): Promise<Record<string, string> | null | undefined> {
  const assets = env.ASSETS as Fetcher | undefined;
  if (assets === undefined) return null;
  let bundle: unknown;
  try {
    const response = await assets.fetch("https://assets/seeds.json");
    if (!response.ok) return null;
    bundle = await response.json();
  } catch {
    return null;
  }
  const files = (bundle as Record<string, unknown>)[seed];
  if (typeof files !== "object" || files === null) return undefined;
  if (!Object.values(files).every((v) => typeof v === "string")) return undefined;
  return files as Record<string, string>;
}

export class Trunk extends DurableObject<Env> {
  readonly #sql: Sql;
  readonly #engine: EngineTable;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = sqlOf(ctx);
    applyShellSchema(this.#sql);
    this.#engine = engineTable();
  }

  get #pool(): string {
    return this.ctx.id.name ?? "";
  }

  /**
   * The shell's own entries, consulted only when the engine table has no entry of the name (the
   * engine's wins when both exist). Each runs without a wrapping transaction of the shell's —
   * `pool_create` opens the engine's own transaction, `_probe` writes one row.
   */
  readonly #shellEntries: Record<string, (input: unknown, ctx: EntryContext) => EntryResult | Promise<EntryResult>> = {
    /**
     * PL1: creates the pool — the schema, the seed files and the seed commit, `pool.state` and
     * `pool.files` as events 1 and 2 (EM1), and the seed's outbox batch (PL1's "land the seed on
     * Artifacts through the pusher" — the after-commit push sends it). `summary_only` is fixed
     * here (EV6). A repeated `request_id` is a no-op (9.8); a second create for a live pool
     * answers `pool_exists`.
     */
    pool_create: async (input, ctx) => {
      const create = asCreatePoolInput(input);
      if (create === null) return { response: { error: { code: "invalid_args" } }, status: 400 };
      if (metaGet(ctx.sql, "pool_id") !== null) {
        return metaGet(ctx.sql, "create_request_id") === create.request_id
          ? { response: { ok: true, already: true } }
          : { response: { error: { code: "pool_exists" } }, status: 409 };
      }
      const files = create.files ?? (await seedFiles(ctx.env, create.seed));
      if (files === null) return { response: { error: { code: "seed_unavailable" } }, status: 502 };
      if (files === undefined) return { response: { error: { code: "invalid_args" } }, status: 400 };
      TrunkEngine.create(ctx.sql, files, {
        pool_id: create.pool,
        summary_only: create.summary_only,
        remote: create.remote,
        request_id: create.request_id,
        now: () => ctx.now,
      });
      return { response: { ok: true, pool: create.pool } };
    },

    /**
     * The fake engine entry of the SY2 acceptance: commits `probe:<marker>` inside its transaction
     * and leaves a `_remote_probe` effect, whose handler posts to `args.url` — the fake remote's
     * request log is the proof the request left the object after the commit.
     */
    _probe: (input, ctx) => {
      const request = input as { call_id?: unknown; args?: { url?: unknown; marker?: unknown } };
      const url = request?.args?.url;
      const marker = request?.args?.marker;
      if (typeof url !== "string" || typeof marker !== "string") {
        return { response: { error: { code: "invalid_args" } }, status: 400 };
      }
      metaSet(ctx.sql, `probe:${marker}`, String(ctx.now));
      return {
        response: {
          call_id: typeof request?.call_id === "string" ? request.call_id : "",
          ok: true,
          head_seq: 0,
          result: { marked: marker },
          premises: [],
          heads_ups: [],
          heads_ups_more: false,
          attempt: { state: "working", go_arounds: 0, pull_backs: 0 },
        },
        effects: [{ kind: "_remote_probe", payload: { url, marker } }],
      };
    },
  };

  /**
   * LP7: on the first request after start-up — never in the constructor — reconcile the outbox
   * with the remote through the `restart` entry. The flag is in-memory on purpose: an evicted
   * object reconciles again at its next start.
   */
  #reconciled = false;
  #ensureReconciled(): void {
    if (this.#reconciled) return;
    this.#reconciled = true;
    // No pool yet: nothing to reconcile — and no `trunk.error` may precede `pool.state` (EM1).
    if (metaGet(this.#sql, "pool_id") === null) return;
    void reconcileOnStart(this.env, this.ctx, async (input) => {
      const r = await this.#callEngineEntry("restart", input);
      if ("error" in r) return;
      await this.#postCommit();
    }).catch(() => recordTrunkError(this.ctx, "restart", "engine_error"));
  }

  /**
   * The engine entry for a path — the tool endpoints, the internal creation and launch calls and
   * the owner actions of 13.6 — or null (the object answers `not_built`). `/tool` resolves to the
   * single `tool` entry: the request body carries the tool name.
   */
  #entryFor(pathname: string, input: unknown): string | null {
    // A tool call names its entry in `tool` (4.3): the seven real tools all reach the single
    // `tool` entry, but a name that is itself a registered entry — the test's `_probe` — wins.
    if (pathname === "/tool") {
      const tool = (input as { tool?: unknown } | null)?.tool;
      if (typeof tool === "string" && (this.#engine.entries.has(tool) || tool in this.#shellEntries)) return tool;
      return "tool";
    }
    if (pathname === "/sync" || pathname === "/register" || pathname === "/stop") return pathname.slice(1);
    if (pathname === "/internal/create-pool") return "pool_create";
    if (pathname === "/internal/open-attempt") return "open_attempt";
    if (pathname === "/internal/tick") return "tick";
    if (/^\/api\/pools\/[^/]+\/intents$/.test(pathname)) return "create_intent";
    if (/^\/api\/pools\/[^/]+\/cards\/[^/]+$/.test(pathname)) return "card_action";
    if (/^\/api\/pools\/[^/]+\/undo-plan$/.test(pathname)) return "undo_plan";
    if (/^\/api\/pools\/[^/]+\/undo$/.test(pathname)) return "undo";
    if (/^\/api\/pools\/[^/]+\/rebuild$/.test(pathname)) return "rebuild";
    return null;
  }

  /**
   * Calls an engine entry with the pool's `Trunk` facade — the entry's methods open and commit
   * their own transaction (SY2), so nothing here wraps the call: a nested transactionSync would
   * throw. The pool must exist (every entry but `pool_create` serves an existing pool).
   */
  async #callEngineEntry(name: string, input: unknown): Promise<{ result: unknown } | { error: Response }> {
    const entry = this.#engine.entries.get(name);
    if (entry === undefined) return { error: notBuilt() };
    if (metaGet(this.#sql, "pool_id") === null) {
      return { error: json({ error: { code: "pool_not_found" } }, 404) };
    }
    try {
      const trunk = TrunkEngine.open(this.#sql, { now: () => Date.now() });
      const result = await Promise.resolve(entry(input, trunk));
      return { result };
    } catch {
      recordTrunkError(this.ctx, `entry:${name}`, "engine_error");
      return { error: json({ error: { code: "internal_error" } }, 500) };
    }
  }

  /**
   * 9.4 step 6: after every commit, in this order and none awaited by the next — the events to
   * the Floor (EV2), the push (9.6), the heads-up delivery (HU5b). Each step's failure is a
   * `trunk.error`, not a lost transaction: the timers they arm retry them.
   *
   * A push whose answer was applied (`push_ok`, `push_result`) leaves new work: its events, and
   * perhaps the next batch. The pipeline therefore runs again after it — as a loop with a bound,
   * never from inside the push. A pass that started inside the push's own `apply` would push the
   * same batch again before its retry was scheduled, and would never return.
   */
  async #postCommit(): Promise<void> {
    for (let pass = 0; pass < POST_COMMIT_PASSES; pass += 1) {
      try {
        await deliverEvents(this.env, this.ctx);
      } catch {
        recordTrunkError(this.ctx, "events", "transport");
      }
      const applied = await this.#pushOnce();
      try {
        await deliverHeadsUps(this.env, this.ctx);
      } catch {
        recordTrunkError(this.ctx, "heads_up", "transport");
      }
      if (!applied) return;
    }
    // The bound was reached with work still to do: the `push` timer continues it (AL1).
    this.#sql.transaction(() => timerPut(this.#sql, "push", "", Date.now()));
  }

  /** One `pushOutbox`. True when the push's answer was applied to the engine, which is when the
   * pipeline has new work. */
  async #pushOnce(): Promise<boolean> {
    let applied = false;
    try {
      await pushOutbox(this.env, this.ctx, async (name, input) => {
        const r = await this.#callEngineEntry(name, input);
        if ("error" in r) throw new Error(`push apply ${name} failed`);
        applied = true;
        return r.result;
      });
    } catch {
      recordTrunkError(this.ctx, "push", "transport");
    }
    return applied;
  }

  /** Entry calls answered since the object started — the app-server acceptance's proof that no
   * `/pool/` request reaches Trunk (AS16): its reads are Floor reads. In-memory on purpose. */
  readonly #served = new Map<string, number>();

  /** One entry's request path: run it, run its returned effects, then the after-commit pipeline. */
  async #runEntry(name: string, input: unknown, path: string, query: URLSearchParams): Promise<Response> {
    this.#served.set(name, (this.#served.get(name) ?? 0) + 1);
    if (this.#engine.entries.has(name)) {
      const r = await this.#callEngineEntry(name, input);
      if ("error" in r) return r.error;
      const { response, status, effects } = normalizeResult(r.result);
      await runEffects(this.env, this.ctx, effects);
      await this.#postCommit();
      return json(response, status);
    }
    const entry = this.#shellEntries[name];
    if (entry === undefined) return notBuilt();
    const ctx: EntryContext = { sql: this.#sql, pool: this.#pool, env: this.env, now: Date.now(), path, query };
    let result: unknown;
    try {
      result = await Promise.resolve(entry(input, ctx));
    } catch (cause) {
      console.error(
        `trunk entry ${name} failed`,
        cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown",
      );
      recordTrunkError(this.ctx, `entry:${name}`, "engine_error");
      const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
      return json({ error: { code: "internal_error", detail } }, 500);
    }
    const { response, status, effects } = normalizeResult(result);
    await runEffects(this.env, this.ctx, effects);
    await this.#postCommit();
    return json(response, status);
  }

  /** A timer's engine entry: false when unregistered; entry errors propagate so the alarm can
   * re-schedule with backoff (AL2). The after-commit pipeline runs on success. */
  async #runTimerEntry(kind: string): Promise<boolean> {
    if (!this.#engine.entries.has(kind)) return false;
    const r = await this.#callEngineEntry(kind, {});
    if ("error" in r) throw new Error(`timer ${kind} failed`);
    await this.#postCommit();
    return true;
  }

  /** The request's JSON: the body, or `?q=` for a GET (the Agent's convention). Empty input is `{}`. */
  async #readInput(request: Request, url: URL): Promise<unknown> {
    if (request.method === "GET" || request.method === "HEAD") {
      const q = url.searchParams.get("q");
      if (q === null) return {};
      try {
        return JSON.parse(q);
      } catch {
        return BAD_JSON;
      }
    }
    const text = await request.text();
    if (text === "") return {};
    try {
      return JSON.parse(text);
    } catch {
      return BAD_JSON;
    }
  }

  #state(): Response {
    return json({
      pool: this.#pool,
      meta: metaAll(this.#sql),
      events_out: pendingEvents(this.#sql).map((row) => ({ ...row, body: JSON.parse(row.body) as unknown })),
      timers: timerList(this.#sql),
      outbox: outboxRow(this.ctx),
      served: Object.fromEntries(this.#served),
    });
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      this.#ensureReconciled();
      const url = new URL(request.url);
      const pathname = url.pathname;
      if (pathname === "/internal/state" && request.method === "GET") return this.#state();
      if (pathname === "/internal/alarm") {
        // `?now=` lets a test drive the retry schedule through the alarm path without sleeping
        // for the real backoff (LP5a): the due-check alone reads it; scheduling stays real-time.
        const now = url.searchParams.get("now");
        const at = now === null ? undefined : Number(now);
        await this.#runAlarm(at !== undefined && Number.isFinite(at) ? at : undefined);
        return json({ ok: true });
      }
      const input = await this.#readInput(request, url);
      if (input === BAD_JSON) return json({ error: { code: "bad_json" } }, 400);
      const name = this.#entryFor(pathname, input);
      if (name === null) return notBuilt();
      return await this.#runEntry(name, input, pathname, url.searchParams);
    } catch {
      return json({ error: { code: "internal_error" } }, 500);
    } finally {
      // AL3: every request handler ends by checking an alarm is set whenever `timers` is not empty.
      await this.#arm();
    }
  }

  /** The alarm override (AL1): all due timers in order, then re-arm — also on a throw (AL2).
   * LP7's reconcile runs on the first request *or alarm*, so it is ensured here too. */
  override async alarm(): Promise<void> {
    try {
      this.#ensureReconciled();
      await this.#runAlarm();
    } finally {
      await this.#arm();
    }
  }

  #runAlarm(now?: number): Promise<void> {
    return runAlarm({
      env: this.env,
      ctx: this.ctx,
      sql: this.#sql,
      now,
      runEntry: (kind) => this.#runTimerEntry(kind),
      push: async () => {
        if (await this.#pushOnce()) await this.#postCommit();
      },
      repush: async () => {
        try {
          await deliverHeadsUps(this.env, this.ctx);
        } catch {
          recordTrunkError(this.ctx, "heads_up", "transport");
        }
      },
    });
  }

  #arm(): Promise<void> {
    return armAlarm(this.ctx, this.#sql);
  }
}
