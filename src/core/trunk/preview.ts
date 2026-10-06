// src/core/trunk/preview.ts — the preview commits of 01-core PV1-PV3 and PV1a (04-build-plan
// 2.12). Head plus the submitted operations, frozen at card open, becomes one parentless
// commit in `<pool>-plain` under
// `refs/previews/<submit_id>` — `PREVIEW_REF_PREFIX` holds the prefix so PV1a's fallback
// (`refs/heads/previews/`) is one constant away. The build happens off the landing path: the
// `preview` timer's entry builds the bytes and parks the spec in `meta.preview_pending`, the
// worker pushes them, and `preview_done` writes the card's `preview.after` — or `preview.error`
// (FR32, PV3 — the card stays usable either way). Everything here is synchronous and
// transaction-bound (SY2, AL4): no remote read, no clock but the pool's own.

import { PREVIEW_REF_PREFIX, PUSH_BACKOFF_BASE_MS, PUSH_BACKOFF_MAX_MS } from "../../protocol/constants.ts";
import type { Card, FrameAddress } from "../../protocol/cards.ts";
import { makeCommit } from "../git/objects.ts";
import { makeTreeFromFiles } from "../git/tree-files.ts";
import { buildPack } from "../git/pack.ts";
import { event, metaWrite } from "./events.ts";
import { metaSet } from "./schema.ts";
import { curOps, replayOps, type Op, type CardRec, type FileMap, type Pool } from "./sets.ts";
import { buildsPlain } from "./plain.ts";

import type { PreviewBuild, PreviewDoneInput, PreviewPush, PreviewResult } from "../../protocol/internal.ts";

const PENDING_KEY = "preview_pending";

/** One queued or in-flight preview push (LP6's rule: durable, so a restart retries the same
 * bytes — `at` freezes the commit's timestamp so a rebuild reproduces the same id). */
type PreviewPendingEntry = {
  card_id: string;
  attempt_id: string;
  at: number;
  head_seq: number;
  ops: Op[];
  commit?: string;
  /** Consecutive failed pushes — the re-arm backoff reads it (9.6's schedule). */
  tries: number;
};

type PendingMap = { v: 1; epoch: number; submits: Record<string, PreviewPendingEntry> };

function pendingOf(pool: Pool): PendingMap {
  const epoch = Number(pool.meta.get("epoch") ?? "1");
  const raw = pool.meta.get(PENDING_KEY);
  if (raw === undefined || raw === "") return { v: 1, epoch, submits: {} };
  try {
    const p = JSON.parse(raw) as PendingMap;
    return p.v === 1 && p.epoch === epoch && p.submits !== null && typeof p.submits === "object"
      ? p
      : { v: 1, epoch, submits: {} };
  } catch {
    return { v: 1, epoch, submits: {} };
  }
}

export function clearPreviews(pool: Pool): void {
  pool.meta.delete(PENDING_KEY);
  metaSet(pool.sql, PENDING_KEY, null);
}

/** Arm the `preview` timer at once (AL1 picks it up after the commit). */
function armPreviews(pool: Pool): void {
  pool.sql.exec("INSERT OR REPLACE INTO timers (kind, key, due_at) VALUES ('preview', '', ?)", pool.now());
}

/**
 * Queue a preview build for each current submit of a card's attempts (PV1). Called when a held or
 * race card opens, and when a race candidate's submit joins its open card. A card with no
 * `preview` field (a choice card, or the minimal form of HD1) queues nothing.
 */
export function enqueuePreviews(pool: Pool, card: CardRec, headSeq = pool.headSeq()): void {
  if (card.body.preview === null) return;
  const pending = pendingOf(pool);
  let queued = false;
  for (const id of card.attempt_ids) {
    const a = pool.attempts.get(id);
    const sid = a?.submit_id;
    if (a === undefined || typeof sid !== "string") continue;
    if (card.body.preview.after[id] !== undefined) continue;
    if (pending.submits[sid] !== undefined) continue;
    pending.submits[sid] = {
      card_id: card.card_id,
      attempt_id: id,
      at: Math.floor(pool.now() / 1000),
      head_seq: headSeq,
      ops: JSON.parse(JSON.stringify(curOps(a))) as Op[],
      tries: 0,
    };
    queued = true;
  }
  if (!queued) return;
  metaWrite(pool, PENDING_KEY, JSON.stringify(pending));
  armPreviews(pool);
}

/**
 * `preview` (PV1): every pending submit's parentless preview commit — the frozen head
 * plus the frozen submitted operations — with the pack the runner pushes. A pending row whose
 * card closed or whose submit was superseded is `dropped`; a row that cannot become a commit
 * lands in `errors` (PV3).
 */
