// src/core/trunk/registry.ts — the TrunkPool: the whole working state of the engine, assembled
// from the SQLite schema of 3.2, mutated by one synchronous call at a time and written back in
// the same transaction. `TrunkPool.open` is the rebuild path (3.6): a fresh instance over the
// same `Sql` reconstructs everything the tables hold.
//
// The engine never awaits, never reads a clock it was not given, and never touches the network.

import type { Sql, SyncTriage } from "../../protocol/ports.ts";
import type { Check, ToolRequest, ToolResponse } from "../../protocol/tools.ts";
import type {
  Attempt,
  CardRec,
  FileMap,
  Head,
  IntentRec,
  Judgment,
  Landing,
  Op,
  OutboxRow,
  PendingTriage,
  Pool,
  Premise,
  UndoRequest,
} from "./sets.ts";
import { beginTrace } from "./sets.ts";
import { applySchema, metaAll, metaSet, migrateSchema, SCHEMA_VERSION, HASH_VERSION } from "./schema.ts";
import { event, emitPoolFiles, emitPoolState, syncRealAgents } from "./events.ts";
import { clearPreviews, previewBuild, previewDone } from "./preview.ts";
import { canChooseRace, createIntent, raceCostDone, refreshRaceCandidates } from "./race.ts";
import type { RaceCostDone, TrunkCreateIntentRequest, TrunkCreateIntentResponse } from "../../protocol/internal.ts";
import type { PreviewBuild, PreviewDoneInput } from "../../protocol/internal.ts";
import { plainBuild, plainDone, type PlainBuild } from "./plain.ts";
import { buildPack } from "../git/pack.ts";
import { clearRightOfWay, openAttempt, type OpenArgs } from "./intents.ts";
import { RIGHT_OF_WAY_MS } from "../../protocol/constants.ts";
import { tool } from "./tools-edit.ts";
import { tick, pushOk, reconcile, restart, triage, owner, recordLanding, seedCommit } from "./tick.ts";
import { armRebuild, beginRebuild, applyRebuildStep, registerDeadline } from "../rebuild/apply.ts";
import { IMPORT_CURSOR_KEY, applyImportStep, type ImportCursor, type ImportPayload } from "./import.ts";
import { register as registerAttempt } from "../rebuild/register.ts";
import type { ApplyPayload } from "../rebuild/plan.ts";
import type { RegisterRequest, RegisterResponse } from "../../protocol/tools.ts";
import { IMPORT_LANGUAGES, TIDEPOOL_LANGUAGES } from "../keys/paths.ts";
import { blobId } from "../sync/sha1.ts";
import { utf8, text as fromUtf8, blobBytes } from "../sync/bytes.ts";
import type { GitObject } from "../git/objects.ts";

import { undoPlan, confirmUndo } from "./undo-apply.ts";
import type { UndoRequest as OwnerUndoRequest } from "../../protocol/routes.ts";
import type { UndoPlanResponse, UndoResponse } from "../../protocol/undo.ts";

export type PoolOptions = {
  pool_id?: string;
  constants?: Partial<Pool["K"]>;
  switches?: { CLEF_TRIAGE?: "on" | "off" };
  killed?: boolean; // SE10's kill switch, as the caller last heard it
  syncTriage?: SyncTriage | null; // the SyncTriage port (S6a): ScriptedTriage for synthetic attempts
  features?: { held?: boolean };
  now?: () => number;
  ids?: { next(kind: string): string };
};

const DEFAULT_K: Pool["K"] = {
  GO_AROUND_LIMIT: 3,
  STARVATION_AFTER: 2,
  MAX_BATCH: 64,
  T_REPAIR: 0.7,
  T_CONFIRM: 0.2,
};

// Older stores used the requester string directly; new rows also freeze the confirmed set.
function parseUndoDetail(raw: string): { requested_by: string | null; reverted?: number[] } {
  try {
    return JSON.parse(raw) as { requested_by: string | null; reverted?: number[] };
  } catch {
    return { requested_by: raw };
  }
}

const str = (v: unknown): string => String(v);
const num = (v: unknown): number => Number(v);
const bool = (v: unknown): boolean => v === 1 || v === true || v === "1";

/**
 * Create a fresh pool: the schema plus `meta`, the seed files, and the seed commit that `main`
 * pointed to when the pool was created (3.5).
 */
export function createPool(
  sql: Sql,
  files: Record<string, string>,
  opts: PoolOptions & {
    pool_id?: string;
    summary_only?: boolean;
    synthetic?: boolean;
    remote?: string;
    request_id?: string;
  } = {},
): Pool {
  applySchema(sql);
  const pool = emptyPool(sql, opts);
  const seed = seedCommit(pool, new Map(Object.entries(files)));
  // IR5's entry bookkeeping starts at creation: `entries`/`trees` mirror the seed tree (set by
  // `seedCommit`), so a landing's tree write carries every untouched directory by object id.
  sql.transaction(() => {
    metaSet(sql, "schema_version", SCHEMA_VERSION);
    metaSet(sql, "hash_version", HASH_VERSION);
    metaSet(sql, "pool_id", opts.pool_id ?? pool.meta.get("pool_id") ?? "pool");
    metaSet(sql, "head_seq", "0");
    metaSet(sql, "head_commit", seed.oid);
    metaSet(sql, "head_tree", "");
    metaSet(sql, "notes_commit", "");
    metaSet(sql, "green_seq", "0");
    metaSet(sql, "green_commit", "");
    metaSet(sql, "landed_seq", "0");
    // SE19: the seed is what `main` means before the first landing — `landed_commit` carries it.
    metaSet(sql, "landed_commit", seed.oid);
    metaSet(sql, "pool_state", "ready");
    metaSet(sql, "next_batch_id", "1");
    metaSet(sql, "next_event_n", "1");
    // EV2: source epochs count from 1 — the Floor rejects `epoch < 1`.
    metaSet(sql, "epoch", "1");
    metaSet(sql, "summary_only", opts.summary_only === true ? "1" : "0");
    metaSet(sql, "synthetic", opts.synthetic === true ? "1" : "0");
    // FJ1: the build's `features.held`, or the create call's own `features.held` — the pool
    // remembers a direct engine override across reopen; an explicit build flag takes precedence.
    if (opts.features?.held === true) metaSet(sql, "features_held", "1");
    metaSet(sql, "remote", opts.remote ?? "");
    metaSet(sql, "real_agents", "0");
    if (opts.request_id !== undefined) metaSet(sql, "create_request_id", opts.request_id);
    for (const [path, content] of Object.entries(files)) {
      sql.exec(
        "INSERT INTO files (path, mode, oid, content, parse_state, changed_seq) VALUES (?, '100644', ?, ?, 'ok', 0)",
        path,
        blobId(utf8(content)),
        utf8(content),
      );
      pool.files.set(path, content);
      pool.modes.set(path, "100644");
      sql.exec(
        "INSERT OR REPLACE INTO blobs (oid, content, seq) VALUES (?, ?, 0)",
        blobId(utf8(content)),
        utf8(content),
      );
    }
    for (const [dir, oid] of pool.trees) {
      sql.exec("INSERT OR REPLACE INTO trees (dir, oid) VALUES (?, ?)", dir, oid);
    }
    // EM1: `pool.state` is event 1 (`head_seq` 0), `pool.files` follows with the seed tree.
    pool.meta = metaAll(sql);
    pool.eventCounter = 1;
    emitPoolState(pool);
    emitPoolFiles(pool);
    // The seed lands on Artifacts like every commit (PL1, gap 3): batch 0 of the outbox pushes
    // `main` from nothing to the seed commit. Its pack — the seed's objects — is stored with the
    // row, so the bytes survive a restart of the object (LP6).
    const pack = buildPack([...pool.objects.values()]);
    sql.exec(
      `INSERT INTO outbox (batch_id, state, first_seq, last_seq, old_main, new_main, old_notes, new_notes,
         tries, rejects, next_try, last_error, created_at, pushed_at)
       VALUES (0, 'pending', 0, 0, '', ?, '', '', 0, 0, NULL, NULL, ?, NULL)`,
      seed.oid,
      pool.now(),
    );
    sql.exec("INSERT INTO outbox_chunks (batch_id, i, bytes) VALUES (0, 0, ?)", pack);
    metaSet(sql, "next_event_n", String(pool.eventCounter));
  });
  return openPool(sql, opts);
}

