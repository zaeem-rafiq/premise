// FR10 (03-floor.md section 7, amended 2026-10-05): the Floor sends `metrics` to every open socket
// every METRICS_EVERY_MS (EM5), so an open socket that carries no frame for STREAM_SILENCE_MS is
// dead even though no close event came (a half-open connection after a network drop). The page
// closes it and reconnects, asking for the events after its last `n`. Fake socket, clock and
// timers; expected behaviour from FR10 and Appendix A, not from the module's output (BP1).

import { describe, expect, it } from "vitest";
import { METRICS_EVERY_MS, STREAM_SILENCE_MS, WS_RETRY_BASE_MS } from "../../protocol/constants.ts";
import type { PoolEvent } from "../../protocol/events.ts";
import { openLiveStream } from "./live.ts";
import type { Connection, LiveEnv, SocketLike } from "./live.ts";

class FakeSocket implements SocketLike {
  url: string;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness() {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sockets: FakeSocket[] = [];
  const connections: Connection[] = [];
  const applied: number[] = [];
  const env: LiveEnv = {
    // FR30's probe: 426 is a pool that exists and wants the upgrade.
    get: (async () => new Response(null, { status: 426 })) as unknown as typeof fetch,
    origin: "https://floor.test",
    socket(url) {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    now: () => now,
    setTimeout(fn, ms) {
      next += 1;
      timers.set(next, { at: now + ms, fn });
      return next;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  /** Moves the clock by `ms`, running every timer that falls due, earliest first. */
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await flush();
    }
    now = end;
    await flush();
  };
  const handle = openLiveStream("tidepool", env, {
    onSnapshot(n) {
      applied.push(n);
    },
    onEvents(events) {
      for (const event of events) applied.push(event.n);
    },
    onConnection(connection) {
      connections.push(connection);
    },
    onMissing() {},
  });
  return { sockets, connections, applied, advance, handle };
}

/** One `events` frame holding a `metrics` event numbered `n`, as the Floor's tick sends it. */
function tick(socket: FakeSocket, n: number): void {
  const event = { n, t: n, ts: n, pool: "tidepool", src: "floor", type: "metrics" } as unknown as PoolEvent;
  socket.onmessage?.({ data: JSON.stringify({ events: [event] }) });
}

describe("FR10: a silent open socket is replaced", () => {
  it("no frame for STREAM_SILENCE_MS: the socket is closed and a new one asks after the last n", async () => {
    const h = harness();
    await h.advance(0);
    expect(h.sockets).toHaveLength(1);
    const first = h.sockets[0]!;
    first.onopen?.();
    expect(first.sent).toEqual([JSON.stringify({ hello: 1, after: 0 })]);
    tick(first, 7);

    // One millisecond short of the silence limit nothing happens.
    await h.advance(STREAM_SILENCE_MS - 1);
    expect(first.closed).toBe(false);
    expect(h.sockets).toHaveLength(1);

    // At the limit the page gives the socket up, waits WS_RETRY_BASE_MS and connects again.
    await h.advance(1);
    expect(first.closed).toBe(true);
    await h.advance(WS_RETRY_BASE_MS);
    expect(h.sockets).toHaveLength(2);
    const second = h.sockets[1]!;
    second.onopen?.();
    expect(second.sent).toEqual([JSON.stringify({ hello: 1, after: 7 })]);
    // A quick reconnect is "connecting", never "lost" (lost needs OFFLINE_AFTER_MS without a socket).
    expect(h.connections).not.toContain("lost");
    tick(second, 8);
    expect(h.applied).toEqual([7, 8]);
    h.handle.close();
  });

  it("a socket that carries the Floor's tick every METRICS_EVERY_MS is never replaced", async () => {
    const h = harness();
    await h.advance(0);
    const only = h.sockets[0]!;
    only.onopen?.();
    for (let n = 1; n <= (3 * STREAM_SILENCE_MS) / METRICS_EVERY_MS; n += 1) {
      tick(only, n);
      await h.advance(METRICS_EVERY_MS);
    }
    expect(h.sockets).toHaveLength(1);
    expect(only.closed).toBe(false);
    h.handle.close();
  });

  it("the given-up socket's late close event opens no second reconnect", async () => {
    const h = harness();
    await h.advance(0);
    const first = h.sockets[0]!;
    first.onopen?.();
    tick(first, 3);
    await h.advance(STREAM_SILENCE_MS + WS_RETRY_BASE_MS);
    expect(h.sockets).toHaveLength(2);
    // The dead connection's close finally arrives: it must not count as a second loss.
    first.onclose?.({ code: 1006, reason: "" });
    await h.advance(4 * WS_RETRY_BASE_MS);
    expect(h.sockets).toHaveLength(2);
    h.handle.close();
  });

  it("closing the stream stops the silence watch", async () => {
    const h = harness();
    await h.advance(0);
    const first = h.sockets[0]!;
    first.onopen?.();
    tick(first, 1);
    h.handle.close();
    await h.advance(3 * STREAM_SILENCE_MS);
    expect(h.sockets).toHaveLength(1);
  });
});
