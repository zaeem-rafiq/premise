// src/worker/agent/agent-do.ts — the Agent Durable Object (01-core 3.3, 4.1, 4.5, 5.2; 05-agent 4).
//
// One Agent per attempt. This file holds the durable core of Track 1H:
//
//   journal   the write-ahead row that exists before a tool call and is gone
//             after it (AG1), so a repeated send uses the same call_id and
//             Trunk's TA2 returns the stored response (AG4);
//   inbox     heads-ups de-duplicated by hn and shown only in ascending,
//             gap-free order (HU4, HU6a, SP5), with sync before a gap;
//   pump      the loop that asks the driver for the next step, journals the
//             call, applies the answer's mirrors, and ends on wait or stop;
//   scripted  the canned agent of 02-tidepool 10 — same tools, no model.
//
// The model driver (05-agent) and the turn rendering of src/core/agent/loop
// are another track; real agents answer not_built until then.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { notBuilt } from "../not-built.ts";
import { callId } from "../../protocol/ids.ts";
import { redact } from "../../protocol/redact.ts";
import {
  AGENT_WATCHDOG_MS,
  ATTEMPT_TIMEOUT_MS,
  HEADS_UP_REPUSH_MS,
  RESUME_MODEL_CALLS,
  RESUME_STEPS,
  RESUME_TIMEOUT_MS,
  MAX_STEPS,
  MAX_MODEL_CALLS,
  MAX_ATTEMPT_TOKENS,
  MAX_ATTEMPT_USD,
  TOOL_RETRIES,
  TOOL_TIMEOUT_MS,
  WAIT_BACKOFF_BASE_MS,
  WAIT_BACKOFF_MAX_MS,
} from "../../protocol/constants.ts";
import type { Driver, Sql } from "../../protocol/ports.ts";
import type { AgentStopReason, AttemptState } from "../../protocol/attempt.ts";
import type { HeadsUp } from "../../protocol/headsup.ts";
import type { PremiseKind } from "../../protocol/premise.ts";
import type {
  ModelToolMessage,
  RegisterRequest,
  RegisterResponse,
  ResumeResponse,
  ToolName,
  ToolRequest,
  ToolResponse,
} from "../../protocol/tools.ts";
import type {
  AgentOpenRequest,
  AgentPushRequest,
  AgentPushResponse,
  AgentReleaseRequest,
  AgentReleaseResponse,
} from "../../protocol/internal.ts";
import {
  applySchema,
  inboxRows,
  journalPut,
  metaAll,
  metaGet,
  metaSet,
  opList,
  opPut,
  premiseList,
  premisePut,
  timerDelete,
  timerDue,
  timerList,
  timerMin,
  timerPut,
  transcriptAppend,
  transcriptRows,
  type JournalRow,
} from "../../core/agent/store.ts";
import { abandonCall, beginCall, finishCall, journaledCall, retryCall } from "./journal.ts";
import * as inbox from "./inbox.ts";
import {
  TrunkCalls,
  TrunkTransportError,
  durableObjectTransport,
  urlTransport,
  type TrunkTransport,
} from "./trunk-client.ts";
import { ScriptedDriver, scriptedHeadsUpForModel, type Script } from "./scripted-driver.ts";
import { PatternDriver } from "./pattern-driver.ts";
import { patternById } from "../../swarm/pattern.ts";
import { sqlOver } from "../sql-port.ts";
import { ModelDriver, loadLoopState } from "./model-driver.ts";
import { urlModel } from "../adapters/model/workers-ai.ts";
import { GateCalls, gateDurableObjectTransport, gateUrlTransport } from "./gate-client.ts";
import { appendEvent, deliverEvents, ensureEventsSchema } from "./events.ts";
import { MODEL_PLAN } from "../../config/model-plan.ts";
import { RESUME_MESSAGE } from "../../protocol/agent-prompt.ts";
import { firstRows } from "../../core/agent/loop/context.ts";
import { callTarget, headsUpUserMessage, messageForResponse, writeToolRow } from "../../core/agent/loop/index.ts";

// What a pool's launcher POSTs to the Agent's /open is `AgentOpenRequest` of
// src/protocol/internal.ts (SW4; the swarm lane's launch call carries the same
// fields). `trunk_url` points the Trunk client at an HTTP endpoint instead of
// the Trunk Durable Object; tests use it for a local fake that follows
// src/protocol/tools.ts.
type PushRequest = AgentPushRequest;

type JournalRequest =
  | { call: "tool"; request: ToolRequest; model_call_id?: string; target?: string | null; waits?: number }
  | {
      call: "model";
      model: string;
      request: Record<string, unknown>;
      request_bytes: number;
      elided_steps: number[];
      reservation_id: string | null;
      waiting: boolean;
      error: string | null;
      waits: number;
    };