/**
 * Create a pool imported from a public repository (IR2, IR3): the schema plus `meta` and the
 * first `pool.state` — `rebuilding` with reason `import`, `head_seq` 0 — and nothing else: no
 * files, no seed commit, no batch 0 (the imported head is the seed commit; nothing is pushed
 * for it), no `pool.files` (EM1's pair ends the job, not starts it). `app` is "" — an imported
 * pool has no live picture (IR8) — and `source` is `<owner>/<name>` for the prompt and the page.
 * The import cursor and the `rebuild` timer arm the job (IR3: "like a rebuild").
 */
export function createImportPool(
  sql: Sql,
  opts: PoolOptions & {
    pool_id: string;
    summary_only?: boolean;
    remote?: string;
    source: string;
    request_id?: string;
    branch?: string;
  },
): Pool {
  applySchema(sql);
  const pool = emptyPool(sql, opts);
  const cursor: ImportCursor = {
    v: 1,
    job: "import",
    request_id: opts.request_id ?? `import:${opts.pool_id}`,
    stage: "await",
    repo: opts.pool_id,
    branch: opts.branch ?? "",
  };
  sql.transaction(() => {
    metaSet(sql, "schema_version", SCHEMA_VERSION);
    metaSet(sql, "hash_version", HASH_VERSION);
    metaSet(sql, "pool_id", opts.pool_id);
    metaSet(sql, "head_seq", "0");
    metaSet(sql, "head_commit", "");
    metaSet(sql, "head_tree", "");
    metaSet(sql, "notes_commit", "");
    metaSet(sql, "green_seq", "0");
    metaSet(sql, "green_commit", "");
    metaSet(sql, "landed_seq", "0");
    metaSet(sql, "landed_commit", "");
    metaSet(sql, "pool_state", "rebuilding");
    metaSet(sql, "pause_reason", "import");
    metaSet(sql, "next_batch_id", "1");
    metaSet(sql, "next_event_n", "1");
    // EV2: source epochs count from 1 — the Floor rejects `epoch < 1`.
    metaSet(sql, "epoch", "1");
    metaSet(sql, "summary_only", opts.summary_only === true ? "1" : "0");
    metaSet(sql, "synthetic", "0");
    metaSet(sql, "remote", opts.remote ?? "");
    metaSet(sql, "app", "");
    metaSet(sql, "source", opts.source);
    // IR10/IR11: the branch the pool was imported from — the request's `branch`, or the remote's
    // default the route resolved off the binding's `import` answer. The prompt's
    // `Repository: <owner>/<name> (<branch>)` line reads it.
    metaSet(sql, "branch", opts.branch ?? "");
    metaSet(sql, "real_agents", "0");
    if (opts.request_id !== undefined) metaSet(sql, "create_request_id", opts.request_id);
    metaSet(sql, IMPORT_CURSOR_KEY, JSON.stringify(cursor));
    sql.exec("INSERT OR REPLACE INTO timers (kind, key, due_at) VALUES ('rebuild', '', ?)", pool.now());
    pool.meta = metaAll(sql);
    pool.eventCounter = 1;
    // IR3: event 1 is `pool.state` `rebuilding`/`import`/`head_seq` 0. `pool.files` follows the
    // job's finish, not the create.
    emitPoolState(pool);
    metaSet(sql, "next_event_n", String(pool.eventCounter));
  });
  return openPool(sql, opts);
}

