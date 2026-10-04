/**
 * Git operations used by the experiments:
 *  - isomorphic-git over an in-memory filesystem, with an HTTP client that
 *    records every request;
 *  - raw smart-HTTP requests (ref discovery and receive-pack) built with rawgit.
 *
 * No Cloudflare imports: only `fetch`, so it runs in Workers and in Node tests.
 */
import git from "isomorphic-git";
import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git";
import { MemoryFS } from "./memory-fs";
import {
  ZERO_OID,
  buildPack,
  buildReceivePackRequest,
  parseRefAdvertisement,
  parseReportStatus,
  type GitObject,
  type RefAdvertisement,
  type RefCommand,
  type ReportStatus,
} from "./rawgit";
import { errInfo, errText, previewBytes, tokenSecret, type ErrInfo, type HttpEntry, type Recorder } from "./recorder";

export type AuthStyle = "bearer" | "basic";

export const AUTHOR = { name: "spike-harness", email: "spike@example.invalid" };

/**
 * Authorization header value for an Artifacts repo token.
 *  - bearer: the full token string, "?expires=" suffix included.
 *  - basic: any username, password = token with the "?expires=" suffix removed.
 */
export function authHeader(token: string, style: AuthStyle): string {
  if (style === "bearer") return `Bearer ${token}`;
  return `Basic ${btoa(`x:${tokenSecret(token)}`)}`;
}

/** No single git HTTP request may hang longer than this. A timeout shows up as a thrown TimeoutError. */
const HTTP_TIMEOUT_MS = 120_000;

const INTERESTING_RESPONSE_HEADERS = ["content-type", "www-authenticate", "cf-ray", "cf-mitigated", "server", "retry-after"];

function describeHeaders(headers: Headers): string {
  return INTERESTING_RESPONSE_HEADERS.map((name) => {
    const value = headers.get(name);
    return value === null ? "" : `${name}=${JSON.stringify(value)}`;
  })
    .filter(Boolean)
    .join(" ");
}

/** Path and query of a git URL after the repo, for example "/info/refs?service=git-receive-pack". */
function gitSuffix(url: string): string {
  const index = url.indexOf(".git/");
  return index === -1 ? url : url.slice(index + 4);
}

async function collectBody(body: unknown): Promise<Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (body instanceof Uint8Array) return body;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export interface RecordingHttpClient extends HttpClient {
  /** Requests made through this client, in order. */
  calls: (HttpEntry & { method: string; requestBytes: number; responseBytes: number })[];
}

/**
 * HTTP client for isomorphic-git built on `fetch`. Every request is recorded
 * with its status and duration; non-2xx responses also get an observation with
 * the server's message.
 */
export function gitHttp(rec: Recorder, step: string, options: { quiet?: boolean } = {}): RecordingHttpClient {
  const calls: RecordingHttpClient["calls"] = [];
  return {
    calls,
    async request(req: GitHttpRequest): Promise<GitHttpResponse> {
      const method = req.method ?? "GET";
      const body = await collectBody(req.body);
      rec.checkpoint();
      const started = Date.now();
      const label = `${step} ${method} ${gitSuffix(req.url)}`;
      let res: Response;
      let bytes: Uint8Array;
      try {
        res = await fetch(req.url, { method, headers: req.headers, body, signal: rec.requestSignal(HTTP_TIMEOUT_MS) });
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        // A cancelled run stops here: the cancellation reason is thrown instead of being recorded.
        rec.checkpoint();
        // No HTTP response at all (network error or timeout): recorded as status 0.
        const failedMs = Date.now() - started;
        calls.push({ step: label, status: 0, ms: failedMs, method, requestBytes: body?.byteLength ?? 0, responseBytes: 0 });
        if (!options.quiet) rec.http(label, 0, failedMs);
        rec.note(`${label}: fetch threw ${errText(e)}`);
        throw e;
      }
      const ms = Date.now() - started;
      calls.push({ step: label, status: res.status, ms, method, requestBytes: body?.byteLength ?? 0, responseBytes: bytes.byteLength });
      if (!options.quiet) rec.http(label, res.status, ms);
      if (res.status >= 400) {
        rec.note(`${label}: HTTP ${res.status} ${res.statusText} ${describeHeaders(res.headers)} body="${previewBytes(bytes)}"`);
      }
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return {
        url: res.url,
        method,
        statusCode: res.status,
        statusMessage: res.statusText,
        headers,
        // isomorphic-git accepts any iterable of Uint8Array here.
        body: [bytes] as unknown as AsyncIterableIterator<Uint8Array>,
      };
    },
  };
}

