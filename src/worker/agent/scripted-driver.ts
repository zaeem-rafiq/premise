// src/worker/agent/scripted-driver.ts — the canned agent (SW4, SW5, SW6, SW7).
//
// A scripted agent is a small state machine that calls the same seven Trunk
// tools as a real agent, with agent_kind "synthetic" and no model
// (02-tidepool 10.1). Its script is the ordered list of tool calls of a
// canned pattern plus the pattern's truth list (TR8) and its repair rule;
// the Swarm's pattern tables produce it and the launch POST carries it to
// the Agent's open.
//
// Heads-up answers follow SW6: `info` does nothing; `confirm` acknowledges
// with the pattern's statement ("not affected" by default); `repair`
// acknowledges and, for each dropped own edit, applies that edit again on
// the current source (SW6). A repair item whose premise is on the truth
// list gets the pattern's repair rule: re-read the premises and answer with
// the pattern's statement. `no_match`, `ambiguous` or `limit_reached` ends
// the attempt with `stop` and the reason `withdrawn` (TA9a); a pattern may
// give up after a number of repairs (SW7's sweep gives up at its second).

import type { AgentStopReason } from "../../protocol/attempt.ts";
import type { Driver } from "../../protocol/ports.ts";
import type { HeadsUpForModel, ModelToolMessage, ToolName } from "../../protocol/tools.ts";

export type ScriptStep = { tool: ToolName; args: Record<string, unknown>; reapply?: boolean };

export type Script = {
  pattern: string;
  truth: string[]; // "<kind>:<key>" strings (10.3, TR8)
  steps: ScriptStep[];
  repair?: {
    reread?: boolean; // re-read each truth premise the heads-up named before answering
    statement?: string; // the repair answer's statement (SW6)
    give_up_after?: number; // withdraw after this many repairs (SW7: sweeps use 2)
  };
  confirm_statement?: string; // the confirm answer's statement; default "not affected" (SW6)
  think_ms?: number; // the wait before answering a heads-up (SW6); default 0
};

export type ScriptState = {
  queue: ScriptStep[];
  statement: string | null; // the statement to send with the next submit
  submit_args: Record<string, unknown> | null; // remembered for a re-submit after go_around/needs_confirm
  resubmit: boolean;
  repairs: number;
  reapply_pending: boolean; // the last emitted step re-applied a dropped edit
  last_step: ScriptStep | null; // re-queued on heads_up_first
  op_step: Record<string, number>; // op_seq -> script steps index, for re-apply
  path_step: Record<string, number>; // path -> script steps index, for re-apply
};

function initialState(script: Script): ScriptState {
  return {
    queue: script.steps.map((s) => ({ ...s })),
    statement: null,
    submit_args: null,
    resubmit: false,
    repairs: 0,
    reapply_pending: false,
    last_step: null,
    op_step: {},
    path_step: {},
  };
}

function scriptIndex(script: Script, step: ScriptStep): number {
  const i = script.steps.indexOf(step);
  if (i >= 0) return i;
  return script.steps.findIndex((s) => s.tool === step.tool && JSON.stringify(s.args) === JSON.stringify(step.args));
}

// A truth hit turns the pattern's repair rule into a re-read step.
function rereadStep(truthEntry: string): ScriptStep | null {
  const cut = truthEntry.indexOf(":");
  const kind = truthEntry.slice(0, cut);
  const key = truthEntry.slice(cut + 1);
  if (kind === "entity") {
    const hash = key.indexOf("#");
    if (hash < 0) return { tool: "read", args: { path: key } };
    return { tool: "read", args: { path: key.slice(0, hash), entity: key.slice(hash + 1) } };
  }
  if (kind === "file") return { tool: "read", args: { path: key } };
  if (kind === "listing") return { tool: "list", args: { path: key } };
  return null; // query premises have no single re-read
}

const WITHDRAW_CODES = new Set(["no_match", "ambiguous", "limit_reached"]); // SW6
const FINAL_SUBMIT = new Set(["validated", "submitted", "held", "accepted", "landed", "stopped"]);

export class ScriptedDriver implements Driver {
  #script: Script;
  #truth: Set<string>;

  constructor(script: Script) {
    this.#script = script;
    this.#truth = new Set(script.truth);
  }

