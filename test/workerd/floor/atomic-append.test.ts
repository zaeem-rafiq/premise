import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendBody, poolState, startFloor, type FloorHandle } from "./harness.ts";

describe("EV2: atomic source batches in local workerd", () => {
  let floor: FloorHandle;
  beforeAll(async () => {
    floor = await startFloor();
    await floor.fetch("/internal/events", {
      method: "POST",
      body: appendBody("trunk", 1, [{ source_n: 1, event: poolState(1) }]),
    });
  });
  afterAll(async () => floor?.dispose());

  const append = (epoch: number, ns: number[]) =>
    floor.fetch("/internal/events", {
      method: "POST",
      body: appendBody(
        "swarm",
        epoch,
        ns.map((source_n) => ({
          source_n,
          event: {
            ts: source_n,
            pool: "tidepool",
            src: "swarm",
            type: "swarm.state",
            synthetic: true,
            running: true,
            agents: source_n,
            collision_dial: 0,
            pools: ["tidepool"],
          },
        })),
      ),
    });
  const source = async () => (await floor.fetch("/internal/swarm-source")).json();
  const replay = async () => (await floor.fetch("/api/pools/tidepool/replay.ndjson")).text();

  it("a middle hole stores nothing, keeps last_n, and accepts the corrected batch exactly once", async () => {
    expect((await append(1, [1])).status).toBe(200);
    const before = await replay();
    const state = await floor.state();
    const counter = await source();

    // Includes an already-confirmed prefix as well as a fresh prefix before the hole.
    const gap = await append(1, [1, 2, 4]);
    expect(gap.status).toBe(409);
    expect(await gap.json()).toEqual({ error: { code: "gap", expected: 2 } });
    expect(await replay()).toBe(before);
    expect(await floor.state()).toEqual(state);
    expect(await source()).toEqual(counter);
    expect(counter).toMatchObject({ epoch: 1, last_n: 1 });

    expect(await (await append(1, [1, 2, 3, 4])).json()).toMatchObject({ appended: 3 });
    expect(await source()).toMatchObject({ epoch: 1, last_n: 4 });
    const stored = await replay();
    expect(await (await append(1, [1, 2, 3, 4])).json()).toMatchObject({ appended: 0, duplicate: true });
    expect(await replay()).toBe(stored);
    expect(stored.trim().split("\n")).toHaveLength(6); // header, pool.state, four swarm events
  });

  it("a new epoch with a middle hole leaves the prior epoch intact", async () => {
    const before = await replay();
    const gap = await append(2, [1, 3]);
    expect(gap.status).toBe(409);
    expect(await gap.json()).toEqual({ error: { code: "gap", expected: 1 } });
    expect(await source()).toMatchObject({ epoch: 1, last_n: 4 });
    expect(await replay()).toBe(before);
    expect(await (await append(2, [1, 2, 3])).json()).toMatchObject({ appended: 3 });
    expect(await source()).toMatchObject({ epoch: 2, last_n: 3 });
  });
});