/** Rebuild the working Pool from the schema (3.6): everything the tables hold, in memory. */
export function openPool(sql: Sql, opts: PoolOptions = {}): Pool {
  // 3.6: the store may be a wiped object — `meta` itself absent. `applySchema` is idempotent
  // (CREATE TABLE IF NOT EXISTS), so the ordinary open is unchanged.
  applySchema(sql);
  const pool = emptyPool(sql, opts);
  pool.meta = metaAll(sql);
  // FJ1: `features.held` comes from the build (the caller passes FEATURES.held); a pool created
  // under a direct engine call keeps that default, but an explicit false always wins.
  pool.featuresHeld = opts.features?.held ?? pool.meta.get("features_held") === "1";
  // LG1: an imported pool (`app` "", 06-repos IR2/IR8) works in IMPORT_LANGUAGES; the tide
  // pool and any other seeded pool keep 2.1's set.
  pool.languages = pool.meta.get("app") === "" ? IMPORT_LANGUAGES : TIDEPOOL_LANGUAGES;
  pool.eventCounter = Number(pool.meta.get("next_event_n") ?? "1");
  for (const [k, v] of pool.meta) {
    if (k.startsWith("steps:")) pool.steps.set(k.slice(6), Number(v));
  }
  pool.judgmentsCounter = num(
    sql.exec("SELECT COALESCE(MAX(judgment_id), 0) AS m FROM judgments").toArray()[0]?.m ?? 0,
  );
  pool.cardCounter = num(sql.exec("SELECT COUNT(*) AS m FROM cards").toArray()[0]?.m ?? 0) + 1;
  pool.undoCounter = num(sql.exec("SELECT COUNT(*) AS m FROM undo_requests").toArray()[0]?.m ?? 0) + 1;
  // head files: every row is an entry (IR5); only a managed row joins `files` — an unmanaged
  // path (a symbolic link, a submodule, a path outside 2.1) is stored with its mode and object
  // id but is invisible to the tools, and a content-NULL row is the pool's `opaque` set (RB4).
  const headEntries = pool.entries; // local: the seam guard reads `pool.entries`' writes as table writes
  for (const row of sql.exec("SELECT path, mode, oid, content, parse_state FROM files").toArray()) {
    const path = str(row.path);
    headEntries.set(path, { oid: str(row.oid), mode: str(row.mode) });
    pool.modes.set(path, str(row.mode));
    if (str(row.parse_state) === "unmanaged") continue;
    // RB4: a content-NULL row is an opaque blob (over MAX_FILE_BYTES) — `blobBytes` maps null to
    // empty bytes, so the NULL itself is what names the set, not the decode.
    if (row.content === null) {
      pool.opaque.add(path);
      pool.files.set(path, "");
      continue;
    }
    pool.files.set(path, fromUtf8(blobBytes(row.content)));
  }
  for (const row of sql.exec("SELECT dir, oid FROM trees").toArray()) {
    pool.trees.set(str(row.dir), str(row.oid));
  }
  // intents
  for (const row of sql.exec("SELECT * FROM intents").toArray()) {
    pool.intents.set(str(row.intent_id), {
      intent_id: str(row.intent_id),
      text: str(row.text),
      requester: str(row.requester),
      race: bool(row.race),
      state: str(row.state) as IntentRec["state"],
      created_at: num(row.created_at),
    });
  }
  // attempts + premises + ops + heads_ups + judgments
  const judgmentsByAttempt = new Map<string, Judgment[]>();
  for (const row of sql.exec("SELECT * FROM judgments ORDER BY judgment_id").toArray()) {
    const j = judgmentFromRow(row);
    pool.judgments.set(j.judgment_id, j);
    let l = judgmentsByAttempt.get(j.attempt_id);
    if (l === undefined) {
      l = [];
      judgmentsByAttempt.set(j.attempt_id, l);
    }
    l.push(j);
  }
  // Each child table is read once, in its key order, and grouped: one query per attempt and per
  // landing made every open cost thousands of queries in a busy pool.
  const premisesByAttempt = groupRows(
    sql.exec("SELECT * FROM premises ORDER BY attempt_id, kind, key").toArray(),
    "attempt_id",
  );
  const opsByAttempt = groupRows(sql.exec("SELECT * FROM ops ORDER BY attempt_id, op_seq").toArray(), "attempt_id");
  const headsByAttempt = groupRows(sql.exec("SELECT * FROM heads_ups ORDER BY attempt_id, hn").toArray(), "attempt_id");
  for (const row of sql.exec("SELECT * FROM attempts ORDER BY attempt_id").toArray()) {
    const a = attemptFromRow(pool, row);
    for (const pr of premisesByAttempt.get(a.id) ?? []) {
      const p = premiseFromRow(pr);
      a.premises.set(`${p.kind}|${p.key}`, p);
    }
    for (const or of opsByAttempt.get(a.id) ?? []) {
      a.ops.push(opFromRow(or));
      a.opCount = Math.max(a.opCount, num(or.op_seq));
    }
    for (const hr of headsByAttempt.get(a.id) ?? []) {
      const h = headFromRow(hr);
      a.heads.push(h);
      a.next_hn = Math.max(a.next_hn, h.hn + 1);
      if (h.resolved_at !== null) a.resolved.add(h.hn);
    }
    for (const j of judgmentsByAttempt.get(a.id) ?? []) {
      if (j.result === null) {
        a.pending.push(j);
        const p = a.premises.get(`${j.kind}|${j.key}`);
        if (p !== undefined) pool.pendingTriage.push({ a, p, judgment: j, it: null, cause: j.cause, stamp: a.opCount });
      }
    }
    pool.attempts.set(a.id, a);
    pool.attemptCounter += 1;
  }
  // landings + companions
  const filesBySeq = groupRows(sql.exec("SELECT * FROM landing_files ORDER BY seq, path").toArray(), "seq");
  const writesBySeq = groupRows(sql.exec("SELECT * FROM landing_writes ORDER BY seq, kind, key").toArray(), "seq");
  const premisesBySeq = groupRows(sql.exec("SELECT * FROM landing_premises ORDER BY seq, kind, key").toArray(), "seq");
  const opsBySeq = groupRows(sql.exec("SELECT * FROM landing_ops ORDER BY seq, op_seq").toArray(), "seq");
  for (const row of sql.exec("SELECT * FROM landings ORDER BY seq").toArray()) {
    const l = landingFromRow(row);
    for (const fr of filesBySeq.get(String(l.seq)) ?? []) {
      l.files.set(str(fr.path), { old_oid: str(fr.old_oid), new_oid: str(fr.new_oid) });
    }
    for (const wr of writesBySeq.get(String(l.seq)) ?? []) {
      l.writes.push({
        kind: str(wr.kind) as Landing["writes"][number]["kind"],
        key: str(wr.key),
        old_hash: str(wr.old_hash),
        new_hash: str(wr.new_hash),
      });
    }
    for (const pr of premisesBySeq.get(String(l.seq)) ?? []) {
      l.premises.push({
        kind: str(pr.kind) as Premise["kind"],
        key: str(pr.key),
        hash: str(pr.hash),
        seq: num(pr.pin_seq),
        members: null,
        shown: null,
        read: bool(pr.read),
        edit: bool(pr.edit),
        derived: bool(pr.derived),
        status: "holds",
      });
    }
    for (const or of opsBySeq.get(String(l.seq)) ?? []) {
      l.ops.push(JSON.parse(str(or.body)) as Op);
    }
    pool.landings.push(l);
  }
  for (const l of pool.landings) {
    lazyFileMaps(pool, l);
    pool.landingMarks.set(l.seq, landingMark(l));
  }
  // cards
  for (const row of sql.exec("SELECT * FROM cards").toArray()) {
    const body = JSON.parse(str(row.body)) as CardRec["body"];
    pool.cards.push({
      card_id: str(row.card_id),
      kind: str(row.kind) as CardRec["kind"],
      open: str(row.state) === "open",
      body,
      created_at: num(row.created_at),
      closed_at: row.closed_at === null ? null : num(row.closed_at),
      reason: body.reason,
      attempt_ids: body.attempt_ids,
      intent_ids: body.intent_ids,
    });
  }
  // outbox
  const ob = sql.exec("SELECT * FROM outbox ORDER BY batch_id DESC").toArray()[0];
  if (
    ob !== undefined &&
    (str(ob.state) === "pending" || str(ob.state) === "notes_pending" || str(ob.state) === "diverged")
  ) {
    pool.outbox = outboxFromRow(ob);
    const chunks = sql
      .exec("SELECT bytes FROM outbox_chunks WHERE batch_id = ? ORDER BY i", pool.outbox.batch_id)
      .toArray();
    if (chunks.length > 0) {
      const parts = chunks.map((c) => blobBytes(c.bytes));
      const pack = new Uint8Array(parts.reduce((n, b) => n + b.byteLength, 0));
      let off = 0;
      for (const part of parts) {
        pack.set(part, off);
        off += part.byteLength;
      }
      pool.outboxPack = pack;
    }
  }
  // undo requests: the queue plus the log of completed ones
  for (const row of sql.exec("SELECT * FROM undo_requests").toArray()) {
    const u: UndoRequest = {
      request_id: str(row.request_id),
      target_seq: num(row.target_seq),
      cause: str(row.cause) as UndoRequest["cause"],
      state: str(row.state) as UndoRequest["state"],
      requested_by: row.detail === null ? null : parseUndoDetail(str(row.detail)).requested_by,
      reverted: row.detail === null ? undefined : parseUndoDetail(str(row.detail)).reverted,
    };
    pool.undoLog.set(u.request_id, u);
    if (u.state === "queued") pool.undoQueue.push(u);
  }
  return pool;
}

