// The shared pool-stream reader's unit tests: the fake Floor answers probe and socket the way
// 01-core 12.2 and FR30 describe — 404 while the pool has no event, a snapshot for a stale
// `after`, only new events after it, one message per socket — and the assertions come from the
// events the test writes, never read back off the reader (BP1).

import { describe, expect, it } from "vitest";
import type { PoolEvent } from "../../src/protocol/events.ts";
import { fakeFloor, type FakeFloor } from "./fake-floor.ts";
import { openPoolStream, parseReplayNdjson, type PoolStreamEnv } from "./stream.ts";

const T = 1_700_000_000_000;
let n = 0;

function ev(ts: number, type: string, fields: Record<string, unknown> = {}): PoolEvent {
  n += 1;
  return { n, t: ts, ts, pool: "p-test", src: "trunk", type, ...fields } as PoolEvent;
}

const poolState = (ts: number) =>
  ev(ts, "pool.state", {
    head_seq: 0,
    head_commit: "",
    green_seq: 0,
    landed_seq: 0,
    landed_commit: "",
    state: "ready",
    reason: null,
    epoch: 1,
    remote: "https://artifacts.example.test/p-test",
    plain_remote: null,
    app: "tidepool",
    source: null,
    rebuild: null,
    unwitnessed: [],
    real_agents: 0,
    max_real_agents: 0,
    synthetic: true,
    summary_only: true,
  });

const opened = (ts: number, attempt: string) =>
  ev(ts, "attempt.opened", {
    attempt_id: attempt,
    intent_id: `i_${attempt}`,
    change_id: `c_${attempt}`,
    agent: "synthetic",
    model: null,
    race: false,
  });

const attemptState = (ts: number, attempt: string, to: string) =>
  ev(ts, "attempt.state", {
    attempt_id: attempt,
    from: "working",
    to,
    transition: `working->${to}`,
    reason: to === "stopped" ? "budget" : null,
    go_arounds: 0,
    pull_backs: 0,
    right_of_way: false,
  });

type TestEnv = PoolStreamEnv & { at(): number };

