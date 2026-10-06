// The deployed `test` service as the measurement's transport (ME7): the owner routes go over HTTP
// with the owner key as a bearer token (BP7: the key rides the Authorization header only — it is
// never written to a file or a log), and the pool's event stream (01-core 12.2) is a WebSocket.
// `EngineService` is the injected seam: the unit tests replay canned events through a fake and
// never touch the network.

import type { PoolEvent } from "../../../src/protocol/events.ts";
import type { Clock } from "../early/run.ts";

export type EngineResponse = { status: number; body: unknown };

/** The stream of one pool. `next(deadline)` answers the next event after the cursor, or null when
 * `deadline` (epoch ms) passes with none. A socket that drops is reopened with `after: <last n>`;
 * events already seen are not delivered twice (dedupe by `n`). */
export type EngineStream = {
  next(deadline: number): Promise<PoolEvent | null>;
  events(): readonly PoolEvent[];
  /** True once the socket gave up after `MAX_RECONNECTS` — the run then ends `stream_lost`,
   * not `timeout`. */
  dead(): boolean;
  close(): void;
};

export type EngineService = {
  postJson(path: string, body: unknown): Promise<EngineResponse>;
  getJson(path: string): Promise<EngineResponse>;
  getText(path: string): Promise<{ status: number; text: string }>;
  openStream(pool: string): EngineStream;
};

/** The part of the global `WebSocket` the stream needs; `lib.dom` is not in this program, so the
 * global is read through `globalThis` (Node 22 carries the undici implementation). */
type WsLike = {
  onopen: (() => void) | null;
  onmessage: ((m: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
};

const MAX_RECONNECTS = 5;
const RECONNECT_MS = 1_000;

function wsStream(origin: string, pool: string, clock: Clock): EngineStream {
  const events: PoolEvent[] = [];
  let cursor = 0;
  let lastN = 0;
  let stopped = false; // the caller closed us
  let dead = false; // the socket gave up
  let tries = 0;
  let ws: WsLike | null = null;
  let wake: (() => void) | null = null;

  const connect = (): void => {
    if (stopped || dead) return;
    const WebSocketImpl = (globalThis as Record<string, unknown>).WebSocket as
      (new (url: string) => WsLike) | undefined;
    if (WebSocketImpl === undefined) {
      dead = true;
      wake?.();
      return;
    }
    const url = `${origin.replace(/^http/, "ws")}/api/pools/${encodeURIComponent(pool)}/stream`;
    const sock = new WebSocketImpl(url);
    ws = sock;
    sock.onopen = () => {
      tries = 0;
      sock.send(JSON.stringify({ hello: 1, after: lastN }));
    };
    sock.onmessage = (m) => {
      let frame: { events?: PoolEvent[] };
      try {
        frame = JSON.parse(String(m.data)) as { events?: PoolEvent[] };
      } catch {
        return;
      }
      for (const event of frame.events ?? []) {
        if (typeof event.n !== "number" || event.n <= lastN) continue;
        lastN = event.n;
        events.push(event);
        wake?.();
      }
    };
    const dropped = (): void => {
      ws = null;
      if (stopped) return;
      tries++;
      if (tries > MAX_RECONNECTS) {
        dead = true;
        wake?.();
        return;
      }
      void clock.sleep(RECONNECT_MS).then(connect);
    };
    sock.onclose = dropped;
    sock.onerror = () => {
      // `onclose` follows; nothing to do here.
    };
  };
  connect();

  return {
    events: () => events,
    dead: () => dead,
    close() {
      stopped = true;
      try {
        ws?.close();
      } catch {
        // a half-open socket throws on close; the flag is set either way
      }
    },
    async next(deadline: number): Promise<PoolEvent | null> {
      for (;;) {
        if (cursor < events.length) return events[cursor++] as PoolEvent;
        if (dead || stopped || clock.now() >= deadline) return null;
        const wait = Math.max(1, Math.min(deadline - clock.now(), 60_000));
        await Promise.race([new Promise<void>((resolve) => (wake = resolve)), clock.sleep(wait)]);
        wake = null;
      }
    },
  };
}

/**
 * The real wiring: `origin` is `PREMISE_URL`, `ownerKey` is `PREMISE_OWNER_KEY`. The key is sent as
 * `Authorization: Bearer` on POSTs alone (the public GETs do not need it); it never enters a URL, a
 * body, or a returned value.
 */
export function httpService(opts: { origin: string; ownerKey: string; clock: Clock }): EngineService {
  const origin = opts.origin.replace(/\/+$/, "");
  return {
    async postJson(path, body) {
      const res = await fetch(origin + path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.ownerKey}`,
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
    openStream(pool) {
      return wsStream(origin, pool, opts.clock);
    },
  };
}
