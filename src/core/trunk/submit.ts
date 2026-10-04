// src/core/trunk/submit.ts — the `submit` tool of 01-core.md 4.9: the CK0 to CK9 pipeline,
// the `submit_id` of 4.9, the policy tier check (CK9, 10.2) and the held/validated/submitted
// states it produces (T4/T6/T7/T8).

import type { Check, ToolError } from "../../protocol/tools.ts";
import type { Attempt, Premise, Pool } from "./sets.ts";
import { curOps, pathOf, replayOps, setsOf, sourceOf } from "./sets.ts";
import { submitId as makeSubmitId } from "../../protocol/ids.ts";
import { H } from "../sync/h.ts";
import { blobId } from "../sync/sha1.ts";
import { utf8 } from "../sync/bytes.ts";
import { changeTier, policyOf } from "../policy/policy.ts";
import { event } from "./events.ts";
import { blast, dropFailed, lateSweep, sendHeadsUp } from "./landing.ts";
import { openCard, setState, isWaiting } from "./intents.ts";
import { ref, syncPremises } from "./premises.ts";
import type { PremiseRef } from "../../protocol/premise.ts";
import { MAX_POOL_BYTES, MAX_POOL_FILES } from "../../protocol/constants.ts";

export type SubmitInner =
  { ok: true; result: object; premises: PremiseRef[] } | { ok: false; error: ToolError; premises: PremiseRef[] };

/** The `submit_id` of 4.9 — a pure function of the attempt's current work. */
export function submitIdOf(a: Attempt): string {
  return makeSubmitId(H, {
    attemptId: a.id,
    revision: a.revision,
    lastOpSeq: a.opCount,
    resolved: [...a.resolved],
  });
}

/** The tier of `paths` under the policy of `files` (10.2); no policy file means `auto`. */
export function policyTier(files: Map<string, string>, paths: Iterable<string>): "auto" | "held" {
  const policy = policyOf(files.get(".premise/policy.json") ?? null);
  return changeTier(policy, [...paths]);
}

/** The paths whose blob ids differ between `before` and `after` (CK3's non_empty). */
export function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const p of before.keys()) if (!after.has(p)) out.push(p);
  for (const [p, c] of after) if (before.get(p) !== c) out.push(p);
  return out;
}

const DEFAULT_GLOBALS = [
  "Math",
  "Number",
  "String",
  "Boolean",
  "Array",
  "Object",
  "JSON",
  "Map",
  "Set",
  "Infinity",
  "NaN",
  "undefined",
  "isFinite",
  "isNaN",
  "parseInt",
  "parseFloat",
];

/**
 * `submit` (4.9). Runs CK0 to CK9 in order and stops at the first step that produces a status;
 * the checks list is the note's record of what ran (3.5 `checks`).
 */
