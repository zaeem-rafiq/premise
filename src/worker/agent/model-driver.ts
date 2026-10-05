// src/worker/agent/model-driver.ts — the real agent's driver (05-agent 4, 01-core 3.3).
//
// The pure loop of src/core/agent/loop decides everything; this class wraps it in
// the Durable Object's durable machinery:
//
//   journal   AG1/AG2: a "model" journal row exists before the send and is gone
//             after it; a row that outlives the object is a lost try — it
//             counts, its reservation settles in full (SE6a), and the request
//             is sent again under a new reservation.
//   gate      MG4/SE6/SE8: may-start once, then reserve -> send -> settle per
//             try; a refusal stops (spend_cap, killed), a wait parks the call.
//   rows      transcript, inbox and counters of 01-core 3.3 in SQLite — the
//             loop's LoopState is rebuilt from them before every decision.
//   events    EV2a: `attempt.step` of the model turns (tokens, cost) and of the
//             tool turns — appended inside the call's own transaction.
//
// `next` returns the Driver port's tool/wait/stop: the pump journals and sends
// the tool call exactly as for a scripted agent, and the real apply path writes
// the tool row of TL14. Model calls happen inside `next`/`serveCall`.

import type { Driver, Sql } from "../../protocol/ports.ts";
import type { AgentStopReason } from "../../protocol/attempt.ts";
import type { ToolName, ToolResponse } from "../../protocol/tools.ts";
import {
  HEADS_UP_REPUSH_MS,
  MAX_ATTEMPT_TOKENS,
  MAX_ATTEMPT_USD,
  MAX_MODEL_CALLS,
  MAX_STEPS,
  MODEL_MAX_TOKENS,
  MODEL_RETRIES,
  MODEL_RETRY_BACKOFF_MS,
  MODEL_TIMEOUT_MS,
  WAIT_BACKOFF_BASE_MS,
  WAIT_BACKOFF_MAX_MS,
} from "../../protocol/constants.ts";
import { MODEL_OPTIONS, MODEL_PLAN } from "../../config/model-plan.ts";
import { importedFills, TIDE_FILLS } from "../../protocol/agent-prompt.ts";
import type { ImportedPrompt } from "../../protocol/internal.ts";
import { redact } from "../../protocol/redact.ts";
import { callModel, type AiBinding } from "../adapters/model/workers-ai.ts";
import { GateCalls } from "./gate-client.ts";
import { abandonCall, beginCall, finishCall, journaledCall } from "./journal.ts";
import { appendEvent } from "./events.ts";
import {
  inboxMarkShown,
  journalPut,
  metaSet,
  timerPut,
  transcriptAppend,
  transcriptRows,
  inboxRows,
  metaAll,
  type JournalRow,
} from "../../core/agent/store.ts";
import {
  callTarget,
  decodeAssistant,
  headsUpMessage,
  messageForResponse,
  nextAction,
  parseModelAnswer,
  processCall,
  textsForGuide,
  toHeadsUpForModel,
  toolBudgetOk,
  toolMessageFor,
  unshownRun,
  writeAssistantRow,
  writeToolRow,
  writeUserRow,
  type InboxEntry,
  type LoopState,
  type ModelConfig,
  type Row,
  type ToolCall,
} from "../../core/agent/loop/index.ts";
import type { HeadsUp } from "../../protocol/headsup.ts";

/** `journal.request` of a model call (TL14): the request, the elided rows, the
 * reservation in flight, and the wait/try bookkeeping of TL12. */
export type ModelJournalRequest = {
  call: "model";
  model: string;
  request: Record<string, unknown>;
  request_bytes: number;
  elided_steps: number[];
  reservation_id: string | null; // the open reservation; null before reserve and after settle
  waiting: boolean; // parked on a gate timer (SE8): no send is in flight
  error: string | null; // the last failed try's TL12 code
  waits: number; // consecutive rate-limit waits: the TL12 doubling counter
};