function emptyPool(sql: Sql, opts: PoolOptions): Pool {
  let clock = opts.now !== undefined ? 0 : 0;
  const now = opts.now ?? (() => ++clock);
  const pool: Pool = {
    sql,
    now,
    ids:
      opts.ids ??
      (() => {
        let n = 0;
        return { next: (kind: string) => `${kind}_${(++n).toString(36).padStart(6, "0")}` };
      })(),
    K: { ...DEFAULT_K, ...(opts.constants ?? {}) },
    clefOn: (opts.switches?.CLEF_TRIAGE ?? "on") === "on",
    killed: opts.killed === true,
    syncTriage: opts.syncTriage ?? null,
    featuresHeld: opts.features?.held === true,
    meta: new Map<string, string>([["pool_id", opts.pool_id ?? "pool"]]),
    // `openPool` re-derives this from `meta.app` once the store is read; a fresh map starts
    // at the tide-pool set until then (a seed pool keeps it; an imported create sets `app` "").
    languages: TIDEPOOL_LANGUAGES,
    files: new Map<string, string>(),
    modes: new Map<string, string>(),
    entries: new Map<string, { oid: string; mode: string }>(),
    opaque: new Set<string>(),
    trees: new Map<string, string>(),
    dirtyTrees: new Set<string>(),
    attempts: new Map(),
    landings: [],
    cards: [],
    outbox: null,
    outboxPack: null,
    undoQueue: [],
    order: 0,
    out: beginTrace(),
    dirtyAttempts: new Set(),
    dirtyCards: new Set(),
    dirtyOutbox: false,
    dirtyUndo: new Set(),
    newLandings: [],
    landingMarks: new Map(),
    filesChanged: new Set(),
    entitiesChanged: new Set(),
    analyses: new Map(),
    judgmentsCounter: 0,
    eventCounter: 1,
    cardCounter: 1,
    attemptCounter: 1,
    undoCounter: 1,
    intents: new Map(),
    dirtyIntents: new Set(),
    pendingTriage: [],
    judgments: new Map(),
    eventBuffer: null,
    steps: new Map(),
    objects: new Map<string, GitObject>(),
    undoLog: new Map(),
    headSeq(): number {
      return Number(pool.meta.get("head_seq") ?? "0");
    },
    setHead(seqv: number, files: FileMap) {
      pool.files = files;
      pool.meta.set("head_seq", String(seqv));
      metaSet(sql, "head_seq", String(seqv));
    },
    event(type: string, fields: Record<string, unknown>) {
      event(pool, type, fields);
    },
    dropPendingItem(a: Attempt, p: Premise) {
      for (const t of [...pool.pendingTriage]) {
        if (t.a === a && t.p === p) {
          pool.pendingTriage.splice(pool.pendingTriage.indexOf(t), 1);
          a.pending = a.pending.filter((x) => x !== t.judgment);
          t.judgment.result = "holds";
          t.judgment.reason = "premise_gone";
          t.judgment.resolved_at = pool.now();
          t.judgment.dirty = true;
          // JE1: the pending triage is closed by the premise's deletion — the second
          // premise.judged carries its final result (EV6 suppresses `holds` on summary pools).
          event(pool, "premise.judged", {
            attempt_id: a.id,
            kind: t.judgment.kind,
            key: t.judgment.key,
            old_hash: t.judgment.old_hash,
            new_hash: t.judgment.new_hash,
            cause: t.judgment.cause,
            cause_seq: t.judgment.cause_seq,
            rule: t.judgment.rule,
            class: t.judgment.klass,
            result: "holds",
            reason: "premise_gone",
            clef: null,
          });
        }
      }
    },
    newJudgment(
      a: Attempt,
      j: {
        kind: Judgment["kind"];
        key: string;
        old_hash: string;
        new_hash: string;
        cause: Judgment["cause"];
        cause_seq: number | null;
        rule: string;
        klass: "rule" | "triage";
        result: Judgment["result"];
        reason: string;
        asked_op_seq?: number | null;
        heads_up?: boolean; // EV6: a heads-up item carries this judgment
        clef?: { model: string; p: number | null; error: string | null };
      },
    ): Judgment {
      const record: Judgment = {
        judgment_id: ++pool.judgmentsCounter,
        attempt_id: a.id,
        kind: j.kind,
        key: j.key,
        old_hash: j.old_hash,
        new_hash: j.new_hash,
        cause: j.cause,
        cause_seq: j.cause_seq,
        rule: j.rule,
        klass: j.klass,
        result: j.result,
        asked_op_seq: j.asked_op_seq ?? null,
        asked_at: j.klass === "triage" ? pool.now() : null,
        tries: 0,
        reason: j.reason,
        clef_model: j.clef?.model ?? null,
        clef_p: j.clef?.p ?? null,
        clef_ms: null,
        clef_error: j.clef?.error ?? null,
        t_repair: null,
        t_confirm: null,
        created_at: pool.now(),
        resolved_at: j.result === null ? null : pool.now(),
        dirty: true,
        item: null,
      };
      pool.judgments.set(record.judgment_id, record);
      event(
        pool,
        "premise.judged",
        {
          attempt_id: a.id,
          kind: j.kind,
          key: j.key,
          old_hash: j.old_hash,
          new_hash: j.new_hash,
          cause: j.cause,
          cause_seq: j.cause_seq,
          rule: j.rule,
          class: j.klass,
          result: j.result,
          reason: j.reason,
          clef: j.clef ?? null,
        },
        { headsup: j.heads_up === true },
      );
      return record;
    },
    fileMapAt(seq: number): FileMap {
      const headSeq = pool.headSeq();
      if (seq >= headSeq) return pool.files;
      // Rebuild backwards: start at head, restore each later landing's old blobs.
      const files = new Map(pool.files);
      for (const l of [...pool.landings].filter((x) => x.seq > seq).sort((a, b) => b.seq - a.seq)) {
        for (const [path, fo] of l.files) {
          if (fo.old_oid === "absent") {
            files.delete(path);
          } else {
            const row = pool.sql.exec("SELECT content FROM blobs WHERE oid = ?", fo.old_oid).toArray()[0];
            if (row === undefined) continue;
            files.set(path, fromUtf8(blobBytes(row.content)));
          }
        }
      }
      return files;
    },
    stepOf(a: Attempt): number {
      const key = `steps:${a.id}`;
      const n = Number(pool.meta.get(key) ?? "0") + 1;
      pool.meta.set(key, String(n));
      pool.steps.set(a.id, n);
      return n;
    },
  } satisfies Pool;
  return pool;
}

// ---------------------------------------------------------------------------
// Row (de)serialisation.

function premiseFromRow(row: Record<string, unknown>): Premise {
  return {
    kind: str(row.kind) as Premise["kind"],
    key: str(row.key),
    hash: str(row.hash),
    seq: num(row.seq),
    members: row.members === null ? null : (JSON.parse(str(row.members)) as string[]),
    shown: row.shown === null ? null : (JSON.parse(str(row.shown)) as string | string[]),
    read: bool(row.read),
    edit: bool(row.edit),
    derived: bool(row.derived),
    status: str(row.status) as Premise["status"],
  };
}

function opFromRow(row: Record<string, unknown>): Op {
  const op = str(row.op);
  if (op === "write") {
    return {
      op_seq: num(row.op_seq),
      op: "write",
      path: str(row.path),
      content: row.content === null ? null : str(row.content),
      base_oid: row.base_oid === null ? "absent" : str(row.base_oid),
      dropped: bool(row.dropped),
    };
  }
  return {
    op_seq: num(row.op_seq),
    op: "replace",
    path: str(row.path),
    old: row.old === null ? "" : str(row.old),
    new: row.new === null ? "" : str(row.new),
    targets: row.targets === null ? [] : (JSON.parse(str(row.targets)) as string[]),
    dropped: bool(row.dropped),
  };
}

function headFromRow(row: Record<string, unknown>): Head {
  return {
    hn: num(row.hn),
    result: str(row.result) as Head["result"],
    wake: bool(row.wake),
    body: JSON.parse(str(row.body)) as Head["body"],
    created_at: num(row.created_at),
    received_at: row.received_at === null ? null : num(row.received_at),
    delivered_at: row.delivered_at === null ? null : num(row.delivered_at),
    resolved_at: row.resolved_at === null ? null : num(row.resolved_at),
    statement: row.statement === null ? null : str(row.statement),
    op_mark: num(row.op_mark),
  };
}