  async next(input: {
    last: ModelToolMessage | null;
    state: unknown;
  }): Promise<
    | { kind: "tool"; tool: ToolName; args: object; state: unknown }
    | { kind: "wait"; state: unknown }
    | { kind: "stop"; reason: AgentStopReason; state: unknown }
  > {
    const script = this.#script;
    const s: ScriptState =
      input.state === null || input.state === undefined ? initialState(script) : (input.state as ScriptState);
    const last = input.last;

    // A saved last_step with no new `last` is a call the Agent journaled but
    // lost before sending (the state write landed, the journal write did
    // not): emit it again so the step is not skipped.
    if (last === null && s.last_step !== null) {
      return { kind: "tool", tool: s.last_step.tool, args: s.last_step.args, state: s };
    }

    let woke = false;
    if (last !== null) {
      for (const hu of last.heads_ups ?? []) {
        if (hu.action !== "none") woke = true;
        this.#headsUp(s, hu);
      }
      if (script.repair?.give_up_after !== undefined && s.repairs >= script.repair.give_up_after) {
        return { kind: "stop", reason: "withdrawn", state: s }; // SW7
      }

      const code = last.error?.code;
      if (code !== undefined && WITHDRAW_CODES.has(code)) {
        return { kind: "stop", reason: "withdrawn", state: s }; // SW6
      }
      if (code === "heads_up_first" && s.last_step !== null) {
        // TA3: the row carried the heads-ups; re-issue the blocked call now
        // that they are shown and the next ack covers them.
        s.queue.unshift(s.last_step);
      }

      const result = last.result as { op_seq?: number; path?: string; status?: string } | undefined;
      if (s.last_step !== null && (s.last_step.tool === "write" || s.last_step.tool === "replace") && result) {
        const i = scriptIndex(script, s.last_step);
        if (i >= 0) {
          if (typeof result.op_seq === "number") s.op_step[result.op_seq] = i;
          if (typeof result.path === "string") s.path_step[result.path] = i;
        }
      }
      if (s.last_step?.tool === "submit" && result?.status !== undefined) {
        if (result.status === "needs_confirm" || result.status === "go_around") {
          s.resubmit = true; // answer the unresolved heads-ups first, then submit again (GA2)
        } else if (FINAL_SUBMIT.has(result.status)) {
          s.resubmit = false;
        }
      }
      s.last_step = null;
      s.reapply_pending = false;
      if (woke && script.think_ms !== undefined && script.think_ms > 0) {
        await new Promise((resolve) => setTimeout(resolve, script.think_ms)); // SW6
      }
    }

    if (s.queue.length === 0) {
      if (s.resubmit && s.submit_args !== null) {
        s.resubmit = false;
        const args = { ...s.submit_args };
        if (s.statement !== null) args.statement = s.statement;
        s.last_step = { tool: "submit", args };
        return { kind: "tool", tool: "submit", args, state: s };
      }
      return { kind: "wait", state: s }; // AG3-exempt wait: landed, held or answered
    }

    const step = s.queue.shift() as ScriptStep;
    const reapply = step.reapply === true;
    const args = { ...step.args };
    delete args.reapply;
    if (step.tool === "submit") {
      s.submit_args = args;
      if (s.statement !== null && args.statement === undefined) args.statement = s.statement;
    }
    s.last_step = { tool: step.tool, args };
    s.reapply_pending = reapply;
    return { kind: "tool", tool: step.tool, args, state: s };
  }

  #headsUp(s: ScriptState, hu: HeadsUpForModel): void {
    const script = this.#script;
    if (hu.action === "confirm") {
      s.statement ??= script.confirm_statement ?? "not affected"; // SW6
      return;
    }
    if (hu.action !== "repair") return; // info: nothing (SW6)

    s.repairs += 1;
    // A dropped own edit is applied again on the current source (SW6).
    for (const dropped of hu.dropped_edits) {
      const i = s.path_step[dropped.path];
      const step = i === undefined ? undefined : script.steps[i];
      if (step !== undefined) s.queue.unshift({ ...step, reapply: true });
    }
    // A repair item whose premise is on the truth list: re-read it and
    // answer with the pattern's repair statement.
    const hit = hu.items.find((it) => this.#truth.has(it.what));
    if (hit !== undefined) {
      s.statement = script.repair?.statement ?? s.statement ?? "repaired";
      if (script.repair?.reread === true) {
        for (const it of hu.items.filter((i) => this.#truth.has(i.what))) {
          const step = rereadStep(it.what);
          if (step !== null) s.queue.unshift(step);
        }
      }
    } else {
      s.statement ??= script.repair?.statement ?? "repaired";
    }
  }
}

// ---- What a scripted agent is shown ---------------------------------------------------------

// The Driver port feeds the model's view of a heads-up (HeadsUpForModel,
// 8.2). A scripted agent has no model, so the Agent builds the view itself:
// `what` carries the premise's "<kind>:<key>" — the truth-list format (10.3)
// the driver matches against — and dropped edits carry the path the driver
// needs to find its own step again. Real agents get this rendering from the
// model-side loop instead.
export function scriptedHeadsUpForModel(hu: {
  hn: number;
  result: "info" | "confirm" | "repair";
  cause: { changes: Array<{ intent_text: string | null }> };
  items: Array<{
    premise: { kind: string; key: string };
    reason: string;
    result: "holds" | "pending" | "confirm" | "repair";
    diff?: unknown;
    uses?: Array<{ path: string; entity: string; line: number; text: string }>;
  }>;
  dropped_ops: Array<{ op_seq: number; path: string; rule: string }>;
}): HeadsUpForModel {
  const action = hu.result === "info" ? "none" : hu.result;
  return {
    hn: hu.hn,
    action,
    because: hu.items.map((it) => it.reason).join(" "),
    changed_by: hu.cause.changes[0]?.intent_text ?? null,
    items: hu.items.map((it) => {
      const item: HeadsUpForModel["items"][number] = {
        what: `${it.premise.kind}:${it.premise.key}`,
        before: null,
        after: null,
        your_lines: (it.uses ?? []).map((u) => `${u.path}:${u.line}`),
      };
      const diff = it.diff as { kind?: string; before?: string | null; after?: string | null } | undefined;
      if (diff?.kind === "entity") {
        item.before = diff.before ?? null;
        item.after = diff.after ?? null;
      }
      if (it.result === "pending") item.checking = true;
      return item;
    }),
    dropped_edits: hu.dropped_ops.map((d) => ({ path: d.path, why: d.rule })),
  };
}
