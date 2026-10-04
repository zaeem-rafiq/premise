// The Trunk Durable Object — one per pool (01-core 3.1): the shell around the engine table
// (src/core/trunk/engine.ts). Every request and every timer resolves to an entry by name; the entry
// runs inside one `transactionSync` with no `await` (SY2), and only after the commit do its effects
// reach the network (LP3, EV2). While the engine lane registers no entries, unbuilt work answers
// `not_built` — the scaffold's fail-closed code.
//
// The shell itself owns three entries: `pool_create` (PL1 — a slice-1 stand-in until the engine
// lane's entry of the same name lands; the engine's wins when both exist), and `_probe`, the small
// fake engine entry the SY2 acceptance test drives.
//
// Requests arrive as JSON: a POST/PUT/DELETE body, or `?q=<json>` on a GET — the convention the
// Agent Durable Object uses, which also lets `fetchDurableObject` in workerd tests drive every path.

import { DurableObject } from "cloudflare:workers";
import { engineTable, type EngineTable } from "../../core/trunk/engine.ts";
import { MAX_REAL_AGENTS } from "../../protocol/constants.ts";
import type { Sql } from "../../protocol/ports.ts";
import type { Env } from "../env.ts";
import { notBuilt } from "../not-built.ts";
import { deliverEvents, recordTrunkError, runEffects, type EffectRef } from "./after-commit.ts";
import { armAlarm, runAlarm } from "./alarm.ts";
import { appendEvent, applyShellSchema, metaAll, metaGet, metaSet, pendingEvents, sqlOf, timerList } from "./sql.ts";

/** The context every engine entry gets: storage, identity and the request it serves. */
export type EntryContext = {
  sql: Sql;
  /** The pool this object is — the Durable Object's name. */
  pool: string;
  env: Env;
  /** The request's clock. */
  now: number;
  /** The path the request came in on (`alarm` for a timer). */
  path: string;
  /** The request's query (`?seq=` of undo-plan, the `?q=` carrier excluded). */
  query: URLSearchParams;
};

/** The shape an entry returns: `{ response, status?, effects? }`; a bare value is the response. */
type EntryResult = { response?: unknown; status?: number; effects?: EffectRef[] };

const BAD_JSON = Symbol("bad_json");

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

/** `input` of the `pool_create` entry — forwarded by `POST /api/pools` (PL1). */
type CreatePoolInput = { pool: string; seed: string; summary_only: boolean; request_id: string; remote: string };