const TERMINAL_STATES = new Set<AttemptState>(["landed", "stopped"]);
const WAIT_STATES = new Set<AttemptState>(["submitted", "validated", "held", "accepted"]);

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function invalid(detail: string): Response {
  return json({ ok: false, error: { code: "invalid_args", message: detail } }, 400);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class Agent extends DurableObject<Env> {
  readonly #sql: Sql;
  #trunk: TrunkCalls | null = null;
  #gate: GateCalls | null = null;
  #driver: Driver | null = null;
  #model: ModelDriver | null = null;
  #running = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = sqlOver(ctx.storage);
    applySchema(this.#sql);
    ensureEventsSchema(this.#sql);
    // A journal row at start is a call that never completed (AG2); it is
    // served again before anything else, with the same call_id.
    if (journaledCall(this.#sql) !== null) this.ctx.waitUntil(this.#run());
  }

  // -- plumbing --------------------------------------------------------------

  #meta(k: string): string | null {
    return metaGet(this.#sql, k);
  }

  #int(k: string): number {
    const v = this.#meta(k);
    return v === null ? 0 : Number(v);
  }

  #set(k: string, v: string | number): void {
    metaSet(this.#sql, k, v);
  }

  #open_attempt(): void {
    if (this.#trunk !== null) return;
    const attempt_id = this.#meta("attempt_id");
    if (attempt_id === null) return;
    const trunk_url = this.#meta("trunk_url");
    const transport: TrunkTransport =
      trunk_url === null
        ? durableObjectTransport(this.env.TRUNK, this.#meta("pool_id") ?? "")
        : urlTransport(trunk_url);
    this.#trunk = new TrunkCalls(transport, attempt_id);
    // The model path: gate and AI join the pump below (05-agent). `model_url`
    // points the model client at a test's fake over HTTP; absent it, the
    // Workers AI binding answers — and when the binding is absent the adapter's
    // failures classify as `model_unavailable`, never silent success.
    const gate_url = this.#meta("gate_url");
    if (this.env.GATE !== undefined || gate_url !== null) {
      this.#gate = new GateCalls(
        gate_url === null ? gateDurableObjectTransport(this.env.GATE) : gateUrlTransport(gate_url),
      );
    }
    if (this.#meta("driver") === "model") {
      const model_url = this.#meta("model_url");
      const ai = model_url !== null ? urlModel(model_url) : (this.env.AI as unknown as {
        run(model: string, request: Record<string, unknown>): Promise<unknown>;
      });
      this.#model = new ModelDriver({
        sql: this.#sql,
        ai,
        gate: this.#gate,
        model: this.#meta("model") ?? "",
        pool: this.#meta("pool_id") ?? "",
        attemptId: attempt_id,
        secrets: () => this.#secrets(),
        releaseSlot: () => this.#releaseGateSlot(),
      });
      this.#driver = this.#model;
      return;
    }
    const pattern = this.#meta("pattern");
    const script = this.#meta("script");
    if (pattern !== null) {
      const p = patternById(pattern);
      if (p !== undefined) {
        const think = JSON.parse(this.#meta("think_ms") ?? "[0,0]") as [number, number];
        this.#driver = new PatternDriver(p, {
          seed: this.#int("seed"),
          agent_n: this.#int("agent_n"),
          hold: this.#meta("hold") === "1",
          think_ms: Array.isArray(think) && think.length === 2 ? [think[0] ?? 0, think[1] ?? 0] : [0, 0],
          released: () => metaGet(this.#sql, "released") === "1",
        });
      }
    }
    if (this.#driver === null && script !== null) {
      this.#driver = new ScriptedDriver(JSON.parse(script) as Script);
    }
  }

  #secrets(): string[] {
    return this.env.OWNER_KEY === undefined ? [] : [this.env.OWNER_KEY];
  }

  /** EV2a: deliver the agent outbox to the pool's Floor; the `events` timer retries. */
  async #deliverEvents(): Promise<void> {
    if (this.env.FLOOR === undefined) return;
    const pool = this.#meta("pool_id");
    const attempt_id = this.#meta("attempt_id");
    if (pool === null || attempt_id === null) return;
    await deliverEvents(this.#sql, durableObjectTransport(this.env.FLOOR, pool), attempt_id);
  }

  /** `attempt.step` inside the caller's transaction (EV2's "same transaction"). */
  #emitStep(fields: {
    step: number;
    tool: string | null;
    target: string | null;
    ok: boolean;
    error: string | null;
    ms: number;
  }): void {
    const pool = this.#meta("pool_id");
    const attempt_id = this.#meta("attempt_id");
    if (pool === null || attempt_id === null) return;
    appendEvent(this.#sql, {
      ts: Date.now(),
      pool,
      src: "agent",
      type: "attempt.step",
      attempt_id,
      step: fields.step,
      tool: fields.tool,
      target: fields.target,
      ok: fields.ok,
      error: fields.error,
      ms: fields.ms,
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
    });
  }

  /** MG5: the real-agent slot is freed when the loop ends or waits. Idempotent. */
  async #releaseGateSlot(): Promise<void> {
    if (this.#gate === null || this.#meta("may_started") !== "1") return;
    try {
      await this.#gate.release(this.#meta("attempt_id") as string);
    } catch {
      timerPut(this.#sql, "release", "main", Date.now() + HEADS_UP_REPUSH_MS);
    }
  }

  /** 4.9's held time (real agents): `held` pauses the attempt's own deadline. */
  #heldMirror(prev: string, next: string): void {
    if (this.#meta("agent_kind") !== "real") return;
    const now = Date.now();
    if (next === "held" && prev !== "held") {
      this.#set("held_at", now);
      timerDelete(this.#sql, "attempt_timeout", "main");
    } else if (prev === "held" && next !== "held") {
      const held_at = this.#int("held_at");
      this.#set("deadline_at", this.#int("deadline_at") + (held_at === 0 ? 0 : now - held_at));
      this.#sql.exec("DELETE FROM meta WHERE k = 'held_at'");
      timerPut(this.#sql, "attempt_timeout", "main", this.#int("deadline_at"));
    }
  }

  async #armAlarm(): Promise<void> {
    const next = timerMin(this.#sql);
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  // -- fetch: the internal API ----------------------------------------------
  //
  // Every internal endpoint takes its arguments as JSON — the POST body, or
  // the `q` query parameter for GETs, because the repo's workerd test helper
  // issues GETs only. Unrecognized paths answer not_built, the fail-closed
  // code of Slice 0.

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let body: unknown = null;
    try {
      if (request.method === "GET" || request.method === "HEAD") {
        const q = url.searchParams.get("q");
        body = q === null ? null : (JSON.parse(q) as unknown);
      } else {
        const text = await request.text();
        body = text === "" ? null : (JSON.parse(text) as unknown);
      }
    } catch {
      return invalid("body must be JSON");
    }
    try {
      switch (url.pathname) {
        case "/open":
          return await this.#open(body);
        case "/push":
          return await this.#push(body);
        case "/release":
          return await this.#release(body);
        case "/resume":
          return await this.#resume(body);
        case "/stop":
          return await this.#ownerStop();
        case "/internal/inspect":
          return this.#inspect();
        case "/internal/recover":
          await this.#recover();
          return json({ ok: true });
        case "/internal/alarm":
          await this.alarm();
          return json({ ok: true });
        default:
          if (/^\/api\/pools\/[^/]+\/attempts\/[^/]+\/stop$/.test(url.pathname)) {
            return await this.#ownerStop();
          }
          return notBuilt();
      }
    } finally {
      await this.#armAlarm();
    }
  }

  // -- open ------------------------------------------------------------------

  async #open(body: unknown): Promise<Response> {
    if (!isRecord(body)) return invalid("an open request object is required");
    // The launcher's shape names the pool `pool`; the test/debug shape names it `pool_id`.
    const pool_id =
      typeof body.pool_id === "string" && body.pool_id !== ""
        ? body.pool_id
        : typeof body.pool === "string"
          ? body.pool
          : "";
    for (const k of ["attempt_id", "intent_id", "change_id"] as const) {
      if (typeof body[k] !== "string" || body[k] === "") return invalid(`${k} is required`);
    }
    if (pool_id === "") return invalid("pool_id is required");
    const isReal = body.agent_kind === "real";
    if (body.agent_kind !== undefined && body.agent_kind !== "synthetic" && !isReal) {
      return notBuilt();
    }
    if (isReal) {
      // A real attempt needs the model driver, a model id of the plan and the
      // intent's text — the first two transcript rows are built from it (SP1, SP2).
      if (body.driver !== "model") return invalid("a real attempt requires driver model");
      if (typeof body.model !== "string" || body.model === "") return invalid("model is required");
      if (typeof body.intent_text !== "string" || body.intent_text === "") {
        return invalid("intent_text is required");
      }
    }
    // Two driver carries: `script` (the canned-steps shape of the lane's tests) or `pattern` +
    // `seed` + `agent_n` (the Swarm launcher's SWR2 shape — the pattern is the driver).
    const hasScript = isRecord(body.script) && Array.isArray(body.script.steps) && Array.isArray(body.script.truth);
    const pattern = typeof body.pattern === "string" ? patternById(body.pattern) : undefined;
    if (!isReal && !hasScript && pattern === undefined) {
      return invalid("a synthetic attempt requires script.steps and script.truth, or a known pattern");
    }

    const existing = this.#meta("attempt_id");
    if (existing !== null) {
      return existing === body.attempt_id
        ? json({ ok: true, already: true })
        : json({ ok: false, error: "already_open" }, 409);
    }

    const script = hasScript
      ? (body.script as Script)
      : {
          pattern: pattern?.id ?? "",
          truth: Array.isArray(body.truth)
            ? (body.truth as string[])
            : pattern === undefined
              ? []
              : [...pattern.truth],
          steps: [], // unused — the PatternDriver owns the steps; `script` meta stays unset.
        };
    const now = Date.now();
    const started = typeof body.started_at === "number" ? body.started_at : now;
    this.#sql.transaction(() => {
      const init: Record<string, string | number> = {
        attempt_id: body.attempt_id as string,
        intent_id: body.intent_id as string,
        change_id: body.change_id as string,
        pool_id,
        intent_text: redact(String(body.intent_text ?? ""), this.#secrets()),
        agent_kind: isReal ? "real" : "synthetic",
        model: body.model === null || body.model === undefined ? "" : String(body.model),
        revision: Number(body.revision ?? 1),
        resumed_n: 0,
        state: "opened",
        step: 0,
        shown_hn: 0,
        acked_hn: 0,
        tool_steps: 0,
        model_calls: 0,
        tokens_in: 0,
        tokens_out: 0,
        usd_spent: 0,
        started_at: started,
        deadline_at: started + ATTEMPT_TIMEOUT_MS,
        step_limit: MAX_STEPS,
        model_limit: MAX_MODEL_CALLS,
        token_limit: MAX_ATTEMPT_TOKENS,
        usd_limit: MAX_ATTEMPT_USD,
        truth: JSON.stringify(script.truth),
        released: "0",
        driver_state: "null",
        driver_last: "null",
        sync_needed: "0",
        resume_show: "0",
      };
      if (hasScript) init.script = JSON.stringify(body.script);
      if (pattern !== undefined) {
        init.pattern = pattern.id;
        init.seed = Number(body.seed ?? 0);
        init.agent_n = Number(body.agent_n ?? 0);
        init.hold = body.hold === true ? "1" : "0";
        init.think_ms = JSON.stringify(Array.isArray(body.think_ms) ? body.think_ms : [0, 0]);
      }
      if (isReal) init.driver = "model";
      if (typeof body.trunk_url === "string") init.trunk_url = body.trunk_url;
      if (typeof body.model_url === "string") init.model_url = body.model_url;
      if (typeof body.gate_url === "string") init.gate_url = body.gate_url;
      for (const [k, v] of Object.entries(init)) metaSet(this.#sql, k, v);
      if (isReal) {
        // SP1/SP2: the system prompt and the first user message — rows 1 and 2.
        for (const [i, row] of firstRows(String(body.intent_text)).entries()) {
          transcriptAppend(this.#sql, {
            step: i + 1,
            role: row.role,
            content: redact(row.content, this.#secrets()),
            tool: null,
            call_id: null,
            model: null,
            tokens_in: null,
            tokens_out: null,
            started_at: now,
            ended_at: null,
          });
        }
        metaSet(this.#sql, "step", 2);
        metaSet(this.#sql, "may_started", "0");
        metaSet(this.#sql, "epoch", "1");
      }
      timerPut(this.#sql, "watchdog", "main", now + AGENT_WATCHDOG_MS);
      timerPut(this.#sql, "attempt_timeout", "main", started + ATTEMPT_TIMEOUT_MS);
    });
    this.#open_attempt();
    this.ctx.waitUntil(this.#run());
    return json({ ok: true });
  }

  // -- push: Trunk -> Agent (HU5) ---------------------------------------------

  async #push(body: unknown): Promise<Response> {
    if (!isRecord(body) || !Array.isArray(body.heads_ups)) return invalid("heads_ups is required");
    if (this.#meta("attempt_id") === null || body.attempt_id !== this.#meta("attempt_id")) {
      return invalid("attempt is not open");
    }
    const heads_ups = body.heads_ups as HeadsUp[];
    this.#sql.transaction(() => {
      inbox.receive(this.#sql, heads_ups, Date.now());
    });
    if (heads_ups.some((hu) => hu.wake) && !TERMINAL_STATES.has(this.#meta("state") as AttemptState)) {
      this.ctx.waitUntil(this.#run());
    }
    return json({ ok: true });
  }

  // -- release: the launcher's SWR3 (a held scripted agent may now call submit) --

  async #release(body: unknown): Promise<Response> {
    if (!isRecord(body)) return invalid("a release request object is required");
    const stored = this.#meta("attempt_id");
    if (stored === null || stored !== body.attempt_id) return invalid("attempt is not open");
    if (this.#meta("released") === "1") return json({ ok: true, already: true });
    this.#set("released", "1");
    if (!TERMINAL_STATES.has(this.#meta("state") as AttemptState)) {
      this.ctx.waitUntil(this.#run());
    }
    return json({ ok: true });
  }

  // -- resume: Trunk -> Agent (RS1, RS2) ---------------------------------------

  async #resume(body: unknown): Promise<Response> {
    if (!isRecord(body) || typeof body.resume_n !== "number" || typeof body.revision !== "number") {
      return invalid("resume_n and revision are required");
    }
    const stored = this.#meta("attempt_id");
    const answer = (r: ResumeResponse) => json(r);
    if (stored === null || stored !== body.attempt_id) return answer({ ok: false, error: "attempt_unknown" });
    const resumed_n = this.#int("resumed_n");
    // A resume with a number at or below the stored one is a duplicate or an
    // older request: ok, and nothing else changes (RS2).
    if ((body.resume_n as number) <= resumed_n) return answer({ ok: true, resume_n: resumed_n });
    if (this.#meta("agent_kind") === "real") {
      // RS3: a model no longer in the plan is `model_unavailable`; a used-up
      // token or money budget is `budget` (tokens and money are not extended, AG6).
      const model = this.#meta("model") ?? "";
      if (model !== MODEL_PLAN.workhorse && !MODEL_PLAN.race.includes(model)) {
        return answer({ ok: false, error: "model_unavailable" });
      }
      if (
        this.#int("tokens_in") + this.#int("tokens_out") >= this.#int("token_limit") ||
        this.#int("usd_spent") >= this.#int("usd_limit")
      ) {
        return answer({ ok: false, error: "budget" });
      }
    }

    const now = Date.now();
    this.#sql.transaction(() => {
      this.#set("resumed_n", body.resume_n as number);
      this.#set("revision", body.revision as number);
      this.#set("step_limit", this.#int("step_limit") + RESUME_STEPS);
      this.#set("model_limit", this.#int("model_limit") + RESUME_MODEL_CALLS);
      this.#set("deadline_at", now + RESUME_TIMEOUT_MS);
      this.#sql.exec("DELETE FROM meta WHERE k IN ('stop_reason', 'pending_stop')");
      // The next step is a sync with the current ack; the waiting heads-ups
      // are then shown in order whatever their wake flag (RS2).
      this.#set("sync_needed", "1");
      this.#set("resume_show", "1");
      timerPut(this.#sql, "watchdog", "main", now + AGENT_WATCHDOG_MS);
      timerPut(this.#sql, "attempt_timeout", "main", now + RESUME_TIMEOUT_MS);
    });
    this.ctx.waitUntil(this.#run());
    return answer({ ok: true, resume_n: body.resume_n as number });
  }

  // -- owner stop --------------------------------------------------------------

  async #ownerStop(): Promise<Response> {
    if (this.#meta("attempt_id") === null) return json({ ok: true });
    if (!TERMINAL_STATES.has(this.#meta("state") as AttemptState)) {
      this.#set("pending_stop", "cancelled"); // the owner asked (TA9a)
      this.ctx.waitUntil(this.#run());
    }
    return json({ ok: true });
  }

  // -- the pump -----------------------------------------------------------------
  //
  // One in-flight step at a time. Everything the loop needs is durable, so a
  // restart re-enters here without losing its place: a journal row means
  // resend; pending_stop means send stop; sync_needed or an inbox gap means
  // sync; a waiting wake-run is shown first; otherwise the driver decides.

  async #run(): Promise<void> {
    if (this.#running) return;
    this.#open_attempt();
    if (this.#trunk === null || this.#driver === null) return;
    this.#running = true;
    try {
      for (;;) {
        const pending = this.#meta("pending_stop");
        if (pending !== null) {
          await this.#sendStop(pending as AgentStopReason);
          return;
        }
        if (TERMINAL_STATES.has(this.#meta("state") as AttemptState)) {
          await this.#releaseGateSlot(); // MG5: a landed or stopped attempt frees its slot
          return;
        }

        // Register ahead of the journal: for a real agent an `attempt_unknown`
        // answer keeps the call journaled (MR5), so register must run first or
        // the pump would resend into the same answer forever.
        if (this.#meta("register_needed") === "1") {
          if (!(await this.#register())) return;
          continue;
        }

        const journal = journaledCall(this.#sql);
        if (journal !== null) {
          // A model call parked on its `call` timer (SE8's gate wait or TL12's
          // provider rate limit) is re-served when the timer fires — a heads-up
          // or a sync must not cut the wait short.
          if (
            journal.kind === "model" &&
            (journal.request as { waiting?: boolean }).waiting === true &&
            journal.deadline_at > Date.now()
          ) {
            return;
          }
          await this.#serve(journal);
          continue;
        }

        if (this.#meta("sync_needed") === "1") {
          if (!(await this.#sync())) return;
          continue;
        }

        const shown_hn = this.#int("shown_hn");
        const next = inbox.next(this.#sql, shown_hn);
        if (next.sync) {
          if (!(await this.#sync())) return;
          // The gap is still open: the missing heads-ups come with the next
          // sync — or with the repush Trunk owes (HU8) — not by spinning here.
          if (inbox.next(this.#sql, this.#int("shown_hn")).sync) {
            timerPut(this.#sql, "sync", "main", Date.now() + HEADS_UP_REPUSH_MS);
            return;
          }
          continue;
        }
        const run = next.show.filter((hn) => this.#headsUp(hn)?.wake === true);
        const isReal = this.#meta("agent_kind") === "real";
        if (this.#meta("resume_show") === "1") {
          // RS2: every waiting heads-up is shown after a resume, whatever its
          // wake flag; a real agent with none waiting gets the resume message
          // (SP6) — the one `user` row of 4.5 row 2 — then the model is called.
          this.#set("resume_show", "0");
          if (next.show.length > 0) {
            if (isReal) this.#showHeadsUpsReal(next.show);
            else this.#showHeadsUps(next.show);
          } else if (isReal) {
            this.#appendUserRowReal(RESUME_MESSAGE);
          }
          continue;
        }
        if (run.length > 0) {
          if (isReal) this.#showHeadsUpsReal(next.show);
          else this.#showHeadsUps(next.show);
          continue;
        }

        // AG4: a spent budget ends the attempt here, before the next step;
        // a journaled call and a needed sync still complete above. The time
        // budget is the attempt_timeout timer; the rest are counters. The
        // step budget counts tool steps (TL1): for a real agent that is
        // `tool_steps` — `step` is the transcript's row number, which a
        // model turn also advances.
        const stepsUsed = isReal ? this.#int("tool_steps") : this.#int("step");
        if (
          stepsUsed >= this.#int("step_limit") ||
          this.#int("model_calls") >= this.#int("model_limit") ||
          this.#int("tokens_in") + this.#int("tokens_out") >= this.#int("token_limit") ||
          this.#int("usd_spent") >= this.#int("usd_limit")
        ) {
          this.#set("pending_stop", "budget");
          continue;
        }

        const decision = await this.#driver.next({
          last: this.#driverLast(),
          state: JSON.parse(this.#meta("driver_state") ?? "null") as unknown,
        });
        // The state and the consumed `last` move together: a restart replays
        // the decision exactly once.
        this.#sql.transaction(() => {
          this.#set("driver_state", JSON.stringify(decision.state));
          this.#set("driver_last", "null");
        });
        if (decision.kind === "wait") return;
        if (decision.kind === "stop") {
          await this.#sendStop(decision.reason);
          return;
        }
        await this.#toolCall(decision.tool, decision.args);
      }
    } finally {
      this.#running = false;
      await this.#deliverEvents();
      await this.#armAlarm();
    }
  }

  #driverLast(): ModelToolMessage | null {
    return JSON.parse(this.#meta("driver_last") ?? "null") as ModelToolMessage | null;
  }

  #headsUp(hn: number): HeadsUp | null {
    const rows = inboxRows(this.#sql);
    const row = rows.find((r) => r.hn === hn);
    return row === undefined ? null : (JSON.parse(row.body) as HeadsUp);
  }

  // The heads-up run is shown in one `user` transcript row (SP5), which
  // advances shown_hn and hands the heads-ups to the driver as its next last. `raw_heads_ups`
  // rides beside the model view — a `PatternDriver` consumes the `HeadsUp` shape itself.
  #showHeadsUps(hns: number[]): void {
    const raw = inbox.bodies(this.#sql, hns);
    const hus = raw.map((hu) => scriptedHeadsUpForModel(hu));
    const step = this.#int("step") + 1;
    const now = Date.now();
    this.#sql.transaction(() => {
      transcriptAppend(this.#sql, {
        step,
        role: "user",
        content: redact(JSON.stringify({ heads_ups: hus }), this.#secrets()),
        tool: null,
        call_id: null,
        model: null,
        tokens_in: null,
        tokens_out: null,
        started_at: now,
        ended_at: now,
      });
      inbox.markShown(this.#sql, hns, step);
      this.#set("step", step);
      if (hns.length > 0) this.#set("shown_hn", Math.max(...hns));
      this.#set("driver_last", JSON.stringify({ heads_ups: hus, raw_heads_ups: raw }));
      this.#set("resume_show", "0");
    });
  }

  // The model's own rendering of a heads-up run (SP5, HE3): the same
  // `headsUpUserMessage` the loop sends — never in the system role (HE4).
  #showHeadsUpsReal(hns: number[]): void {
    const raw = inbox.bodies(this.#sql, hns);
    const content = headsUpUserMessage(raw);
    const step = this.#int("step") + 1;
    const now = Date.now();
    this.#sql.transaction(() => {
      transcriptAppend(this.#sql, {
        step,
        role: "user",
        content: redact(content, this.#secrets()),
        tool: null,
        call_id: null,
        model: null,
        tokens_in: null,
        tokens_out: null,
        started_at: now,
        ended_at: now,
      });
      inbox.markShown(this.#sql, hns, step);
      this.#set("step", step);
      if (hns.length > 0) this.#set("shown_hn", Math.max(...hns));
      this.#set("resume_show", "0");
    });
  }

  // RS2's one `user` row when nothing is waiting (SP6): the resume message.
  #appendUserRowReal(text: string): void {
    const step = this.#int("step") + 1;
    const now = Date.now();
    this.#sql.transaction(() => {
      transcriptAppend(this.#sql, {
        step,
        role: "user",
        content: redact(text, this.#secrets()),
        tool: null,
        call_id: null,
        model: null,
        tokens_in: null,
        tokens_out: null,
        started_at: now,
        ended_at: now,
      });
      this.#set("step", step);
      this.#set("resume_show", "0");
    });
  }

  // -- one tool call (AG1) -------------------------------------------------------

  async #toolCall(tool: ToolName, args: object): Promise<void> {
    const step = this.#int("step") + 1;
    const attempt_id = this.#meta("attempt_id") as string;
    const isReal = this.#meta("agent_kind") === "real";
    const pending = isReal
      ? (
          JSON.parse(this.#meta("driver_state") ?? "null") as {
            pending?: { model_call_id: string; target: string | null };
          } | null
        )?.pending
      : undefined;
    const request: ToolRequest = {
      attempt_id,
      call_id: callId(attempt_id, step),
      ack: this.#int("shown_hn"),
      tool,
      // A real submit already carries the `acknowledge` the loop computed
      // (TD6); the scripted `#submitArgs` adds it for the canned drivers.
      args: tool === "submit" && !isReal ? this.#submitArgs(args) : args,
    };
    const now = Date.now();
    beginCall(this.#sql, {
      kind: "tool",
      call_id: request.call_id,
      request: {
        call: "tool",
        request,
        ...(pending !== undefined ? { model_call_id: pending.model_call_id, target: pending.target } : {}),
      } satisfies JournalRequest,
      started_at: now,
      deadline_at: now + TOOL_TIMEOUT_MS,
    });
    const journal = journaledCall(this.#sql);
    if (journal !== null) await this.#serve(journal);
  }

  // Send the journaled call — the same request, the same call_id, whether the
  // pump is sending it for the first time or again after a timeout or a
  // restart (AG4, TL12). A `model` journal is the driver's own call.
  async #serve(journal: JournalRow): Promise<void> {
    if (journal.kind === "model") {
      await this.#serveModel(journal);
      return;
    }
    const { request } = journal.request as JournalRequest & { call: "tool" };
    try {
      const response = await (this.#trunk as TrunkCalls).tool(request);
      this.#applyToolResponse(journal, response);
    } catch (e) {
      this.#callFailed(journal, e);
    }
  }

  // The model driver's serve: `applied` means the assistant row landed and the
  // pump decides next; `waiting` parks the journaled call on its `call` timer;
  // a stop goes to Trunk like any other (TL16).
  async #serveModel(journal: JournalRow): Promise<void> {
    if (this.#model === null) return;
    const parked =
      (journal.request as { waiting?: boolean }).waiting === true && journal.deadline_at > Date.now();
    if (parked) return;
    const result = await this.#model.serveCall(journal);
    await this.#deliverEvents();
    if (result === "applied" || result === "waiting") return;
    await this.#sendStop(result.stop);
  }

  // The response and every fact it carries go into the store in the one
  // transaction that deletes the journal row (AG1): inbox rows, the shown
  // run, the transcript row, the mirrors (MIR1), the limits, driver_last.
  #applyToolResponse(journal: JournalRow, response: ToolResponse): void {
    const current = journaledCall(this.#sql);
    if (current === null || current.call_id !== journal.call_id) return; // superseded
    if (this.#meta("agent_kind") === "real") {
      this.#applyToolResponseReal(journal, response);
      return;
    }
    const { request } = journal.request as JournalRequest & { call: "tool" };
    const now = Date.now();
    const step = this.#int("step") + 1;
    const shownBefore = this.#int("shown_hn");

    finishCall(this.#sql, journal.call_id, () => {
      inbox.receive(this.#sql, response.heads_ups ?? [], now);
      const run = inbox.next(this.#sql, shownBefore).show;
      const raw = inbox.bodies(this.#sql, run);
      const hus = raw.map((hu) => scriptedHeadsUpForModel(hu));
      const msg: ModelToolMessage & { raw_heads_ups?: HeadsUp[] } = {};
      if (hus.length > 0) {
        msg.heads_ups = hus;
        msg.raw_heads_ups = raw;
      }
      if (response.ok) {
        if (response.result !== undefined) msg.result = response.result;
      } else {
        msg.error = response.error ?? { code: "timeout", message: "no response" };
      }
      transcriptAppend(this.#sql, {
        step,
        role: "tool",
        content: redact(JSON.stringify(msg), this.#secrets()),
        tool: request.tool,
        call_id: journal.call_id,
        model: null,
        tokens_in: null,
        tokens_out: null,
        started_at: journal.started_at,
        ended_at: now,
      });
      inbox.markShown(this.#sql, run, step);
      this.#set("step", step);
      this.#set("tool_steps", this.#int("tool_steps") + 1);
      if (run.length > 0) this.#set("shown_hn", run[run.length - 1] ?? shownBefore);
      this.#set("state", response.attempt.state);
      if (response.heads_ups_more) this.#set("sync_needed", "1");
      if (response.error?.code === "attempt_closed" || TERMINAL_STATES.has(response.attempt.state)) {
        this.#set("sync_needed", "1");
      }
      for (const p of response.premises ?? []) {
        premisePut(this.#sql, {
          kind: p.kind,
          key: p.key,
          hash: p.hash,
          seq: p.seq,
          read: true,
          edit: false,
          derived: false,
        });
      }
      if (response.ok && (request.tool === "write" || request.tool === "replace")) {
        // The ops mirror holds the Operation of 01-core 5.1, rebuilt from the
        // acknowledged call: the results carry op_seq and (for replace) the
        // targets; a write's base_oid is the file premise's pinned hash
        // (`absent` for a create, W4).
        const a = request.args as { path?: string; content?: string; old?: string; new?: string };
        const r = response.result as { op_seq?: number; targets?: string[] } | undefined;
        if (r?.op_seq !== undefined) {
          const file = premiseList(this.#sql).find((x) => x.kind === "file" && x.key === a.path);
          opPut(
            this.#sql,
            r.op_seq,
            request.tool === "write"
              ? {
                  op_seq: r.op_seq,
                  op: "write",
                  path: a.path,
                  content: a.content ?? null,
                  base_oid: file?.hash ?? "absent",
                }
              : { op_seq: r.op_seq, op: "replace", path: a.path, old: a.old, new: a.new, targets: r.targets ?? [] },
          );
        }
      }
      // 3.6 step 6: a call for an attempt Trunk does not know is answered
      // attempt_unknown; the Agent then calls register itself.
      if (response.error?.code === "attempt_unknown") this.#set("register_needed", "1");
      if (request.tool === "submit" && response.ok) {
        const status = (response.result as { status?: string } | undefined)?.status;
        const duplicate = (response.result as { duplicate?: true } | undefined)?.duplicate;
        if (status !== undefined && !FINAL_FOR_ACK.has(status) && duplicate !== true) {
          this.#set("acked_hn", request.ack); // TL10
          inbox.prune(this.#sql, request.ack);
        }
      }
      this.#set("driver_last", JSON.stringify(msg));
    });
  }

  // The real apply path (TL12/TL14, MR5): `pool_not_ready`, `attempt_unknown`
  // and `timeout` keep the journal and write no row until the call has a real
  // answer; everything else writes the tool row of TL14 in the same
  // transaction as the mirrors and the `attempt.step` event.
  #applyToolResponseReal(journal: JournalRow, response: ToolResponse): void {
    const current = journaledCall(this.#sql);
    if (current === null || current.call_id !== journal.call_id) return; // superseded
    const jreq = journal.request as JournalRequest & { call: "tool" };
    const request = jreq.request;
    const code = response.ok ? null : (response.error?.code ?? null);
    const now = Date.now();

    if (code === "pool_not_ready") {
      // TL12: wait like a provider rate limit; the row's deadline_at moves with
      // it so the watchdog sees a call in progress.
      const waits = (jreq.waits ?? 0) + 1;
      const wait = Math.min(WAIT_BACKOFF_BASE_MS * 2 ** (waits - 1), WAIT_BACKOFF_MAX_MS);
      this.#sql.transaction(() => {
        journalPut(this.#sql, {
          kind: "tool",
          call_id: journal.call_id,
          request: { ...jreq, waits },
          tries: journal.tries,
          started_at: journal.started_at,
          deadline_at: now + wait,
        });
        timerPut(this.#sql, "call", journal.call_id, now + wait);
      });
      return;
    }
    if (code === "attempt_unknown") {
      // 3.6 step 6: the Agent calls register itself, then sends the same call_id.
      this.#set("register_needed", "1");
      return; // the journal stays; the pump registers, then re-serves it
    }
    if (code === "timeout") {
      this.#callFailedReal(journal);
      return;
    }

    const s = loadLoopState(this.#sql);
    const { message, needsSync } = messageForResponse(s, response);
    const row = writeToolRow(s, {
      tool: request.tool,
      call_id: journal.call_id,
      model_call_id: jreq.model_call_id ?? journal.call_id,
      args: isRecord(request.args) ? request.args : {},
      message,
      trunk_error: response.error?.code ?? null,
      counts_step: true,
      started_at: journal.started_at,
      ended_at: now,
    });
    const prev = s.meta.state;
    s.meta.state = response.attempt.state;
    finishCall(this.#sql, journal.call_id, () => {
      inbox.receive(this.#sql, response.heads_ups ?? [], now);
      transcriptAppend(this.#sql, {
        step: row.step,
        role: row.role,
        content: redact(row.content, this.#secrets()),
        tool: row.tool,
        call_id: row.call_id,
        model: row.model,
        tokens_in: row.tokens_in,
        tokens_out: row.tokens_out,
        started_at: row.started_at,
        ended_at: row.ended_at,
      });
      for (const entry of s.inbox) {
        if (entry.shown_step !== null) {
          this.#sql.exec("UPDATE inbox SET shown_step = ? WHERE hn = ?", entry.shown_step, entry.heads_up.hn);
        }
      }
      this.#set("step", row.step);
      this.#set("tool_steps", s.meta.tool_steps);
      this.#set("shown_hn", s.meta.shown_hn);
      this.#heldMirror(prev, response.attempt.state);
      this.#set("state", response.attempt.state);
      if (needsSync) this.#set("sync_needed", "1");
      if (code === "attempt_closed" || TERMINAL_STATES.has(response.attempt.state)) {
        this.#set("sync_needed", "1");
      }
      for (const p of response.premises ?? []) {
        premisePut(this.#sql, {
          kind: p.kind,
          key: p.key,
          hash: p.hash,
          seq: p.seq,
          read: true,
          edit: false,
          derived: false,
        });
      }
      if (response.ok && (request.tool === "write" || request.tool === "replace")) {
        const a = request.args as { path?: string; content?: string; old?: string; new?: string };
        const r = response.result as { op_seq?: number; targets?: string[] } | undefined;
        if (r?.op_seq !== undefined) {
          const file = premiseList(this.#sql).find((x) => x.kind === "file" && x.key === a.path);
          opPut(
            this.#sql,
            r.op_seq,
            request.tool === "write"
              ? {
                  op_seq: r.op_seq,
                  op: "write",
                  path: a.path,
                  content: a.content ?? null,
                  base_oid: file?.hash ?? "absent",
                }
              : { op_seq: r.op_seq, op: "replace", path: a.path, old: a.old, new: a.new, targets: r.targets ?? [] },
          );
        }
      }
      if (request.tool === "submit" && response.ok) {
        const status = (response.result as { status?: string } | undefined)?.status;
        const duplicate = (response.result as { duplicate?: true } | undefined)?.duplicate;
        if (status !== undefined && !FINAL_FOR_ACK.has(status) && duplicate !== true) {
          this.#set("acked_hn", request.ack); // TL10
          inbox.prune(this.#sql, request.ack);
        }
      }
      this.#emitStep({
        step: row.step,
        tool: request.tool,
        target: jreq.target ?? callTarget(request.tool, request.args as Record<string, unknown>),
        ok: response.ok,
        error: code,
        ms: now - journal.started_at,
      });
    });
  }

  #submitArgs(args: object): object {
    const acknowledge = inbox.acknowledge(this.#sql, this.#int("shown_hn"), this.#int("acked_hn"));
    if (acknowledge.length === 0) return args;
    // TD6: acknowledge without a statement is invalid_args at Trunk.
    return { ...args, acknowledge, statement: (args as { statement?: string }).statement ?? "not affected" };
  }

  // A transport-level failure — timeout, abort, HTTP error — is the timeout
  // path of TL12: at most 1 + TOOL_RETRIES sends, then stop tool_timeout.
  #callFailed(journal: JournalRow, e: unknown): void {
    if (this.#meta("agent_kind") === "real") {
      this.#callFailedReal(journal);
      return;
    }
    const current = journaledCall(this.#sql);
    if (current === null || current.call_id !== journal.call_id) return;
    const { request } = journal.request as JournalRequest & { call: "tool" };
    if (current.tries + 1 > TOOL_RETRIES) {
      const now = Date.now();
      const step = this.#int("step") + 1;
      finishCall(this.#sql, journal.call_id, () => {
        transcriptAppend(this.#sql, {
          step,
          role: "tool",
          content: redact(
            JSON.stringify({ error: { code: "timeout", message: e instanceof Error ? e.message : String(e) } }),
            this.#secrets(),
          ),
          tool: request.tool,
          call_id: journal.call_id,
          model: null,
          tokens_in: null,
          tokens_out: null,
          started_at: journal.started_at,
          ended_at: now,
        });
        this.#set("step", step);
        this.#set("pending_stop", "tool_timeout");
      });
      return;
    }
    retryCall(this.#sql, journal.call_id, Date.now() + TOOL_TIMEOUT_MS);
  }

  // A real agent's transport failure (TL12/TL14): the failure is the tool's
  // `attempt.step` with `ms` measured to the timeout; a tool row is written
  // only when the call has an answer, so the journal — not the transcript — is
  // the record here. The last retry ends the journal and stops tool_timeout.
  #callFailedReal(journal: JournalRow): void {
    const current = journaledCall(this.#sql);
    if (current === null || current.call_id !== journal.call_id) return;
    const jreq = journal.request as JournalRequest & { call: "tool" };
    const request = jreq.request;
    const now = Date.now();
    this.#emitStep({
      step: this.#int("step") + 1,
      tool: request.tool,
      target: jreq.target ?? callTarget(request.tool, request.args as Record<string, unknown>),
      ok: false,
      error: "timeout",
      ms: now - journal.started_at,
    });
    if (current.tries + 1 > TOOL_RETRIES) {
      this.#sql.transaction(() => {
        abandonCall(this.#sql, journal.call_id);
        this.#set("pending_stop", "tool_timeout");
      });
      return;
    }
    retryCall(this.#sql, journal.call_id, now + TOOL_TIMEOUT_MS);
  }

  // -- sync, stop, register --------------------------------------------------------

  // sync fetches the heads-ups above the current ack (4.10). It records no
  // transcript row and no journal; the durable `sync_needed` flag is what
  // brings it back after a crash, and RS2's journal row for the next step is
  // the journal of the call the sync unblocks.
  async #sync(): Promise<boolean> {
    try {
      const res = await (this.#trunk as TrunkCalls).sync(this.#int("shown_hn"));
      this.#sql.transaction(() => {
        inbox.receive(this.#sql, res.heads_ups, Date.now());
        this.#heldMirror(this.#meta("state") ?? "", res.attempt.state);
        this.#set("state", res.attempt.state);
        if (!res.heads_ups_more) this.#set("sync_needed", "0");
      });
      return true;
    } catch {
      timerPut(this.#sql, "sync", "main", Date.now() + HEADS_UP_REPUSH_MS);
      await this.#armAlarm();
      return false;
    }
  }

  // 3.6 step 6: a call answered attempt_unknown means Trunk was rebuilt and
  // lost the attempt. The Agent answers with its mirror — intent, revision,
  // the current operations and the read premises, plus the truth list of a
  // synthetic attempt (TR8). The `ops` mirror stores spec-shaped operations;
  // RegisterRequest["ops"] names the wider protocol union, which no tool
  // result returns — the cast marks the spec's own shape as what is sent.
  async #register(): Promise<boolean> {
    const req: Omit<RegisterRequest, "attempt_id"> = {
      intent_id: this.#meta("intent_id") ?? "",
      change_id: this.#meta("change_id") ?? "",
      revision: this.#int("revision"),
      agent_kind: (this.#meta("agent_kind") ?? "synthetic") as "real" | "synthetic",
      model: this.#meta("model") === "" ? null : this.#meta("model"),
      ops: opList(this.#sql).map((o) => o.body) as RegisterRequest["ops"],
      read_premises: premiseList(this.#sql)
        .filter((x) => x.read)
        .map((x) => ({ kind: x.kind as PremiseKind, key: x.key, hash: x.hash, seq: x.seq })),
      truth: JSON.parse(this.#meta("truth") ?? "[]") as string[],
    };
    let res: RegisterResponse;
    try {
      res = await (this.#trunk as TrunkCalls).register(req);
    } catch {
      timerPut(this.#sql, "register", "main", Date.now() + HEADS_UP_REPUSH_MS);
      await this.#armAlarm();
      return false;
    }
    this.#sql.transaction(() => {
      if (res.ok) {
        inbox.receive(this.#sql, res.heads_ups, Date.now());
        this.#heldMirror(this.#meta("state") ?? "", res.attempt.state);
        this.#set("state", res.attempt.state);
        this.#set("register_needed", "0");
      } else if (res.error === "attempt_closed") {
        this.#set("register_needed", "0");
        this.#set("sync_needed", "1"); // the attempt's real state comes by sync
      } else {
        timerPut(this.#sql, "register", "main", Date.now() + HEADS_UP_REPUSH_MS);
      }
    });
    if (this.#meta("register_needed") === "1") {
      await this.#armAlarm();
      return false;
    }
    return true;
  }

  // stop repeats until Trunk answers (TL16): the pending reason survives
  // restarts, and the call timer named "stop" re-sends after a failure.
  async #sendStop(reason: AgentStopReason): Promise<void> {
    let res;
    try {
      res = await (this.#trunk as TrunkCalls).stop(reason);
    } catch {
      timerPut(this.#sql, "call", "stop", Date.now() + HEADS_UP_REPUSH_MS);
      await this.#armAlarm();
      return;
    }
    this.#sql.transaction(() => {
      // Whatever call was still journaled is abandoned: the journal row and
      // its timer go in the same transaction as the stop (TL16).
      const j = journaledCall(this.#sql);
      if (j !== null) abandonCall(this.#sql, j.call_id);
      this.#sql.exec("DELETE FROM meta WHERE k = 'pending_stop'");
      if (res.ok) {
        this.#set("state", "stopped");
        this.#set("stop_reason", res.stop_reason);
      } else if (res.error === "attempt_unknown") {
        this.#set("state", "stopped");
        this.#set("stop_reason", reason);
      } else if (res.error === "attempt_closed") {
        this.#set("sync_needed", "1");
      }
      timerDelete(this.#sql, "call", "stop");
    });
    if (!res.ok && res.error === "attempt_closed") await this.#sync();
    // MG5: whatever Trunk answered, the stop ended the loop — the slot goes.
    await this.#releaseGateSlot();
  }

  // -- alarms (AL1, AL2, AG3) ------------------------------------------------------

  override async alarm(): Promise<void> {
    const now = Date.now();
    try {
      for (const t of timerDue(this.#sql, now)) {
        try {
          if (t.kind === "call" && t.key === "stop") {
            await this.#sendStop((this.#meta("pending_stop") as AgentStopReason | null) ?? "cancelled");
          } else if (t.kind === "call") {
            const j = journaledCall(this.#sql);
            if (j === null || j.call_id !== t.key) timerDelete(this.#sql, "call", t.key);
            else if (j.kind === "model") {
              // Only a parked wait is re-served here: a journal marked `waiting`
              // has no send in flight, so re-entering cannot start a second one.
              // A non-parked model journal belongs to a live send — its own
              // MODEL_TIMEOUT decides — or to a dead one, which recover sees.
              if ((j.request as { waiting?: boolean }).waiting === true) await this.#serve(j);
            } else this.#callFailed(j, new TrunkTransportError("call deadline passed"));
          } else if (t.kind === "events") {
            timerDelete(this.#sql, "events", t.key);
            await this.#deliverEvents();
          } else if (t.kind === "release") {
            timerDelete(this.#sql, "release", t.key);
            await this.#releaseGateSlot();
          } else if (t.kind === "watchdog") {
            await this.#watchdog(now);
          } else if (t.kind === "attempt_timeout") {
            if (this.#meta("state") === "accepted") {
              await this.#sync();
              timerPut(this.#sql, "attempt_timeout", "main", now + AGENT_WATCHDOG_MS);
            } else {
              this.#set("pending_stop", "timeout");
              timerDelete(this.#sql, "attempt_timeout", "main");
            }
          } else if (t.kind === "sync") {
            timerDelete(this.#sql, "sync", t.key);
            await this.#sync();
          } else if (t.kind === "register") {
            timerDelete(this.#sql, "register", t.key); // #run retries while the flag stands
          } else {
            timerDelete(this.#sql, t.kind, t.key);
          }
        } catch {
          // AL2: a failing handler keeps its timer and tries again later.
          timerPut(this.#sql, t.kind, t.key, now + HEADS_UP_REPUSH_MS);
        }
      }
      await this.#run();
    } finally {
      await this.#armAlarm();
    }
  }

  // AG3: no progress since the last run, outside an exempt wait, means stalled.
  async #watchdog(now: number): Promise<void> {
    const j = journaledCall(this.#sql);
    if (j !== null && j.deadline_at > now) {
      timerPut(this.#sql, "watchdog", "main", now + AGENT_WATCHDOG_MS);
      return;
    }
    await this.#sync(); // the watchdog syncs before it judges (AG3)
    const state = this.#meta("state") as AttemptState;
    // A wake run the sync just delivered is work the loop has not run yet — not a stall.
    const wakePending = inbox.next(this.#sql, this.#int("shown_hn")).show.some((hn) => {
      const hu = this.#headsUp(hn);
      return hu !== null && hu.wake === true;
    });
    const exempt =
      TERMINAL_STATES.has(state) || WAIT_STATES.has(state) || this.#meta("pending_stop") !== null || wakePending;
    const step = this.#int("step");
    if (exempt || step !== this.#int("wd_step")) {
      this.#set("wd_step", step);
      timerPut(this.#sql, "watchdog", "main", now + AGENT_WATCHDOG_MS);
      return;
    }
    this.#set("pending_stop", "stalled");
    timerDelete(this.#sql, "watchdog", "main");
  }

  // -- restart recovery (AG2, AG4) --------------------------------------------------

  async #recover(): Promise<void> {
    // The journal row — not the pump — decides: it is the call that never
    // completed, so it is sent again with the same call_id (AG4). While a
    // pump is already live its own journal step does the resend — a second
    // serve could race a model send in flight (TL15).
    const j = journaledCall(this.#sql);
    if (j === null || this.#running) {
      await this.#run();
      return;
    }
    // The send runs in the background: the caller (or a test) gets its
    // answer back now, the way a real restart answers requests while the
    // recovered call is still out.
    this.ctx.waitUntil(this.#serve(j));
  }

  // -- inspection for tests -----------------------------------------------------------

  #inspect(): Response {
    return json({
      meta: metaAll(this.#sql),
      journal: journaledCall(this.#sql),
      inbox: inboxRows(this.#sql).map((r) => ({
        hn: r.hn,
        shown_step: r.shown_step,
        result: (JSON.parse(r.body) as HeadsUp).result,
        wake: (JSON.parse(r.body) as HeadsUp).wake,
      })),
      ops: opList(this.#sql),
      timers: timerList(this.#sql),
      transcript: transcriptRows(this.#sql).map((r) => ({
        step: Number(r.step),
        role: String(r.role),
        tool: r.tool === null ? null : String(r.tool),
        call_id: r.call_id === null ? null : String(r.call_id),
        content: String(r.content),
      })),
    });
  }
}

// A submit status that ends the acked_hn bookkeeping (TL10): terminal or
// duplicate answers do not move it.
const FINAL_FOR_ACK = new Set(["accepted", "landed", "stopped", "rejected"]);