/** A fake clock + the floor's transport as the reader's env. `at` advances on every sleep. */
function env(floor: FakeFloor, at = 0): TestEnv {
  let now = at;
  return {
    at: () => now,
    probe: (pool) => floor.probe(pool),
    socket: (pool) => floor.socket(pool),
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

const OPTS = { probeMs: 10, reconnectMs: 10, deadlineMs: 100_000 };

describe("the shared pool-stream reader", () => {
  it("probes the route until it answers 426, then opens the socket and reads the first frame", async () => {
    n = 0;
    const floor = fakeFloor([poolState(T)], { probeMisses: 2 }); // 404, 404, then 426 (FR30)
    const stream = openPoolStream("p-test", env(floor), OPTS);
    expect(await stream.ready()).toBe(true);
    expect(floor.probes).toBe(3); // two 404s before the route existed
    const hello = JSON.parse(floor.sockets[0]?.sent[0] ?? "{}") as { hello?: number; after?: number };
    expect(hello).toEqual({ hello: 1, after: 0 });
    // The pool's one event was already appended: the first frame is the snapshot, not events.
    expect(floor.sockets[0]?.frames[0]).toHaveProperty("snapshot");
    stream.close();
  });

  it("a first-frame snapshot becomes the state; the events it covers are not replayed", async () => {
    n = 0;
    const floor = fakeFloor([poolState(T), opened(T + 10, "a1")]);
    const e = env(floor);
    const stream = openPoolStream("p-test", e, OPTS);
    expect(await stream.ready()).toBe(true);
    expect(stream.lastN()).toBe(2);
    expect(stream.state()?.attempts["a1"]?.state).toBe("opened");
    // The snapshot covers events 1 and 2: they are not delivered again as `events` frames.
    expect(stream.events()).toHaveLength(0);
    // A newer event arrives as an events frame and reduces onto the snapshot's state.
    floor.push(attemptState(T + 20, "a1", "landed"));
    expect(await stream.wait(e.at() + 2000)).toBe(true);
    expect(stream.events().map((e) => e.n)).toEqual([3]);
    expect(stream.state()?.attempts["a1"]?.state).toBe("landed");
    stream.close();
  });

  it("a dropped socket is reopened with after:<last n>; the snapshot covers the gap", async () => {
    n = 0;
    const floor = fakeFloor([poolState(T), opened(T + 10, "a1")]);
    const e = env(floor);
    const stream = openPoolStream("p-test", e, OPTS);
    expect(await stream.ready()).toBe(true);
    floor.push(attemptState(T + 20, "a1", "working"), opened(T + 30, "a2"));
    expect(await stream.wait(e.at() + 2000)).toBe(true);
    expect(stream.lastN()).toBe(4);

    // The socket dies; while it is down the pool keeps appending (the gap).
    floor.dropAll();
    floor.push(attemptState(T + 40, "a2", "working"), attemptState(T + 50, "a1", "stopped"));
    expect(await stream.wait(e.at() + 2000)).toBe(true); // the reconnect's snapshot is a frame
    expect(floor.sockets).toHaveLength(2);
    // The reconnect hello asks for events after the last applied n — 4.
    const hello = JSON.parse(floor.sockets[1]?.sent[0] ?? "{}") as { hello?: number; after?: number };
    expect(hello).toEqual({ hello: 1, after: 4 });
    // The reconnect's first frame is the snapshot at n=6: the gap's events are not replayed.
    expect(floor.sockets[1]?.frames[0]).toMatchObject({ snapshot: { n: 6 } });
    expect(stream.events().map((e) => e.n)).toEqual([3, 4]);
    // ... but the snapshot's state carries them: `a1` stopped, `a2` working.
    expect(stream.state()?.attempts["a1"]?.state).toBe("stopped");
    expect(stream.state()?.attempts["a2"]?.state).toBe("working");
    floor.push(attemptState(T + 60, "a2", "landed"));
    expect(await stream.wait(e.at() + 2000)).toBe(true);
    expect(stream.events().map((e) => e.n)).toEqual([3, 4, 7]);
    stream.close();
  });

  it("sends exactly one hello on each socket and drops an event whose n was already seen", async () => {
    n = 0;
    const script = [poolState(T), opened(T + 10, "a1")];
    const floor = fakeFloor(script);
    const e = env(floor);
    const stream = openPoolStream("p-test", e, OPTS);
    expect(await stream.ready()).toBe(true);
    floor.dropAll();
    floor.push(attemptState(T + 20, "a1", "working")); // appended in the gap
    expect(await stream.wait(e.at() + 2000)).toBe(true); // the reconnect's snapshot
    expect(floor.sockets).toHaveLength(2);
    for (const socket of floor.sockets) {
      expect(socket.sent).toHaveLength(1); // one hello per socket, never a second message
    }
    expect(JSON.parse(floor.sockets[0]?.sent[0] ?? "{}")).toEqual({ hello: 1, after: 0 });
    expect(JSON.parse(floor.sockets[1]?.sent[0] ?? "{}")).toEqual({ hello: 1, after: 2 });
    // An events frame carrying an already-seen n is dropped, not applied twice (12.2 dedupe).
    const again = JSON.stringify({ events: [script[1]] }); // n=2, already applied via snapshots
    floor.sockets[1]?.onmessage?.({ data: again });
    expect(stream.lastN()).toBe(3);
    expect(stream.events()).toHaveLength(0);
    stream.close();
  });

  it("a pool that never gets an event goes dead before ready: probe 404 past the deadline", async () => {
    n = 0;
    const floor = fakeFloor([]); // the Floor holds no event — every probe answers 404 (FR30)
    const stream = openPoolStream("p-test", env(floor), { probeMs: 10, deadlineMs: 100 });
    expect(await stream.ready()).toBe(false);
    expect(stream.dead()).toBe(true);
    stream.close();
  });

  it("the export parse yields the header and every event in n order", () => {
    n = 0;
    const events = [poolState(T), opened(T + 10, "a1"), attemptState(T + 20, "a1", "landed")];
    const floor = fakeFloor(events);
    const parsed = parseReplayNdjson(floor.exportNdjson("p-test"));
    expect(parsed.header).toMatchObject({ premise_replay: 2, pool: "p-test", events: 3 });
    expect(parsed.events.map((e) => e.n)).toEqual([1, 2, 3]);
    expect(parsed.events).toEqual(events);
  });
});
