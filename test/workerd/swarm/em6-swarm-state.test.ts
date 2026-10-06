// Slice 8 acceptance item 1 — EM6 and EV2a in local workerd over the built bundle:
//
//   - a pool's registration sends it the current `swarm.state`, and every later change of what
//     is running reaches the stream of every registered pool with `src` "swarm";
//   - each pool numbers the source by its own `(epoch, source_n)` counter: one pool's counter
//     has nothing to do with another's;
//   - a Floor whose counter already moved answers `gap`, and the emit lands at the counter it
//     expects — at least once, never twice;
//   - a repeated request and a restarted Worker neither lose the registration nor re-deliver.
//
// Expected values are worked from 01-core EV2a/EM6 and SWR4 (BP1): a second pool's registration
// emits once to it and once to the first pool (the `pools` list changed); a run's start, a dial
// move and a stop each emit exactly one `swarm.state`.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSwarmWorker, waitFor, type SwarmWorker } from "./harness.ts";

const KEY = "owner-key-for-tests-0123456789abcdef";
const SEED = "tidepool";

type SwarmEvent = {
  n: number;
  ts: number;
  src: string;
  type: string;
  synthetic: boolean;
  running: boolean;
  agents: number;
  collision_dial: number;
  pools: string[];
};

async function swarmEvents(worker: SwarmWorker, pool: string): Promise<SwarmEvent[]> {
  const events = (await worker.events(pool)) as unknown as SwarmEvent[];
  return events.filter((event) => event.type === "swarm.state");
}

async function createPool(worker: SwarmWorker, pool: string, requestId: string): Promise<void> {
  const response = await worker.owner("/api/pools", {
    pool,
    seed: SEED,
    summary_only: false,
    request_id: requestId,
  });
  expect(response.status).toBe(200);
}

