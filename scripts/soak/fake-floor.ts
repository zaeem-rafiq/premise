// A fake Floor for the scripts' unit tests: one pool's event list, answered the way the
// Durable Object answers the reader (01-core 12.2, 03-floor FR30). The plain-GET probe answers
// 404 while the pool has no event and 426 after; a socket gets exactly one `hello` — a second
// message closes it — and a stale `after` answers with a snapshot of the whole reducer state at
// the newest `n`, then only events appended after it. `push` appends events and fans them out
// to the open sockets; `dropAll` closes the sockets mid-run so the reader's reconnect — and the
// gap only the snapshot covers — can be tested. `exportNdjson` renders the owner Replay export
// (12.3): the header plus every event, so the tests' export holds every event.
//
// The fake reduces the product's own reducer, as the Floor itself does; expected values in the
// tests are still worked by hand from the scripted events (BP1), never read back off the fake.

import type { PoolEvent } from "../../src/protocol/events.ts";
import { emptyFloorState, reduce, type FloorState } from "../../src/protocol/reducer/index.ts";
import { REPLAY_FORMAT, type ReplayHeader } from "../../src/protocol/replay.ts";
import type { StreamFrame, StreamHello } from "../../src/protocol/stream.ts";
import type { StreamSocket } from "./stream.ts";

export type FakeSocket = StreamSocket & {
  /** Every message the client sent on this socket — the protocol allows exactly one. */
  sent: string[];
  /** Every frame this socket was sent, before serialization. */
  frames: StreamFrame[];
  closed: boolean;
};

export type FakeFloor = {
  /** FR30's probe: 404 while the pool has no event (and for the first `probeMisses` calls),
   * 426 after. */
  probe(pool: string): Promise<number>;
  /** A fresh stream socket; the hello arrives via `send` after `onopen` fires. */
  socket(pool: string): FakeSocket;
  /** Appends events to the pool's stream and fans them out to helloed open sockets. */
  push(...fresh: PoolEvent[]): void;
  /** Closes every open socket (a mid-run drop). */
  dropAll(code?: number, reason?: string): void;
  /** The owner Replay export: the header plus every event, as NDJSON. */
  exportNdjson(pool: string): string;
  /** Every socket ever opened on this floor. */
  sockets: FakeSocket[];
  /** How many probes have run. */
  probes: number;
  /** How many frames all sockets were sent in total (a snapshot counts once). */
  framesSent: number;
  /** Set true to refuse every further socket (it closes before it ever opens): how a dead
   * stream drives the reader's `dead()` — and the caller's `stream_lost`. */
  refuseSockets: boolean;
};

type Held = {
  ws: FakeSocket;
  after: number | null; // the hello's `after`, then the newest n delivered (EV7's attachment)
};

export function fakeFloor(script: PoolEvent[] = [], opts: { probeMisses?: number } = {}): FakeFloor {
  const events: PoolEvent[] = [];
  const state = emptyFloorState();
  const held: Held[] = [];
  const newestN = (): number => (events.length === 0 ? 0 : (events[events.length - 1] as PoolEvent).n);
  const floor = {
    probes: 0,
    framesSent: 0,
    refuseSockets: false,
    sockets: [] as FakeSocket[],
    async probe(): Promise<number> {
      floor.probes += 1;
      if (floor.probes <= (opts.probeMisses ?? 0)) return 404;
      return events.length === 0 ? 404 : 426;
    },
    socket(): FakeSocket {
      const h: Held = { ws: null as unknown as FakeSocket, after: null };
      if (floor.refuseSockets) {
        const ws = {
          sent: [],
          frames: [],
          closed: false,
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
          send(): void {},
          close(): void {},
        } as FakeSocket;
        floor.sockets.push(ws);
        queueMicrotask(() => {
          ws.closed = true;
          ws.onclose?.({ code: 1006, reason: "refused" });
        });
        return ws;
      }
      const ws: FakeSocket = {
        sent: [],
        frames: [],
        closed: false,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send(data: string): void {
          ws.sent.push(data);
          if (h.after !== null) {
            bye(ws, 1008, "stream_closed"); // any second client message closes the socket
            return;
          }
          let hello: StreamHello;
          try {
            hello = JSON.parse(data) as StreamHello;
          } catch {
            bye(ws, 1007, "bad_message");
            return;
          }
          if (hello?.hello !== 1 || !Number.isInteger(hello.after) || hello.after < 0) {
            bye(ws, 1007, "bad_message");
            return;
          }
          const n = newestN();
          // 12.2: an `after` older than the newest n answers a snapshot of the newest state —
          // a copy the reader may reduce onto without touching the floor's own.
          if (hello.after < n) {
            deliver(h, { snapshot: { n, state: JSON.parse(JSON.stringify(state)) as FloorState } });
          }
          h.after = n;
        },
        close(): void {
          bye(ws, 1000, "closed");
        },
      };
      h.ws = ws;
      floor.sockets.push(ws);
      held.push(h);
      queueMicrotask(() => {
        if (!ws.closed) ws.onopen?.();
      });
      return ws;
    },
    push(...fresh: PoolEvent[]): void {
      for (const event of fresh) {
        events.push(event);
        reduce(state, event);
      }
      for (const h of held) {
        if (h.ws.closed || h.after === null) continue;
        const unseen = fresh.filter((event) => event.n > (h.after as number));
        if (unseen.length === 0) continue;
        deliver(h, { events: unseen });
        h.after = unseen[unseen.length - 1]?.n ?? h.after;
      }
    },
    dropAll(code = 1006, reason = "dropped"): void {
      for (const h of held) {
        if (!h.ws.closed) bye(h.ws, code, reason);
      }
    },
    exportNdjson(pool: string): string {
      const header: ReplayHeader = {
        premise_replay: REPLAY_FORMAT,
        pool,
        recorded_at: new Date(events[events.length - 1]?.t ?? 0).toISOString(),
        events: events.length,
        synthetic: events.some((event) => event.type === "pool.state" && event.synthetic),
        build: "fake",
        label: "live",
      };
      return `${[header, ...events].map((row) => JSON.stringify(row)).join("\n")}\n`;
    },
  };
  function deliver(h: Held, frame: StreamFrame): void {
    if (h.ws.closed) return;
    floor.framesSent += 1;
    h.ws.frames.push(frame);
    const data = JSON.stringify(frame);
    // A real socket is an ordered channel: a frame written before the close still arrives, so
    // the queued message fires even when `dropAll` closes the socket in the same task.
    queueMicrotask(() => {
      h.ws.onmessage?.({ data });
    });
  }
  function bye(ws: FakeSocket, code: number, reason: string): void {
    if (ws.closed) return;
    ws.closed = true;
    queueMicrotask(() => ws.onclose?.({ code, reason }));
  }
  for (const event of script) {
    events.push(event);
    reduce(state, event);
  }
  return floor;
}