// --------------------------------------------------- isomorphic-git repo ----

export interface LocalRepo {
  fs: MemoryFS;
  dir: string;
  /** isomorphic-git object cache, reused across calls on a warm repo. */
  cache: Record<string, unknown>;
}

export function newLocalRepo(): LocalRepo {
  return { fs: new MemoryFS(), dir: "/repo", cache: {} };
}

export async function initRepo(repo: LocalRepo, defaultBranch: string): Promise<void> {
  await git.init({ fs: repo.fs, dir: repo.dir, defaultBranch });
}

/** Write files into the working tree, stage them and commit. Returns the commit id. */
export async function commitFiles(repo: LocalRepo, files: Record<string, string>, message: string): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    const full = `${repo.dir}/${path}`;
    await repo.fs.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await repo.fs.writeFile(full, content);
    await git.add({ fs: repo.fs, dir: repo.dir, filepath: path, cache: repo.cache });
  }
  return git.commit({ fs: repo.fs, dir: repo.dir, message, author: AUTHOR, cache: repo.cache });
}

export interface GitTarget {
  url: string;
  token: string;
  style: AuthStyle;
}

export interface PushOutcome {
  ok: boolean;
  ms: number;
  /** True when a POST to git-receive-pack was actually sent. */
  posted: boolean;
  /** HTTP statuses seen, in order. */
  statuses: number[];
  calls: RecordingHttpClient["calls"];
  /** Per-ref result from the server's report-status, when one was received. */
  refs?: Record<string, { ok: boolean; error?: string }>;
  /** Progress and error lines the server sent on the side-band during the push. */
  serverMessages: string[];
  error?: ErrInfo;
  errorText?: string;
}

export interface PushOptions {
  ref: string;
  remoteRef?: string;
  force?: boolean;
  delete?: boolean;
  /** Do not add per-request rows to the recorder (soak aggregates them itself). */
  quiet?: boolean;
}

/** Push one ref with isomorphic-git. Failures come back in the outcome; it throws only when the run was cancelled. */
export async function pushRef(rec: Recorder, step: string, repo: LocalRepo, target: GitTarget, options: PushOptions): Promise<PushOutcome> {
  const http = gitHttp(rec, step, { quiet: options.quiet });
  const started = Date.now();
  const outcome: PushOutcome = { ok: false, ms: 0, posted: false, statuses: [], calls: http.calls, serverMessages: [] };
  try {
    const result = await git.push({
      fs: repo.fs,
      http,
      onMessage: (message: string) => {
        const line = message.trim();
        if (line.length > 0 && outcome.serverMessages.length < 20) outcome.serverMessages.push(line.slice(0, 300));
      },
      dir: repo.dir,
      url: target.url,
      ref: options.ref,
      remoteRef: options.remoteRef,
      force: options.force ?? false,
      delete: options.delete ?? false,
      // Sent on the first request, so there is no 401 round trip.
      headers: { Authorization: authHeader(target.token, target.style) },
      cache: repo.cache,
    });
    outcome.ok = result.ok === true && Object.values(result.refs ?? {}).every((r) => r.ok);
    outcome.refs = result.refs as PushOutcome["refs"];
  } catch (e) {
    rec.checkpoint();
    outcome.error = errInfo(e);
    outcome.errorText = errText(e);
    const data = (e as { data?: { result?: { refs?: PushOutcome["refs"] } } }).data;
    if (data?.result?.refs) outcome.refs = data.result.refs;
  }
  outcome.ms = Date.now() - started;
  outcome.statuses = http.calls.map((c) => c.status);
  outcome.posted = http.calls.some((c) => c.method === "POST");
  return outcome;
}

export interface CloneOutcome {
  ok: boolean;
  ms: number;
  repo?: LocalRepo;
  head?: string;
  statuses: number[];
  /** Every HTTP request the clone made, in order. */
  calls: RecordingHttpClient["calls"];
  error?: ErrInfo;
  errorText?: string;
}