function asCreatePoolInput(input: unknown): CreatePoolInput | null {
  if (typeof input !== "object" || input === null) return null;
  const body = input as Partial<CreatePoolInput>;
  if (
    typeof body.pool !== "string" ||
    typeof body.seed !== "string" ||
    typeof body.summary_only !== "boolean" ||
    typeof body.request_id !== "string" ||
    typeof body.remote !== "string"
  ) {
    return null;
  }
  return body as CreatePoolInput;
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
   * engine's wins when both exist). `pool_create` is PL1's stand-in for this slice; `_probe` is the
   * SY2 acceptance's fake engine entry — each name starts with `_` or is spec-named so a real
   * engine entry always supersedes.
   */
  readonly #shellEntries: Record<string, (input: unknown, ctx: EntryContext) => EntryResult> = {
    /**
     * PL1: stores the creation record in `meta` — `summary_only` fixed here, carried by every
     * `pool.state` (EV6) — and emits the first two stream events (EM1): `pool.state` then
     * `pool.files`. The seed tree is built into the deployment but reaches Trunk only through the
     * engine, so this slice emits `files: []` and `head_commit: ""` (see the track report). A
     * repeated `request_id` is a no-op (9.8); a second create for a live pool answers `pool_exists`.
     */
    pool_create: (input, ctx) => {
      const create = asCreatePoolInput(input);
      if (create === null) return { response: { error: { code: "invalid_args" } }, status: 400 };
      if (metaGet(ctx.sql, "pool_id") !== null) {
        return metaGet(ctx.sql, "create_request_id") === create.request_id
          ? { response: { ok: true, already: true } }
          : { response: { error: { code: "pool_exists" } }, status: 409 };
      }
      const now = ctx.now;
      for (const [key, value] of Object.entries({
        pool_id: create.pool,
        pool_state: "ready",
        head_seq: "0",
        head_commit: "",
        green_seq: "0",
        green_commit: "",
        epoch: "1",
        summary_only: create.summary_only ? "1" : "0",
        synthetic: "0",
        repo: create.remote,
        create_request_id: create.request_id,
        reconciled: "1",
      })) {
        metaSet(ctx.sql, key, value);
      }
      appendEvent(ctx.sql, now, {
        ts: now,
        pool: create.pool,
        src: "trunk",
        type: "pool.state",
        head_seq: 0,
        head_commit: "",
        green_seq: 0,
        landed_seq: 0,
        landed_commit: "",
        state: "ready",
        reason: null,
        epoch: 1,
        remote: create.remote,
        plain_remote: null,
        rebuild: null,
        unwitnessed: [],
        real_agents: 0,
        max_real_agents: MAX_REAL_AGENTS,
        synthetic: false,
        summary_only: create.summary_only,
      });
      appendEvent(ctx.sql, now, {
        ts: now,
        pool: create.pool,
        src: "trunk",
        type: "pool.files",
        files: [],
      });
      return { response: { ok: true, pool: create.pool }, effects: [{ kind: "events" }] };
    },

    /**
     * The fake engine entry of the SY2 acceptance: commits `probe:<marker>` inside its transaction
     * and leaves a `_remote_probe` effect, whose handler posts to `args.url` — the fake remote's
     * request log is the proof the request left the object after the commit. Removed when a real
     * entry of the name exists (never — the name is reserved).
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
   * LP7: on the first request after start-up — never in the constructor — reconcile the outbox with
   * the remote through the `restart` entry when the git lane registers it. Until then, or when a
   * fresh pool has nothing pending, this only marks `meta.reconciled`.
   */
  #ensureReconciled(): void {
    if (metaGet(this.#sql, "reconciled") === "1") return;
    this.#sql.transaction(() => metaSet(this.#sql, "reconciled", "1"));
    if (!this.#engine.entries.has("restart")) return;
    void this.#runEntry("restart", { restart: true }, "restart", new URLSearchParams()).catch(() =>
      recordTrunkError(this.ctx, "restart", "engine_error"),
    );
  }

  /** The engine entry for a path — the tool endpoints, the internal creation call and the owner
   * actions of 13.6 — or null (the object answers `not_built`). Entry names are provisional for the
   * engine lane's wiring (see the track report). */
  #entryFor(pathname: string, input: unknown): string | null {
    if (pathname === "/tool") {
      const tool = (input as { tool?: unknown })?.tool;
      return typeof tool === "string" ? tool : null;
    }
    if (pathname === "/sync" || pathname === "/register" || pathname === "/stop") return pathname.slice(1);
    if (pathname === "/internal/create-pool") return "pool_create";
    if (/^\/api\/pools\/[^/]+\/intents$/.test(pathname)) return "create_intent";
    if (/^\/api\/pools\/[^/]+\/cards\/[^/]+$/.test(pathname)) return "card_action";
    if (/^\/api\/pools\/[^/]+\/undo-plan$/.test(pathname)) return "undo_plan";
    if (/^\/api\/pools\/[^/]+\/undo$/.test(pathname)) return "undo";
    if (/^\/api\/pools\/[^/]+\/rebuild$/.test(pathname)) return "rebuild";
    return null;
  }

  /**
   * One entry, the SY2 shape: the transaction runs start to commit with no `await`; effects — the
   * network work — run after. An entry may return a promise for work it intentionally defers past
   * the commit (the `restart` reconciliation of LP7); its synchronous part still committed first.
   */
  async #runEntry(name: string, input: unknown, path: string, query: URLSearchParams): Promise<Response> {
    const entry = this.#engine.entries.get(name) ?? this.#shellEntries[name];
    if (entry === undefined) return notBuilt();
    const ctx: EntryContext = { sql: this.#sql, pool: this.#pool, env: this.env, now: Date.now(), path, query };
    let result: unknown;
    try {
      result = await Promise.resolve(this.#sql.transaction(() => entry(input, ctx)));
    } catch {
      recordTrunkError(this.ctx, `entry:${name}`, "engine_error");
      return json({ error: { code: "internal_error" } }, 500);
    }
    const { response, status, effects } = normalizeResult(result);
    await runEffects(this.env, this.ctx, effects);
    return json(response, status);
  }

  /** A timer's engine entry for the alarm: false when unregistered; entry errors propagate so the
   * alarm can re-schedule with backoff (AL2). */
  async #runTimerEntry(
    kind: string,
    input: { timer: { kind: string; key: string; due_at: number } },
  ): Promise<boolean> {
    const entry = this.#engine.entries.get(kind);
    if (entry === undefined) return false;
    const ctx: EntryContext = {
      sql: this.#sql,
      pool: this.#pool,
      env: this.env,
      now: Date.now(),
      path: "alarm",
      query: new URLSearchParams(),
    };
    const result = await Promise.resolve(this.#sql.transaction(() => entry(input, ctx)));
    await runEffects(this.env, this.ctx, normalizeResult(result).effects);
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
    });
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      this.#ensureReconciled();
      const url = new URL(request.url);
      const pathname = url.pathname;
      if (pathname === "/internal/state" && request.method === "GET") return this.#state();
      if (pathname === "/internal/alarm") {
        await this.#runAlarm();
        return json({ ok: true });
      }
      const input = await this.#readInput(request, url);
      if (input === BAD_JSON) return json({ error: { code: "bad_json" } }, 400);
      const name = this.#entryFor(pathname, input);
      if (name === null) return notBuilt();
      const response = await this.#runEntry(name, input, pathname, url.searchParams);
      // EV2: this entry's events — and any stragglers an earlier crash left — flush to the Floor.
      await deliverEvents(this.env, this.ctx);
      return response;
    } catch {
      return json({ error: { code: "internal_error" } }, 500);
    } finally {
      // AL3: every request handler ends by checking an alarm is set whenever `timers` is not empty.
      await this.#arm();
    }
  }

  /** The alarm override (AL1): all due timers in order, then re-arm — also on a throw (AL2). */
  override async alarm(): Promise<void> {
    try {
      await this.#runAlarm();
    } finally {
      await this.#arm();
    }
  }

  #runAlarm(): Promise<void> {
    return runAlarm({
      env: this.env,
      ctx: this.ctx,
      sql: this.#sql,
      runEntry: (kind, input) => this.#runTimerEntry(kind, input),
    });
  }

  #arm(): Promise<void> {
    return armAlarm(this.ctx, this.#sql);
  }
}
