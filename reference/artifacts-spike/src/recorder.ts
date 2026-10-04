/**
 * Result shape, observation recorder, token redaction and small helpers.
 * Pure module: no Cloudflare imports.
 */

export interface HttpEntry {
  step: string;
  status: number;
  /** Wall-clock milliseconds for this request (response body included). */
  ms?: number;
  /** Present only on aggregated entries (soak): how many requests this row stands for. */
  count?: number;
}

export interface ExperimentResult {
  experiment: string;
  ok: boolean;
  observations: string[];
  timings_ms: Record<string, number | number[]>;
  http: HttpEntry[];
  error?: string;
  /** Structured findings. `data.verdict` holds the short answers. */
  data?: Record<string, unknown>;
  /**
   * Present only when the request asked for it (e2 with {"outside_control": true}).
   * The one place where a token is returned on purpose; see Recorder.disclose().
   */
  disclosed?: Record<string, unknown>;
}

// ------------------------------------------------------------ redaction ----

// The secret's alphabet is not assumed to be hex: an art_v2 token has been seen in the wild.
// The class covers base64, base64url and URL-unreserved characters; it cannot cross a JSON string boundary.
const TOKEN_RE = /art_v(\d+)_[A-Za-z0-9_\-.~+/=]{8,}(\?expires=\d+)?/g;
// Case-sensitive and requires a digit, so prose such as "basic auth" is left alone.
const AUTH_HEADER_RE = /\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=?-]*\d)[A-Za-z0-9._~+/=?-]{8,}/g;
const URL_USERINFO_RE = /:\/\/[^/\s:@"]+:[^@\s/"]+@/g;
// Artifacts remotes are https://<account>.artifacts.cloudflare.net/git/...; the account label is masked.
const ARTIFACTS_HOST_RE = /[A-Za-z0-9-]+(\.artifacts\.cloudflare\.net)\b/g;

function base64(text: string): string {
  return btoa(text);
}

export function tokenSecret(token: string): string {
  const index = token.indexOf("?expires=");
  return index === -1 ? token : token.slice(0, index);
}

/** Every string form in which a token could leak: full token, secret, and Basic credential. */
export function secretForms(token: string): string[] {
  const secret = tokenSecret(token);
  return [token, secret, base64(`x:${secret}`), base64(`x:${token}`)];
}

export function redactText(text: string, knownSecrets: Iterable<string> = []): string {
  let out = text;
  const sorted = [...knownSecrets].filter((s) => s.length >= 8).sort((a, b) => b.length - a.length);
  for (const secret of sorted) out = out.split(secret).join("<redacted-token>");
  out = out.replace(TOKEN_RE, "art_v$1_<redacted>");
  out = out.replace(AUTH_HEADER_RE, "$1 <redacted>");
  out = out.replace(URL_USERINFO_RE, "://<redacted>@");
  out = out.replace(ARTIFACTS_HOST_RE, "<account>$1");
  return out;
}

/** Shape of a token without its value, so reports can say what the service issued. */
export function describeToken(token: unknown): string {
  if (typeof token !== "string") return `not a string (${typeof token})`;
  const match = /^(art_v\d+_)([^?]*)(?:\?expires=(\d+))?$/.exec(token);
  if (!match) return `unrecognised format, length ${token.length}`;
  const secret = match[2] ?? "";
  const hex = /^[0-9a-f]+$/.test(secret);
  const expires = match[3] ? `expires=${match[3]}` : "no expires suffix";
  return `prefix ${match[1]}, secret length ${secret.length}${hex ? " (hex)" : ""}, ${expires}`;
}

// --------------------------------------------------------------- errors ----

export interface ErrInfo {
  name: string;
  message: string;
  code?: string;
  numericCode?: number;
  /** HTTP status when the error came from a git HTTP request. */
  httpStatus?: number;
  /** Extra fields carried by the error (isomorphic-git puts details in `data`). */
  detail?: string;
}

export function errInfo(e: unknown): ErrInfo {
  if (e === null || typeof e !== "object") return { name: typeof e, message: String(e) };
  const obj = e as Record<string, unknown>;
  const info: ErrInfo = {
    name: typeof obj.name === "string" ? obj.name : "Error",
    message: typeof obj.message === "string" ? obj.message : String(e),
  };
  if (typeof obj.code === "string" || typeof obj.code === "number") info.code = String(obj.code);
  if (typeof obj.numericCode === "number") info.numericCode = obj.numericCode;
  const data = obj.data;
  if (data && typeof data === "object") {
    const status = (data as Record<string, unknown>).statusCode;
    if (typeof status === "number") info.httpStatus = status;
    try {
      info.detail = JSON.stringify(data).slice(0, 600);
    } catch {
      info.detail = "(unserialisable error data)";
    }
  }
  return info;
}

export function errText(e: unknown): string {
  const i = errInfo(e);
  const tags = [
    i.code !== undefined && i.code !== i.name ? `code=${i.code}` : "",
    i.numericCode !== undefined ? `numericCode=${i.numericCode}` : "",
    i.httpStatus !== undefined ? `http=${i.httpStatus}` : "",
  ].filter(Boolean);
  const head = tags.length ? `${i.name}[${tags.join(" ")}]` : i.name;
  return `${head}: ${i.message}${i.detail ? ` data=${i.detail}` : ""}`;
}

const IN_PROGRESS_CODES = new Set(["CREATE_IN_PROGRESS", "FORK_IN_PROGRESS", "IMPORT_IN_PROGRESS"]);
// Documented numeric codes: 10302 IMPORT_IN_PROGRESS, 10303 FORK_IN_PROGRESS.
// CREATE_IN_PROGRESS is in the published types but has no documented number.
const IN_PROGRESS_NUMERIC = new Set([10302, 10303]);

