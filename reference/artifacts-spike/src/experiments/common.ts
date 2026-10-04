/**
 * Shared types and helpers for the experiments.
 *
 * No Cloudflare imports: the Artifacts binding, the Workers AI binding and the
 * state store arrive as plain objects, so local tests can run the same code
 * against a fake binding and a real local git server.
 */
import {
  AUTHOR,
  authHeader,
  commitFiles,
  initRepo,
  newLocalRepo,
  pushRef,
  rawDiscover,
  type AuthStyle,
  type GitService,
  type GitTarget,
  type LocalRepo,
  type PushOptions,
  type PushOutcome,
} from "../gitops";
import {
  makeCommit,
  makeTreeFromFiles,
  type GitObject,
} from "../rawgit";
import {
  Recorder,
  describeToken,
  errInfo,
  errText,
  isInProgress,
  isNotFound,
  randomSuffix,
  sleep,
} from "../recorder";

/** The part of the Workers AI binding that e9 uses. */
export interface AiLike {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/** Durable state shared between experiments (backed by Durable Object storage). */
export interface StateStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
}

export interface RepoState {
  name: string;
  remote: string;
  branch: string;
  /** Token returned by create(). Kept so later experiments can use it as a control. */
  token: string;
  head: string | null;
}

/**
 * The 60-second token of an e2 outside control. It stays in the Durable Object's memory
 * (never in storage) so that e2 can probe the same token again from inside, after the
 * operator's machine has probed it from outside. It is dropped on that second probe.
 */
export interface OutsideControlState {
  token: string;
  remote: string;
  service: GitService;
  scope: "read" | "write";
  /** Date.now() right after createToken() returned. */
  mintedAtMs: number;
  /** ISO time at which the token expires, as createToken() reported it. */
  expiresAt: string;
  /** Body of the POST probe (pkt-lines, ASCII). */
  postBody: string;
}

/** In-memory state that lives as long as the Durable Object instance. */
export interface WarmState {
  e7?: { repo: CreatedRepo; style: AuthStyle; local: LocalRepo; commits: number };
  e2OutsideControl?: OutsideControlState;
}

export interface Deps {
  artifacts: Artifacts;
  ai: AiLike;
  store: StateStore;
  warm: WarmState;
  /** Context copied into every result (colo, Durable Object instance age, ...). */
  meta: Record<string, unknown>;
}

export type Body = Record<string, unknown>;
export type Experiment = (deps: Deps, body: Body, rec: Recorder) => Promise<boolean>;

export interface CreatedRepo {
  name: string;
  remote: string;
  branch: string;
  token: string;
}

export const REPO_PREFIX = "spike-";