export type ModelDeps = {
  sql: Sql;
  ai: AiBinding;
  gate: GateCalls | null; // null: the binding is absent — the driver waits, never calls un-gated
  model: string;
  pool: string;
  attemptId: string;
  secrets(): string[];
  /** Frees the real-agent slot when the loop ends or waits (MG5). */
  releaseSlot(): Promise<void>;
  /** EV2: start the outbox's delivery to the pool's Floor — called after the
   * transaction that appended the event commits, never inside it (an in-flight
   * post would miss the not-yet-committed row). */
  kickEvents(): void;
};

type ServeResult = "applied" | "waiting" | { stop: AgentStopReason };

type Decision =
  | { kind: "tool"; tool: ToolName; args: object; state: unknown }
  | { kind: "wait"; state: unknown }
  | { kind: "stop"; reason: AgentStopReason; state: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A usage block readable even when the answer itself does not parse (SE6a). */
function rawUsageOf(result: unknown): { prompt_tokens: number; completion_tokens: number } | null {
  if (!isRecord(result) || !isRecord(result.usage)) return null;
  const u = result.usage;
  if (typeof u.prompt_tokens !== "number" || typeof u.completion_tokens !== "number") return null;
  if (!Number.isFinite(u.prompt_tokens) || !Number.isFinite(u.completion_tokens)) return null;
  return { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens };
}

/** The resume extension (RS1): a resume raises the Agent's `*_limit` rows above
 * the spec's base budgets, but the pure loop's checks read the constants. The
 * driver hands the loop counters shifted by the extension — a shifted counter
 * may go negative, which only reads as more headroom to the loop's `>=` checks
 * — and `budgetExtension` gives the shift back so a persist stores the real
 * numbers. The WeakMap keys on the loaded state object: the extension that was
 * applied at load is the one undone at persist, whatever a resume changed in
 * between. */
interface BudgetExt {
  calls: number;
  steps: number;
  tokens: number;
  usd: number;
}
const BUDGET_EXT = new WeakMap<LoopState, BudgetExt>();
const NO_EXT: BudgetExt = { calls: 0, steps: 0, tokens: 0, usd: 0 };
export function budgetExtension(s: LoopState): BudgetExt {
  return BUDGET_EXT.get(s) ?? NO_EXT;
}

/** `meta.state` mirror + counters, rebuilt from the tables of 01-core 3.3. */
export function loadLoopState(sql: Sql): LoopState {
  const m = metaAll(sql);
  const num = (k: string): number => (m[k] === undefined ? 0 : Number(m[k]));
  const rows: Row[] = transcriptRows(sql).map((r) => ({
    step: Number(r.step),
    role: r.role as Row["role"],
    content: String(r.content),
    tool: r.tool === null ? null : String(r.tool),
    call_id: r.call_id === null ? null : String(r.call_id),
    model: r.model === null ? null : String(r.model),
    tokens_in: r.tokens_in === null ? null : Number(r.tokens_in),
    tokens_out: r.tokens_out === null ? null : Number(r.tokens_out),
    started_at: Number(r.started_at),
    ended_at: r.ended_at === null ? null : Number(r.ended_at),
  }));
  const inbox: InboxEntry[] = inboxRows(sql).map((r) => ({
    heads_up: JSON.parse(r.body) as HeadsUp,
    shown_step: r.shown_step,
    received_at: r.received_at,
  }));
  // RS1: counters shifted down by the resume extension; persisted back +ext.
  const ext: BudgetExt = {
    calls: Math.max(0, num("model_limit") - MAX_MODEL_CALLS),
    steps: Math.max(0, num("step_limit") - MAX_STEPS),
    tokens: Math.max(0, num("token_limit") - MAX_ATTEMPT_TOKENS),
    usd: Math.max(0, num("usd_limit") - MAX_ATTEMPT_USD),
  };
  // IR9 to IR11: the pool's prompt context, stored at open — a seed pool's meta carries no
  // `imported`, so the rebuilt loop's fills are the tide pool's. A restart re-reads it (kept
  // across eviction), and a resumed attempt keeps the prompt it opened with.
  const imported = m.imported;
  const state: LoopState = {
    rows,
    inbox,
    fills: imported === undefined ? TIDE_FILLS : importedFills(JSON.parse(imported) as ImportedPrompt),
    meta: {
      step: num("step"),
      tool_steps: num("tool_steps") - ext.steps,
      model_calls: num("model_calls") - ext.calls,
      nudges: num("nudges"),
      tokens_in: num("tokens_in") - ext.tokens,
      tokens_out: num("tokens_out"),
      spent_usd: num("usd_spent") - ext.usd,
      shown_hn: num("shown_hn"),
      acked_hn: num("acked_hn"),
      state: m.state ?? "opened",
      stopped: m.pending_stop ?? null,
    },
    syncNeeded: m.sync_needed === "1",
  };
  if (ext.calls !== 0 || ext.steps !== 0 || ext.tokens !== 0 || ext.usd !== 0) BUDGET_EXT.set(state, ext);
  return state;
}

/** The calls of the last assistant reply with no tool row yet (05-agent 4.5 row 5). */
function pendingCallsOf(state: LoopState): { row: Row; calls: ToolCall[]; answered: number } | null {
  let row: Row | null = null;
  for (let i = state.rows.length - 1; i >= 0; i--) {
    const candidate = state.rows[i];
    if (candidate === undefined) continue;
    if (candidate.role === "assistant") {
      row = candidate;
      break;
    }
    if (candidate.role === "user") return null;
  }
  if (row === null) return null;
  const answered = state.rows.length - row.step;
  return { row, calls: decodeAssistant(row).tool_calls.slice(answered), answered };
}

/** The `finish_reason` of the last assistant row — TD4's `output_cut` input. */
function finishOfLastAssistant(state: LoopState): string | null {
  for (let i = state.rows.length - 1; i >= 0; i--) {
    const row = state.rows[i];
    if (row !== undefined && row.role === "assistant") return decodeAssistant(row).finish_reason;
  }
  return null;
}

export class ModelDriver implements Driver {
  #deps: ModelDeps;

  constructor(deps: ModelDeps) {
    this.#deps = deps;
  }

  get #sql(): Sql {
    return this.#deps.sql;
  }

  #meta(k: string): string | null {
    const rows = this.#sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray();
    return rows.length === 0 ? null : String(rows[0]?.v);
  }

  #set(k: string, v: string | number): void {
    metaSet(this.#sql, k, v);
  }

  /** The `model` config of `nextAction`: MG2's options and the plan's prices. An
   * unpriced model fails closed: its bound is unbounded, the budget check stops it. */
  #modelCfg(): ModelConfig {
    const price = MODEL_PLAN.prices_usd_per_mtok[this.#deps.model];
    return {
      options: MODEL_OPTIONS[this.#deps.model] ?? {},
      price:
        price === undefined
          ? { input: Number.MAX_SAFE_INTEGER, output: Number.MAX_SAFE_INTEGER }
          : { input: price.in, output: price.out },
    };
  }

  #bound(requestBytes: number): number {
    const price = MODEL_PLAN.prices_usd_per_mtok[this.#deps.model];
    if (price === undefined) return Number.MAX_SAFE_INTEGER;
    return (requestBytes * price.in + MODEL_MAX_TOKENS * price.out) / 1_000_000;
  }

  // -- persistence: the loop's in-memory effects to the tables of 3.3 ---------

  #persistCounters(s: LoopState): void {
    const ext = budgetExtension(s);
    this.#set("step", s.meta.step);
    this.#set("tool_steps", s.meta.tool_steps + ext.steps);
    this.#set("model_calls", s.meta.model_calls + ext.calls);
    this.#set("nudges", s.meta.nudges);
    this.#set("tokens_in", s.meta.tokens_in + ext.tokens);
    this.#set("tokens_out", s.meta.tokens_out);
    this.#set("usd_spent", s.meta.spent_usd + ext.usd);
    this.#set("shown_hn", s.meta.shown_hn);
    this.#set("acked_hn", s.meta.acked_hn);
    this.#set("state", s.meta.state);
    if (s.syncNeeded) this.#set("sync_needed", "1");
  }

  /** Append rows the loop wrote and sync every counter + shown mark (TL14's "one transaction"). */
  #persistRows(s: LoopState, rows: Row[]): void {
    const secrets = this.#deps.secrets();
    this.#sql.transaction(() => {
      for (const row of rows) {
        transcriptAppend(this.#sql, {
          step: row.step,
          role: row.role,
          content: redact(row.content, secrets),
          tool: row.tool,
          call_id: row.call_id,
          model: row.model,
          tokens_in: row.tokens_in,
          tokens_out: row.tokens_out,
          started_at: row.started_at,
          ended_at: row.ended_at,
        });
      }
      for (const entry of s.inbox) {
        if (entry.shown_step !== null) inboxMarkShown(this.#sql, [entry.heads_up.hn], entry.shown_step);
      }
      this.#persistCounters(s);
    });
  }

  // -- EV2a: the Agent's own attempt.step events -------------------------------

  #emitStep(fields: {
    step: number;
    tool: string | null;
    target: string | null;
    ok: boolean;
    error: string | null;
    ms: number;
    tokens_in: number | null;
    tokens_out: number | null;
    cost_usd: number | null;
  }): void {
    // EV6: a `summary_only` pool's stream holds no per-step events. The `step`
    // is the transcript's row number (05-agent's "Row" line), so a `user` row
    // leaves a number unused by the stream.
    if (this.#meta("summary_only") === "1") return;
    appendEvent(this.#sql, {
      ts: Date.now(),
      pool: this.#deps.pool,
      src: "agent",
      type: "attempt.step",
      attempt_id: this.#deps.attemptId,
      step: fields.step,
      tool: fields.tool,
      target: fields.target,
      ok: fields.ok,
      error: fields.error,
      ms: fields.ms,
      tokens_in: fields.tokens_in,
      tokens_out: fields.tokens_out,
      cost_usd: fields.cost_usd,
    });
  }

  // -- the model call (MG4, TL12, TL14, AG2) ------------------------------------

  #journalUpdate(journal: JournalRow, request: ModelJournalRequest, tries: number, deadline_at: number): void {
    journalPut(this.#sql, {
      kind: "model",
      call_id: journal.call_id,
      request,
      tries,
      started_at: journal.started_at,
      deadline_at,
    });
    timerPut(this.#sql, "call", journal.call_id, deadline_at);
    journal.request = request;
    journal.tries = tries;
    journal.deadline_at = deadline_at;
  }

  /** Park the journaled call on its `call` timer: the wait keeps the journal,
   * moves `deadline_at` so the watchdog sees a call in progress (TL12). */
  #park(journal: JournalRow, request: ModelJournalRequest, waitMs: number): "waiting" {
    this.#sql.transaction(() => {
      this.#journalUpdate(journal, { ...request, waiting: true }, journal.tries, Date.now() + waitMs);
    });
    return "waiting";
  }

  /** Settle a reservation; a transport failure charges the bound (the gate's
   * sweep will charge it in full at expiry, SE6a — the count never goes low). */
  async #settle(reservationId: string, usage: { tokens_in: number; tokens_out: number } | null): Promise<number> {
    if (this.#deps.gate === null) return 0;
    try {
      const res = await this.#deps.gate.settle({ reservation_id: reservationId, usage });
      return typeof res.charged_usd === "number" ? res.charged_usd : 0;
    } catch {
      return Number.NaN; // caller substitutes the bound
    }
  }

  /** One failed try that counts (TL12): the step, the counters, the journal's
   * tries — then the park for the next try, or the journal's end when the
   * retries are used up. The retry is never awaited in line: the journal's
   * `call` timer re-enters `serveCall`, so an eviction mid-wait loses nothing
   * and no alarm can observe a send that is not really in flight. */
  #failedTry(
    s: LoopState,
    journal: JournalRow,
    request: ModelJournalRequest,
    code: string,
    charged: number,
    ms: number,
  ): "waiting" | { stop: AgentStopReason } {
    const tries = journal.tries + 1;
    if (tries > MODEL_RETRIES) {
      this.#sql.transaction(() => {
        s.meta.model_calls++;
        s.meta.spent_usd += charged;
        this.#persistCounters(s);
        this.#emitStep({
          step: s.meta.step + 1,
          tool: null,
          target: null,
          ok: false,
          error: code,
          ms,
          tokens_in: null,
          tokens_out: null,
          cost_usd: charged,
        });
        abandonCall(this.#sql, journal.call_id);
      });
      this.#deps.kickEvents();
      return { stop: "model_error" };
    }
    const backoff = Math.min(MODEL_RETRY_BACKOFF_MS * 2 ** (tries - 1), WAIT_BACKOFF_MAX_MS);
    this.#sql.transaction(() => {
      s.meta.model_calls++;
      s.meta.spent_usd += charged;
      this.#persistCounters(s);
      this.#emitStep({
        step: s.meta.step + 1,
        tool: null,
        target: null,
        ok: false,
        error: code,
        ms,
        tokens_in: null,
        tokens_out: null,
        cost_usd: charged,
      });
      this.#journalUpdate(
        journal,
        { ...request, reservation_id: null, waiting: true, error: code, waits: 0 },
        tries,
        Date.now() + backoff,
      );
    });
    this.#deps.kickEvents();
    return "waiting";
  }

  /**
   * Serve a journaled model call — fresh from `next`, after a parked wait, or
   * recovered after an eviction (AG2). The call's journal row is the record.
   * Every wait ends here as `"waiting"` with the journal parked on its `call`
   * timer; only an applied answer or a stop leaves the function.
   */
  async serveCall(journal: JournalRow, s?: LoopState): Promise<ServeResult> {
    const state = s ?? loadLoopState(this.#sql);
    let req = journal.request as ModelJournalRequest;
    const bound = this.#bound(req.request_bytes);

    // AG2: a reservation was open and the call was not parked — the send was in
    // flight when the object died. The lost try counts; its reservation settles
    // in full (SE6a: settle without a usage report).
    if (req.reservation_id !== null && req.waiting !== true) {
      const settled = await this.#settle(req.reservation_id, null);
      const charged = Number.isNaN(settled) ? bound : settled;
      const ms = Date.now() - journal.started_at;
      return this.#failedTry(state, journal, req, req.error ?? "model_timeout", charged, ms);
    }

    req = { ...req, waiting: false };
    // SE8/MG5: may-start guards the loop's start — the attempt's first call only.
    if (this.#deps.gate === null) {
      return this.#park(journal, req, HEADS_UP_REPUSH_MS); // fail closed: never un-gated
    }
    if (this.#meta("may_started") !== "1") {
      let may;
      try {
        may = await this.#deps.gate.mayStart(this.#deps.attemptId);
      } catch {
        return this.#park(journal, req, HEADS_UP_REPUSH_MS);
      }
      if (!may.ok) return this.#park(journal, req, may.retry_after_ms);
      this.#set("may_started", "1");
    }
    // SE6: the reservation before the send.
    let reserved;
    try {
      reserved = await this.#deps.gate.reserve({
        attempt_id: this.#deps.attemptId,
        pool: this.#deps.pool,
        model: req.model,
        request_bytes: req.request_bytes,
        max_tokens: MODEL_MAX_TOKENS,
      });
    } catch {
      return this.#park(journal, req, HEADS_UP_REPUSH_MS);
    }
    if (!reserved.ok) {
      if ("refused" in reserved) {
        this.#sql.transaction(() => abandonCall(this.#sql, journal.call_id));
        return { stop: reserved.refused }; // SE7 spend_cap, SE10 killed
      }
      return this.#park(journal, req, reserved.retry_after_ms); // SE8: a wait, not a try
    }
    req.reservation_id = reserved.reservation_id;
    const sendStart = Date.now();
    this.#sql.transaction(() => {
      this.#journalUpdate(journal, req, journal.tries, sendStart + MODEL_TIMEOUT_MS);
    });
    const outcome = await callModel(this.#deps.ai, req.model, req.request, MODEL_TIMEOUT_MS);
    const ended = Date.now();
    const ms = ended - sendStart;
    const reservationId = req.reservation_id;

    if (outcome.kind === "answer") {
      const parsed = parseModelAnswer(outcome.result, state.meta.step + 1);
      const usage = parsed?.usage ?? rawUsageOf(outcome.result);
      const settled = await this.#settle(
        reservationId,
        usage === null ? null : { tokens_in: usage.prompt_tokens, tokens_out: usage.completion_tokens },
      );
      const charged = Number.isNaN(settled) ? bound : settled;
      req.reservation_id = null;
      if (parsed !== null) {
        finishCall(this.#sql, journal.call_id, () => {
          const row = writeAssistantRow(state, {
            answer: {
              content: parsed.content,
              tool_calls: parsed.tool_calls,
              finish_reason: parsed.finish_reason,
              ...(parsed.reasoning !== undefined ? { reasoning: parsed.reasoning } : {}),
            },
            model: req.model,
            tokens_in: usage?.prompt_tokens ?? null,
            tokens_out: usage?.completion_tokens ?? null,
            started_at: journal.started_at,
            ended_at: ended,
          });
          state.meta.spent_usd += charged;
          transcriptAppend(this.#sql, {
            step: row.step,
            role: row.role,
            content: redact(row.content, this.#deps.secrets()),
            tool: row.tool,
            call_id: row.call_id,
            model: row.model,
            tokens_in: row.tokens_in,
            tokens_out: row.tokens_out,
            started_at: row.started_at,
            ended_at: row.ended_at,
          });
          this.#persistCounters(state);
          const noCall = parsed.tool_calls.length === 0;
          this.#emitStep({
            step: row.step,
            tool: null,
            target: null,
            ok: !noCall,
            error: noCall ? "no_tool_call" : null,
            ms,
            tokens_in: usage?.prompt_tokens ?? null,
            tokens_out: usage?.completion_tokens ?? null,
            cost_usd: charged,
          });
        });
        this.#deps.kickEvents();
        return "applied";
      }
      return this.#failedTry(state, journal, { ...req, waits: 0 }, "model_bad_output", charged, ms);
    }

    const settled = await this.#settle(reservationId, null);
    const charged = Number.isNaN(settled) ? bound : settled;
    req.reservation_id = null;

    if (outcome.kind === "rate_limited") {
      // SE8/TL12: the provider's rate answer is a wait, never a counted try.
      const waits = req.waits + 1;
      const wait = Math.min(
        Math.max(outcome.retry_after_ms ?? 0, WAIT_BACKOFF_BASE_MS * 2 ** (waits - 1)),
        WAIT_BACKOFF_MAX_MS,
      );
      this.#sql.transaction(() => {
        state.meta.spent_usd += charged;
        this.#persistCounters(state);
        this.#emitStep({
          step: state.meta.step + 1,
          tool: null,
          target: null,
          ok: false,
          error: "model_rate_limited",
          ms,
          tokens_in: null,
          tokens_out: null,
          cost_usd: charged,
        });
        this.#journalUpdate(journal, { ...req, waits, waiting: true }, journal.tries, Date.now() + wait);
      });
      this.#deps.kickEvents();
      return "waiting";
    }

    if (outcome.kind === "rejected") {
      // TL12: model_rejected stops at once — repeating cannot help.
      this.#sql.transaction(() => {
        state.meta.model_calls++;
        state.meta.spent_usd += charged;
        this.#persistCounters(state);
        this.#emitStep({
          step: state.meta.step + 1,
          tool: null,
          target: null,
          ok: false,
          error: "model_rejected",
          ms,
          tokens_in: null,
          tokens_out: null,
          cost_usd: charged,
        });
        abandonCall(this.#sql, journal.call_id);
      });
      this.#deps.kickEvents();
      return { stop: "model_error" };
    }

    // timeout / unavailable: a counted try (TL12).
    const code = outcome.kind === "timeout" ? "model_timeout" : "model_unavailable";
    return this.#failedTry(state, journal, req, code, charged, ms);
  }

  // -- the Driver port ---------------------------------------------------------

  async next(input: { last: unknown; state: unknown }): Promise<Decision> {
    void input;
    const s = loadLoopState(this.#sql);
    const texts = textsForGuide(s.fills.guide);
    for (;;) {
      const action = nextAction(s, { model: this.#modelCfg(), texts });
      switch (action.type) {
        case "stop": {
          await this.#deps.releaseSlot();
          const reason = action.reason.startsWith("model_error")
            ? ("model_error" as AgentStopReason)
            : action.reason.startsWith("budget")
              ? ("budget" as AgentStopReason)
              : (action.reason as AgentStopReason);
          return { kind: "stop", reason, state: null };
        }
        case "idle": {
          await this.#deps.releaseSlot();
          return { kind: "wait", state: null };
        }
        case "show_heads_ups": {
          const row = writeUserRow(s, headsUpMessage(action.heads_ups), Date.now());
          this.#persistRows(s, [row]);
          continue;
        }
        case "nudge": {
          const row = writeUserRow(s, action.text, Date.now());
          s.meta.nudges++;
          this.#persistRows(s, [row]);
          continue;
        }
        case "answer_rest": {
          const pending = pendingCallsOf(s);
          const now = Date.now();
          const rows: Row[] = [];
          for (const call of pending?.calls ?? []) {
            rows.push(
              writeToolRow(s, {
                tool: call.function.name,
                call_id: null,
                model_call_id: call.id,
                args: isRecord(call.function.arguments) ? call.function.arguments : {},
                message: toolMessageFor({
                  error: { code: "not_run", detail: { reason: action.reason } },
                  heads_ups: unshownRun(s).show.map((hu) => toHeadsUpForModel(hu)),
                  texts,
                }),
                counts_step: false,
                started_at: now,
                ended_at: now,
              }),
            );
          }
          if (rows.length > 0) this.#persistRows(s, rows);
          continue;
        }
        case "tool": {
          const outcome = processCall(s, action.call, finishOfLastAssistant(s));
          if (outcome.kind === "error") {
            const now = Date.now();
            const row = writeToolRow(s, {
              tool: action.call.function.name,
              call_id: null,
              model_call_id: action.call.id,
              args: isRecord(action.call.function.arguments) ? action.call.function.arguments : {},
              message: toolMessageFor({
                error: { code: outcome.code, detail: outcome.detail },
                heads_ups: unshownRun(s).show.map((hu) => toHeadsUpForModel(hu)),
                texts,
              }),
              counts_step: false,
              started_at: now,
              ended_at: now,
            });
            this.#persistRows(s, [row]);
            continue;
          }
          if (!toolBudgetOk(s)) {
            await this.#deps.releaseSlot();
            return { kind: "stop", reason: "budget", state: null };
          }
          const tool = action.call.function.name as ToolName;
          const target = callTarget(tool, outcome.args as Record<string, unknown>);
          // `pending` rides in driver_state: the pump writes it next to the
          // journal row, so the tool row can carry the model's call id (TL14).
          return {
            kind: "tool",
            tool,
            args: outcome.args,
            state: { pending: { model_call_id: action.call.id, target } },
          };
        }
        case "model": {
          const callId = `${this.#deps.attemptId}:m${s.meta.step + 1}`;
          const now = Date.now();
          beginCall(this.#sql, {
            kind: "model",
            call_id: callId,
            request: {
              call: "model",
              model: this.#deps.model,
              request: action.request,
              request_bytes: action.request_bytes,
              elided_steps: action.elided_steps,
              reservation_id: null,
              waiting: false,
              error: null,
              waits: 0,
            } satisfies ModelJournalRequest,
            started_at: now,
            deadline_at: now + MODEL_TIMEOUT_MS,
          });
          const journal = journaledCall(this.#sql);
          if (journal === null) return { kind: "wait", state: null };
          const result = await this.serveCall(journal, s);
          if (result === "applied") continue;
          if (result === "waiting") return { kind: "wait", state: null };
          return { kind: "stop", reason: result.stop, state: null };
        }
      }
    }
  }
}
