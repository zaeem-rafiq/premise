// The one pool-stream reader of scripts/soak and scripts/measure (01-core 12.2, 03-floor FR30).
//
//   - Before the socket opens, the stream route is probed with a plain GET: 404 means the Floor
//     holds no event of the pool yet (FR30) — wait and probe again; 426 means the route exists
//     and needs the upgrade. The probe runs before every connect, first one and reconnects.
//   - The socket gets exactly one message, `{ "hello": 1, "after": <last n> }` — never a second:
//     the Floor closes the socket on any second client message.
//   - A stale `after` answers with a snapshot frame `{ "snapshot": { "n", "state" } }`: its `n`
//     becomes the last seen and its `state` the current state (12.2 does not replay the events
//     it covers — after a reconnect the snapshot's attempt states are what callers read).
//   - `events` frames apply in `n` order, dropping any `n` already seen.
//   - A socket that closes is reopened through the same probe until the caller closes the
//     reader or `deadlineMs` passes without an applied frame.
//
// The reader is transport-free: the probe, the socket factory, the clock and the sleep are
// injected, so the unit tests drive it against fakes.

import type { PoolEvent } from "../../src/protocol/events.ts";
import type { FloorState } from "../../src/protocol/reducer/index.ts";
import { reduce } from "../../src/protocol/reducer/index.ts";
import type { ReplayHeader } from "../../src/protocol/replay.ts";
import type { StreamFrame, StreamHello } from "../../src/protocol/stream.ts";

/** The part of a WebSocket the reader needs (the browser and undici shapes both fit). */
export type StreamSocket = {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
};

export type PoolStreamEnv = {
  /** A plain GET of `/api/pools/{pool}/stream`, FR30's probe: 404 while the Floor holds no
   * event of the pool, 426 once it does (the route wants the upgrade). Answers the HTTP
   * status, or 0 when the request itself failed. */
  probe(pool: string): Promise<number>;
  /** Opens the pool's stream WebSocket. */
  socket(pool: string): StreamSocket;
  now(): number;
  sleep(ms: number): Promise<void>;
};

export type PoolStreamOpts = {
  /** Give up after this many ms without an applied frame (the first connect's probe phase
   * counts from `openPoolStream`). Default 10 minutes. */
  deadlineMs?: number;
  /** Wait between plain-GET probes while the route answers 404. Default 250 ms. */
  probeMs?: number;
  /** Wait after a socket close before the next probe. Default 1 s. */
  reconnectMs?: number;
  /** Give up after this many consecutive sockets closed without a single frame applied —
   * the caller's `stream_lost` bound. Default: never (the dark bound alone applies). */
  giveUpDrops?: number;
};

export type PoolStream = {
  /** Resolves true once the first frame was applied, false when the stream gave up (or was
   * closed) before it — callers start their work only on true. */
  ready(): Promise<boolean>;
  /** The deduplicated events of the `events` frames, in `n` order. The events a snapshot
   * covers are not in this list — the complete list is the owner Replay export's (12.3). */
  events(): readonly PoolEvent[];
  /** The newest snapshot's state with every event since reduced onto it: the current attempt
   * and pool states, fresh after each applied frame. Null before the first snapshot. */
  state(): FloorState | null;
  /** The highest `n` applied so far (0 before the first frame). */
  lastN(): number;
  /** Waits until another frame is applied, the stream dies or closes, or `deadline`
   * (epoch ms) passes. True when something was applied. */
  wait(deadline: number): Promise<boolean>;
  /** True once the deadline passed with no stream up — the caller's run ends `stream_lost`. */
  dead(): boolean;
  /** Stops the reader: no reconnect, the socket closed, every wait released. */
  close(): void;
};

