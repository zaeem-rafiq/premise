// Offline Swarm through real Agents, Trunk, Floor and the landing harness's fake Artifacts.
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { SessionMetrics } from "../../../src/worker/trunk/engine-session.ts";
import { startLandingWorker } from "../../workerd/landing/harness.ts";
import { bearer, createPool, KEY, waitFor } from "../../workerd/collide/helpers.ts";

it("measures retained engine calls for 128 dial-zero scripted agents with pushes", async () => {
  const pool = "scale-session";
  const worker = await startLandingWorker({ ownerKey: KEY, repos: [pool, `${pool}-plain`], swarm: true });
  try {
    await createPool(worker, pool);
    const response = await worker.fetch(
      "/api/swarm",
      bearer({
        pool,
        seed: 7,
        agents: 128,
        launch_per_second: 16,
        collision_dial: 0,
        think_ms: [10, 20],
        rescale_every_s: 60,
        running: true,
        request_id: "scale-session-run",
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    await waitFor(async () => {
      const events = await worker.events(pool);
      const finished = new Set(
        events
          .filter((e) => e.type === "attempt.state" && (e.to === "landed" || e.to === "stopped"))
          .map((e) => e.attempt_id),
      );
      return finished.size === 128;
    }, 240_000);
    const state = await worker.trunk(pool).state();
    const metrics = state.engine_session as SessionMetrics;
    const counts = Object.values(metrics.calls);
    const reused = counts.reduce((n, c) => n + c.reused, 0);
    const reopened = counts.reduce((n, c) => n + c.reopened, 0);
    const events = await worker.events(pool);
    const landed = events.filter((e) => e.type === "landing.landed").length;
    const pushes = worker
      .gitRequests()
      .filter((r) => r.method === "POST" && r.path.endsWith("git-receive-pack")).length;
    expect(reused + reopened).toBeGreaterThan(128);
    expect(landed).toBe(128);
    expect(pushes).toBeGreaterThan(1);
    expect(worker.refs(pool).notes).not.toBeNull();
    const report = {
      agents: 128,
      landed,
      pushes,
      reused,
      reopened,
      hit_rate: reused / (reused + reopened),
      ...metrics,
    };
    const label = process.env.SCALE_REPORT === "before" ? "before" : "after";
    mkdirSync(`${process.cwd()}/.tmp-test`, { recursive: true });
    writeFileSync(`${process.cwd()}/.tmp-test/session-${label}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    expect(report.hit_rate).toBeGreaterThanOrEqual(0.95);
  } finally {
    await worker.dispose();
  }
});