/** Clone one branch into a fresh in-memory repo. Throws only when the run was cancelled. */
export async function cloneRepo(rec: Recorder, step: string, target: GitTarget, branch: string): Promise<CloneOutcome> {
  const http = gitHttp(rec, step);
  const repo = newLocalRepo();
  const started = Date.now();
  const outcome: CloneOutcome = { ok: false, ms: 0, statuses: [], calls: http.calls };
  try {
    await git.clone({
      fs: repo.fs,
      http,
      dir: repo.dir,
      url: target.url,
      ref: branch,
      singleBranch: true,
      noTags: true,
      headers: { Authorization: authHeader(target.token, target.style) },
      cache: repo.cache,
    });
    outcome.head = await git.resolveRef({ fs: repo.fs, dir: repo.dir, ref: "HEAD" });
    outcome.repo = repo;
    outcome.ok = true;
  } catch (e) {
    rec.checkpoint();
    outcome.error = errInfo(e);
    outcome.errorText = errText(e);
  }
  outcome.ms = Date.now() - started;
  outcome.statuses = http.calls.map((c) => c.status);
  return outcome;
}

// ----------------------------------------------------- raw smart HTTP ----

export type GitService = "git-receive-pack" | "git-upload-pack";

export interface DiscoverOutcome {
  status: number;
  ms: number;
  ok: boolean;
  adv?: RefAdvertisement;
  /** Server message for a non-200 response, or the parse error. */
  message?: string;
}

/**
 * GET <repo>/info/refs?service=<service> with plain fetch, protocol v1.
 * Failures come back in the outcome; it throws only when the run was cancelled.
 * `extraHeaders` adds request headers (for example a User-Agent) to this one request.
 */
export async function rawDiscover(
  rec: Recorder,
  step: string,
  url: string,
  service: GitService,
  authorization: string | null,
  extraHeaders: Record<string, string> = {},
): Promise<DiscoverOutcome> {
  const label = `${step} GET /info/refs?service=${service}`;
  rec.checkpoint();
  const started = Date.now();
  try {
    const headers: Record<string, string> = { ...extraHeaders };
    if (authorization !== null) headers.Authorization = authorization;
    const res = await fetch(`${url}/info/refs?service=${service}`, { headers, signal: rec.requestSignal(HTTP_TIMEOUT_MS) });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const ms = Date.now() - started;
    rec.http(label, res.status, ms);
    if (res.status !== 200) {
      const message = `HTTP ${res.status} ${res.statusText} ${describeHeaders(res.headers)} body="${previewBytes(bytes)}"`;
      rec.note(`${label}: ${message}`);
      return { status: res.status, ms, ok: false, message };
    }
    try {
      return { status: 200, ms, ok: true, adv: parseRefAdvertisement(bytes) };
    } catch (e) {
      const message = `could not parse ref advertisement (${errText(e)}); content-type=${res.headers.get("content-type")} body="${previewBytes(bytes)}"`;
      rec.note(`${label}: ${message}`);
      return { status: 200, ms, ok: false, message };
    }
  } catch (e) {
    rec.checkpoint();
    const ms = Date.now() - started;
    rec.http(label, 0, ms);
    const message = `fetch threw ${errText(e)}`;
    rec.note(`${label}: ${message}`);
    return { status: 0, ms, ok: false, message };
  }
}

export interface ServicePostOutcome {
  /** HTTP status, or 0 when there was no HTTP answer. */
  status: number;
  ms: number;
  message?: string;
}

/**
 * POST <repo>/<service> with the given pkt-line body and plain fetch. The caller looks only
 * at the HTTP status: this is a credential probe, not a fetch or a push.
 * Failures come back in the outcome; it throws only when the run was cancelled.
 */
