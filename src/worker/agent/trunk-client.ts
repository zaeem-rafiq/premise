// src/worker/agent/trunk-client.ts — the Agent's only door to Trunk.
//
// TrunkCalls is the Agent's TrunkCalls port: the seven tools plus the three
// calls that are not tools — sync, register and stop (the model never names
// these; the Agent does). Two transports exist: the production one posts to
// the Trunk Durable Object of the attempt's pool; a url transport posts to a
// base URL, which tests point at a local fake that follows
// src/protocol/tools.ts (Trunk itself lands in a later track).

import type {
  ToolRequest,
  ToolResponse,
  RegisterRequest,
  RegisterResponse,
  StopRequest,
  StopResponse,
  SyncRequest,
  SyncResponse,
} from "../../protocol/tools.ts";

export const TRUNK_PATHS = { tool: "/tool", sync: "/sync", register: "/register", stop: "/stop" } as const;

export interface TrunkTransport {
  post(path: string, body: unknown): Promise<Response>;
}

// The Durable Object fetch ignores the origin; only the path is dispatched.
const TRUNK_ORIGIN = "https://trunk.internal";

export function durableObjectTransport(ns: DurableObjectNamespace, pool: string): TrunkTransport {
  const stub = ns.get(ns.idFromName(pool));
  return {
    post: (path, body) =>
      stub.fetch(TRUNK_ORIGIN + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

export function urlTransport(base: string): TrunkTransport {
  return {
    post: (path, body) =>
      fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

/** A transport-level failure: HTTP error or an unparseable answer. Mapped to the timeout path (TL12). */
export class TrunkTransportError extends Error {}

export class TrunkCalls {
  #transport: TrunkTransport;
  #attempt_id: string;

  constructor(transport: TrunkTransport, attempt_id: string) {
    this.#transport = transport;
    this.#attempt_id = attempt_id;
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.#transport.post(path, body);
    if (!res.ok) throw new TrunkTransportError(`trunk ${path}: HTTP ${res.status}`);
    try {
      return (await res.json()) as T;
    } catch {
      throw new TrunkTransportError(`trunk ${path}: unreadable response`);
    }
  }

  tool(request: Omit<ToolRequest, "attempt_id">): Promise<ToolResponse> {
    return this.#post<ToolResponse>(TRUNK_PATHS.tool, { ...request, attempt_id: this.#attempt_id });
  }

  sync(ack: number): Promise<SyncResponse> {
    return this.#post<SyncResponse>(TRUNK_PATHS.sync, { attempt_id: this.#attempt_id, ack });
  }

  register(request: Omit<RegisterRequest, "attempt_id">): Promise<RegisterResponse> {
    return this.#post<RegisterResponse>(TRUNK_PATHS.register, { ...request, attempt_id: this.#attempt_id });
  }

  stop(reason: StopRequest["reason"]): Promise<StopResponse> {
    return this.#post<StopResponse>(TRUNK_PATHS.stop, { attempt_id: this.#attempt_id, reason });
  }
}