function judgmentFromRow(row: Record<string, unknown>): Judgment {
  return {
    judgment_id: num(row.judgment_id),
    attempt_id: str(row.attempt_id),
    kind: str(row.kind) as Judgment["kind"],
    key: str(row.key),
    old_hash: str(row.old_hash),
    new_hash: str(row.new_hash),
    cause: str(row.cause) as Judgment["cause"],
    cause_seq: row.cause_seq === null ? null : num(row.cause_seq),
    rule: str(row.rule),
    klass: str(row.class) as Judgment["klass"],
    result: row.result === null ? null : (str(row.result) as Judgment["result"]),
    asked_op_seq: row.asked_op_seq === null ? null : num(row.asked_op_seq),
    asked_at: row.asked_at === null ? null : num(row.asked_at),
    tries: num(row.tries),
    reason: str(row.reason),
    clef_model: row.clef_model === null ? null : str(row.clef_model),
    clef_p: row.clef_p === null ? null : num(row.clef_p),
    clef_ms: row.clef_ms === null ? null : num(row.clef_ms),
    clef_error: row.clef_error === null ? null : str(row.clef_error),
    t_repair: row.t_repair === null ? null : num(row.t_repair),
    t_confirm: row.t_confirm === null ? null : num(row.t_confirm),
    created_at: num(row.created_at),
    resolved_at: row.resolved_at === null ? null : num(row.resolved_at),
    dirty: false,
    item: null,
  };
}

function landingFromRow(row: Record<string, unknown>): Landing {
  return {
    seq: num(row.seq),
    kind: str(row.kind) as Landing["kind"],
    change_id: str(row.change_id),
    attempt_id: row.attempt_id === null ? null : str(row.attempt_id),
    intent_id: row.intent_id === null ? null : str(row.intent_id),
    batch_id: num(row.batch_id),
    commit_oid: str(row.commit_oid),
    parent_oid: str(row.parent_oid),
    tree_oid: str(row.tree_oid),
    note_oid: str(row.note_oid),
    note: str(row.note),
    submitted_at: row.submitted_at === null ? null : num(row.submitted_at),
    accepted_at: num(row.accepted_at),
    pushed_at: row.pushed_at === null ? null : num(row.pushed_at),
    undone_by: row.undone_by === null ? null : num(row.undone_by),
    files: new Map(),
    writes: [],
    premises: [],
    ops: [],
    intentText: null,
    request_id: null,
    before: new Map(),
    after: new Map(),
  };
}

function outboxFromRow(row: Record<string, unknown>): OutboxRow {
  return {
    batch_id: num(row.batch_id),
    state: str(row.state) as OutboxRow["state"],
    first_seq: num(row.first_seq),
    last_seq: num(row.last_seq),
    old_main: str(row.old_main),
    new_main: str(row.new_main),
    old_notes: str(row.old_notes),
    new_notes: str(row.new_notes),
    tries: num(row.tries),
    rejects: num(row.rejects),
    next_try: row.next_try === null ? null : num(row.next_try),
    last_error: row.last_error === null ? null : str(row.last_error),
    created_at: num(row.created_at),
    pushed_at: row.pushed_at === null ? null : num(row.pushed_at),
    main: false,
    notes: false,
  };
}

export function attemptFromRow(pool: Pool, row: Record<string, unknown>): Attempt {
  const intent = pool.intents.get(str(row.intent_id));
  return {
    id: str(row.attempt_id),
    intent_id: str(row.intent_id),
    change_id: str(row.change_id),
    agent_kind: str(row.agent_kind) as Attempt["agent_kind"],
    model: row.model === null ? null : str(row.model),
    race: bool(row.race),
    truth: row.truth === null ? null : (JSON.parse(str(row.truth)) as string[]),
    resumes: num(row.resumes),
    state: str(row.state) as Attempt["state"],
    stop_reason: row.stop_reason === null ? null : str(row.stop_reason),
    go_arounds: num(row.go_arounds),
    pull_backs: num(row.pull_backs),
    revision: num(row.revision),
    right_of_way_at: row.right_of_way_at === null ? null : num(row.right_of_way_at),
    opened_seq: num(row.opened_seq),
    submit_id: row.submit_id === null ? null : str(row.submit_id),
    summary: row.summary === null ? null : str(row.summary),
    tier: row.tier === null ? null : (str(row.tier) as Attempt["tier"]),
    approved_by: row.approved_by === null ? null : str(row.approved_by),
    approved_at: ((): number | null => {
      const raw = pool.meta.get(`approved:${str(row.attempt_id)}`);
      return raw === undefined ? null : (JSON.parse(raw) as { at: number }).at;
    })(),
    approved_option: ((): Attempt["approved_option"] => {
      const raw = pool.meta.get(`approved:${str(row.attempt_id)}`);
      return raw === undefined ? null : (JSON.parse(raw) as { option: Attempt["approved_option"] }).option;
    })(),
    policy_risk: ((): Attempt["policy_risk"] => {
      const raw = pool.meta.get(`approved:${str(row.attempt_id)}`);
      return raw === undefined ? null : (JSON.parse(raw) as { risk: Attempt["policy_risk"] }).risk;
    })(),
    bypass_row: bool(row.bypass_row),
    submitted_at: row.submitted_at === null ? null : num(row.submitted_at),
    validated_at: row.validated_at === null ? null : num(row.validated_at),
    landed_seq: row.landed_seq === null ? null : num(row.landed_seq),
    attempt_repo: row.attempt_repo === null ? null : str(row.attempt_repo),
    model_calls: num(row.model_calls ?? 0),
    tokens_in: num(row.tokens_in ?? 0),
    tokens_out: num(row.tokens_out ?? 0),
    last_call_id: row.last_call_id === null ? null : str(row.last_call_id),
    last_response: row.last_response === null ? null : (JSON.parse(str(row.last_response)) as Record<string, unknown>),
    ack: num(row.ack),
    next_hn: num(row.next_hn),
    updated_at: num(row.updated_at),
    intentText: intent?.text ?? "",
    requester: intent?.requester ?? "agent",
    opCount: 0,
    op_mark: null,
    premises: new Map(),
    ops: [],
    heads: [],
    resolved: new Set(),
    e1: new Set(),
    checks: ((): Check[] | null => {
      const raw = pool.meta.get(`checks:${str(row.attempt_id)}`);
      return raw === undefined ? null : (JSON.parse(raw) as Check[]);
    })(),
    // PM2: whether this revision already wrote its `ops_first` row — hydrated from the table,
    // so a pool reopen never writes a second snapshot over the first.
    opsFirstDone:
      pool.sql
        .exec(
          "SELECT 1 AS x FROM ops_first WHERE attempt_id = ? AND revision = ?",
          str(row.attempt_id),
          num(row.revision),
        )
        .toArray().length > 0,
    pending: [],
    dirtyJudgments: new Set(),
  };
}

// ---------------------------------------------------------------------------
// Persistence: write the dirty working state back, inside the call's transaction.