export async function rawServicePost(
  rec: Recorder,
  step: string,
  url: string,
  service: GitService,
  authorization: string,
  body: string,
  extraHeaders: Record<string, string> = {},
): Promise<ServicePostOutcome> {
  const label = `${step} POST /${service}`;
  rec.checkpoint();
  const started = Date.now();
  try {
    const res = await fetch(`${url}/${service}`, {
      method: "POST",
      headers: { ...extraHeaders, Authorization: authorization, "Content-Type": `application/x-${service}-request`, Accept: `application/x-${service}-result` },
      body,
      signal: rec.requestSignal(HTTP_TIMEOUT_MS),
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const ms = Date.now() - started;
    rec.http(label, res.status, ms);
    if (res.status === 200) return { status: 200, ms };
    const message = `HTTP ${res.status} ${res.statusText} ${describeHeaders(res.headers)} body="${previewBytes(bytes)}"`;
    rec.note(`${label}: ${message}`);
    return { status: res.status, ms, message };
  } catch (e) {
    rec.checkpoint();
    const ms = Date.now() - started;
    rec.http(label, 0, ms);
    const message = `fetch threw ${errText(e)}`;
    rec.note(`${label}: ${message}`);
    return { status: 0, ms, message };
  }
}

export interface RawPushOutcome {
  status: number;
  ms: number;
  requestBytes: number;
  packBytes: number;
  report?: ReportStatus;
  /** Escaped preview of the raw response body. */
  bodyPreview: string;
  message?: string;
}

export interface RawPushInput {
  url: string;
  authorization: string;
  commands: RefCommand[];
  capabilities: string[];
  /**
   * Objects to pack. May be empty: an update that needs no new objects (for example a new
   * ref that points at a commit the server already has) is sent with an empty pack, as the
   * git CLI does. A request whose commands are all deletes carries no pack at all.
   */
  objects: GitObject[];
  trailingNewline?: boolean;
}

/**
 * POST <repo>/git-receive-pack with a hand-built request. Throws only when the run was
 * cancelled, or when a command is malformed (a bug in the caller, not a server answer).
 */
export async function rawReceivePack(rec: Recorder, step: string, input: RawPushInput): Promise<RawPushOutcome> {
  const label = `${step} POST /git-receive-pack`;
  rec.checkpoint();
  const needsPack = input.commands.some((c) => c.newOid !== ZERO_OID);
  const pack = needsPack ? buildPack(input.objects) : undefined;
  const body = buildReceivePackRequest(input.commands, input.capabilities, pack, { trailingNewline: input.trailingNewline });
  const started = Date.now();
  const outcome: RawPushOutcome = { status: 0, ms: 0, requestBytes: body.byteLength, packBytes: pack?.byteLength ?? 0, bodyPreview: "" };
  try {
    const res = await fetch(`${input.url}/git-receive-pack`, {
      method: "POST",
      headers: {
        Authorization: input.authorization,
        "Content-Type": "application/x-git-receive-pack-request",
        Accept: "application/x-git-receive-pack-result",
      },
      body,
      signal: rec.requestSignal(HTTP_TIMEOUT_MS),
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    outcome.ms = Date.now() - started;
    outcome.status = res.status;
    outcome.bodyPreview = previewBytes(bytes);
    rec.http(label, res.status, outcome.ms);
    if (res.status !== 200) {
      outcome.message = `HTTP ${res.status} ${res.statusText} ${describeHeaders(res.headers)} body="${outcome.bodyPreview}"`;
      rec.note(`${label}: ${outcome.message}`);
      return outcome;
    }
    try {
      outcome.report = parseReportStatus(bytes);
    } catch (e) {
      outcome.message = `could not parse report-status (${errText(e)}); content-type=${res.headers.get("content-type")} body="${outcome.bodyPreview}"`;
      rec.note(`${label}: ${outcome.message}`);
    }
  } catch (e) {
    rec.checkpoint();
    outcome.ms = Date.now() - started;
    outcome.message = `fetch threw ${errText(e)}`;
    rec.http(label, 0, outcome.ms);
    rec.note(`${label}: ${outcome.message}`);
  }
  return outcome;
}

/** One-line description of a report-status, for observations. */
export function describeReport(outcome: RawPushOutcome): string {
  if (!outcome.report) return `no report-status (HTTP ${outcome.status})${outcome.message ? `: ${outcome.message}` : ""}`;
  const r = outcome.report;
  const refs = r.refs.map((s) => (s.ok ? `ok ${s.ref}` : `ng ${s.ref} (${s.message ?? ""})`)).join("; ");
  const extra = [r.errors ? `side-band error="${r.errors.trim()}"` : "", r.progress ? `progress="${r.progress.trim().slice(0, 200)}"` : ""].filter(Boolean).join(" ");
  return `unpack ${r.unpack ?? "(missing)"}; ${refs || "no per-ref status lines"}${extra ? `; ${extra}` : ""}`;
}

/** Status of one ref in a raw push: "ok", "ng" or "missing" (no line for it). */
export function refResult(outcome: RawPushOutcome, ref: string): "ok" | "ng" | "missing" {
  const status = outcome.report?.refs.find((s) => s.ref === ref);
  if (!status) return "missing";
  return status.ok ? "ok" : "ng";
}

/**
 * The server's own reason for refusing one ref in a raw push: the text after "ng <ref>",
 * or the HTTP failure when there was no report-status. Null when the ref was not refused.
 */
export function refusalReason(outcome: RawPushOutcome, ref: string): string | null {
  if (!outcome.report) return outcome.message ?? `HTTP ${outcome.status}, no report-status`;
  const status = outcome.report.refs.find((s) => s.ref === ref);
  return status && !status.ok ? (status.message ?? "") : null;
}

// ------------------------------------------- what the server decided ----

/**
 * A verdict about the server: true (it accepted), false (it refused), or a text that starts
 * with "inconclusive" when no decision by the server was observed.
 */
export type Decision = boolean | string;

/**
 * An HTTP status that is the server's own "no" to this request. A rate limit (429), a
 * request timeout (408), a server error (5xx) and no answer at all (0) are not decisions.
 */
function isRefusalStatus(status: number): boolean {
  return status >= 400 && status <= 499 && status !== 408 && status !== 429;
}

/**
 * What one isomorphic-git push says about the server's decision on `ref`.
 *  - true: report-status "ok";
 *  - false: report-status "ng" for the ref, or an HTTP 4xx answer to the POST;
 *  - "inconclusive (...)": no POST was sent, or the POST got no decision (no answer, 5xx, 408, 429).
 * A failed request is therefore never counted as a refusal.
 */
export function pushDecision(push: PushOutcome, ref: string): Decision {
  if (push.ok) return true;
  if (push.refs?.[ref]?.ok === false) return false;
  const post = push.calls.find((c) => c.method === "POST");
  if (!post) return `inconclusive (no receive-pack POST was sent: ${push.errorText ?? `HTTP ${push.statuses.join(", ") || "none"}`})`;
  if (isRefusalStatus(post.status)) return false;
  if (post.status === 200) return `inconclusive (HTTP 200, but no report-status line for ${ref}: ${push.errorText ?? JSON.stringify(push.refs)})`;
  return `inconclusive (the receive-pack POST got ${post.status === 0 ? "no HTTP answer" : `HTTP ${post.status}`}, which is not a decision about the ref)`;
}

/** The same for a raw push: what the server decided about `ref`. */
export function rawDecision(outcome: RawPushOutcome, ref: string): Decision {
  const line = outcome.status === 200 ? refResult(outcome, ref) : "missing";
  if (line === "ok") return true;
  if (line === "ng" || isRefusalStatus(outcome.status)) return false;
  return `inconclusive (no decision about ${ref}: ${describeReport(outcome)})`;
}

/**
 * Combine the server's answer with what the refs show afterwards.
 * `applied` is true when the ref shows the requested change, false when it does not, and
 * null when the refs could not be read. A change that is visible in the refs counts as
 * accepted whatever the answer was (only this request asked for it); a refusal counts only
 * when the refs confirm that nothing changed.
 */
export function confirmDecision(decision: Decision, applied: boolean | null): Decision {
  if (applied === true) return true;
  if (typeof decision === "string") return decision;
  if (applied === null) return `inconclusive (the server ${decision ? "reported success" : "refused the request"}, but the refs could not be read back)`;
  if (decision) return "inconclusive (the server reported success, but the refs read back do not show the change)";
  return false;
}

/** Capabilities to send on a raw push: the ones we want that the server advertised. */
export function chooseCapabilities(advertised: readonly string[], extra: readonly string[] = []): string[] {
  const names = new Set(advertised.map((c) => c.split("=", 1)[0]));
  const wanted = ["report-status", "side-band-64k", ...extra];
  const chosen = wanted.filter((c) => names.has(c));
  // Without report-status the server sends no result, so always ask for it.
  if (!chosen.includes("report-status")) chosen.unshift("report-status");
  if (names.has("agent")) chosen.push("agent=spike-rawgit/0.1");
  return chosen;
}
