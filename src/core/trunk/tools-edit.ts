// src/core/trunk/tools-edit.ts — the edit tools of 01-core.md 4.7/4.8 (`write`, `replace`) and
// the `submit` tool's dispatch, with the envelope rules of 4.1/4.2: TA2 (idempotent call ids),
// TA3 (heads-up first), TA4 (closed states), T22 (an op after a passing submit), and the count
// and size limits.

import type { Operation } from "../../protocol/operations.ts";
import type { ToolError, ToolRequest, ToolResponse } from "../../protocol/tools.ts";
import type { Attempt, Op, Pool } from "./sets.ts";
import { curOps, entityAt, entityKeysOf, isModule, occurrences, replayOps, setsOf, targetsOf } from "./sets.ts";
import { blobId } from "../sync/sha1.ts";
import { utf8 } from "../sync/bytes.ts";
import { parseModule } from "../entities/entities.ts";
import { event } from "./events.ts";
import { markDelivered, setState } from "./intents.ts";
import { pin, ref, reliedOnBy } from "./premises.ts";
import { afterOp } from "./landing.ts";
import { toolList, toolOutline, toolRead, toolSearch, type ToolOut } from "./tools-read.ts";
import { submitCall } from "./submit.ts";
import {
  MAX_CHANGE_BYTES,
  MAX_FILE_BYTES,
  MAX_HEADS_UPS_PER_RESPONSE,
  MAX_OPS,
  MAX_PATHS,
  MAX_PREMISES,
  MAX_STATEMENT_CHARS,
  RESPONSE_HEADS_UP_MAX_BYTES,
} from "../../protocol/constants.ts";

const PATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

type InnerOut = ToolOut;

const e = (code: ToolError["code"], message: string, detail?: object): InnerOut => ({
  ok: false,
  error: detail === undefined ? { code, message } : { code, message, detail },
  premises: [],
});

function validPath(path: string): boolean {
  return PATH_RE.test(path) && !path.includes("..") && !path.endsWith("/");
}

/** The heads-up carry of a response (TA8): the lowest hns above `ack`, bounded. */
export function headsUpsFor(
  a: Attempt,
  ack: number,
): { heads_ups: ToolResponse["heads_ups"]; heads_ups_more: boolean } {
  const pending = a.heads.filter((h) => h.hn > ack).map((h) => h.body);
  const out: ToolResponse["heads_ups"] = [];
  let bytes = 0;
  for (const h of pending) {
    if (out.length >= MAX_HEADS_UPS_PER_RESPONSE) break;
    const size = JSON.stringify(h).length;
    if (bytes + size > RESPONSE_HEADS_UP_MAX_BYTES) break;
    out.push(h);
    bytes += size;
  }
  return { heads_ups: out, heads_ups_more: pending.length > out.length };
}

/**
 * Serve one tool call (4.1): TA2 replay on `call_id`, HU8 delivery by `ack`, the gates of TA3/TA4
 * and the pool state, then the tool itself. The whole call runs inside the caller's transaction.
 */
export function tool(pool: Pool, req: ToolRequest): ToolResponse {
  const got = pool.attempts.get(req.attempt_id);
  if (got === undefined) {
    return {
      call_id: req.call_id,
      ok: false,
      error: { code: "attempt_unknown", message: `unknown attempt: ${req.attempt_id}` },
      head_seq: pool.headSeq(),
      premises: [],
      heads_ups: [],
      heads_ups_more: false,
      attempt: { state: "stopped", go_arounds: 0, pull_backs: 0 },
    };
  }
  const a = got;
  const make = (
    body: Omit<ToolResponse, "call_id" | "head_seq" | "heads_ups" | "heads_ups_more" | "attempt">,
  ): ToolResponse => {
    const carry = headsUpsFor(a, req.ack);
    return {
      call_id: req.call_id,
      head_seq: pool.headSeq(),
      ...body,
      heads_ups: carry.heads_ups,
      heads_ups_more: carry.heads_ups_more,
      attempt: { state: a.state, go_arounds: a.go_arounds, pull_backs: a.pull_backs },
    };
  };
  // TA2: the stored response of the most recent call_id, with heads_ups recomputed.
  if (a.last_call_id !== null && req.call_id === a.last_call_id && a.last_response !== null) {
    const carry = headsUpsFor(a, req.ack);
    markDelivered(pool, a, req.ack);
    return {
      ...a.last_response,
      heads_ups: carry.heads_ups,
      heads_ups_more: carry.heads_ups_more,
    } as ToolResponse;
  }
  markDelivered(pool, a, req.ack);
  const step = pool.stepOf(a);
  event(pool, "attempt.step", {
    attempt_id: a.id,
    step,
    tool: req.tool,
    target: toolTarget(req),
    ok: true,
    error: null,
    ms: 0,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
  });
  const inner = toolInner(pool, a, req);
  // EM2/TA7: every premise the response lists is recorded — a new pin, a re-pin, a flag set.
  for (const p of inner.premises) {
    event(pool, "premise.recorded", { attempt_id: a.id, premise: p, tool: req.tool });
  }
  const resp = make(inner);
  // TA2: store the response without its heads-up carry.
  const { heads_ups: _h, heads_ups_more: _m, ...storable } = resp;
  a.last_call_id = req.call_id;
  a.last_response = storable;
  pool.dirtyAttempts.add(a.id);
  return resp;
}

