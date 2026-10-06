// The deployed `test` service as the measurement's transport (ME7): the owner routes go over HTTP
// with the owner key as a bearer token (BP7: the key rides the Authorization header only — it is
// never written to a file or a log), and the pool's event stream (01-core 12.2) is a WebSocket.
// `EngineService` is the injected seam: the unit tests replay canned events through a fake and
// never touch the network.
//
// The stream itself is the shared reader of `../../soak/stream.ts`: this service only supplies
// its transport pieces — FR30's plain-GET probe, the socket factory, and the owner-keyed GET the
// Replay export (12.3) needs.

import type { StreamSocket } from "../../soak/stream.ts";

export type EngineResponse = { status: number; body: unknown };

export type EngineService = {
  postJson(path: string, body: unknown): Promise<EngineResponse>;
  getJson(path: string): Promise<EngineResponse>;
  getText(path: string): Promise<{ status: number; text: string }>;
  /** A GET carrying the owner key (the Replay export is owner-only, 12.3). The key goes in the
   * Authorization header and nowhere else. */
  getAuthed(path: string): Promise<{ status: number; text: string }>;
  /** FR30's probe: a plain GET of `/api/pools/{pool}/stream`, answering the HTTP status (0 when
   * the request itself failed). */
  probe(pool: string): Promise<number>;
  /** Opens the pool's stream WebSocket. */
  socket(pool: string): StreamSocket;
};

/**
 * The real wiring: `origin` is `PREMISE_URL`, `ownerKey` is `PREMISE_OWNER_KEY`. The key is sent as
 * `Authorization: Bearer` on the owner routes alone (POSTs and the export GET); it never enters a
 * URL, a body, or a returned value.
 */
export function httpService(opts: { origin: string; ownerKey: string }): EngineService {
  const origin = opts.origin.replace(/\/+$/, "");
  const authed = { authorization: `Bearer ${opts.ownerKey}` };
  return {
    async postJson(path, body) {
      const res = await fetch(origin + path, {
        method: "POST",
        headers: {
          ...authed,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { text };
      }
      return { status: res.status, body: parsed };
    },
    async getJson(path) {
      const res = await fetch(origin + path);
      const text = await res.text();
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { text };
      }
      return { status: res.status, body: parsed };
    },
    async getText(path) {
      const res = await fetch(origin + path);
      return { status: res.status, text: await res.text() };
    },
    async getAuthed(path) {
      const res = await fetch(origin + path, { headers: authed });
      return { status: res.status, text: await res.text() };
    },
    async probe(pool) {
      try {
        const res = await fetch(`${origin}/api/pools/${encodeURIComponent(pool)}/stream`);
        await res.arrayBuffer().catch(() => new ArrayBuffer(0));
        return res.status;
      } catch {
        return 0;
      }
    },
    socket(pool) {
      return new WebSocket(
        `${origin.replace(/^http/, "ws")}/api/pools/${encodeURIComponent(pool)}/stream`,
      ) as StreamSocket;
    },
  };
}