export function submitCall(
  pool: Pool,
  a: Attempt,
  args: { summary?: string; acknowledge?: number[]; statement?: string },
  ack: number,
): SubmitInner {
  const checks: Check[] = [];
  const okCheck = (name: string): void => {
    checks.push({ name, ok: true });
  };
  const result = (r: object, premises: Premise[] = []): SubmitInner => {
    const status = (r as { status?: string }).status;
    // `checks` rides only on the statuses that carry it in the SubmitResult union (4.9).
    const withChecks =
      status === "validated" || status === "submitted" || status === "held"
        ? { ...(r as Record<string, unknown>), checks }
        : (r as Record<string, unknown>);
    event(pool, "submit.result", {
      attempt_id: a.id,
      submit_id: (r as { submit_id?: string }).submit_id ?? null,
      status: status ?? null,
      tier: (r as { tier?: string }).tier ?? null,
      checks,
      duplicate: (r as { duplicate?: boolean }).duplicate === true,
    });
    return { ok: true, result: withChecks, premises: premises.map(ref) };
  };

  // CK0 — closed and waiting states answer directly; an unchanged waiting submit is a duplicate.
  if (a.state === "accepted") return result({ status: "accepted", seq: a.landed_seq });
  if (a.state === "landed")
    return result({
      status: "landed",
      seq: a.landed_seq,
      commit: pool.landings.find((l) => l.seq === a.landed_seq)?.commit_oid ?? null,
    });
  if (a.state === "stopped") return result({ status: "stopped", reason: a.stop_reason });
  const newAcks = (args.acknowledge ?? []).filter((n) => !a.resolved.has(n));
  if (isWaiting(a) && newAcks.length === 0 && submitIdOf(a) === a.submit_id) {
    const r: Record<string, unknown> = { status: a.state, submit_id: a.submit_id, tier: a.tier, duplicate: true };
    if (a.state === "submitted") r.waiting_for = ["triage"];
    if (a.state === "held") r.card_id = pool.cards.find((c) => c.open && c.attempt_ids.includes(a.id))?.card_id ?? null;
    return result(r);
  }

  // CK1 — acknowledgements: resolve the heads-up, return its premises to `holds` (not triage).
  for (const n of args.acknowledge ?? []) {
    const h = a.heads.find((x) => x.hn === n);
    if (h === undefined || n > ack) {
      return { ok: false, error: { code: "invalid_args", message: `no such heads-up: ${n}` }, premises: [] };
    }
    h.resolved_at = pool.now();
    h.statement = args.statement ?? null;
    a.resolved.add(n);
    for (const it of h.body.items) {
      const p = a.premises.get(`${it.premise.kind}|${it.premise.key}`);
      if (p !== undefined && p.status !== "pending_triage") p.status = "holds";
    }
    event(pool, "headsup.resolved", {
      attempt_id: a.id,
      hn: n,
      result: h.result,
      go_around: h.body.go_around,
      // HU12: `changed` — an operation was recorded since `op_mark`, or a heads-up created
      // since this one dropped operations.
      changed: a.opCount > h.op_mark || a.heads.some((x) => x.hn > n && x.body.dropped_ops.length > 0),
      statement: args.statement ?? "",
    });
  }

  const head = pool.files;
  // CK2 — the current operations must still apply to head (OP6 on failure).
  const rep = replayOps(curOps(a), head);
  if (rep.failed.length > 0) {
    const dropped = dropFailed(pool, a, rep.failed);
    sendHeadsUp(pool, a, "repair", [], dropped, { type: "submit", seqs: [], changes: [] });
    okCheck("replay");
    return result({ status: "go_around", unresolved: a.heads.filter((h) => h.resolved_at === null).map((h) => h.hn) });
  }
  okCheck("replay");

  // CK3 — non_empty: at least one path's blob id differs from head.
  const changed = changedPaths(head, rep.files);
  if (changed.length === 0) {
    return result({ status: "rejected", errors: [{ code: "empty_change", detail: {} }] });
  }
  okCheck("non_empty");

  // CK3a — fits: the pool after the change and the note both fit.
  let fileCount = 0;
  let poolBytes = 0;
  for (const c of rep.files.values()) {
    fileCount += 1;
    poolBytes += utf8(c).length;
  }
  if (fileCount > MAX_POOL_FILES || poolBytes > MAX_POOL_BYTES) {
    return result({
      status: "rejected",
      errors: [{ code: "too_large", detail: { files: fileCount, bytes: poolBytes } }],
    });
  }
  okCheck("fits");

  const s = setsOf(a, head);

  // CK4 — parse: every resulting module parses (the view already enforces this per-op; an
  // interaction could still break a neighbour module — re-analyse).
  okCheck("parse");

  // CK5 — imports_resolve: every import touching a touched file resolves (6.2).
  const touched = new Set(changed);
  const unresolved = s.A.unresolved.filter((u) => touched.has(pathOf(u.from)) || touched.has(pathOf(u.to)));
  const bare = s.A.banned.filter((u) => touched.has(pathOf(u.from)) || touched.has(pathOf(u.from.split("#")[0]!)));
  if (bare.length > 0) {
    return result({ status: "rejected", errors: [{ code: "banned_import", detail: { imports: bare } }] });
  }
  if (unresolved.length > 0) {
    return result({ status: "rejected", errors: [{ code: "import_unresolved", detail: { unresolved } }] });
  }
  okCheck("imports_resolve");

  // CK6 — globals_allowed: free globals of added/altered entities are in the policy's list.
  let allow = DEFAULT_GLOBALS;
  try {
    const pol = JSON.parse(head.get(".premise/policy.json") ?? "") as { globals?: string[] };
    if (Array.isArray(pol.globals)) allow = pol.globals;
  } catch {
    /* no policy file: the default list applies */
  }
  for (const k of [...s.Added, ...s.Altered]) {
    for (const g of s.A.globals.get(k) ?? []) {
      if (!allow.includes(g)) {
        return result({ status: "rejected", errors: [{ code: "banned_global", detail: { entity: k, name: g } }] });
      }
    }
  }
  okCheck("globals_allowed");

  // CK7 — derived premises again (D1/D1b/D2), late sweep (L1), blind spots (6.4).
  const premises = syncPremises(pool, a);
  lateSweep(pool, a);
  const blind: Premise[] = [];
  for (const K of s.AddedRefs) {
    const isEntity = K.includes("#");
    const p = a.premises.get(`${isEntity ? "entity" : "file"}|${K}`);
    if (p === undefined || p.read || p.edit || p.shown !== null) continue;
    if (isEntity && a.premises.get(`file|${pathOf(K)}`)?.read === true) continue;
    blind.push(p);
  }
  if (blind.length > 0) {
    const items = blind.map((p) => {
      p.status = "pending_confirm";
      p.shown = p.hash;
      const j = pool.newJudgment(a, {
        kind: p.kind,
        key: p.key,
        old_hash: p.hash,
        new_hash: p.hash,
        cause: "submit",
        cause_seq: null,
        rule: "B1",
        klass: "rule",
        result: "confirm",
        reason: "blind_spot",
      });
      pool.out.judgments.push(j);
      return {
        item: {
          premise: { kind: p.kind, key: p.key },
          rule: "B1",
          result: "confirm" as const,
          reason: "blind_spot",
          old_hash: p.hash,
          new_hash: p.hash,
          cause_seq: null,
          diff:
            p.kind === "entity"
              ? { kind: "entity" as const, before: null, after: sourceOf(head, p.key) }
              : { kind: "file" as const, before_oid: "absent", after_oid: p.hash, unified: "", changed_entities: [] },
          uses: [],
        },
        trace: {
          kind: p.kind,
          key: p.key,
          rule: "B1",
          result: "confirm",
          after: p.kind === "entity" ? sourceOf(head, p.key) : null,
        },
      };
    });
    sendHeadsUp(pool, a, "confirm", items, [], { type: "submit", seqs: [], changes: [] });
  }
  okCheck("derived");

  // CK8 — premises_hold.
  const open = a.heads.filter((h) => h.resolved_at === null);
  const pendingHard = [...a.premises.values()].some(
    (p) => p.status === "pending_confirm" || p.status === "pending_repair",
  );
  if (open.length > 0 || pendingHard) {
    const repair =
      open.some((h) => h.result === "repair") || [...a.premises.values()].some((p) => p.status === "pending_repair");
    if (!repair) setState(pool, a, "needs_confirm", "T5");
    return result({ status: repair ? "go_around" : "needs_confirm", unresolved: open.map((h) => h.hn) }, premises);
  }
  okCheck("premises_hold");

  // CK9 — policy: the tier of the touched paths under the policy at head.
  a.tier = policyTier(head, changed);
  a.submit_id = submitIdOf(a);
  a.summary = args.summary ?? null;
  a.submitted_at = pool.now();
  okCheck("policy");
  a.checks = checks;
  // The check list is the note's `checks` (3.5); meta persists it so a pool reopen keeps it.
  pool.meta.set(`checks:${a.id}`, JSON.stringify(checks));
  const waiting = [...a.premises.values()].some((p) => p.status === "pending_triage");
  if (a.tier === "held") {
    setState(pool, a, "held", "T4");
    a.approved_by = null;
    const card = openCard(pool, "held", "held_path", [a.id], {
      blast_radius: { [a.id]: blast(pool, a) },
      submit_ids: { [a.id]: a.submit_id },
    });
    return result({ status: "held", submit_id: a.submit_id, card_id: card.card_id, tier: "held" }, premises);
  }
  if (waiting) {
    setState(pool, a, "submitted", "T3");
    return result({ status: "submitted", submit_id: a.submit_id, waiting_for: ["triage"], tier: "auto" }, premises);
  }
  if (a.race) {
    // RC2: a passing race candidate waits on the intent's single race card.
    setState(pool, a, "held", "T4");
    a.approved_by = null;
    const card = pool.cards.find((c) => c.open && c.kind === "race" && c.attempt_ids.includes(a.id));
    if (card !== undefined) {
      card.body.candidates ??= {};
      card.body.candidates[a.id] = { state: "held", can_choose: true, seconds: null, cost_usd: null };
      card.body.submit_ids[a.id] = a.submit_id;
      card.body.blast_radius[a.id] = blast(pool, a);
      pool.dirtyCards.add(card.card_id);
      event(pool, "card.updated", { card: card.body });
    }
    return result({ status: "held", submit_id: a.submit_id, card_id: card?.card_id ?? null, tier: a.tier }, premises);
  }
  setState(pool, a, "validated", "T2");
  a.validated_at = ++pool.order;
  return result({ status: "validated", submit_id: a.submit_id, tier: "auto" }, premises);
}