function toolTarget(req: ToolRequest): string | null {
  const args = req.args as Record<string, unknown>;
  return typeof args.path === "string" ? args.path : null;
}

function toolInner(pool: Pool, a: Attempt, req: ToolRequest): InnerOut {
  const toolName = req.tool;
  const args = req.args as Record<string, unknown>;
  const isWriteTool = toolName === "write" || toolName === "replace" || toolName === "submit";
  // TA3: any heads-up above the ack blocks write/replace/submit.
  if (isWriteTool && a.heads.some((h) => h.hn > req.ack))
    return e("heads_up_first", "acknowledge the pending heads-ups first");
  const poolState = pool.meta.get("pool_state") ?? "ready";
  if (isWriteTool && toolName !== "submit" && poolState !== "ready") return e("pool_not_ready", `pool is ${poolState}`);
  if (toolName === "submit" && poolState !== "ready" && !["accepted", "landed", "stopped"].includes(a.state)) {
    return e("pool_not_ready", `pool is ${poolState}`);
  }
  if (["accepted", "landed", "stopped"].includes(a.state) && toolName !== "submit")
    return e("attempt_closed", `attempt is ${a.state}`);
  if (a.state === "opened") setState(pool, a, "working", "T1");

  if (toolName === "outline") {
    if (typeof args.path !== "string" || !validPath(args.path)) return e("invalid_path", "bad path");
    return toolOutline(pool, a, { path: args.path });
  }
  if (toolName === "read") {
    if (typeof args.path !== "string" || !validPath(args.path)) return e("invalid_path", "bad path");
    if (args.entity !== undefined && typeof args.entity !== "string") return e("invalid_args", "bad entity");
    return toolRead(pool, a, { path: args.path, entity: args.entity as string | undefined });
  }
  if (toolName === "list") {
    const path = args.path;
    if (typeof path !== "string" || (path !== "/" && (!path.endsWith("/") || !validPath(path.slice(0, -1))))) {
      return e("invalid_path", "a directory key ends in /");
    }
    return toolList(pool, a, { path });
  }
  if (toolName === "search") {
    if (typeof args.query !== "string") return e("invalid_args", "query required");
    const scope = typeof args.path === "string" ? args.path : undefined;
    if (scope !== undefined && scope !== "/" && !scope.endsWith("/") && !validPath(scope))
      return e("invalid_path", "bad scope");
    if (scope !== undefined && scope.endsWith("/") && scope !== "/" && !validPath(scope.slice(0, -1)))
      return e("invalid_path", "bad scope");
    return toolSearch(pool, a, { query: args.query, path: scope });
  }
  if (toolName === "write") return toolWrite(pool, a, args);
  if (toolName === "replace") return toolReplace(pool, a, args);
  return submitCall(pool, a, args as { summary?: string; acknowledge?: number[]; statement?: string }, req.ack);
}

/** The limits of 4.2 that a new operation can exceed. */
function opLimits(pool: Pool, a: Attempt, path: string, op: Operation): InnerOut | null {
  if (a.opCount + 1 > MAX_OPS) return e("limit_reached", `at most ${MAX_OPS} operations per attempt`);
  const paths = new Set(curOps(a).map((o) => o.path));
  paths.add(path);
  if (paths.size > MAX_PATHS) return e("limit_reached", `at most ${MAX_PATHS} paths per attempt`);
  const ops: Operation[] = [...curOps(a), op];
  const bytes = ops.reduce((n, o) => {
    if (o.op === "write") return n + (o.content === null ? 0 : utf8(o.content).length);
    return n + utf8(o.old).length + utf8(o.new).length;
  }, 0);
  if (bytes > MAX_CHANGE_BYTES) return e("too_large", `change exceeds ${MAX_CHANGE_BYTES} bytes`);
  if (a.premises.size + 8 > MAX_PREMISES) return e("limit_reached", `at most ${MAX_PREMISES} premises per attempt`);
  return null;
}

