// emitSwarmState fans one swarm.state out to every registered pool (EM6, EV2a): in parallel, and
// still to every pool when one of them fails.

import { describe, expect, it } from "vitest";
import type { Env } from "../env.ts";
import { emitSwarmState } from "./emit.ts";

function fakeEnv(pools: string[], failing: Set<string> = new Set()) {
  let inFlight = 0;
  let maxInFlight = 0;
  const appended: string[] = [];
  const floor = (pool: string) => ({
    fetch: async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname;
      if (path === "/internal/swarm-source") {
        return Response.json({ epoch: 1, last_n: 0, newest: null });
      }
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      if (failing.has(pool)) return Response.json({ error: { code: "internal" } });
      expect(JSON.parse(String(init?.body)).events[0].event.type).toBe("swarm.state");
      appended.push(pool);
      return Response.json({ ok: true });
    },
  });
  const env = {
    GATE: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => Response.json({ state: { pools: Object.fromEntries(pools.map((p) => [p, {}])) } }),
      }),
    },
    FLOOR: { idFromName: (name: string) => name, get: (pool: string) => floor(pool) },
  } as unknown as Env;
  return { env, appended, maxInFlight: () => maxInFlight };
}

describe("emitSwarmState (EM6)", () => {
  const pools = Array.from({ length: 40 }, (_, i) => `pool-${i}`);

  it("delivers to every registered pool, several at a time", async () => {
    const { env, appended, maxInFlight } = fakeEnv(pools);
    await emitSwarmState(env, { running: true }, 1);
    expect([...appended].sort()).toEqual([...pools].sort());
    expect(maxInFlight()).toBeGreaterThan(1);
  });

  it("a pool that fails fails the emit, after every other pool was delivered", async () => {
    const { env, appended } = fakeEnv(pools, new Set(["pool-3"]));
    await expect(emitSwarmState(env, { running: false }, 2)).rejects.toThrow(/pool-3/);
    expect(appended).toHaveLength(39);
  });
});
