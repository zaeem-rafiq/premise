import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KEY, bearer, createPool, eventsOf, openAttempt, tool, waitFor } from "../collide/helpers.ts";
import { startLandingWorker, type LandingWorker } from "./harness.ts";

const POOLS = ["epoch-confirmation", "epoch-missing-first"];
let worker: LandingWorker;

async function land(pool: string, id: string, count: number): Promise<void> {
  await openAttempt(worker, pool, id);
  await tool(
    worker,
    pool,
    id,
    { tool: "write", args: { path: `creatures/${id}.js`, content: `export const value = ${count};\n` } },
    1,
  );
  await tool(worker, pool, id, { tool: "submit", args: { summary: `add ${id}` } }, 2);
  await waitFor(async () => (await eventsOf(worker, pool, "landing.landed")).length === count, 30_000);
}

async function meta(pool: string): Promise<Record<string, string>> {
  return ((await worker.trunk(pool).state()) as { meta: Record<string, string> }).meta;
}

async function pending(pool: string) {
  return worker.sql("TRUNK", pool, "SELECT n, ts, body, sent FROM events_out ORDER BY n");
}

async function source(pool: string) {
  return (await worker.sql("FLOOR", pool, "SELECT epoch, last_n FROM sources WHERE source = 'trunk'"))[0];
}

async function rebuild(pool: string): Promise<void> {
  const response = await worker.fetch(`/api/pools/${pool}/rebuild`, bearer({ request_id: `rebuild-${pool}` }));
  expect(response.status, await response.clone().text()).toBe(200);
  await waitFor(async () => {
    await worker.runAlarm(pool, Date.now() + 60_000);
    const state = await meta(pool);
    return state.rebuild_cursor === undefined && state.pool_state === "ready";
  }, 30_000);
}

function message(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no stream message in 4 s")), 4_000);
    ws.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
      },
      { once: true },
    );
  });
}

describe("EV2/RB5: rebuilt Trunk resumes its Floor stream in local workerd", () => {
  beforeAll(async () => {
    // Static green line: the fixtures' files fail the isolate's self-test, and a take-back would
    // add landings this delivery test does not expect.
    worker = await startLandingWorker({
      ownerKey: KEY,
      repos: POOLS,
      floorFaults: true,
      features: { green: "static" },
    });
  }, 60_000);
  afterAll(async () => worker?.dispose());

  it.each(POOLS)(
    "%s: rebuild with pending events, then a later landing reaches the stream",
    async (pool) => {
      await createPool(worker, pool, { seed: "tidepool", summary_only: true });
      await land(pool, `${pool}-before-1`, 1);
      await land(pool, `${pool}-before-2`, 2);
      expect(await source(pool)).toMatchObject({ epoch: 1 });

      const hold = pool === POOLS[0];
      await worker.setFloorFault(pool, hold ? "hold" : "block");
      let oldRequest: Promise<void> | undefined;
      try {
        if (hold) {
          oldRequest = openAttempt(worker, pool, `${pool}-inflight`);
          await waitFor(async () => (await worker.floorFaultState(pool)).held, 5_000);
          expect(await worker.floorFaultState(pool)).toMatchObject({ held: true, epoch: 1 });
        }
        await openAttempt(worker, pool, `${pool}-pending`);
        expect((await pending(pool)).length).toBeGreaterThan(0);
        await rebuild(pool);

        const rebuilt = await meta(pool);
        expect(rebuilt.epoch).toBe("2");
        expect(rebuilt.head_seq).toBe("2");
        expect(rebuilt.head_commit).toBe(worker.refs(pool).main);
        expect(await source(pool)).toMatchObject({ epoch: 1 });
        const before = await pending(pool);
        expect(before[0]?.n).toBe(1);
        expect(JSON.parse(String(before[0]?.body))).toMatchObject({
          type: "pool.state",
          epoch: 2,
          state: "rebuilding",
        });

        if (hold) {
          // This confirmation belongs to epoch 1, although its n cutoff covers epoch 2's row 1.
          await worker.releaseFloorResponse(pool);
          await oldRequest;
          oldRequest = undefined;
          const retained = await pending(pool);
          expect(retained[0]?.n).toBe(1);
          expect(retained.slice(0, before.length).map(({ n, ts, body }) => ({ n, ts, body }))).toEqual(
            before.map(({ n, ts, body }) => ({ n, ts, body })),
          );
        } else {
          // The live soak's exact failure: Floor e1, Trunk e2, contiguous n2.. with n1 lost.
          await worker.sql("TRUNK", pool, "DELETE FROM events_out WHERE n = 1");
          const broken = await pending(pool);
          expect(broken.map((row) => row.n)).toEqual(Array.from({ length: broken.length }, (_, index) => index + 2));
        }

        await worker.setFloorFault(pool, "pass");
        await worker.runAlarm(pool, Date.now() + 60_000);
        await waitFor(async () => (await pending(pool)).length === 0, 10_000);
        const delivered = await source(pool);
        expect(delivered).toEqual({ epoch: 2, last_n: Number((await meta(pool)).next_event_n) - 1 });
        const states = await eventsOf(worker, pool, "pool.state");
        expect(states.at(-1)).toMatchObject({
          epoch: 2,
          state: "ready",
          head_seq: 2,
          head_commit: rebuilt.head_commit,
        });

        const socket = await worker.stream(pool);
        try {
          const snapshotMessage = message(socket);
          socket.send(JSON.stringify({ hello: 1, after: 0 }));
          const frame = await snapshotMessage;
          expect(frame).toMatchObject({
            snapshot: {
              state: {
                pool: { epoch: 2, state: "ready", head_seq: 2 },
                files: {
                  [`creatures/${pool}-before-1.js`]: { exists: true },
                  [`creatures/${pool}-before-2.js`]: { exists: true },
                },
              },
            },
          });
          const streamed: Record<string, unknown>[] = [];
          socket.addEventListener("message", (event) => {
            const body = JSON.parse(String(event.data)) as { events?: Record<string, unknown>[] };
            streamed.push(...(body.events ?? []));
          });
          await land(pool, `${pool}-after`, 3);
          await waitFor(
            async () => streamed.some((event) => event.type === "landing.landed" && event.seq === 3),
            5_000,
          );
          expect(streamed.find((event) => event.type === "landing.landed" && event.seq === 3)?.commit).toBe(
            worker.refs(pool).main,
          );
        } finally {
          socket.close();
        }
      } finally {
        if (oldRequest !== undefined) {
          await worker.releaseFloorResponse(pool);
          await oldRequest;
        }
        await worker.setFloorFault(pool, "pass");
      }
    },
    60_000,
  );
});
