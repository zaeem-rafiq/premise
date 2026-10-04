// src/worker/agent/gate-client.ts — the Agent's door to the model gate (SE6, SE6a, SE8, MG5).
//
// The gate is one Durable Object named "premise". Every model call goes
// may-start (first call only) -> reserve -> the send -> settle; release frees
// the attempt's real-agent slot when the loop ends or waits. A transport that
// throws is a wait, never a refusal: SE8 says the gate's own waits count
// nothing, and a call that never reached the gate reserves nothing.

import type {
  GateMayStartResponse,
  GateReleaseResponse,
  GateReserveResponse,
  GateSettleResponse,
} from "../../protocol/internal.ts";

export const GATE_OBJECT = "premise";

export const GATE_PATHS = {
  mayStart: "/internal/may-start",
  reserve: "/internal/reserve",
  settle: "/internal/settle",
  release: "/internal/release",
} as const;

export interface GateTransport {
  post(path: string, body: unknown): Promise<Response>;
}

const GATE_ORIGIN = "https://gate.internal";

export function gateDurableObjectTransport(ns: DurableObjectNamespace): GateTransport {
  const stub = ns.get(ns.idFromName(GATE_OBJECT));
  return {
    post: (path, body) =>
      stub.fetch(GATE_ORIGIN + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

export function gateUrlTransport(base: string): GateTransport {
  return {
    post: (path, body) =>
      fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

/** A transport-level failure: HTTP error or an unparseable answer. Mapped to a gate wait (SE8). */
export class GateTransportError extends Error {}

export class GateCalls {
  #transport: GateTransport;

  constructor(transport: GateTransport) {
    this.#transport = transport;
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.#transport.post(path, body);
    if (!res.ok) throw new GateTransportError(`gate ${path}: HTTP ${res.status}`);
    try {
      return (await res.json()) as T;
    } catch {
      throw new GateTransportError(`gate ${path}: unreadable response`);
    }
  }

  /** SE8/MG5: may a new real agent's loop start? `retry_after_ms` means wait. */
  mayStart(attemptId: string): Promise<GateMayStartResponse> {
    return this.#post<GateMayStartResponse>(GATE_PATHS.mayStart, { attempt_id: attemptId });
  }

  reserve(request: {
    attempt_id: string;
    pool: string;
    model: string;
    request_bytes: number;
    max_tokens: number;
  }): Promise<GateReserveResponse> {
    return this.#post<GateReserveResponse>(GATE_PATHS.reserve, request);
  }

  settle(request: {
    reservation_id: string;
    usage: { tokens_in: number; tokens_out: number } | null;
  }): Promise<GateSettleResponse> {
    return this.#post<GateSettleResponse>(GATE_PATHS.settle, request);
  }

  /** MG5: the attempt's real-agent slot is free again. Idempotent. */
  release(attemptId: string): Promise<GateReleaseResponse> {
    return this.#post<GateReleaseResponse>(GATE_PATHS.release, { attempt_id: attemptId });
  }
}
