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
import { ScriptedTriage } from "../../swarm/scripted-triage.ts";
import { FEATURES } from "../../config/features.ts";
import { PUSH_BACKOFF_BASE_MS } from "../../protocol/constants.ts";

/** How long one Floor delivery may run before another may start beside it (#deliverEvents). */
const EVENTS_STALE_MS = 10_000;
import type { Sql } from "../../protocol/ports.ts";
import type { Env } from "../env.ts";
import { notBuilt } from "../not-built.ts";
import { deliverEvents, recordTrunkError, runEffects, type EffectRef } from "./after-commit.ts";
import { cardAction } from "./card-action.ts";
import { deliverHeadsUps, outboxRow, pushOutbox, reconcileOnStart } from "./push.ts";
import { armAlarm, runAlarm } from "./alarm.ts";
import { deliverResumes } from "./resume.ts";
import { applyShellSchema, metaAll, metaGet, metaSet, pendingEvents, sqlOf, timerList, timerPut } from "./sql.ts";
import { runRebuildJob } from "./rebuild-job.ts";
import { runImportJob } from "./import-job.ts";
import { runPlainJob } from "./plain-runner.ts";
import { runGreenJob } from "./wiring/green.ts";
import { runPreviewJob } from "./preview-runner.ts";
import { runRaceCostJob } from "./race-cost-runner.ts";
import { attemptCheckpointView, recordAttemptRepository } from "./attempt-repo.ts";
import { poolRepoName } from "../repos.ts";
import {
  clefRiskOf,
  clefRiskOn,
  clefTriageOf,
  clefTriageOn,
  hasAsks,
  hasRisk,
  runRisk,
  runTriage,
} from "./triage-runner.ts";
import { initParsers, parse as parseSyntax } from "../parsers/tree-sitter.ts";
import { setSyntaxParser } from "../../core/entities/syntax.ts";
import { selftestCandidate, type SelftestVerdict } from "../../core/trunk/selftest.ts";
import type { IsolateLoader } from "../adapters/verifier/isolate.ts";
import { isolateSelftestRun, SubmitSelftest } from "./selftest-submit.ts";

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
export type EntryResult = { response?: unknown; status?: number; effects?: EffectRef[] };

const BAD_JSON = Symbol("bad_json");

/** How many times one request runs the after-commit pipeline before the `push` timer takes over.
 * One landing needs two passes (the push, then the events of `push_ok`); the bound only keeps a
 * long outbox from holding one request open. */
const POST_COMMIT_PASSES = 4;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * The prompt context the open-attempt answer carries for an imported pool (06-repos IR9 to
 * IR11): the guide file the import found in the head tree ("" for none), the repository's
 * `<owner>/<name>` and the branch it was imported from. Null for a seed pool (`app` is not
 * the imported marker), whose prompt stays the tide pool's.
 */