export function openPoolStream(pool: string, env: PoolStreamEnv, opts: PoolStreamOpts = {}): PoolStream {
  const deadlineMs = opts.deadlineMs ?? 10 * 60_000;
  const probeMs = opts.probeMs ?? 250;
  const reconnectMs = opts.reconnectMs ?? 1_000;
  const giveUpDrops = opts.giveUpDrops ?? Number.POSITIVE_INFINITY;

  const applied: PoolEvent[] = [];
  let state: FloorState | null = null;
  let lastN = 0;
  let frames = 0;
  let lastFrameAt = env.now();
  let stopped = false;
  let dead = false;
  let socket: StreamSocket | null = null;
  let readyDone = false;
  let readyResolve: ((ok: boolean) => void) | null = null;
  let wake: (() => void) | null = null;
  const readyPromise = new Promise<boolean>((resolve) => {
    readyResolve = resolve;
  });

  const settleReady = (ok: boolean): void => {
    if (readyDone) return;
    readyDone = true;
    readyResolve?.(ok);
    readyResolve = null;
  };

  const notify = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };

  const frameApplied = (): void => {
    frames += 1;
    lastFrameAt = env.now();
    settleReady(true);
    notify();
  };

  const apply = (frame: StreamFrame): void => {
    if ("snapshot" in frame) {
      const snapshot = frame.snapshot;
      if (typeof snapshot?.n === "number" && snapshot.n > lastN) {
        lastN = snapshot.n;
        // The reader owns this parsed copy: later events reduce onto it so `state()` is the
        // state at `lastN`, not at the snapshot's `n`.
        state = snapshot.state as FloorState;
      }
      frameApplied();
      return;
    }
    for (const event of frame.events ?? []) {
      if (typeof event.n !== "number" || event.n <= lastN) continue;
      lastN = event.n;
      applied.push(event);
      if (state !== null) reduce(state, event);
    }
    frameApplied();
  };

  /** Ends the reader's work: no reconnect, `dead()` reports the loss, every wait released. */
  const die = (): void => {
    if (dead) return;
    dead = true;
    const ws = socket;
    socket = null;
    try {
      ws?.close();
    } catch {
      // A socket that cannot even close is already gone.
    }
    settleReady(false);
    notify();
  };

  /** The dark bound of the task's deadline: `deadlineMs` with no applied frame gives up. */
  const tooDark = (): boolean => env.now() - lastFrameAt >= deadlineMs;

  /** One socket: the hello on open, frames applied until close. Resolves when it closes. */
  const openSocket = (): Promise<void> =>
    new Promise((resolve) => {
      let ws: StreamSocket;
      try {
        ws = env.socket(pool);
      } catch {
        resolve();
        return;
      }
      socket = ws;
      const bye = (): void => {
        if (socket === ws) socket = null;
        resolve();
      };
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({ hello: 1, after: lastN } satisfies StreamHello));
        } catch {
          // A socket that cannot send is already dying; its close drives the retry.
        }
      };
      ws.onmessage = (message) => {
        let frame: StreamFrame;
        try {
          frame = JSON.parse(String(message.data)) as StreamFrame;
        } catch {
          return; // an unparseable frame is not a frame
        }
        apply(frame);
      };
      ws.onclose = bye;
      ws.onerror = bye;
    });

  const run = async (): Promise<void> => {
    let drops = 0;
    try {
      for (;;) {
        if (stopped || dead) return;
        if (tooDark()) {
          die();
          return;
        }
        // FR30's probe: 404 keeps the pool "not up yet"; 426 lets the socket open. A socket
        // that then 404s the upgrade (the probe answered before the event landed) just closes
        // and the loop probes again — both orderings of the route's checks work.
        let status = 0;
        try {
          status = await env.probe(pool);
        } catch {
          status = 0;
        }
        if (stopped || dead) return;
        if (tooDark()) {
          die();
          return;
        }
        if (status !== 426) {
          await env.sleep(probeMs);
          continue;
        }
        const framesBefore = frames;
        await openSocket();
        if (stopped || dead) return;
        // A socket that applied nothing counts against the give-up bound; one that produced
        // even a snapshot proves the stream flows and resets it.
        drops = frames === framesBefore ? drops + 1 : 0;
        if (drops >= giveUpDrops) {
          die();
          return;
        }
        await env.sleep(reconnectMs);
      }
    } catch {
      die();
    }
  };
  void run();

  return {
    ready: () => readyPromise,
    events: () => applied,
    state: () => state,
    lastN: () => lastN,
    dead: () => dead,
    async wait(deadline: number): Promise<boolean> {
      const mark = frames;
      for (;;) {
        if (frames !== mark) return true;
        if (dead || stopped) return false;
        const left = deadline - env.now();
        if (left <= 0) return false;
        // The deadline timer wakes in hops: a frame in flight a few awaits out must land
        // before the caller's budget is spent, whatever granularity `env.sleep` has.
        await Promise.race([
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
          env.sleep(Math.min(left, 100)),
        ]);
        wake = null;
      }
    },
    close() {
      if (stopped) return;
      stopped = true;
      const ws = socket;
      socket = null;
      try {
        ws?.close();
      } catch {
        // Already gone.
      }
      settleReady(false);
      notify();
    },
  };
}

/** The parsed owner Replay export (01-core 12.3): the header line, then every event in `n`
 * order — the complete event list every reported number is computed from. Throws
 * `SyntaxError` on a malformed line: the caller treats that as an unusable export. */
export function parseReplayNdjson(text: string): { header: ReplayHeader | null; events: PoolEvent[] } {
  const lines = text.split("\n").filter((line) => line !== "");
  if (lines.length === 0) return { header: null, events: [] };
  const header = JSON.parse(lines[0] as string) as ReplayHeader;
  const events = lines.slice(1).map((line) => JSON.parse(line) as PoolEvent);
  return { header, events };
}
