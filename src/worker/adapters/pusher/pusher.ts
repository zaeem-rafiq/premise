// The chosen Pusher (01-core.md S1 option A): the batch's hand-built pack posted as one
// receive-pack request over git smart HTTP. The request carries every ref command of the
// batch — for a landing, `refs/heads/main` and `refs/notes/premise` together (S1a, LP4).
// `atomic` is requested only when the server's advertisement offers it (S1a); Artifacts
// does not offer it (platform record X8) and refuses the whole request on one bad command.

import { parseRefAdvertisement } from "../../../core/git/advertisement.ts";
import {
  buildReceivePackRequest,
  parseReceivePackReport,
  RECEIVE_PACK_CAPABILITIES,
  type ReceivePackReport,
  type RefCommand,
} from "../../../core/git/receive-pack.ts";
import type { ErrCode } from "../../../protocol/events.ts";
import { redact } from "../../../protocol/redact.ts";
import type { Pusher, PushResult } from "../../../protocol/ports.ts";

// Messages name the endpoint and status only; a token never appears in any error or result
// (01-core.md 13.1 — secret material stays out of logs and reports).

/** The failure a request produced, classified the way PushResult classifies it. */
export class TransportError extends Error {
  override readonly name = "TransportError";
  readonly code: ErrCode;
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;
  constructor(code: ErrCode, httpStatus: number | null, retryAfterMs: number | null, message: string) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The `Retry-After` header as a delay in milliseconds (seconds or an HTTP date). */
function retryAfterMs(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

function httpError(response: Response, endpoint: string): TransportError {
  const status = response.status;
  const code: ErrCode = status === 429 ? "rate_limited" : `http_${status}`;
  return new TransportError(code, status, retryAfterMs(response), `${endpoint} answered HTTP ${status}`);
}

function asTransportError(error: unknown): TransportError {
  if (error instanceof TransportError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") {
    return new TransportError("timeout", null, null, "the request was aborted before an answer");
  }
  return new TransportError("transport", null, null, "the request failed before an answer");
}

function asResult(error: unknown): PushResult {
  const failure = asTransportError(error);
  return {
    ok: false,
    kind: "transport",
    code: failure.code,
    http_status: failure.httpStatus,
    retry_after_ms: failure.retryAfterMs,
  };
}

async function fetchAdvertisement(remote: string, token: string, signal: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(`${remote}/info/refs?service=git-receive-pack`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
  } catch (error) {
    throw asTransportError(error);
  }
  if (response.status !== 200) throw httpError(response, "info/refs");
  try {
    return parseRefAdvertisement(new Uint8Array(await response.arrayBuffer()));
  } catch {
    throw new TransportError("bad_response", 200, null, "info/refs answered a malformed advertisement");
  }
}

/** What the operator's log sees of a refusal. Every string the remote sent — the unpack error and
 * each ref's refusal text — runs through `redact()` first (SE5b, hardening), so nothing the remote
 * echoes reaches the log unredacted. */
export function refusalLog(report: ReceivePackReport): { unpack: string | null; refs: string[] } {
  return {
    unpack: report.unpackError === null ? null : redact(report.unpackError),
    refs: report.results.map((result) => redact(result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.error}`)),
  };
}

/**
 * The receive-pack adapter. `atomic` in the input means the batch wants all-or-nothing
 * semantics: the adapter reads the ref advertisement and requests the `atomic` capability
 * only when the server advertises it (LP4), which is exactly when the server is allowed to
 * receive that capability.
 */
export function receivePackPusher(): Pusher {
  return {
    async push(input): Promise<PushResult> {
      const commands: RefCommand[] = input.updates.map((update) => ({
        ref: update.ref,
        oldOid: update.old,
        newOid: update.new,
      }));
      const capabilities: string[] = [...RECEIVE_PACK_CAPABILITIES];
      if (input.atomic) {
        let advertisement;
        try {
          advertisement = await fetchAdvertisement(input.remote, input.token, input.signal);
        } catch (error) {
          return asResult(error);
        }
        if (advertisement.capabilities.includes("atomic")) capabilities.push("atomic");
      }
      const body = buildReceivePackRequest(commands, capabilities, input.pack);
      let response: Response;
      try {
        response = await fetch(`${input.remote}/git-receive-pack`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${input.token}`,
            "Content-Type": "application/x-git-receive-pack-request",
            Accept: "application/x-git-receive-pack-result",
          },
          body,
          signal: input.signal,
        });
      } catch (error) {
        return asResult(error);
      }
      if (response.status !== 200) return asResult(httpError(response, "git-receive-pack"));
      let report;
      try {
        report = parseReceivePackReport(new Uint8Array(await response.arrayBuffer()));
      } catch {
        return asResult(new TransportError("bad_response", 200, null, "git-receive-pack answered a malformed report"));
      }
      const byRef = new Map(report.results.map((result) => [result.ref, result]));
      const refs: Record<string, "ok" | "ng"> = {};
      for (const command of commands) {
        const result = byRef.get(command.ref);
        refs[command.ref] = result !== undefined && result.ok ? "ok" : "ng";
      }
      if (report.unpackOk && Object.values(refs).every((status) => status === "ok")) {
        return { ok: true, refs: refs as Record<string, "ok"> };
      }
      // LP5 decides from the remote's ref values, never from this text. The text is for the
      // operator's log only: it names why the server refused (no request data, no token).
      console.warn("git-receive-pack refused the push", refusalLog(report));
      return { ok: false, kind: "rejected", refs };
    },

    async readRefs(input): Promise<Record<string, string | null>> {
      const advertisement = await fetchAdvertisement(input.remote, input.token, input.signal);
      const out: Record<string, string | null> = {};
      for (const ref of input.refs) out[ref] = advertisement.refs.get(ref) ?? null;
      return out;
    },
  };
}