export function previewBuild(pool: Pool): PreviewBuild {
  if (pool.meta.get("pool_state") === "rebuilding") return { state: "idle" };
  const pending = pendingOf(pool);
  const sids = Object.keys(pending.submits);
  if (sids.length === 0) return { state: "idle" };
  const previews: PreviewPush[] = [];
  const errors: PreviewResult[] = [];
  const dropped: string[] = [];
  const heads = new Map<number, FileMap>();
  for (const sid of sids) {
    const e = pending.submits[sid]!;
    const card = pool.cards.find((c) => c.card_id === e.card_id);
    const a = pool.attempts.get(e.attempt_id);
    // The card went away (landed, declined, stale-closed) or the submit was superseded — a ref
    // already pushed stays (PV3), and nothing more is owed for this row.
    if (card === undefined || !card.open || a === undefined || a.submit_id !== sid) {
      dropped.push(sid);
      continue;
    }
    // Idempotent re-run: `preview_done` already applied this submit (a lost answer's replay).
    if (card.body.preview !== null && card.body.preview.after[e.attempt_id] !== undefined) {
      dropped.push(sid);
      continue;
    }
    try {
      let head = heads.get(e.head_seq);
      if (head === undefined) {
        head = pool.fileMapAt(e.head_seq);
        heads.set(e.head_seq, head);
      }
      const replayed = replayOps(e.ops, head, {}, pool.languages);
      if (replayed.failed.length > 0) throw new Error("preview operations no longer apply");
      const files = Object.fromEntries(replayed.files);
      const { root, objects } = makeTreeFromFiles(files);
      const ident = { name: "Premise Trunk", email: "trunk@premise.invalid", timestamp: e.at };
      const commit = makeCommit({
        tree: root.oid,
        parents: [],
        author: ident,
        committer: ident,
        message: `Premise preview ${sid}`,
      });
      e.commit = commit.oid;
      previews.push({
        submit_id: sid,
        ref: `${PREVIEW_REF_PREFIX}${sid}`,
        commit: commit.oid,
        tree: root.oid,
        pack: buildPack([commit, ...objects]),
      });
    } catch {
      errors.push({ submit_id: sid, error: "preview_build_failed" });
    }
  }
  metaWrite(pool, PENDING_KEY, JSON.stringify(pending));
  return { state: "build", epoch: pending.epoch, previews, errors, dropped };
}

/**
 * `preview_done` (PV1/PV3): apply the runner's answers — a pushed commit joins its card's
 * `preview.after`, a terminal error sets `preview.error`, `dropped` rows are forgotten, and a
 * `retried` row counts a failed push and re-arms the timer on the push backoff (9.6). The apply
 * is idempotent: a `commit` result for a row already gone changes nothing.
 */
export function previewDone(pool: Pool, input: PreviewDoneInput): Record<string, unknown> {
  const pending = pendingOf(pool);
  if (input.epoch !== undefined && input.epoch !== pending.epoch) return { ok: false, error: { code: "stale" } };
  const submits = { ...pending.submits };
  const touched = new Set<CardRec>();
  for (const sid of input.dropped ?? []) delete submits[sid];
  for (const r of input.results ?? []) {
    const e = submits[r.submit_id];
    if (e === undefined || (r.commit !== undefined && r.commit !== e.commit)) continue;
    delete submits[r.submit_id];
    const card = pool.cards.find((c) => c.card_id === e.card_id);
    if (
      card !== undefined &&
      card.open &&
      card.body.preview !== null &&
      card.body.submit_ids[e.attempt_id] === r.submit_id &&
      pool.attempts.get(e.attempt_id)?.submit_id === r.submit_id
    ) {
      if (r.commit !== undefined) {
        card.body.preview.after[e.attempt_id] = { repo: "plain", commit: r.commit } satisfies FrameAddress;
        if (Object.keys(card.body.submit_ids).every((id) => card.body.preview!.after[id] !== undefined)) {
          card.body.preview.error = null;
        }
      } else {
        card.body.preview.error = r.error ?? "preview_build_failed";
      }
      touched.add(card);
    }
  }
  for (const sid of input.retried ?? []) {
    const e = submits[sid];
    if (e !== undefined) {
      e.tries += 1;
      const card = pool.cards.find((c) => c.card_id === e.card_id);
      if (card?.open && card.body.preview !== null && card.body.submit_ids[e.attempt_id] === sid) {
        card.body.preview.error = "preview_push_failed";
        touched.add(card);
      }
    }
  }
  const rest = Object.keys(submits);
  if (rest.length === 0) {
    clearPreviews(pool);
  } else {
    metaWrite(pool, PENDING_KEY, JSON.stringify({ v: 1, epoch: pending.epoch, submits } satisfies PendingMap));
    const maxTries = Math.max(...rest.map((s) => submits[s]!.tries));
    const due = pool.now() + Math.min(PUSH_BACKOFF_BASE_MS * 2 ** maxTries, PUSH_BACKOFF_MAX_MS);
    pool.sql.exec("INSERT OR REPLACE INTO timers (kind, key, due_at) VALUES ('preview', '', ?)", due);
  }
  // CD2: a preview's arrival (or failure) is a card update like any other.
  for (const card of touched) {
    pool.dirtyCards.add(card.card_id);
    event(pool, "card.updated", { card: card.body });
  }
  return { ok: true };
}

/** The `Card.preview` value a freshly opened held/race card carries (PV1/PV2): `before` is the
 * landed commit of `main` at open — `null` when none has ever pushed — `after` fills in as the
 * preview commits land. `null` for a card that takes no preview (HD1's minimal form, a choice
 * card, or a pool with no plain-merge repository). */
export function cardPreview(pool: Pool, kind: Card["kind"]): Card["preview"] {
  if ((kind === "held" && !pool.featuresHeld) || (kind !== "held" && kind !== "race")) return null;
  if (!buildsPlain(pool)) return null;
  const seedPending = pool.outbox?.batch_id === 0 && pool.outbox.pushed_at === null;
  const before = seedPending ? "" : (pool.meta.get("landed_commit") ?? "");
  return { before: before === "" ? null : { repo: "main", commit: before }, after: {}, error: null };
}
