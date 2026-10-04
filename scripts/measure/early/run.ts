// The driver of one early run: the pure loop of `src/core/agent/loop` decides what happens next;
// this file performs it — a model call over the injected transport, a tool call on the in-memory
// pool, a row written. ME2 (fresh state), ME4 (limits and spend), ME5 (the scripted heads-up) and
// TL12 (retries and waits) live here. `callModel` and `clock` are injected so tests use a fake.

import {
  decodeAssistant,
  decodeToolRow,
  headsUpMessage,
  messageForResponse,
  nextAction,
  newLoopState,
  processCall,
  receiveHeadsUp,
  startAttempt,
  toHeadsUpForModel,
  toolBudgetOk,
  toolMessageFor,
  unshownRun,
  writeAssistantRow,
  writeToolRow,
  writeUserRow,
  type LoopState,
  type Row,
  type ToolCall,
} from "../../../src/core/agent/loop/index.ts";
import {
  ATTEMPT_TIMEOUT_MS,
  MODEL_MAX_TOKENS,
  MODEL_RETRIES,
  MODEL_RETRY_BACKOFF_MS,
  WAIT_BACKOFF_BASE_MS,
  WAIT_BACKOFF_MAX_MS,
} from "../../../src/protocol/constants.ts";
import { GUIDE_PATH } from "../../../src/protocol/agent-prompt.ts";
import type { ToolRequest, ToolResponse } from "../../../src/protocol/tools.ts";
import { parseModelAnswer } from "../../../src/core/agent/loop/model.ts";
import type { ModelPrice } from "../../../src/core/agent/loop/model.ts";
import type { RestOutcome } from "./workers-ai-rest.ts";
import { newMemPool, type MemPool } from "./mem-pool.ts";
import { buildHeroHeadsUp, landEnergyChange, ENERGY_PATH } from "./heads-up.ts";
import { scoreCompleted, classifyHero, type Completion, type HeroClass } from "./score.ts";
import type { IntentSpec } from "./intents.ts";
import type { Ledger } from "./ledger.ts";

export type CallModel = (request: Record<string, unknown>) => Promise<RestOutcome>;

export type Clock = {
  now(): number; // milliseconds
  sleep(ms: number): Promise<void>;
};

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type RunRecord = {
  intent: string;
  run: number;
  outcome: "landed" | "completed" | "other_name" | "not_completed" | "not_counted";
  stop_reason: string | null;
  seconds: number | null;
  waited_ms: number;
  model_calls: number;
  tool_calls: number;
  tool_errors: number;
  nudges: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  first_tool: string | null;
  whole_file_reads: string[];
  files: Record<string, string>;
  hero: {
    class: string;
    judged_by: "rule" | "person";
    before: string | null;
    statement: string | null;
    repair_ms: number | null;
  } | null;
};