export function repoName(tag: string): string {
  return `${REPO_PREFIX}${tag}-${randomSuffix()}`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function target(repo: CreatedRepo, style: AuthStyle): GitTarget {
  return { url: repo.remote, token: repo.token, style };
}

export function disposeQuietly(value: unknown): void {
  try {
    (value as Partial<Disposable> | null | undefined)?.[Symbol.dispose]?.();
  } catch {
    // Disposal is best effort: the value may be a plain object.
  }
}

/**
 * Run `fn` with a repo handle and release the RPC stub afterwards.
 * Same effect as `using repo = await artifacts.get(name)`, written as
 * try/finally so that a handle without Symbol.dispose cannot break a run.
 */
export async function withRepo<T>(artifacts: Artifacts, name: string, fn: (repo: ArtifactsRepo) => Promise<T>): Promise<T> {
  const repo = await artifacts.get(name);
  try {
    return await fn(repo);
  } finally {
    disposeQuietly(repo);
  }
}

/**
 * Delay before the next readiness poll.
 *
 * The delay is at most 10% of the time already waited (never under `floor`, never over
 * 500 ms), so a measured "ready after N ms" overstates the true time by at most
 * max(floor, 10% of N). `concurrency` is the number of repos polled at the same time:
 * the floor grows with it (5 ms per repo, 50 ms minimum) so that 50 parallel waits stay
 * under the documented 2,000 control-plane requests per 10 seconds per namespace.
 */
export function pollDelayMs(elapsedMs: number, concurrency = 1): number {
  const floor = Math.max(50, 5 * concurrency);
  return Math.min(Math.max(500, floor), Math.max(floor, Math.round(elapsedMs * 0.1)));
}

export interface ReadyOutcome {
  info: ArtifactsRepoInfo;
  attempts: number;
  /** Milliseconds from the first poll until a poll succeeded (upper bound of the time to ready). */
  ms: number;
  /**
   * Milliseconds from the first poll until the start of the last poll that found the repo
   * NOT ready (lower bound of the time to ready). Null when the first poll succeeded.
   */
  notReadyAtMs: number | null;
  retriedOn: string[];
}

/**
 * Poll get() + info() until the repo stops reporting *_IN_PROGRESS.
 * The true time to ready lies between `notReadyAtMs` and `ms`.
 */
export async function waitReady(rec: Recorder, artifacts: Artifacts, name: string, label: string, maxMs = 120_000, concurrency = 1): Promise<ReadyOutcome> {
  const started = Date.now();
  const retriedOn: string[] = [];
  let attempts = 0;
  let notReadyAtMs: number | null = null;
  for (;;) {
    rec.checkpoint();
    attempts++;
    const pollStartedMs = Date.now() - started;
    try {
      const info = await withRepo(artifacts, name, (repo) => repo.info());
      const plain: ArtifactsRepoInfo = {
        id: info.id,
        name: info.name,
        description: info.description,
        defaultBranch: info.defaultBranch,
        createdAt: info.createdAt,
        updatedAt: info.updatedAt,
        lastPushAt: info.lastPushAt,
        source: info.source,
        readOnly: info.readOnly,
        remote: info.remote,
      };
      return { info: plain, attempts, ms: Date.now() - started, notReadyAtMs, retriedOn };
    } catch (e) {
      rec.checkpoint();
      const elapsed = Date.now() - started;
      // NOT_FOUND right after create/fork is treated as "not visible yet" for a short while.
      const retryable = isInProgress(e) || (isNotFound(e) && elapsed < 15_000);
      const info = errInfo(e);
      retriedOn.push(info.code ?? info.name);
      if (retriedOn.length <= 3) rec.note(`${label}: get()/info() attempt ${attempts} at ${elapsed} ms threw ${errText(e)}`);
      if (!retryable || elapsed > maxMs) throw e;
      notReadyAtMs = pollStartedMs;
      await sleep(pollDelayMs(elapsed, concurrency));
    }
  }
}

/** create() with retry on *_IN_PROGRESS, then wait until get() succeeds. */
export async function createRepo(rec: Recorder, artifacts: Artifacts, name: string): Promise<CreatedRepo> {
  const started = Date.now();
  let attempts = 0;
  let created: ArtifactsCreateRepoResult | undefined;
  while (!created) {
    rec.checkpoint();
    attempts++;
    try {
      created = await artifacts.create(name, { description: "throwaway spike repo; safe to delete" });
    } catch (e) {
      rec.checkpoint();
      rec.note(`create(${name}) attempt ${attempts} threw ${errText(e)}`);
      if (!isInProgress(e) || Date.now() - started > 60_000) throw e;
      await sleep(pollDelayMs(Date.now() - started));
    }
  }
  const createMs = Date.now() - started;
  rec.addSecret(created.token);
  const repo: CreatedRepo = { name: created.name, remote: created.remote, branch: created.defaultBranch, token: created.token };
  disposeQuietly(created);
  const ready = await waitReady(rec, artifacts, name, `create(${name})`);
  rec.timing("create_call_ms", createMs);
  // The true time to ready lies between the lower bound (last poll that found the repo not
  // ready, or the end of the create() call when no poll did) and create_to_ready_ms.
  rec.timing("create_to_ready_lower_bound_ms", createMs + (ready.notReadyAtMs ?? 0));
  rec.timing("create_to_ready_ms", Date.now() - started);
  if (ready.attempts > 1) rec.note(`create(${name}): repo became ready after ${ready.attempts} get() attempts (${ready.retriedOn.join(", ")})`);
  if (typeof repo.remote !== "string" || repo.remote.length === 0) {
    rec.note(`create(${name}) returned no remote; using info().remote`);
    repo.remote = ready.info.remote;
  } else if (repo.remote !== ready.info.remote) {
    rec.note(`create(${name}).remote differs from info().remote: ${repo.remote} vs ${ready.info.remote}`);
  }
  if (typeof repo.branch !== "string" || repo.branch.length === 0) {
    rec.note(`create(${name}) returned no defaultBranch; using info().defaultBranch`);
    repo.branch = ready.info.defaultBranch;
  }
  if (typeof repo.token !== "string" || repo.token.length === 0) {
    throw new Error(`create(${name}) returned no token (${describeToken(repo.token)})`);
  }
  return repo;
}

export const SEED_FILES: Record<string, string> = {
  "README.md": "# Artifacts spike\n\nThrowaway repository created by the measurement harness.\n",
  "src/index.ts": 'export const message = "hello from a Durable Object";\n',
  "data/config.json": '{\n  "version": 1\n}\n',
};

export function isTransientStatus(status: number | undefined): boolean {
  return status === undefined || status === 0 || status === 404 || status === 409 || status === 429 || (status >= 500 && status <= 599);
}

/** Push, retrying a few times on statuses that look transient right after create or fork. */
export async function pushWithRetry(rec: Recorder, step: string, local: LocalRepo, gitTarget: GitTarget, options: PushOptions): Promise<PushOutcome> {
  let outcome = await pushRef(rec, step, local, gitTarget, options);
  for (let attempt = 2; attempt <= 4 && !outcome.ok && outcome.error?.name === "HttpError" && isTransientStatus(outcome.error.httpStatus); attempt++) {
    rec.note(`${step}: attempt ${attempt - 1} failed with ${outcome.errorText}; retrying`);
    await sleep(500 * (attempt - 1));
    outcome = await pushRef(rec, `${step}-retry${attempt - 1}`, local, gitTarget, options);
  }
  return outcome;
}

export interface Seeded {
  repo: CreatedRepo;
  local: LocalRepo;
  head: string;
  /** Auth style that worked for the seed push. */
  style: AuthStyle;
}

/** Create a repo and push a three-file seed commit with the create() token. */
export async function seedRepo(rec: Recorder, deps: Deps, tag: string): Promise<Seeded> {
  const repo = await createRepo(rec, deps.artifacts, repoName(tag));
  const local = newLocalRepo();
  await initRepo(local, repo.branch);
  const head = await commitFiles(local, SEED_FILES, "spike: seed commit (three files)");
  for (const style of ["basic", "bearer"] as const) {
    const push = await pushWithRetry(rec, `seed-push-${style}`, local, target(repo, style), { ref: repo.branch });
    rec.timing("seed_push_ms", push.ms);
    if (push.ok) return { repo, local, head, style };
    rec.note(`seed push with ${style} auth failed: ${push.errorText ?? JSON.stringify(push.refs)}`);
  }
  throw new Error(`seed push to ${repo.name} failed with both auth styles`);
}

/** Head of a ref as the binding reports it, or null when log() returns nothing. */
export async function bindingHead(artifacts: Artifacts, name: string, ref: string): Promise<string | null> {
  return withRepo(artifacts, name, async (repo) => {
    const log = await repo.log({ ref, limit: 1 });
    return log[0]?.hash ?? null;
  });
}

export interface FreshOutcome {
  matched: boolean;
  ms: number;
  staleReads: number;
  last: string | null;
}

/** Poll the binding until log(ref) reports the expected head. */
export async function waitBindingHead(artifacts: Artifacts, name: string, ref: string, expected: string, maxMs = 15_000): Promise<FreshOutcome> {
  const started = Date.now();
  let staleReads = 0;
  let last: string | null = null;
  for (;;) {
    last = await bindingHead(artifacts, name, ref);
    const ms = Date.now() - started;
    if (last === expected) return { matched: true, ms, staleReads, last };
    staleReads++;
    if (ms > maxMs) return { matched: false, ms, staleReads, last };
    await sleep(25);
  }
}

export function rawCommit(parents: string[], files: Record<string, string>, message: string): { commit: GitObject; objects: GitObject[] } {
  const { root, objects } = makeTreeFromFiles(files);
  const commit = makeCommit({ tree: root.oid, parents, author: { ...AUTHOR, timestamp: nowSeconds() }, message });
  return { commit, objects: [...objects, commit] };
}

/**
 * Current value of a ref on the remote, read from the fetch advertisement with the given
 * token (basic auth first, then bearer). Null when the ref is missing or no request worked.
 */
export async function remoteRefValue(rec: Recorder, step: string, url: string, token: string, ref: string): Promise<string | null> {
  for (const style of ["basic", "bearer"] as const) {
    const outcome = await rawDiscover(rec, `${step}-${style}`, url, "git-upload-pack", authHeader(token, style));
    if (outcome.adv) return outcome.adv.refs[ref] ?? null;
  }
  return null;
}

export interface RefsRead {
  /** Refs from the last read that worked (the push advertisement lists every ref namespace). Null when no read worked. */
  refs: Record<string, string> | null;
  /** Capabilities from that read. */
  capabilities: string[];
  /** True when a read worked but did not show the expected state, and a later read did. */
  lagged: boolean;
  /** Why the last read failed, when `refs` is null. */
  message?: string;
}

/** Most reads of the refs after one push, and the pause between two of them. */
const REF_READS = 4;
const REF_READ_GAP_MS = 300;

/**
 * Read the refs advertised for push until `settled(refs)` is true, at most REF_READS times.
 *
 * A caller passes `settled` when the server has just reported success for an update: a ref
 * advertisement that lags behind the push must not be mistaken for "nothing changed". A read
 * that fails (no answer, non-200) is repeated as well, so one failed read is never taken as
 * an answer. Without `settled`, the first read that works is final.
 */
export async function readRefsUntil(
  rec: Recorder,
  step: string,
  url: string,
  authorization: string,
  settled: (refs: Record<string, string>) => boolean = () => true,
): Promise<RefsRead> {
  const started = Date.now();
  let last: RefsRead = { refs: null, capabilities: [], lagged: false };
  let sawUnsettled = false;
  for (let read = 1; read <= REF_READS; read++) {
    if (read > 1) await sleep(REF_READ_GAP_MS);
    const outcome = await rawDiscover(rec, read === 1 ? step : `${step}-reread${read - 1}`, url, "git-receive-pack", authorization);
    if (!outcome.adv) {
      last = { ...last, message: outcome.message };
      continue;
    }
    last = { refs: outcome.adv.refs, capabilities: outcome.adv.capabilities, lagged: false };
    if (settled(outcome.adv.refs)) {
      if (sawUnsettled) {
        last.lagged = true;
        rec.note(`${step}: the refs showed the change the server had reported only on read ${read}, ${Date.now() - started} ms after the first read. Ref reads can lag behind a push.`);
      }
      return last;
    }
    sawUnsettled = true;
  }
  return last;
}

export function pushSummary(p: PushOutcome): string {
  const said = p.serverMessages.length > 0 ? `; server said: ${JSON.stringify(p.serverMessages)}` : "";
  if (p.ok) return `ok in ${p.ms} ms (HTTP ${p.statuses.join(", ")})${said}`;
  return `FAILED in ${p.ms} ms (HTTP ${p.statuses.join(", ") || "none sent"}): ${p.errorText ?? JSON.stringify(p.refs)}${said}`;
}

export async function requireE1(deps: Deps): Promise<RepoState & { head: string }> {
  const state = await deps.store.get<RepoState>("e1");
  if (!state || !state.head) throw new Error("no usable e1 repo in Durable Object storage: run e1-create-push first (it must succeed)");
  return state as RepoState & { head: string };
}