function persistAttempt(pool: Pool, a: Attempt): void {
  const sql = pool.sql;
  sql.exec(
    `INSERT OR REPLACE INTO attempts (
      attempt_id, intent_id, change_id, agent_kind, model, race, truth, resumes, state, stop_reason,
      go_arounds, pull_backs, revision, right_of_way_at, opened_seq, submit_id, summary, tier,
      approved_by, bypass_row, sets, submitted_at, validated_at, landed_seq, attempt_repo,
      model_calls, tokens_in, tokens_out, last_call_id, last_response, ack, next_hn, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    a.id,
    a.intent_id,
    a.change_id,
    a.agent_kind,
    a.model,
    a.race ? 1 : 0,
    a.truth === null ? null : JSON.stringify(a.truth),
    a.resumes,
    a.state,
    a.stop_reason,
    a.go_arounds,
    a.pull_backs,
    a.revision,
    a.right_of_way_at,
    a.opened_seq,
    a.submit_id,
    a.summary,
    a.tier,
    a.approved_by,
    a.bypass_row ? 1 : 0,
    null,
    a.submitted_at,
    a.validated_at,
    a.landed_seq,
    a.attempt_repo,
    a.model_calls ?? 0,
    a.tokens_in ?? 0,
    a.tokens_out ?? 0,
    a.last_call_id,
    a.last_response === null ? null : JSON.stringify(a.last_response),
    a.ack,
    a.next_hn,
    pool.now(),
  );
  sql.exec("DELETE FROM premises WHERE attempt_id = ?", a.id);
  for (const p of a.premises.values()) {
    sql.exec(
      `INSERT INTO premises (attempt_id, kind, key, hash, seq, members, shown, read, edit, derived, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.id,
      p.kind,
      p.key,
      p.hash,
      p.seq,
      p.members === null ? null : JSON.stringify(p.members),
      p.shown === null ? null : JSON.stringify(p.shown),
      p.read ? 1 : 0,
      p.edit ? 1 : 0,
      p.derived ? 1 : 0,
      p.status,
    );
  }
  sql.exec("DELETE FROM ops WHERE attempt_id = ?", a.id);
  for (const o of a.ops) {
    if (o.op === "write") {
      sql.exec(
        `INSERT INTO ops (attempt_id, op_seq, op, path, content, old, new, base_oid, targets, dropped)
         VALUES (?, ?, 'write', ?, ?, NULL, NULL, ?, NULL, ?)`,
        a.id,
        o.op_seq,
        o.path,
        o.content,
        o.base_oid,
        o.dropped ? 1 : 0,
      );
    } else {
      sql.exec(
        `INSERT INTO ops (attempt_id, op_seq, op, path, content, old, new, base_oid, targets, dropped)
         VALUES (?, ?, 'replace', ?, NULL, ?, ?, NULL, ?, ?)`,
        a.id,
        o.op_seq,
        o.path,
        o.old,
        o.new,
        JSON.stringify(o.targets),
        o.dropped ? 1 : 0,
      );
    }
  }
  sql.exec("DELETE FROM heads_ups WHERE attempt_id = ?", a.id);
  for (const h of a.heads) {
    sql.exec(
      `INSERT INTO heads_ups (attempt_id, hn, result, wake, body, created_at, received_at, delivered_at, resolved_at, statement, op_mark)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.id,
      h.hn,
      h.result,
      h.wake ? 1 : 0,
      JSON.stringify(h.body),
      h.created_at,
      h.received_at,
      h.delivered_at,
      h.resolved_at,
      h.statement,
      h.op_mark,
    );
  }
}

function persistJudgment(pool: Pool, j: Judgment): void {
  pool.sql.exec(
    `INSERT OR REPLACE INTO judgments (
      judgment_id, attempt_id, kind, key, old_hash, new_hash, cause, cause_seq, rule, class, result,
      asked_op_seq, asked_at, tries, reason, clef_model, clef_p, clef_ms, clef_error, t_repair,
      t_confirm, created_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    j.judgment_id,
    j.attempt_id,
    j.kind,
    j.key,
    j.old_hash,
    j.new_hash,
    j.cause,
    j.cause_seq,
    j.rule,
    j.klass,
    j.result,
    j.asked_op_seq,
    j.asked_at,
    j.tries,
    j.reason,
    j.clef_model,
    j.clef_p,
    j.clef_ms,
    j.clef_error,
    j.t_repair,
    j.t_confirm,
    j.created_at,
    j.resolved_at,
  );
  j.dirty = false;
}

/** The rows of `table` grouped by the string value of `column`, each group in the query's order. */
function groupRows(rows: Record<string, unknown>[], column: string): Map<string, Record<string, unknown>[]> {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = String(row[column]);
    let group = groups.get(key);
    if (group === undefined) {
      group = [];
      groups.set(key, group);
    }
    group.push(row);
  }
  return groups;
}

/**
 * A loaded landing's `before` and `after` are the file maps at `seq - 1` and `seq`, computed when
 * first read (`fileMapAt` walks back from head) and kept: copying the whole map twice for every
 * landing on every open made each open quadratic in the landings, and its memory grew with them.
 * An assignment replaces the map, as for a landing made in this call.
 */
function lazyFileMaps(pool: Pool, l: Landing): void {
  let before: FileMap | undefined;
  let after: FileMap | undefined;
  Object.defineProperty(l, "before", {
    get: () => (before ??= pool.fileMapAt(l.seq - 1)),
    set: (value: FileMap) => {
      before = value;
    },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(l, "after", {
    get: () => (after ??= pool.fileMapAt(l.seq)),
    set: (value: FileMap) => {
      after = value;
    },
    enumerable: true,
    configurable: true,
  });
}

/** The fields of a landing's own row that change after it is made (its push, its note, its undo). */
function landingMark(l: Landing): string {
  return JSON.stringify([
    l.kind,
    l.batch_id,
    l.commit_oid,
    l.parent_oid,
    l.tree_oid,
    l.note_oid,
    l.submitted_at,
    l.accepted_at,
    l.pushed_at,
    l.undone_by,
  ]);
}

function persistLanding(pool: Pool, l: Landing): void {
  const sql = pool.sql;
  sql.exec(
    `INSERT OR REPLACE INTO landings (
      seq, kind, change_id, attempt_id, intent_id, batch_id, commit_oid, parent_oid, tree_oid,
      note_oid, note, submitted_at, accepted_at, pushed_at, undone_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    l.seq,
    l.kind,
    l.change_id,
    l.attempt_id,
    l.intent_id,
    l.batch_id,
    l.commit_oid,
    l.parent_oid,
    l.tree_oid,
    l.note_oid,
    l.note,
    l.submitted_at,
    l.accepted_at,
    l.pushed_at,
    l.undone_by,
  );
  sql.exec("DELETE FROM landing_files WHERE seq = ?", l.seq);
  for (const [path, fo] of l.files) {
    sql.exec(
      "INSERT INTO landing_files (seq, path, old_oid, new_oid) VALUES (?, ?, ?, ?)",
      l.seq,
      path,
      fo.old_oid,
      fo.new_oid,
    );
    for (const oid of [fo.old_oid, fo.new_oid]) {
      if (oid !== "absent") {
        const content = fo.new_oid === oid ? l.after.get(path) : l.before.get(path);
        if (content !== undefined) {
          sql.exec("INSERT OR IGNORE INTO blobs (oid, content, seq) VALUES (?, ?, ?)", oid, utf8(content), l.seq);
        }
      }
    }
  }
  sql.exec("DELETE FROM landing_writes WHERE seq = ?", l.seq);
  for (const w of l.writes) {
    sql.exec(
      "INSERT INTO landing_writes (seq, kind, key, old_hash, new_hash) VALUES (?, ?, ?, ?, ?)",
      l.seq,
      w.kind,
      w.key,
      w.old_hash,
      w.new_hash,
    );
  }
  sql.exec("DELETE FROM landing_premises WHERE seq = ?", l.seq);
  for (const p of l.premises) {
    sql.exec(
      "INSERT INTO landing_premises (seq, kind, key, hash, pin_seq, read, edit, derived) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      l.seq,
      p.kind,
      p.key,
      p.hash,
      p.seq,
      p.read ? 1 : 0,
      p.edit ? 1 : 0,
      p.derived ? 1 : 0,
    );
  }
  sql.exec("DELETE FROM landing_ops WHERE seq = ?", l.seq);
  for (const o of l.ops) {
    sql.exec("INSERT INTO landing_ops (seq, op_seq, body) VALUES (?, ?, ?)", l.seq, o.op_seq, JSON.stringify(o));
  }
}

/** Write every dirty piece of the pool back to SQLite; called inside the call's transaction. */
export function persist(pool: Pool): void {
  const sql = pool.sql;
  for (const id of pool.dirtyAttempts) {
    const a = pool.attempts.get(id);
    if (a !== undefined) persistAttempt(pool, a);
  }
  pool.dirtyAttempts.clear();
  for (const id of pool.dirtyIntents) {
    const i = pool.intents.get(id);
    if (i !== undefined) {
      sql.exec(
        "INSERT OR REPLACE INTO intents (intent_id, text, requester, race, state, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        i.intent_id,
        i.text,
        i.requester,
        i.race ? 1 : 0,
        i.state,
        i.created_at,
      );
    }
  }
  pool.dirtyIntents.clear();
  for (const j of pool.judgments.values()) if (j.dirty) persistJudgment(pool, j);
  for (const l of pool.newLandings) {
    persistLanding(pool, l);
    pool.landingMarks.set(l.seq, landingMark(l));
  }
  pool.newLandings = [];
  // Only a landing whose row changed since it was loaded or persisted (its push, its undo) is
  // written again: rewriting every pushed landing on every save made each call write a number of
  // rows that grew with the pool.
  for (const l of pool.landings) {
    const mark = landingMark(l);
    if (pool.landingMarks.get(l.seq) === mark) continue;
    persistLanding(pool, l);
    pool.landingMarks.set(l.seq, mark);
  }
  for (const id of pool.dirtyCards) {
    const c = pool.cards.find((x) => x.card_id === id);
    if (c !== undefined) {
      sql.exec(
        "INSERT OR REPLACE INTO cards (card_id, kind, state, body, created_at, closed_at) VALUES (?, ?, ?, ?, ?, ?)",
        c.card_id,
        c.kind,
        c.open ? "open" : "closed",
        JSON.stringify(c.body),
        c.created_at,
        c.closed_at,
      );
    }
  }
  pool.dirtyCards.clear();
  if (pool.dirtyOutbox) {
    sql.exec("DELETE FROM outbox");
    sql.exec("DELETE FROM outbox_chunks");
    if (pool.outbox !== null) {
      const pack = pool.outboxPack;
      if (pack !== null && pack.byteLength > 0) {
        const CHUNK = 64 * 1024;
        for (let i = 0; i * CHUNK < pack.byteLength; i += 1) {
          sql.exec(
            "INSERT INTO outbox_chunks (batch_id, i, bytes) VALUES (?, ?, ?)",
            pool.outbox.batch_id,
            i,
            pack.subarray(i * CHUNK, (i + 1) * CHUNK),
          );
        }
      }
      const o = pool.outbox;
      sql.exec(
        `INSERT INTO outbox (batch_id, state, first_seq, last_seq, old_main, new_main, old_notes, new_notes, tries, rejects, next_try, last_error, created_at, pushed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        o.batch_id,
        o.state,
        o.first_seq,
        o.last_seq,
        o.old_main,
        o.new_main,
        o.old_notes,
        o.new_notes,
        o.tries,
        o.rejects,
        o.next_try,
        o.last_error,
        o.created_at,
        o.pushed_at,
      );
    }
    pool.dirtyOutbox = false;
  }
  for (const id of pool.dirtyUndo) {
    const u = pool.undoQueue.find((x) => x.request_id === id) ?? pool.undoLog.get(id);
    if (u !== undefined) {
      sql.exec(
        "INSERT OR REPLACE INTO undo_requests (request_id, target_seq, cause, state, detail) VALUES (?, ?, ?, ?, ?)",
        u.request_id,
        u.target_seq,
        u.cause,
        u.state,
        JSON.stringify({ requested_by: u.requested_by, reverted: u.reverted }),
      );
    }
  }
  pool.dirtyUndo.clear();
  for (const path of pool.filesChanged) {
    const content = pool.files.get(path);
    if (content === undefined) {
      sql.exec("DELETE FROM files WHERE path = ?", path);
    } else {
      sql.exec(
        `INSERT OR REPLACE INTO files (path, mode, oid, content, parse_state, changed_seq)
         VALUES (?, ?, ?, ?, 'ok', ?)`,
        path,
        pool.modes.get(path) ?? "100644",
        blobId(utf8(content)),
        utf8(content),
        pool.headSeq(),
      );
      sql.exec(
        "INSERT OR IGNORE INTO blobs (oid, content, seq) VALUES (?, ?, ?)",
        blobId(utf8(content)),
        utf8(content),
        pool.headSeq(),
      );
    }
  }
  pool.filesChanged.clear();
  for (const dir of pool.dirtyTrees) {
    const oid = pool.trees.get(dir);
    if (oid !== undefined) sql.exec("INSERT OR REPLACE INTO trees (dir, oid) VALUES (?, ?)", dir, oid);
  }
  pool.dirtyTrees.clear();
  for (const [k, v] of pool.meta) {
    if (k !== "pool_id") metaSet(sql, k, v);
  }
}

// ---------------------------------------------------------------------------
// The public facade the driver (and later the DO) calls.

export type RunOutcome = {
  resp: ToolResponse | null;
  extra: Record<string, unknown>;
  out: Pool["out"];
  pool: Pool;
};

function wrapCall<T>(pool: Pool, run: () => T): T {
  pool.out = beginTrace();
  const r = pool.sql.transaction(() => {
    const got = run();
    refreshRaceCandidates(pool);
    // EM1: the call's transitions settle into `real_agents` — one `pool.state` at most.
    syncRealAgents(pool);
    persist(pool);
    return got;
  });
  return r;
}

export class Trunk {
  readonly pool: Pool;

  private constructor(pool: Pool) {
    this.pool = pool;
  }

  static create(
    sql: Sql,
    files: Record<string, string>,
    opts: PoolOptions & {
      pool_id?: string;
      summary_only?: boolean;
      synthetic?: boolean;
      remote?: string;
      request_id?: string;
    } = {},
  ): Trunk {
    return new Trunk(createPool(sql, files, opts));
  }

  static open(sql: Sql, opts: PoolOptions = {}): Trunk {
    return new Trunk(openPool(sql, opts));
  }

  /** IR2/IR3: the `pool_create` call for a `source` request — the store is born `rebuilding`. */
  static createImported(
    sql: Sql,
    opts: PoolOptions & {
      pool_id: string;
      summary_only?: boolean;
      remote?: string;
      source: string;
      request_id?: string;
      branch?: string;
    },
  ): Trunk {
    return new Trunk(createImportPool(sql, opts));
  }

  /** One import run's commit (IR3): fetched rows plus the cursor that continues the job. */
  importStep(payload: ImportPayload): Record<string, unknown> {
    return wrapCall(this.pool, () => applyImportStep(this.pool, payload));
  }

  /** Create an intent + attempt (the case's attempt ids are used verbatim). */
  openAttempt(id: string, args: OpenArgs): Attempt {
    return wrapCall(this.pool, () => openAttempt(this.pool, id, args));
  }

  createIntent(request: TrunkCreateIntentRequest): TrunkCreateIntentResponse {
    return wrapCall(this.pool, () => createIntent(this.pool, request));
  }

  raceCostDone(input: RaceCostDone): void {
    wrapCall(this.pool, () => raceCostDone(this.pool, input));
  }

  tool(req: ToolRequest): ToolResponse {
    return wrapCall(this.pool, () => tool(this.pool, req));
  }

  sync(req: { attempt_id: string; ack: number }): Record<string, unknown> {
    return wrapCall(this.pool, () => {
      const a = this.pool.attempts.get(req.attempt_id);
      if (a === undefined) return { ok: false, error: "attempt_unknown" };
      const pending = a.heads.filter((h) => h.hn > req.ack).map((h) => h.body);
      return {
        ok: true,
        heads_ups: pending.slice(0, 8),
        heads_ups_more: pending.length > 8,
        head_seq: this.pool.headSeq(),
        attempt: { state: a.state, go_arounds: a.go_arounds, pull_backs: a.pull_backs },
      };
    });
  }

  tick(): void {
    wrapCall(this.pool, () => tick(this.pool));
  }

  pushOk(): void {
    wrapCall(this.pool, () => pushOk(this.pool));
  }

  pushResult(remote_main: "old" | "new" | "other", remote_notes?: "old" | "new" | "other"): string {
    return wrapCall(this.pool, () => reconcile(this.pool, remote_main, remote_notes ?? remote_main));
  }

  /** PV1: materialize frozen preview snapshots off the landing path. */
  preview(): PreviewBuild {
    return wrapCall(this.pool, () => previewBuild(this.pool));
  }

  previewDone(input: PreviewDoneInput): Record<string, unknown> {
    return wrapCall(this.pool, () => previewDone(this.pool, input));
  }

  /** 11.7's `plain` timer: the next plain-merge commit spec, or `idle` when caught up. */
  plain(input: { parent_override?: string } = {}): PlainBuild {
    return wrapCall(this.pool, () => plainBuild(this.pool, input));
  }

  /** PM6's `plain_done`: the pushed commit is `main` of `<pool>-plain`; emits `plain.updated`. */
  plainDone(input: { commit: string; remote: string }): Record<string, unknown> {
    return wrapCall(this.pool, () => plainDone(this.pool, input));
  }

  restart(args: { remote_main: "old" | "new" | "other"; remote_notes?: "old" | "new" | "other" }): string {
    return wrapCall(this.pool, () => restart(this.pool, args));
  }

  /**
   * RW1: the `right_of_way` timer fired — lapse the grant when the attempt still holds the one
   * this row was armed for (a re-grant overwrote the row, so `due_at` is the grant's identity),
   * then wake the tick so whatever RW3 held back can go. RW1 names no event for the lapse
   * itself, so none is emitted; the landing it unblocks is the observable end.
   */
  expireRightOfWay(input: { attempt_id: string; due_at: number }): void {
    wrapCall(this.pool, () => {
      const a = this.pool.attempts.get(input.attempt_id);
      if (a === undefined || a.right_of_way_at === null) return;
      if (a.right_of_way_at + RIGHT_OF_WAY_MS !== input.due_at) return;
      clearRightOfWay(this.pool, a);
      tick(this.pool);
    });
  }

  triage(args: { attempt: string; kind: string; key: string; p?: number | null; asked_at_op?: number }): void {
    wrapCall(this.pool, () => {
      triage(this.pool, args);
      const attempt = this.pool.attempts.get(args.attempt);
      if (attempt?.race && attempt.state === "held") attempt.validated_at = null;
    });
  }

  owner(args: {
    action: string;
    attempt?: string;
    seq?: number;
    expect_reverted?: number[];
    reason?: string;
    new_attempt_model?: string;
  }): Record<string, unknown> {
    return wrapCall(this.pool, () => {
      if (args.action === "choose") {
        const attempt = this.pool.attempts.get(args.attempt ?? "");
        if (attempt === undefined || !canChooseRace(this.pool, attempt)) {
          return { ok: false, error: { code: "invalid_args", message: "race candidate is not ready" } };
        }
      }
      return owner(this.pool, args);
    });
  }

  undoPlan(seq: number): UndoPlanResponse {
    return undoPlan(this.pool, seq);
  }

  undo(request: OwnerUndoRequest): UndoResponse {
    return wrapCall(this.pool, () => confirmUndo(this.pool, request));
  }

  /** 13.6 `rebuild`: park the job cursor and arm the `rebuild` timer (idempotent, 9.8). */
  rebuild(requestId: string): Record<string, unknown> {
    return wrapCall(this.pool, () => armRebuild(this.pool, requestId));
  }

  /** 3.6 begin: the job's first commit — wipe, new epoch (RB5), `rebuilding`, first pool.state. */
  rebuildBegin(begin: {
    epoch: number;
    pool_id?: string;
    remote?: string;
    summary_only?: boolean;
    synthetic?: boolean;
    head_commit: string;
    notes_commit: string | null;
    green_commit: string | null;
  }): Record<string, unknown> {
    return wrapCall(this.pool, () => {
      if (begin.summary_only !== undefined) metaSet(this.pool.sql, "summary_only", begin.summary_only ? "1" : "0");
      if (begin.synthetic !== undefined) metaSet(this.pool.sql, "synthetic", begin.synthetic ? "1" : "0");
      const result = beginRebuild(this.pool, begin);
      if (result.ok === true) clearPreviews(this.pool);
      return result;
    });
  }

  /** One job run's commit (RB3): fetched rows plus the cursor that continues the job. */
  rebuildStep(payload: ApplyPayload): Record<string, unknown> {
    return wrapCall(this.pool, () => applyRebuildStep(this.pool, payload));
  }

  /** Step 8's `rebuild_lost` timer entry: missing agents are recorded `stopped`/`lost` (T20). */
  rebuildLost(): void {
    wrapCall(this.pool, () => registerDeadline(this.pool));
  }

  /** 4.12 `register`: an Agent's post-rebuild re-registration (3.6 steps 6-8, T17/T17a). */
  register(req: RegisterRequest): RegisterResponse {
    return wrapCall(this.pool, () => registerAttempt(this.pool, req));
  }

  /** TA9 `stop`: the Agent ends its own attempt. */
  stop(req: { attempt_id: string; reason: string }): Record<string, unknown> {
    return wrapCall(this.pool, () => {
      const a = this.pool.attempts.get(req.attempt_id);
      if (a === undefined) return { ok: false, error: "attempt_unknown" };
      if (a.state === "stopped")
        return {
          ok: true,
          stop_reason: a.stop_reason,
          attempt: { state: a.state, go_arounds: a.go_arounds, pull_backs: a.pull_backs },
        };
      if (a.state === "accepted" || a.state === "landed") return { ok: false, error: "attempt_closed" };
      closeCardLocal(this.pool, a, "stale");
      setStateLocal(this.pool, a, "stopped", "T20", req.reason);
      return {
        ok: true,
        stop_reason: req.reason,
        attempt: { state: a.state, go_arounds: a.go_arounds, pull_backs: a.pull_backs },
      };
    });
  }

  get out(): Pool["out"] {
    return this.pool.out;
  }

  state(id: string): Attempt["state"] | undefined {
    return this.pool.attempts.get(id)?.state;
  }
}

// Local indirection to keep this file's import list short.
import { closeCard as closeCardLocal, setState as setStateLocal } from "./intents.ts";

export type { Pool, Attempt, Landing, Judgment, Premise, PendingTriage, Op };