export type RunResult = {
  record: RunRecord;
  rows: Row[];
  pool: MemPool;
  spend_usd: number;
  rate_limited: number;
  incomplete: boolean; // --max-usd stopped this run's work
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function lastAssistantCalls(state: LoopState): ToolCall[] {
  for (let i = state.rows.length - 1; i >= 0; i--) {
    const row = state.rows[i] as Row;
    if (row.role === "assistant") return decodeAssistant(row).tool_calls;
    if (row.role === "user") break;
  }
  return [];
}

function answeredCalls(state: LoopState): number {
  let last = -1;
  for (let i = state.rows.length - 1; i >= 0; i--) {
    if ((state.rows[i] as Row).role === "assistant") {
      last = i;
      break;
    }
    if ((state.rows[i] as Row).role === "user") return 0;
  }
  if (last === -1) return 0;
  return state.rows.length - 1 - last;
}

function finishReasonOfLastAssistant(state: LoopState): string | null {
  for (let i = state.rows.length - 1; i >= 0; i--) {
    const row = state.rows[i] as Row;
    if (row.role === "assistant") return decodeAssistant(row).finish_reason;
    if (row.role === "user") return null;
  }
  return null;
}

const passing = (req: ToolRequest, response: ToolResponse): boolean =>
  req.tool === "submit" &&
  response.ok === true &&
  isRecord(response.result) &&
  (response.result.status === "validated" ||
    response.result.status === "submitted" ||
    response.result.status === "accepted");

/**
 * One run of the plan (ME2: fresh state). `hero` intents get the scripted heads-up of ME5 after
 * their first passing submit. The loop runs until `nextAction` says stop or idle, or a limit.
 */
export async function runOnce(opts: {
  attemptId: string;
  intent: IntentSpec;
  runIndex: number;
  seed: Map<string, string>;
  seedPaths: ReadonlySet<string>;
  modelId: string;
  modelOptions: object;
  modelPrice: ModelPrice;
  ledger: Ledger;
  callModel: CallModel;
  clock: Clock;
}): Promise<RunResult> {
  const { clock, ledger } = opts;
  const state = newLoopState();
  const pool = newMemPool({ attemptId: opts.attemptId, head: opts.seed });
  const hero = opts.intent.set === "hero";
  const heroState = {
    injected: false,
    skipped: false,
    before: null as string | null,
    repairStart: null as number | null,
    secondPassed: false,
    statement: null as string | null,
  };

  const startedAt = clock.now();
  startAttempt(state, opts.intent.text, startedAt);

  let stopReason: string | null = null;
  let incomplete = false;
  let waitedMs = 0;
  let rateLimited = 0;
  let spendUsd = 0;
  let firstModelCallAt: number | null = null;
  let passSubmitAt: number | null = null;
  let firstTool: string | null = null;
  const wholeFileReads = new Set<string>();
  let nudges = 0;

  const nowMs = () => clock.now();

  const syncInbox = () => {
    // MR4's sync: pull the pool's pending heads-ups into the inbox (the early `sync`).
    for (const hu of pool.pendingHeadsUps()) receiveHeadsUp(state, hu, nowMs());
    state.syncNeeded = false;
  };

  const runLoop = async (): Promise<void> => {
    for (let guard = 0; guard < 500; guard++) {
      if (nowMs() - startedAt > ATTEMPT_TIMEOUT_MS) {
        stopReason = "timeout";
        return;
      }
      const action = nextAction(state, {
        model: { options: opts.modelOptions, price: opts.modelPrice },
      });
      switch (action.type) {
        case "stop": {
          stopReason = action.reason;
          return;
        }
        case "idle": {
          return; // validated/waiting or landed/stopped: the run is over
        }
        case "show_heads_ups": {
          writeUserRow(state, headsUpMessage(action.heads_ups), nowMs());
          break;
        }
        case "nudge": {
          nudges++;
          writeUserRow(state, action.text, nowMs());
          break;
        }
        case "answer_rest": {
          const calls = lastAssistantCalls(state);
          const answered = answeredCalls(state);
          for (const call of calls.slice(answered)) {
            writeToolRow(state, {
              tool: call.function.name,
              call_id: null,
              model_call_id: call.id,
              args: isRecord(call.function.arguments) ? call.function.arguments : {},
              message: toolMessageFor({
                error: { code: "not_run", detail: { reason: action.reason } },
                heads_ups: unshownRun(state).show.map((hu) => toHeadsUpForModel(hu)),
              }),
              counts_step: false,
              started_at: nowMs(),
              ended_at: nowMs(),
            });
          }
          break;
        }
        case "tool": {
          const outcome = processCall(state, action.call, finishReasonOfLastAssistant(state));
          if (outcome.kind === "error") {
            // TD4: the Agent refuses the call itself; the row is no tool step (4.1).
            writeToolRow(state, {
              tool: action.call.function.name,
              call_id: null,
              model_call_id: action.call.id,
              args: isRecord(action.call.function.arguments) ? action.call.function.arguments : {},
              message: toolMessageFor({
                error: { code: outcome.code, detail: outcome.detail },
                heads_ups: unshownRun(state).show.map((hu) => toHeadsUpForModel(hu)),
              }),
              counts_step: false,
              started_at: nowMs(),
              ended_at: nowMs(),
            });
            break;
          }
          if (!toolBudgetOk(state)) {
            stopReason = "budget";
            return;
          }
          const req: ToolRequest = {
            attempt_id: opts.attemptId,
            call_id: `${opts.attemptId}:${state.rows.length + 1}`,
            ack: state.meta.shown_hn,
            tool: action.call.function.name as ToolRequest["tool"],
            args: outcome.args,
          };
          const response = pool.call(req);
          if (req.tool === "submit" && response.ok) {
            // TL10: `acked_hn` is the highest heads-up number the attempt has acknowledged.
            const acks = (req.args as Record<string, unknown>).acknowledge;
            if (Array.isArray(acks)) {
              for (const hn of acks) {
                if (typeof hn === "number" && hn > state.meta.acked_hn) state.meta.acked_hn = hn;
              }
            }
          }
          if (firstTool === null && response.ok) {
            firstTool =
              req.tool === "read" &&
              (req.args as Record<string, unknown>).path === GUIDE_PATH &&
              (req.args as Record<string, unknown>).entity === undefined
                ? "read GUIDE.md"
                : req.tool;
          }
          const { message, needsSync } = messageForResponse(state, response);
          writeToolRow(state, {
            tool: req.tool,
            call_id: req.call_id,
            model_call_id: action.call.id,
            args: outcome.args,
            message,
            trunk_error: response.error?.code ?? null,
            counts_step: true,
            started_at: nowMs(),
            ended_at: nowMs(),
          });
          state.meta.state = response.attempt.state;
          if (needsSync) state.syncNeeded = true;
          if (req.tool === "read" && response.ok && (req.args as Record<string, unknown>).entity === undefined) {
            wholeFileReads.add(String((req.args as Record<string, unknown>).path ?? ""));
          }
          if (passing(req, response)) {
            passSubmitAt = nowMs();
            if (hero && !heroState.injected) {
              // ME5, steps 1 to 4: keep `before`, land the energy change, build and send the heads-up.
              heroState.injected = true;
              heroState.before = pool.fileAt(opts.intent.writes);
              const energy = pool.fileAt(ENERGY_PATH);
              if (energy !== null) pool.landHead(ENERGY_PATH, landEnergyChange(energy));
              if (heroState.before !== null) {
                const hu = buildHeroHeadsUp({
                  attemptId: opts.attemptId,
                  creaturePath: opts.intent.writes,
                  creatureSource: heroState.before,
                  now: nowMs(),
                });
                if (hu !== null) {
                  pool.pushHeadsUp(hu);
                  receiveHeadsUp(state, hu, nowMs());
                  state.meta.state = "going_around";
                } else {
                  heroState.skipped = true; // no ENERGY_MAX line: HC3 (a) — no heads-up is sent
                }
              } else {
                heroState.skipped = true;
              }
            } else if (hero && heroState.injected && !heroState.skipped) {
              heroState.secondPassed = true;
              heroState.statement =
                typeof (outcome.args as Record<string, unknown>).statement === "string"
                  ? ((outcome.args as Record<string, unknown>).statement as string)
                  : null;
            }
          }
          break;
        }
        case "model": {
          // The per_minute meter of ME4: wait for the rate bucket; the wait counts in waited_ms.
          for (;;) {
            if (!ledger.rateLimited(opts.modelId, nowMs())) break;
            const wait = 1_000;
            waitedMs += wait;
            await clock.sleep(wait);
          }
          let reservation = ledger.reserve(opts.modelId, action.request_bytes, MODEL_MAX_TOKENS);
          if (reservation === null) {
            stopReason = "spend_cap";
            incomplete = true;
            return;
          }
          ledger.noteCall(opts.modelId, nowMs());
          if (firstModelCallAt === null) firstModelCallAt = nowMs();
          const modelCallAt = nowMs();
          if (heroState.injected && !heroState.skipped && heroState.repairStart === null) {
            heroState.repairStart = modelCallAt;
          }
          let tries = 0;
          for (;;) {
            const outcome = await opts.callModel(action.request);
            if (outcome.kind === "answer") {
              const parsed = parseModelAnswer(outcome.result, state.rows.length + 1);
              if (parsed !== null) {
                const settled = ledger.settle(
                  reservation.id,
                  parsed.usage === null
                    ? null
                    : { tokens_in: parsed.usage.prompt_tokens, tokens_out: parsed.usage.completion_tokens },
                );
                spendUsd += settled;
                state.meta.spent_usd += settled;
                writeAssistantRow(state, {
                  answer: {
                    content: parsed.content,
                    tool_calls: parsed.tool_calls,
                    finish_reason: parsed.finish_reason,
                    ...(parsed.reasoning !== undefined ? { reasoning: parsed.reasoning } : {}),
                  },
                  model: opts.modelId,
                  tokens_in: parsed.usage?.prompt_tokens ?? null,
                  tokens_out: parsed.usage?.completion_tokens ?? null,
                  started_at: modelCallAt,
                  ended_at: nowMs(),
                });
                break;
              }
              tries++;
              if (tries > MODEL_RETRIES) {
                spendUsd += ledger.settle(reservation.id, null);
                state.meta.spent_usd += reservation.bound;
                stopReason = "model_error:model_bad_output";
                return;
              }
              const wait = Math.min(MODEL_RETRY_BACKOFF_MS * 2 ** (tries - 1), WAIT_BACKOFF_MAX_MS);
              waitedMs += wait;
              await clock.sleep(wait);
              continue;
            }
            if (outcome.kind === "rate_limited") {
              rateLimited++;
              // TL12: settle without usage (SE6a), wait, then a new reservation for the same request.
              spendUsd += ledger.settle(reservation.id, null);
              state.meta.spent_usd += reservation.bound;
              const wait = Math.min(Math.max(outcome.retry_after_ms, WAIT_BACKOFF_BASE_MS), WAIT_BACKOFF_MAX_MS);
              waitedMs += wait;
              await clock.sleep(wait);
              const again = ledger.reserve(opts.modelId, action.request_bytes, MODEL_MAX_TOKENS);
              if (again === null) {
                stopReason = "spend_cap";
                incomplete = true;
                return;
              }
              reservation = again;
              continue;
            }
            if (outcome.kind === "rejected") {
              spendUsd += ledger.settle(reservation.id, null);
              state.meta.spent_usd += reservation.bound;
              stopReason = "model_error:model_rejected";
              return;
            }
            // timeout, unavailable, network: counted retries (TL12).
            tries++;
            if (tries > MODEL_RETRIES) {
              spendUsd += ledger.settle(reservation.id, null);
              state.meta.spent_usd += reservation.bound;
              stopReason = `model_error:${outcome.kind === "timeout" ? "model_timeout" : "model_unavailable"}`;
              return;
            }
            const wait = Math.min(MODEL_RETRY_BACKOFF_MS * 2 ** (tries - 1), WAIT_BACKOFF_MAX_MS);
            waitedMs += wait;
            await clock.sleep(wait);
          }
          break;
        }
      }
      if (state.syncNeeded) syncInbox();
    }
    if (stopReason === null) stopReason = "stalled";
  };

  await runLoop();

  // Scoring (6.5, ME8): the tree the run left, the writes file, the hero classes.
  const files = pool.files();
  const completion: Completion = scoreCompleted({
    files,
    seedPaths: opts.seedPaths,
    writes: opts.intent.writes,
    passedSubmit: passSubmitAt !== null,
  });
  const heroClass: HeroClass | null = hero
    ? classifyHero({
        intent: opts.intent.id as "P1a" | "P1b",
        creaturePath: opts.intent.writes,
        firstSubmitPassed: passSubmitAt !== null,
        before: heroState.before,
        finalSource: pool.fileAt(opts.intent.writes),
        secondSubmitPassed: heroState.secondPassed,
      })
    : null;

  const seconds = firstModelCallAt !== null && passSubmitAt !== null ? (passSubmitAt - firstModelCallAt) / 1000 : null;
  const repairMs =
    hero && heroState.repairStart !== null && heroState.secondPassed && passSubmitAt !== null
      ? passSubmitAt - heroState.repairStart
      : null;

  const toolRows = state.rows.filter((r) => r.role === "tool");
  const toolErrors = toolRows.filter((r) => decodeToolRow(r).message.error !== undefined).length;
  const written: Record<string, string> = {};
  const opsPaths = new Set(pool.ops().map((o) => o.path));
  for (const path of opsPaths) {
    const content = pool.fileAt(path);
    if (content !== null) written[path] = content;
  }
  for (const path of opsPaths) wholeFileReads.delete(path); // the run wrote it: not a wide read

  const record: RunRecord = {
    intent: opts.intent.id,
    run: opts.runIndex,
    outcome: completion,
    stop_reason: stopReason,
    seconds,
    waited_ms: waitedMs,
    model_calls: state.meta.model_calls,
    tool_calls: toolRows.length,
    tool_errors: toolErrors,
    nudges,
    tokens_in: state.meta.tokens_in,
    tokens_out: state.meta.tokens_out,
    cost_usd: state.meta.spent_usd,
    first_tool: firstTool,
    whole_file_reads: [...wholeFileReads].sort(),
    files: written,
    hero: hero
      ? {
          class: heroClass ?? "not_completed",
          judged_by: heroClass === "unclear" ? "person" : "rule",
          before: heroState.before,
          statement: heroState.statement,
          repair_ms: repairMs,
        }
      : null,
  };
  return { record, rows: state.rows, pool, spend_usd: spendUsd, rate_limited: rateLimited, incomplete };
}