export function isInProgress(e: unknown): boolean {
  const i = errInfo(e);
  if (i.code && IN_PROGRESS_CODES.has(i.code)) return true;
  if (i.numericCode !== undefined && IN_PROGRESS_NUMERIC.has(i.numericCode)) return true;
  return /(CREATE|FORK|IMPORT)_IN_PROGRESS|still being (created|forked|imported)|in progress/i.test(i.message);
}

export function isNotFound(e: unknown): boolean {
  const i = errInfo(e);
  return i.code === "NOT_FOUND" || i.numericCode === 10200 || /\bNOT_FOUND\b|not found/i.test(i.message);
}

export function isAlreadyExists(e: unknown): boolean {
  const i = errInfo(e);
  return i.code === "ALREADY_EXISTS" || i.numericCode === 10201 || /ALREADY_EXISTS|already exists/i.test(i.message);
}

// ---------------------------------------------------------------- stats ----

export interface Summary {
  n: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

/** Nearest-rank percentiles. Returns null for an empty list. */
export function summarize(values: readonly number[]): Summary | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0]!,
    p50: rank(50),
    p95: rank(95),
    max: sorted[sorted.length - 1]!,
    mean: Math.round((sum / sorted.length) * 10) / 10,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomSuffix(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

/** Printable preview of bytes: ASCII kept, everything else escaped. */
export function previewBytes(bytes: Uint8Array, max = 300): string {
  let out = "";
  const n = Math.min(bytes.byteLength, max);
  for (let i = 0; i < n; i++) {
    const b = bytes[i]!;
    if (b === 0x0a) out += "\\n";
    else if (b === 0x0d) out += "\\r";
    else if (b === 0x5c) out += "\\\\";
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += `\\x${b.toString(16).padStart(2, "0")}`;
  }
  if (bytes.byteLength > max) out += `... (${bytes.byteLength} bytes total)`;
  return out;
}

export function intParam(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

// ------------------------------------------------------------- recorder ----

/** Reason carried by the cancellation signal of a run (deadline reached). */
export class RunCancelled extends Error {
  override readonly name = "RunCancelled";
}

export class Recorder {
  readonly observations: string[] = [];
  readonly timings: Record<string, number | number[]> = {};
  readonly httpLog: HttpEntry[] = [];
  readonly data: Record<string, unknown> = {};
  readonly verdict: Record<string, unknown> = {};
  private readonly secrets = new Set<string>();
  private disclosure: Record<string, unknown> | undefined;

  /**
   * @param signal Cancellation signal of the run. Every network helper checks it, so a
   *               cancelled experiment stops at its next request instead of running on.
   */
  constructor(
    readonly experiment: string,
    private readonly signal?: AbortSignal,
  ) {}

  /** True once the run was cancelled. */
  get cancelled(): boolean {
    return this.signal?.aborted === true;
  }

  /** Throw the cancellation reason if the run was cancelled. Call before I/O and inside every loop. */
  checkpoint(): void {
    this.signal?.throwIfAborted();
  }

  /** Signal for one HTTP request: aborts on cancellation of the run or after `timeoutMs`. */
  requestSignal(timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
  }

  /** A recorder whose notes and rows are thrown away, but which stops on the same cancellation. */
  quiet(): Recorder {
    return new Recorder("quiet", this.signal);
  }

  note(message: string): void {
    this.observations.push(message);
  }

  /** Register a token so that no form of it can appear in the result. */
  addSecret(token: unknown): void {
    if (typeof token !== "string" || token.length === 0) return;
    for (const form of secretForms(token)) this.secrets.add(form);
  }

  http(step: string, status: number, ms?: number): void {
    this.httpLog.push(ms === undefined ? { step, status } : { step, status, ms });
  }

  /**
   * Count one request in an aggregated row. Requests with the same step and status
   * share one row: `count` requests and their summed `ms`. Used for polling loops.
   */
  httpCount(step: string, status: number, ms: number): void {
    const row = this.httpLog.find((h) => h.count !== undefined && h.step === step && h.status === status);
    if (row) {
      row.count = (row.count ?? 0) + 1;
      row.ms = (row.ms ?? 0) + ms;
    } else {
      this.httpLog.push({ step, status, ms, count: 1 });
    }
  }

  /**
   * The one deliberate exception to redaction: hand a value to the operator who asked
   * for it. It is attached to the finished result under `disclosed`, after redaction,
   * and appears nowhere else in the result.
   */
  disclose(value: Record<string, unknown>): void {
    this.disclosure = value;
  }

  /** Record one timing. A label used twice becomes a list. */
  timing(label: string, ms: number): void {
    const existing = this.timings[label];
    if (existing === undefined) this.timings[label] = ms;
    else if (Array.isArray(existing)) existing.push(ms);
    else this.timings[label] = [existing, ms];
  }

  /** Time an async step. The timing is recorded even when the step throws. */
  async time<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      this.timing(label, Date.now() - start);
    }
  }

  redact(text: string): string {
    return redactText(text, this.secrets);
  }

  finish(ok: boolean, error?: string): ExperimentResult {
    const result: ExperimentResult = {
      experiment: this.experiment,
      ok,
      observations: this.observations,
      timings_ms: this.timings,
      http: this.httpLog,
      data: { verdict: this.verdict, ...this.data },
    };
    if (error !== undefined) result.error = error;
    // Last line of defence: redact the whole serialised result.
    const redacted = JSON.parse(this.redact(JSON.stringify(result))) as ExperimentResult;
    if (this.disclosure !== undefined) redacted.disclosed = structuredClone(this.disclosure);
    return redacted;
  }
}