describe("EM6/EV2a: swarm.state reaches every registered pool, each on its own counter", () => {
  let worker: SwarmWorker;

  beforeAll(async () => {
    worker = await startSwarmWorker({ ownerKey: KEY });
  }, 60_000);

  afterAll(async () => {
    await worker?.dispose();
  });

  it("registration emits the current state; a second pool updates `pools` on both streams", async () => {
    await createPool(worker, "sw-a", "reg-a");
    // The first registration emits once to the new pool: idle state, its own source_n 1.
    await waitFor(async () => (await swarmEvents(worker, "sw-a")).length >= 1);
    const first = (await swarmEvents(worker, "sw-a"))[0]!;
    expect(first).toMatchObject({
      src: "swarm",
      synthetic: true,
      running: false,
      agents: 0,
      collision_dial: 0,
      pools: ["sw-a"],
    });

    await createPool(worker, "sw-b", "reg-b");
    // The second registration emits to BOTH pools: sw-b gets its first state (source_n 1 of
    // its own counter), sw-a its second (source_n 2) — the pools list changed.
    await waitFor(async () => (await swarmEvents(worker, "sw-b")).length >= 1);
    await waitFor(async () => (await swarmEvents(worker, "sw-a")).length >= 2);
    const onB = (await swarmEvents(worker, "sw-b"))[0]!;
    expect(onB).toMatchObject({ src: "swarm", running: false });
    expect(onB.pools.sort()).toEqual(["sw-a", "sw-b"]);
    const onA = await swarmEvents(worker, "sw-a");
    expect(onA[1]!.pools.sort()).toEqual(["sw-a", "sw-b"]);
  });

  it("a run's start, a dial move and a stop each emit to every pool", async () => {
    // SWR1: a run on sw-a. agents 0 keeps the test to the emit contract — the launch loop is
    // exercised by the route's own tests and the landing lane's.
    const start = await worker.owner("/api/swarm", {
      pool: "sw-a",
      running: true,
      seed: 7,
      agents: 0,
      launch_per_second: 1,
      collision_dial: 0.3,
      think_ms: [0, 0],
      rescale_every_s: 60,
      request_id: "run-1",
    });
    expect(start.status).toBe(200);
    for (const pool of ["sw-a", "sw-b"]) {
      await waitFor(async () =>
        (await swarmEvents(worker, pool)).some((event) => event.running === true && event.agents === 0),
      );
    }
    const onB = (await swarmEvents(worker, "sw-b")).at(-1)!;
    expect(onB).toMatchObject({ src: "swarm", running: true, agents: 0, collision_dial: 0.3 });

    // CO44a: a dial move during the run emits the new collision_dial everywhere.
    const dial = await worker.owner("/api/swarm", {
      pool: "sw-a",
      running: true,
      collision_dial: 0.8,
      request_id: "dial-1",
    });
    expect(dial.status).toBe(200);
    for (const pool of ["sw-a", "sw-b"]) {
      await waitFor(async () => (await swarmEvents(worker, pool)).some((event) => event.collision_dial === 0.8));
    }

    // Stop: `running` goes false on every stream.
    const stop = await worker.owner("/api/swarm", {
      pool: "sw-a",
      running: false,
      request_id: "stop-1",
    });
    expect(stop.status).toBe(200);
    for (const pool of ["sw-a", "sw-b"]) {
      await waitFor(async () =>
        (await swarmEvents(worker, pool)).some((event) => event.running === false && event.collision_dial === 0.8),
      );
    }
    // The run itself heard the stop and ended: the streams' `running: false` is not a stand-in
    // emitted beside a run that keeps launching (SWR1).
    const swarm = await worker.swarm();
    await waitFor(async () => (await swarm.status("run-sw-a")) === "complete");
  });

  it("a pool whose swarm counter already moved still gets the event once (EV2a resend)", async () => {
    // Stand in for a Floor that stored rows 1 and 2 of source "swarm" — e.g. a crash between
    // the append and the launcher's view of the confirm. The emit must not land at 1 or 2;
    // the Floor's `gap` answer names its `last_n + 1`, and the emit lands there exactly once.
    const fake = {
      ts: 1,
      pool: "sw-b",
      src: "swarm",
      type: "swarm.state",
      synthetic: true,
      running: false,
      agents: 0,
      collision_dial: 0,
      pools: ["sw-b"],
    };
    const append = (events: Array<{ source_n: number; event: unknown }>) =>
      worker.floor("sw-b").fetch("/internal/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "swarm", epoch: 1, events }),
      });
    // The counter first: a probe the stream can never take is refused `gap` with the expected
    // `source_n` (EV2a's resend handshake — the same mechanism the emitter uses).
    const probe = await append([{ source_n: Number.MAX_SAFE_INTEGER, event: fake }]);
    expect(probe.status).toBe(409);
    const expected = ((await probe.json()) as { error: { expected: number } }).error.expected;
    const injected = await append([expected, expected + 1].map((source_n) => ({ source_n, event: fake })));
    expect(injected.status).toBe(200);

    const next = await worker.owner("/api/swarm", {
      pool: "sw-a",
      running: true,
      collision_dial: 0.4,
      request_id: "dial-2",
    });
    expect(next.status).toBe(200);
    // sw-b's counter stood at `expected + 1`: the emit lands past the injected pair on the
    // stream — and sw-a's own counter is untouched by sw-b's.
    await waitFor(async () => {
      const events = await swarmEvents(worker, "sw-b");
      return events.some((event) => event.collision_dial === 0.4 && event.pools.length === 2);
    });
    const onB = await swarmEvents(worker, "sw-b");
    const real = onB.filter((event) => event.collision_dial === 0.4);
    expect(real).toHaveLength(1); // exactly once, not once per retry
    const injectedNs = onB.filter((event) => event.collision_dial === 0 && event.pools.length === 1);
    expect(injectedNs).toHaveLength(2);
    // sw-a got the same emit on its own counter — one event, the latest.
    const onA = await swarmEvents(worker, "sw-a");
    expect(onA.at(-1)!.collision_dial).toBe(0.4);
  });

  it("a repeated request id and a repeated state do not duplicate the stream event", async () => {
    const before = await swarmEvents(worker, "sw-a");
    // SWR4: the same request_id answers `already` and emits nothing new.
    const again = await worker.owner("/api/swarm", {
      pool: "sw-a",
      running: true,
      collision_dial: 0.4,
      request_id: "dial-2",
    });
    expect(await again.json()).toMatchObject({ ok: true, already: true });
    // And a different request id carrying an unchanged state is deduplicated at the Floor.
    const same = await worker.owner("/api/swarm", {
      pool: "sw-a",
      running: true,
      collision_dial: 0.4,
      request_id: "dial-3",
    });
    expect(same.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const after = await swarmEvents(worker, "sw-a");
    expect(after).toEqual(before);
  });
});

describe("EM6/EV2a across a Worker restart (the registrations and counters are durable)", () => {
  it("a second Worker on the same storage keeps the counters and does not re-deliver", async () => {
    const first = await startSwarmWorker({ ownerKey: KEY });
    const storageDir = first.storageDir;
    try {
      await createPool(first, "sw-r", "reg-r");
      await waitFor(async () => (await swarmEvents(first, "sw-r")).length >= 1);
      await first.dispose();
    } catch (cause) {
      await first.dispose();
      throw cause;
    }

    // A second Worker over the same object storage is the restart of EV2a's durability clause.
    const second = await startSwarmWorker({ ownerKey: KEY, storageDir });
    try {
      // The restart lost nothing the Floor stored: the emit lands on the stream exactly once
      // more, numbered past the rows the first Worker confirmed.
      await createPool(second, "sw-r2", "reg-r2");
      await waitFor(async () => (await swarmEvents(second, "sw-r")).some((event) => event.pools.includes("sw-r2")));
      const events = await swarmEvents(second, "sw-r");
      // The old pool's counter kept counting: no `swarm.state` repeats an earlier one.
      const keys = events.map(
        (event) => `${event.running}:${event.agents}:${event.collision_dial}:${event.pools.join(",")}`,
      );
      expect(new Set(keys).size).toBe(keys.length);
      expect((await swarmEvents(second, "sw-r2")).length).toBe(1);
    } finally {
      await second.dispose();
    }
  }, 90_000);
});
