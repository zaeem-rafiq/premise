// Slice 14 part 14b, acceptance item 2 (04-build-plan 2.15): in local workerd with the isolate
// runtime switched on for this bundle only (`withFeatures`), the Worker Loader bound as
// wrangler.jsonc binds it, and a real `git http-backend` remote. The plain-merge tree of the hero
// (02-tidepool A5) lands in a throwaway pool as one change. The stream then carries
// `green.verified` with `ok: false, confirmed: false`, then `ok: false, confirmed: true`, then one
// landing of kind `revert` that reopens the attempt with a heads-up of cause `revert` whose check
// item is a name and a fixed code (GR3, GR8). No event and no heads-up carries the log (GR7).
// Run `npm run build` first: the harness starts the built Worker.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GREEN_CHECK_NAMES } from "../../../src/protocol/green.ts";
import { startLandingWorker, type LandingWorker } from "../../workerd/landing/harness.ts";
import { createPool, eventsOf, KEY, openAttempt, tool, waitFor } from "../../workerd/collide/helpers.ts";
import { a5Tree, seedTree } from "../../workerd/green/trees.ts";

const POOL = "green-f";

describe("Slice 14 part 14b: the isolate runtime takes back a confirmed red (2.15 item 2)", () => {
  let worker: LandingWorker;

  beforeAll(async () => {
    worker = await startLandingWorker({
      ownerKey: KEY,
      features: { green: "full", held: true },
      // CK6c would send A5 back at submit (its not_exhausted failure is new against the seed), so
      // the take-back this acceptance proves could not happen; the pre-landing run is switched off.
      vars: { SUBMIT_SELFTEST: "off" },
      repos: [POOL, `${POOL}-plain`],
    });
  }, 240_000);

  afterAll(async () => {
    await worker?.dispose();
  });

  it("GR3, GR7, GR8: A5 lands, fails twice in the isolate, and is taken back as one revert", async () => {
    await createPool(worker, POOL, { seed: "tidepool-auto" });
    const seed = seedTree("tidepool-auto");
    const tree = a5Tree("tidepool-auto");

    // One change writes every path the hero's plain-merge tree differs in. It reads the seed's
    // modules first, so what it writes rests on what it read (no blind-spot confirm, B1).
    await openAttempt(worker, POOL, "hero");
    let n = 0;
    const changed = [...tree].filter(([path, content]) => seed.get(path) !== content).map(([path]) => path);
    expect(changed).toEqual(expect.arrayContaining(["creatures/crab.js", "creatures/shrimp.js", "world/energy.js"]));
    for (const path of [...seed.keys()].filter((p) => p.endsWith(".js")).sort()) {
      await tool(worker, POOL, "hero", { tool: "read", args: { path } }, ++n);
    }
    for (const path of changed) {
      await tool(worker, POOL, "hero", { tool: "write", args: { path, content: tree.get(path)! } }, ++n);
    }
    await tool(worker, POOL, "hero", { tool: "submit", args: { summary: "the hero, merged by plain git" } }, ++n);
    await waitFor(async () => (await eventsOf(worker, POOL, "landing.landed")).length >= 1, 60_000);
    const landed = (await eventsOf(worker, POOL, "landing.landed")).at(-1)!;

    await waitFor(async () => (await eventsOf(worker, POOL, "green.verified")).length >= 2, 120_000);
    const verified = await eventsOf(worker, POOL, "green.verified");
    expect(verified.slice(0, 2)).toEqual([
      expect.objectContaining({
        seq: landed.seq,
        commit: landed.commit,
        ok: false,
        confirmed: false,
        runtime: "isolate",
      }),
      expect.objectContaining({
        seq: landed.seq,
        commit: landed.commit,
        ok: false,
        confirmed: true,
        runtime: "isolate",
      }),
    ]);
    for (const e of verified.slice(0, 2)) {
      expect(e.checks).toContainEqual({ name: "not_exhausted", ok: false, code: "not_exhausted:failed" });
      for (const c of e.checks as Array<{ name: string }>)
        expect(GREEN_CHECK_NAMES as readonly string[]).toContain(c.name);
    }

    // The take-back: planned after the second run only, then one landing of kind revert.
    await waitFor(
      async () => (await eventsOf(worker, POOL, "landing.accepted")).some((e) => e.kind === "revert"),
      60_000,
    );
    const all = await worker.events(POOL);
    const types = all.map((e) => String(e.type));
    const second = all.findIndex((e) => e.n === verified[1]!.n);
    const first = all.findIndex((e) => e.n === verified[0]!.n);
    const planned = all.findIndex((e) => e.type === "undo.planned");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(planned).toBeGreaterThan(second);
    expect(all[planned]).toMatchObject({ cause: "revert", reverted: [landed.seq], reopened: ["hero"] });
    const reverts = (await eventsOf(worker, POOL, "landing.accepted")).filter((e) => e.kind === "revert");
    expect(reverts).toHaveLength(1);
    expect(await eventsOf(worker, POOL, "attempt.reopened")).toContainEqual(
      expect.objectContaining({ attempt_id: "hero", cause: "revert" }),
    );
    const headsUp = (await eventsOf(worker, POOL, "headsup.sent")).filter((e) => e.attempt_id === "hero").at(-1)!;
    expect(JSON.stringify(headsUp)).toContain('"check":"not_exhausted"');
    expect(JSON.stringify(headsUp)).toContain('"code":"not_exhausted:failed"');

    // GR7: the log's free text ("shrimp: resting …") is in no event at all.
    expect(types.length).toBeGreaterThan(0);
    for (const e of all) expect(JSON.stringify(e)).not.toContain("resting");
  }, 300_000);
});