function importedPrompt(sql: Sql): { guide_path: string; source: string; branch: string } | null {
  if (metaGet(sql, "app") !== "") return null;
  const source = metaGet(sql, "source");
  if (source === null || source === "") return null;
  return {
    guide_path: metaGet(sql, "guide_path") ?? "",
    source,
    branch: metaGet(sql, "branch") ?? "",
  };
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

/** `input` of `pool_create` — forwarded by `POST /api/pools` (PL1/IR1): either `seed` with the
 * seed's whole tree, or `source` with the imported repository's address (IR2/IR3). */
type CreatePoolInput = {
  pool: string;
  summary_only: boolean;
  request_id: string;
  remote: string;
  seed?: string;
  /** When absent and `source` is too, the object reads the named seed through ASSETS (PL1). */
  files?: Record<string, string>;
  /** IR1: the imported repository — `url`/`branch` as validated by the route. */
  source?: { url: string; branch?: string };
};

function asCreatePoolInput(input: unknown): CreatePoolInput | null {
  if (typeof input !== "object" || input === null) return null;
  const body = input as Partial<CreatePoolInput>;
  if (
    typeof body.pool !== "string" ||
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
  // IR1: exactly one of `seed`, `source` — the route validates `source`'s shape; here presence is
  // all the object re-checks.
  const seeded = body.seed !== undefined;
  const imported = body.source !== undefined;
  if (seeded === imported) return null;
  if (seeded && typeof body.seed !== "string") return null;
  if (imported) {
    const source = body.source as { url?: unknown; branch?: unknown };
    if (typeof source.url !== "string" || (source.branch !== undefined && typeof source.branch !== "string")) {
      return null;
    }
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

/** The entries a `pool_id`-less store may run — the rebuild job's arm and applies (3.6). */
const REBUILD_ENTRIES = new Set(["rebuild", "rebuild_begin", "rebuild_step", "rebuild_lost"]);

export class Trunk extends DurableObject<Env> {
  readonly #sql: ReturnType<typeof sqlOf>;
  readonly #engine: EngineTable;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = sqlOf(ctx);
    applyShellSchema(this.#sql);
    this.#engine = engineTable();
    // LG4: Python and Go parse through tree-sitter, which loads asynchronously; the engine is
    // synchronous. Every engine entry runs inside this object, so no event reaches it before the
    // parsers are installed. A failed load throws here and resets the object.
    void ctx.blockConcurrencyWhile(async () => {
      await initParsers();
      setSyntaxParser(parseSyntax);
    });
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
      if (create.source !== undefined) {
        // IR2/IR3: the route already ran the binding's `import` — the repository is filled and
        // the remote is the clone address without credentials. The store is born `rebuilding`
        // with reason `import` (event 1, IR3) and the `rebuild` timer runs the ingestion.
        const url = new URL(create.source.url);
        const repo = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
        TrunkEngine.createImported(ctx.sql, {
          pool_id: create.pool,
          summary_only: create.summary_only,
          remote: create.remote,
          source: repo,
          request_id: create.request_id,
          branch: create.source.branch,
          syncTriage: ScriptedTriage,
          features: FEATURES,
          now: () => ctx.now,
        });
        return { response: { ok: true, pool: create.pool } };
      }
      const files = create.files ?? (await seedFiles(ctx.env, create.seed!));
      if (files === null) return { response: { error: { code: "seed_unavailable" } }, status: 502 };
      if (files === undefined) return { response: { error: { code: "invalid_args" } }, status: 400 };
      TrunkEngine.create(ctx.sql, files, {
        pool_id: create.pool,
        summary_only: create.summary_only,
        remote: create.remote,
        request_id: create.request_id,
        syncTriage: ScriptedTriage,
        features: FEATURES,
        now: () => ctx.now,
      });
      return { response: { ok: true, pool: create.pool } };
    },

    /**
     * The fake engine entry of the SY2 acceptance: commits `probe:<marker>` inside its transaction
     * and leaves a `_remote_probe` effect, whose handler posts to `args.url` — the fake remote's
     * request log is the proof the request left the object after the commit.
     */
    /**
     * The card route's entry (13.6, CD4): the owner's tap on a card — `land`, `decline`,
     * `retry`, `choose` — checked against the stored card row, then run through the engine's
     * `owner` entry (T13, T14, T21). Implemented in card-action.ts.
     */
    card_action: (input, ctx) => cardAction(input, ctx),

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
  #ensureReconciled(forPath?: string): void {
    if (this.#reconciled) return;
    this.#reconciled = true;
    // 3.6: an empty store on an object whose Artifacts repository exists is a lost pool —
    // arm the rebuild job and let the `rebuild` timer run it. A name no repository answers
    // is not a pool: nothing is armed (and no `trunk.error` may precede `pool.state`, EM1).
    // The pool's own birth (`/internal/create-pool`) is the one caller the probe skips — its
    // `seedFiles` await is exactly the gap in which a probe would arm a rebuild on the pool
    // being created.
    if (metaGet(this.#sql, "pool_id") === null) {
      if (forPath !== "/internal/create-pool") {
        void this.#probeEmptyPool().catch(() => recordTrunkError(this.ctx, "rebuild", "transport"));
      }
      return;
    }
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
    if (pathname === "/internal/open-intent") return "open_intent";
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
  async #callEngineEntry(
    name: string,
    input: unknown,
    now?: number,
    selftest?: SelftestVerdict | null,
  ): Promise<{ result: unknown } | { error: Response }> {
    const entry = this.#engine.entries.get(name);
    if (entry === undefined) return { error: notBuilt() };
    // The rebuild entries are the wiped pool's way back (3.6): they run before `pool_id`
    // exists — `rebuild` arms the cursor, `rebuild_begin` writes it. Every other entry serves
    // a pool that is there.
    if (metaGet(this.#sql, "pool_id") === null && !REBUILD_ENTRIES.has(name)) {
      return { error: json({ error: { code: "pool_not_found" } }, 404) };
    }
    try {
      // S6a: the engine cannot import `src/swarm`, so the object hands it the scripted triage
      // of synthetic attempts (TR8). Real attempts never use it.
      // A driven `now` (the alarm's `?now=` hook) is the engine clock for the call, so a test
      // drives time-dependent rules — RW1's lapse — without sleeping (LP5a's convention).
      const result = this.#sql.run(name, { ...this.#engineOptions(now), selftest }, (trunk) => entry(input, trunk));
      this.#deliverEvents();
      return { result };
    } catch {
      recordTrunkError(this.ctx, `entry:${name}`, "engine_error");
      return { error: json({ error: { code: "internal_error" } }, 500) };
    }
  }

  /** The options of every engine call: the clock, scripted triage, the build's features, the switches. */
  #engineOptions(now?: number) {
    return { now: () => now ?? Date.now(), syncTriage: ScriptedTriage, features: FEATURES, switches: this.#switches() };
  }

  /** CK6c's runs of this object (selftest-submit.ts): made on the first submit that needs one. */
  #submitSelftest: SubmitSelftest | null = null;

  /**
   * CK6c: before the `tool` entry serves a `submit` under features.green "full", the pool's
   * self-test runs on the tree the submit would land, and the verdict rides the engine call. No
   * `LOADER` binding, the variable `SUBMIT_SELFTEST` "off", no candidate (selftest.ts), or any
   * failure here gives no verdict: the engine then records the check as skipped and the submit
   * proceeds.
   */
  async #selftestVerdict(input: unknown): Promise<SelftestVerdict | null> {
    if (FEATURES.green !== "full" || (input as { tool?: unknown } | null)?.tool !== "submit") return null;
    // The binding of wrangler.jsonc (absent in a deployment without it) and the optional switch
    // (absent means on): read through their own types, as the green line reads `LOADER`.
    const env = this.env as unknown as { LOADER?: IsolateLoader; SUBMIT_SELFTEST?: string };
    const loader = env.LOADER;
    if (loader === undefined || env.SUBMIT_SELFTEST === "off" || metaGet(this.#sql, "pool_id") === null) return null;
    try {
      const candidate = this.#sql.run("selftest_candidate", this.#engineOptions(), (trunk) =>
        selftestCandidate(trunk.pool, input),
      );
      if (candidate === null) return null;
      this.#submitSelftest ??= new SubmitSelftest(isolateSelftestRun(loader));
      return await this.#submitSelftest.verdict(candidate);
    } catch (cause) {
      console.error("submit selftest failed", cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown");
      return null;
    }
  }

  /** Hand committed rows to the Floor immediately (EV3), without making the push await
   * confirmation (9.4 step 6). Every delivery retains EV2's epoch and gap checks. Independent
   * sends are intentional: a held confirmation must not hold a newer entry's events. */
  #eventsRun: Promise<void> | null = null;
  #eventsAgain = false;
  #eventsEpoch = "";
  #eventsStarted = 0;
  #eventsToken: object | null = null;

  /**
   * EV2/EV3: one delivery to the Floor at a time. A request calls this up to three times and every
   * call used to start its own delivery of every pending row, so under load the Floor received the
   * same rows many times over and Trunk's requests queued behind it (the final soak on `test`,
   * 2026-10-11: agent `sync` calls waited 9 to 27 s). A call while a delivery runs asks for one
   * more round when it ends, so no committed event waits for a later request.
   */
  #deliverEvents(): void {
    this.#eventsAgain = true;
    // A run that hangs (a Floor that never answers) or that a rebuild left on an older epoch (RB5)
    // must not hold back the new epoch's events: after EVENTS_STALE_MS, or on a new epoch, a fresh
    // run starts beside it. The old run's rows are confirmed by epoch, so it cannot undo the new one.
    const epoch = metaGet(this.#sql, "epoch") ?? "1";
    if (this.#eventsRun !== null && epoch === this.#eventsEpoch && Date.now() - this.#eventsStarted < EVENTS_STALE_MS) {
      return;
    }
    this.#eventsEpoch = epoch;
    this.#eventsStarted = Date.now();
    const token = {};
    this.#eventsToken = token;
    const run = (async () => {
      try {
        while (this.#eventsAgain) {
          this.#eventsAgain = false;
          try {
            await deliverEvents(this.env, this.ctx);
          } catch {
            recordTrunkError(this.ctx, "events", "transport");
          }
        }
        // An asynchronous delivery can install a retry after its request/alarm already ended.
        await this.#arm();
      } catch {
        recordTrunkError(this.ctx, "events", "alarm_failed");
      } finally {
        if (this.#eventsToken === token) this.#eventsRun = null;
      }
    })();
    this.#eventsRun = run;
    this.ctx.waitUntil(run);
  }

  /**
   * Dispatch events independently before the push (EV2, EV3, 9.4 step 6). The existing
   * push/heads-up pipeline continues here; its failures leave `trunk.error` and retry timers.
   *
   * A push whose answer was applied (`push_ok`, `push_result`) leaves new work: its events, and
   * perhaps the next batch. The pipeline therefore runs again after it — as a loop with a bound,
   * never from inside the push. A pass that started inside the push's own `apply` would push the
   * same batch again before its retry was scheduled, and would never return.
   */
  async #postCommit(): Promise<void> {
    for (let pass = 0; pass < POST_COMMIT_PASSES; pass += 1) {
      this.#deliverEvents();
      // Resume cause is durable in meta; confirmation may already have removed the event.
      // Each resume failure dispatches its own committed events before the next Agent call.
      try {
        await deliverResumes(this.env, this.ctx, undefined, () => this.#deliverEvents());
      } catch {
        recordTrunkError(this.ctx, "resume", "transport");
      }
      const applied = await this.#pushOnce();
      try {
        await deliverHeadsUps(this.env, this.ctx);
      } catch {
        recordTrunkError(this.ctx, "heads_up", "transport");
      }
      this.#deliverEvents();
      // TR2: Clef is asked only now, after the commit, and nothing here waits for its answer.
      this.#kickTriage();
      if (!applied) return;
    }
    // The bound was reached with work still to do: the `push` timer continues it (AL1).
    this.#sql.transaction(() => timerPut(this.#sql, "push", "", Date.now()));
  }

  /** S6a/TR10: the `CLEF_TRIAGE` switch the engine sees — on only with `features.clef` and the
   * environment's variable `on`; otherwise a real attempt's triage is `OffTriage` (TR5). */
  #switches(): { CLEF_TRIAGE: "on" | "off"; CLEF_RISK: "on" | "off" } {
    return {
      CLEF_TRIAGE: clefTriageOn(this.env) ? "on" : "off",
      CLEF_RISK: clefRiskOn(this.env) ? "on" : "off",
    };
  }

  #triageStarted = false;
  #triageBusy = false;
  #triageAgain = false;

  /**
   * TR10's runner, off the request path: one loop at a time sends the unsent questions and applies
   * the answers, then runs the after-commit pipeline for the heads-ups they create. The first run
   * of an instance re-asks what an earlier instance sent (TR6: no request of it is in flight).
   */
  #kickTriage(): void {
    if (this.#triageBusy) {
      this.#triageAgain = true;
      return;
    }
    const restart = !this.#triageStarted && (hasAsks(this.#sql, "sent") || hasRisk(this.#sql, "sent"));
    if (!restart && !hasAsks(this.#sql, "unsent") && !hasRisk(this.#sql, "unsent")) return;
    this.#triageBusy = true;
    const run = (async () => {
      try {
        do {
          this.#triageAgain = false;
          if (!this.#triageStarted) {
            this.#triageStarted = true;
            if (hasAsks(this.#sql, "sent")) await this.#applyEntry("triage_restart", {});
            if (hasRisk(this.#sql, "sent")) await this.#applyEntry("risk_deadline", { restart: true });
          }
          const apply = (name: string, input: unknown) => this.#applyEntry(name, input);
          const [asked, risked] = await Promise.all([
            hasAsks(this.#sql, "unsent") ? runTriage({ apply, triage: clefTriageOf(this.env, this.#pool) }) : 0,
            hasRisk(this.#sql, "unsent")
              ? runRisk({ apply, judge: (attempt) => clefRiskOf(this.env, this.#pool, attempt) })
              : 0,
          ]);
          const sent = asked + risked;
          // The answers' heads-ups and events; a question it creates queues one more pass.
          if (sent > 0) await this.#postCommit();
        } while (this.#triageAgain);
      } catch {
        recordTrunkError(this.ctx, "triage", "transport");
      } finally {
        this.#triageBusy = false;
      }
    })();
    this.ctx.waitUntil(run);
  }

  #greenRun: Promise<void> | null = null;
  #greenAgain = false;

  /**
   * GR1: the green line never blocks a landing. Its run - a static verification of the whole
   * tree, then a ref push - takes seconds and grows with the pool, so it runs beside the alarm,
   * not inside it: the alarm goes on to `tick` and `push`. Awaited inline, it held every landing
   * for up to 50 s in the final soak on `test` (2026-10-11). One run at a time; a timer that fires
   * meanwhile asks for one more pass when the run ends. A throw leaves `trunk.error` and puts the
   * timer back at the push backoff, as the alarm's own catch did (AL2).
   */
  #startGreen(now: number): void {
    this.#greenAgain = true;
    if (this.#greenRun !== null) return;
    const run = (async () => {
      try {
        let at = now;
        while (this.#greenAgain) {
          this.#greenAgain = false;
          await runGreenJob(
            this.env,
            this.ctx,
            async (name, input) => {
              const r = await this.#callEngineEntry(name, input, at);
              if ("error" in r) throw new Error(`green apply ${name} failed`);
              return r.result;
            },
            undefined,
            at,
          );
          await this.#postCommit();
          at = Date.now();
        }
      } catch (cause) {
        console.error("trunk green run failed", cause instanceof Error ? cause.message.slice(0, 300) : "unknown");
        this.#sql.transaction(() =>
          this.#sql.exec(
            "INSERT OR IGNORE INTO timers (kind, key, due_at) VALUES ('green', '', ?)",
            Date.now() + PUSH_BACKOFF_BASE_MS,
          ),
        );
        recordTrunkError(this.ctx, "timer:green", "timer_failed");
      } finally {
        this.#greenRun = null;
        await this.#arm();
      }
    })();
    this.#greenRun = run;
    this.ctx.waitUntil(run);
  }

  /** An engine entry whose failure is a throw (the runner's and the triage timer's calls). */
  async #applyEntry(name: string, input: unknown, now?: number): Promise<unknown> {
    const r = await this.#callEngineEntry(name, input, now);
    if ("error" in r) throw new Error(`${name} failed`);
    return r.result;
  }

  /** One `pushOutbox`. True when the push's answer was applied to the engine, which is when the
   * pipeline has new work. */
  async #pushOnce(now?: number): Promise<boolean> {
    // A push timer may precede the events retry after a Floor outage. Dispatch the durable
    // rows on this path too, before the first network await of the push.
    this.#deliverEvents();
    let applied = false;
    try {
      await pushOutbox(
        this.env,
        this.ctx,
        async (name, input) => {
          const r = await this.#callEngineEntry(name, input);
          if ("error" in r) throw new Error(`push apply ${name} failed`);
          applied = true;
          return r.result;
        },
        undefined,
        now,
      );
    } catch {
      recordTrunkError(this.ctx, "push", "transport");
    }
    this.#deliverEvents(); // Includes shell-generated push.retry and transport errors.
    return applied;
  }

  /** Entry calls answered since the object started — the app-server acceptance's proof that no
   * `/pool/` request reaches Trunk (AS16): its reads are Floor reads. In-memory on purpose. */
  readonly #served = new Map<string, number>();

  /** One entry's request path: run it, run its returned effects, then the after-commit pipeline. */
  async #runEntry(name: string, input: unknown, path: string, query: URLSearchParams): Promise<Response> {
    this.#served.set(name, (this.#served.get(name) ?? 0) + 1);
    if (this.#engine.entries.has(name)) {
      const selftest = name === "tool" ? await this.#selftestVerdict(input) : null;
      const r = await this.#callEngineEntry(name, input, undefined, selftest);
      if ("error" in r) return r.error;
      const { response: raw, status, effects } = normalizeResult(r.result);
      // IR9 to IR11: an imported pool's prompt context rides the open-attempt answer, so the
      // intents route hands it to the Agent's open. A seed pool's answer is unchanged.
      const imported = name === "open_attempt" || name === "open_intent" ? importedPrompt(this.#sql) : null;
      const response =
        imported !== null && typeof raw === "object" && raw !== null && (raw as { ok?: unknown }).ok === true
          ? { ...(raw as Record<string, unknown>), imported }
          : raw;
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
    this.#deliverEvents();
    const { response, status, effects } = normalizeResult(result);
    await runEffects(this.env, this.ctx, effects);
    await this.#postCommit();
    return json(response, status);
  }

  /**
   * The wipe probe of `#ensureReconciled`: `info()` answers the repository exists, so the
   * pool's landing history survives and this object rebuilds from it (3.6). The arm is the
   * `rebuild` entry itself — same cursor, same timer, same idempotency as the route's.
   */
  async #probeEmptyPool(): Promise<void> {
    if (metaGet(this.#sql, "pool_id") !== null) return;
    // A deployment with no Artifacts binding cannot rebuild — there is nothing to mark either:
    // the store stays empty exactly as before the probe existed.
    if (this.env.POOLS === undefined) return;
    try {
      const repo = await this.env.POOLS.get(poolRepoName(this.#pool));
      await repo.info(); // throws NOT_FOUND when no such repository exists
    } catch (error) {
      // No repository behind the name is the ordinary "not a pool" answer — nothing armed, and
      // no `trunk.error` precedes a later `pool.state` (EM1). The binding reports it as a `code`
      // of NOT_FOUND; a service-bound fake can only pass the message. Any other failure is a
      // transport fault: the wipe is real, so it is marked and the next object start retries.
      const code = (error as { code?: unknown })?.code;
      const message = String((error as { message?: unknown })?.message ?? error);
      if (code === "NOT_FOUND" || message.startsWith("NOT_FOUND")) return;
      recordTrunkError(this.ctx, "rebuild", "transport");
      return;
    }
    if (metaGet(this.#sql, "pool_id") !== null) return; // created meanwhile
    const r = await this.#callEngineEntry("rebuild", { request_id: `auto:${crypto.randomUUID()}` });
    if (!("error" in r)) await this.#postCommit();
  }

  /**
   * SWR3: the held scripted attempts of each pattern, kept with the pool so that a release finds
   * them from any Worker isolate. The Swarm route records a held launch here and reads the list
   * back on `release`; its own memory does not outlive the isolate that launched the agents.
   * `POST /internal/swarm-hold` `{ pattern, attempt_id }` adds one; `GET /internal/swarm-held?pattern=`
   * answers `{ attempts }`. The rows live in `meta` under `swarm_hold:<pattern>`.
   */
  async #swarmHold(request: Request, url: URL): Promise<Response> {
    if (url.pathname === "/internal/swarm-held") {
      const raw = metaGet(this.#sql, `swarm_hold:${url.searchParams.get("pattern") ?? ""}`);
      return json({ attempts: raw === null ? [] : (JSON.parse(raw) as string[]) });
    }
    if (request.method !== "POST") return json({ error: { code: "invalid_args" } }, 400);
    let body: { pattern?: unknown; attempt_id?: unknown };
    try {
      body = (await request.json()) as { pattern?: unknown; attempt_id?: unknown };
    } catch {
      return json({ error: { code: "bad_json" } }, 400);
    }
    const { pattern, attempt_id } = body;
    if (typeof pattern !== "string" || pattern === "" || typeof attempt_id !== "string" || attempt_id === "") {
      return json({ error: { code: "invalid_args" } }, 400);
    }
    this.#sql.transaction(() => {
      const key = `swarm_hold:${pattern}`;
      const ids = JSON.parse(metaGet(this.#sql, key) ?? "[]") as string[];
      if (!ids.includes(attempt_id)) metaSet(this.#sql, key, JSON.stringify([...ids, attempt_id]));
    });
    return json({ ok: true });
  }

  /** SWR1: the instance id of the pool's current Swarm run, kept in `meta` under `swarm_run`.
   * `GET /internal/swarm-run` answers `{ id }` (null before any run); `POST` `{ id }` records it. */
  async #swarmRun(request: Request): Promise<Response> {
    if (request.method === "GET") return json({ id: metaGet(this.#sql, "swarm_run") });
    if (request.method !== "POST") return json({ error: { code: "invalid_args" } }, 400);
    let body: { id?: unknown };
    try {
      body = (await request.json()) as { id?: unknown };
    } catch {
      return json({ error: { code: "bad_json" } }, 400);
    }
    if (typeof body.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(body.id)) {
      return json({ error: { code: "invalid_args" } }, 400);
    }
    metaSet(this.#sql, "swarm_run", body.id);
    return json({ ok: true });
  }

  /** A timer's engine entry: false when unregistered; entry errors propagate so the alarm can
   * re-schedule with backoff (AL2). The after-commit pipeline runs on success. */
  async #runTimerEntry(kind: string, input: unknown, now?: number): Promise<boolean> {
    if (!this.#engine.entries.has(kind)) return false;
    const r = await this.#callEngineEntry(kind, input, now);
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
      // The engine's `outbox` table exists only once `pool_create` ran (shell objects can be
      // named anything — a state read must not 500 before the pool exists).
      outbox: metaGet(this.#sql, "pool_id") === null ? null : outboxRow(this.ctx),
      // The landings table (3.6's rebuilt rows are asserted through it: seq, commit and the
      // note blob oid the job read off the remote's notes tree).
      landings:
        metaGet(this.#sql, "pool_id") === null
          ? []
          : this.#sql.exec("SELECT seq, kind, commit_oid, note_oid, undone_by FROM landings ORDER BY seq").toArray(),
      served: Object.fromEntries(this.#served),
      engine_session: this.#sql.metrics(),
    });
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      this.#ensureReconciled(url.pathname);
      const pathname = url.pathname;
      if (pathname === "/internal/state" && request.method === "GET") return this.#state();
      if (pathname === "/internal/alarm") {
        // `?now=` lets a test drive the retry schedule through the alarm path without sleeping
        // for the real backoff (LP5a): the due-check alone reads it; scheduling stays real-time.
        const now = url.searchParams.get("now");
        const at = now === null ? undefined : Number(now);
        await this.#runAlarm(at !== undefined && Number.isFinite(at) ? at : undefined);
        // The test path waits for a green run and an event delivery the alarm started, so a test
        // sees their results.
        await this.#greenRun;
        await this.#eventsRun;
        return json({ ok: true });
      }
      if (pathname === "/internal/swarm-hold" || pathname === "/internal/swarm-held") {
        return await this.#swarmHold(request, url);
      }
      if (pathname === "/internal/swarm-run") return await this.#swarmRun(request);
      const input = await this.#readInput(request, url);
      if (input === BAD_JSON) return json({ error: { code: "bad_json" } }, 400);
      if (pathname === "/internal/attempt-repo" || pathname === "/internal/attempt-checkpoint") {
        if (!FEATURES.attempt_repos) return notBuilt();
        if (metaGet(this.#sql, "pool_id") === null) return json({ ok: false, error: "pool_not_found" }, 404);
        if (pathname === "/internal/attempt-repo") return recordAttemptRepository(this.#sql, input);
        const attemptId = (input as { attempt_id?: unknown } | null)?.attempt_id;
        if (typeof attemptId !== "string") return json({ ok: false, error: "invalid_args" }, 400);
        const snapshot = this.#sql.run("attempt_checkpoint", { features: FEATURES }, (trunk) =>
          attemptCheckpointView(trunk.pool, attemptId),
        );
        return snapshot === null ? json({ ok: false, error: "attempt_unknown" }, 404) : json(snapshot);
      }
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
      runEntry: (kind, input) => this.#runTimerEntry(kind, input, now),
      push: async (now) => {
        if (await this.#pushOnce(now)) await this.#postCommit();
      },
      repush: async () => {
        try {
          await deliverHeadsUps(this.env, this.ctx);
        } catch {
          recordTrunkError(this.ctx, "heads_up", "transport");
        }
      },
      // A throw means the store itself failed: the alarm's own catch re-arms the row at a
      // backoff (AL2). The transport answers are handled inside `deliverResumes`.
      resume: (now) => deliverResumes(this.env, this.ctx, now, () => this.#deliverEvents()),
      rebuild: async (now) => {
        // IR3: the import job shares the `rebuild` timer and the `rebuild_cursor` row — the
        // cursor's `job` field decides which runner takes this due row (the claim rule already
        // ran in the alarm).
        const raw = metaGet(this.#sql, "rebuild_cursor");
        let isImport = false;
        try {
          isImport = raw !== null && (JSON.parse(raw) as { job?: unknown }).job === "import";
        } catch {
          isImport = false;
        }
        const apply = async (name: string, input: unknown) => {
          const r = await this.#callEngineEntry(name, input, now);
          if ("error" in r) throw new Error(`${name} failed`);
          return r.result;
        };
        if (isImport) await runImportJob(this.env, this.ctx, apply, undefined);
        else await runRebuildJob(this.env, this.ctx, apply, undefined, now);
        await this.#postCommit();
      },
      // PM7: a plain run's failure is swallowed by the job itself or re-armed by the alarm's
      // catch — it never throws into the landing path, and the pool never pauses for it.
      plain: async (now) => {
        await runPlainJob(
          this.env,
          this.ctx,
          async (name, input) => {
            const r = await this.#callEngineEntry(name, input, now);
            if ("error" in r) throw new Error(`plain apply ${name} failed`);
            return r.result;
          },
          undefined,
          now,
        );
        await this.#postCommit();
      },
      // GR1: a verification never blocks a landing — its failures leave `trunk.error` and a
      // retry inside the job, and a throw is re-armed by the alarm's catch (AL2).
      green: async (now) => this.#startGreen(now),
      // TR6: the `triage` timer closes every question past its deadline, then sends what waits.
      triage: async (now) => {
        // TR6 on start-up: an instance woken by this timer re-asks what an earlier one sent
        // before any deadline decides it.
        if (!this.#triageStarted && hasAsks(this.#sql, "sent")) {
          this.#triageStarted = true;
          await this.#applyEntry("triage_restart", {}, now);
        }
        await this.#applyEntry("triage_deadline", {}, now);
        await this.#postCommit();
      },
      // RK3: the `risk` timer — a held card's risk answers past their deadline are unavailable.
      risk: async (now) => {
        await this.#applyEntry("risk_deadline", {}, now);
        await this.#postCommit();
      },
      raceCost: async (now) => {
        await runRaceCostJob(this.env, this.ctx, async (input) => {
          const r = await this.#callEngineEntry("race_cost_done", input, now);
          if ("error" in r) throw new Error("race cost apply failed");
        });
        await this.#postCommit();
      },
      preview: async (now) => {
        await runPreviewJob(this.env, this.ctx, async (name, input) => {
          const trunk = TrunkEngine.open(this.#sql, {
            now: () => now,
            syncTriage: ScriptedTriage,
            features: FEATURES,
            switches: this.#switches(),
          });
          const result = name === "preview" ? trunk.preview() : trunk.previewDone(input);
          this.#deliverEvents();
          return result;
        });
        await this.#postCommit();
      },
    }).finally(() => this.#deliverEvents());
  }

  #arm(): Promise<void> {
    return armAlarm(this.ctx, this.#sql);
  }
}
