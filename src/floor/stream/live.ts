// The live stream: `GET /api/pools/{pool}/stream` (13.6), then the read-only socket of
// `01-core.md` 12.2 — the page sends exactly one message `{ hello: 1, after: n }` and
// receives a snapshot and/or `events` frames in `n` order. A non-upgrade GET on the route
// is the pool-missing probe of FR30: the Floor answers 404 for an unknown pool and 426 for
// a real one, which the browser's WebSocket API cannot see on its own (a failed handshake
// hides the status). Reconnects with waits from WS_RETRY_BASE_MS doubling to
// WS_RETRY_MAX_MS (FR10), asking for events after the last applied `n`. The Floor sends
// `metrics` to every open socket each METRICS_EVERY_MS (EM5), so an open socket that carries no
// frame for STREAM_SILENCE_MS is dead although no close event came — a half-open connection
// after a network drop, which a browser can take minutes to notice. It is given up and replaced.

import { OFFLINE_AFTER_MS, STREAM_SILENCE_MS, WS_RETRY_BASE_MS, WS_RETRY_MAX_MS } from "../../protocol/constants.ts";
import type { PoolEvent } from "../../protocol/events.ts";
import type { FloorState } from "../../protocol/reducer/state.ts";
import type { StreamFrame, StreamHello } from "../../protocol/stream.ts";
import { streamPath } from "./urls.ts";

export type Connection = "connecting" | "open" | "lost";

export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
}

export type LiveEnv = {
  get: typeof fetch;
  origin: string; // ws/wss scheme is derived from it
  socket(url: string): SocketLike;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type LiveCallbacks = {
  onSnapshot(n: number, state: FloorState): void;
  onEvents(events: PoolEvent[]): void;
  onConnection(connection: Connection, tries: number): void;
  onMissing(): void; // FR30: the stream of the pool in /p/{pool} answered 404
};

export function wsUrl(pool: string, origin: string): string {
  const base = origin.replace(/^http/, "ws");
  return `${base}${streamPath(pool)}`;
}

/** One live-stream session. `close()` stops every retry and the socket. */
export function openLiveStream(pool: string, env: LiveEnv, cb: LiveCallbacks): { close(): void } {
  let closed = false;
  let socket: SocketLike | null = null;
  let timer: unknown = null;
  let tries = 0;
  let lastN = 0;
  let lostSince: number | null = null;
  let lastFrameAt = 0;
  let silence: unknown = null;

  const say = (connection: Connection) => cb.onConnection(connection, tries);
  const after = (ms: number, fn: () => void) => {
    timer = env.setTimeout(fn, ms);
  };

  const markDead = () => {
    if (closed) return;
    if (lostSince === null) lostSince = env.now();
    const elapsed = env.now() - lostSince;
    tries += 1;
    say(elapsed >= OFFLINE_AFTER_MS ? "lost" : "connecting");
    const wait = Math.min(WS_RETRY_BASE_MS * 2 ** Math.max(0, tries - 1), WS_RETRY_MAX_MS);
    after(wait, () => void attempt());
  };

  const stopSilenceWatch = () => {
    if (silence !== null) env.clearTimeout(silence);
    silence = null;
  };

  /** FR10: checks the open socket for silence; a check that finds a recent frame re-arms for the rest. */
  const watchSilence = (ws: SocketLike, ms: number) => {
    silence = env.setTimeout(() => {
      silence = null;
      if (closed || socket !== ws) return;
      const quiet = env.now() - lastFrameAt;
      if (quiet < STREAM_SILENCE_MS) {
        watchSilence(ws, STREAM_SILENCE_MS - quiet);
        return;
      }
      // Detached first: the dead connection's close may still arrive, and must not count twice.
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      socket = null;
      try {
        ws.close();
      } catch {
        // A socket that cannot even close is already gone; the reconnect below is what matters.
      }
      markDead();
    }, ms);
  };

  const openSocket = () => {
    if (closed) return;
    const ws = env.socket(wsUrl(pool, env.origin));
    socket = ws;
    ws.onopen = () => {
      const hello: StreamHello = { hello: 1, after: lastN };
      ws.send(JSON.stringify(hello));
      socket = ws;
      lastFrameAt = env.now();
      stopSilenceWatch();
      watchSilence(ws, STREAM_SILENCE_MS);
    };
    ws.onmessage = (event) => {
      if (closed) return;
      lastFrameAt = env.now();
      let frame: StreamFrame;
      try {
        frame = JSON.parse(String(event.data)) as StreamFrame;
      } catch {
        return;
      }
      lostSince = null;
      tries = 0;
      say("open");
      if ("snapshot" in frame) {
        lastN = Math.max(lastN, frame.snapshot.n);
        cb.onSnapshot(frame.snapshot.n, frame.snapshot.state as FloorState);
      } else {
        cb.onEvents(frame.events);
        const last = frame.events[frame.events.length - 1];
        if (last !== undefined) lastN = Math.max(lastN, last.n);
      }
    };
    ws.onclose = () => {
      socket = null;
      stopSilenceWatch();
      markDead();
    };
    ws.onerror = () => {
      // The close event follows; nothing to do here.
    };
  };

  const attempt = async () => {
    if (closed) return;
    say(
      tries === 0
        ? "connecting"
        : lostSince !== null && env.now() - lostSince >= OFFLINE_AFTER_MS
          ? "lost"
          : "connecting",
    );
    try {
      // FR30: a plain GET on the stream route — 404 means the pool does not exist
      // (`{"error":"not_found"}` of the Floor), 426 means it does but needs the upgrade.
      const response = await env.get(streamPath(pool));
      if (closed) return;
      if (response.status === 404) {
        let missing = false;
        try {
          const body = (await response.json()) as { error?: string };
          missing = body.error === "not_found";
        } catch {
          missing = false; // a dev server's 404 page: unreachable, not "no pool"
        }
        if (missing) {
          cb.onMissing();
          return;
        }
      }
      openSocket();
    } catch {
      markDead();
    }
  };

  void attempt();

  return {
    close() {
      closed = true;
      if (timer !== null) env.clearTimeout(timer);
      stopSilenceWatch();
      socket?.close();
      socket = null;
    },
  };
}