/** 4.7 `write`: create or replace a whole file, or delete it. */
export function toolWrite(pool: Pool, a: Attempt, args: Record<string, unknown>): InnerOut {
  const path = args.path;
  if (typeof path !== "string" || !validPath(path)) return e("invalid_path", "bad path");
  const head = pool.files;
  const v = replayOps(curOps(a), head).files;
  const deleting = args.delete === true;
  const content = deleting ? null : args.content;
  if (!deleting && typeof content !== "string") return e("invalid_args", "content required");
  // W1: the bytes at head now must have been shown by a whole-file read.
  if (head.has(path)) {
    const fp = a.premises.get(`file|${path}`);
    const shownOk = fp !== undefined && fp.read && fp.shown === blobId(utf8(head.get(path)!));
    if (!shownOk) return e("read_first", `read ${path} at head first`);
  }
  if (content !== null && isModule(path)) {
    try {
      parseModule(content as string);
    } catch (err) {
      const se = err as { message?: string; loc?: { line: number; column: number } };
      return e("parse_error", se.message ?? "parse error", { line: se.loc?.line, column: se.loc?.column });
    }
  }
  if (content !== null && utf8(content as string).length > MAX_FILE_BYTES)
    return e("too_large", `file exceeds ${MAX_FILE_BYTES} bytes`);
  if ((content === null && !v.has(path)) || v.get(path) === content) return e("no_change", "no change");
  const op: Operation = {
    op_seq: a.opCount + 1,
    op: "write",
    path,
    content: content as string | null,
    base_oid: head.has(path) ? blobId(utf8(head.get(path)!)) : "absent",
  };
  const limited = opLimits(pool, a, path, op);
  if (limited !== null) return limited;
  a.opCount += 1;
  a.ops.push({ ...(op as Extract<Operation, { op: "write" }>), dropped: false });
  pool.dirtyAttempts.add(a.id);
  const premises = afterOp(pool, a, op, v);
  const s = setsOf(a, head);
  const hk = entityKeysOf(head, path) ?? [];
  const result = {
    path,
    op_seq: op.op_seq,
    created: !head.has(path),
    bytes: content === null ? 0 : utf8(content as string).length,
    added: s.Added.filter((k) => k.startsWith(`${path}#`)),
    altered: s.Altered.filter((k) => k.startsWith(`${path}#`) && entityAt(s.view, k) !== null),
    removed: hk.filter((k) => entityAt(s.view, k) === null),
    relied_on_by: reliedOnBy(pool, a, s.Altered),
  };
  return { ok: true, result, premises: premises.map(ref) };
}

/** 4.8 `replace`: the unique occurrence of `old` in the attempt view. */
export function toolReplace(pool: Pool, a: Attempt, args: Record<string, unknown>): InnerOut {
  const path = args.path;
  if (typeof path !== "string" || !validPath(path)) return e("invalid_path", "bad path");
  const head = pool.files;
  const v = replayOps(curOps(a), head).files;
  const content = v.get(path);
  if (content === undefined) return e("not_found", `no such path: ${path}`);
  if (typeof args.old !== "string" || typeof args.new !== "string" || args.old.length === 0 || args.old === args.new) {
    return e("no_change", "old must be non-empty and differ from new");
  }
  const occ = occurrences(content, args.old);
  if (occ.length === 0) return e("no_match", "old does not occur");
  if (occ.length > 1) {
    const lines = occ.map((o) => content.slice(0, o).split("\n").length);
    return e("ambiguous", "old occurs more than once", { count: occ.length, lines });
  }
  const at = occ[0]!;
  const next = content.slice(0, at) + args.new + content.slice(at + args.old.length);
  if (isModule(path)) {
    try {
      parseModule(next);
    } catch (err) {
      const se = err as { message?: string; loc?: { line: number; column: number } };
      return e("parse_error", se.message ?? "parse error", { line: se.loc?.line, column: se.loc?.column });
    }
  }
  const targets = targetsOf(v, path, at, at + args.old.length);
  const op: Operation = { op_seq: a.opCount + 1, op: "replace", path, old: args.old, new: args.new, targets };
  const limited = opLimits(pool, a, path, op);
  if (limited !== null) return limited;
  a.opCount += 1;
  a.ops.push({ ...(op as Extract<Operation, { op: "replace" }>), dropped: false });
  pool.dirtyAttempts.add(a.id);
  const premises = afterOp(pool, a, op, v);
  const s = setsOf(a, head);
  const hk = entityKeysOf(head, path) ?? [];
  const result = {
    path,
    op_seq: op.op_seq,
    targets,
    altered: s.Altered.filter((k) => k.startsWith(`${path}#`) && entityAt(s.view, k) !== null),
    added: s.Added.filter((k) => k.startsWith(`${path}#`)),
    removed: hk.filter((k) => entityAt(s.view, k) === null),
    relied_on_by: reliedOnBy(pool, a, s.Altered),
  };
  return { ok: true, result, premises: premises.map(ref) };
}
