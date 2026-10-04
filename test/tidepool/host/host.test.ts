// The pool host of 02-tidepool 4.5–4.8 running in the harness frame: real dynamic imports against
// pool versions laid down on disk, a fake clock for timers and frames, and the recorded channel.

import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runHost, type Landed } from "../../../src/host/main.ts";
import { STATS_EVERY_MS } from "../../../src/protocol/constants.ts";
import { creatureJs, FakeFrame, landedFor, versionOf, writeHead, writeVersion } from "./harness.ts";

const POOL = "tidepool";
/** One animation frame: at TICKS_PER_SECOND 60 a 17ms frame carries exactly one tick. */
const FRAME_MS = 17;

type Pool = { root: string; pageDir: string; pageUrl: (query?: string) => string };

/** A scratch pool: `<root>/tidepool/<version>/` trees plus a `page/` dir holding `~head.js`. */
async function scratch(name: string): Promise<Pool> {
  const root = join(".tmp-test", "host", name);
  const pageDir = join(root, "page");
  return {
    root,
    pageDir,
    pageUrl: (query = "") => `${pathToFileURL(pageDir + "/").href}${query}`,
  };
}

/** Version on disk at `<root>/tidepool/<v>`, and a landed naming the real `/pool/` base path. */
async function lay(pool: Pool, name: string, creatures: Record<string, string>, shared?: Record<string, string>) {
  const version = versionOf(name);
  await writeVersion(pool.root, POOL, version, { creatures, shared });
  return version;
}

const live = (pool: string, version: string, seq = 12): Landed =>
  landedFor(pool, "main", version, `/pool/${pool}/v/${version}/`, seq);
const commit = (pool: string, version: string): Landed =>
  landedFor(pool, version.slice(2), version, `/pool/${pool}/v/${version}/`, null);

/** Wait on the async work a `probe`/`advance` schedules (imports resolve over real microtasks).
 * `vi.waitFor` retries while the callback throws — a returned `false` resolves at once. */
async function until(check: () => boolean, what: string): Promise<void> {
  await vi
    .waitFor(
      () => {
        expect(check()).toBe(true);
      },
      { timeout: 3000, interval: 2 },
    )
    .catch(() => {
      throw new Error(`timed out waiting for ${what}`);
    });
}

/** A freshly started live frame over a fixture version. */
async function startLive(name: string, creatures: Record<string, string>, query = "") {
  const pool = await scratch(name);
  const version = await lay(pool, "v1", creatures);
  const landed = live(POOL, version);
  await writeHead(pool.pageDir, landed);
  const frame = new FakeFrame(pool.pageUrl(query)).mount(pool.root);
  await runHost(frame.env, landed);
  return { pool, frame, version, landed };
}

describe("start-up and ticking (HO1, HO2, HO4, HO7)", () => {
  it("HO1/HO7: the pool starts and posts stats naming the landed version, seq and kinds", async () => {
    const { frame, version } = await startLive("start", { fish: creatureJs("fish") });
    const stats = frame.lastStats();
    expect(stats).toMatchObject({ type: "stats", source: "main", version, seq: 12, paused: false });
    expect(stats?.kinds.fish).toMatchObject({ count: 1 });
    expect(stats?.total).toBe(1);
    expect(stats?.shown).toBe(1);
  });

  it("HO2/PN9: Math.random is the seeded stream and DEFAULT_GLOBALS are frozen", async () => {
    await startLive("frozen", { fish: creatureJs("fish") });
    expect(Object.isFrozen(Math)).toBe(true);
    expect(Object.isFrozen(Function.prototype)).toBe(true);
    expect(Object.isFrozen(Object.prototype)).toBe(true);
    const first = Math.random();
    const second = Math.random();
    expect(first).not.toBe(second); // the seeded stream advances
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
  });

  it("HO2: two hosts on the same seed draw the same first frame", async () => {
    const a = await startLive("det-a", { fish: creatureJs("fish") });
    const b = await startLive("det-b", { fish: creatureJs("fish") });
    a.frame.frame(FRAME_MS);
    b.frame.frame(FRAME_MS);
    expect(a.frame.canvas.ctx.ops).toEqual(b.frame.canvas.ctx.ops);
  });

  it("HO4: each animation frame ticks once; STATS_EVERY_MS posts another stats", async () => {
    const { frame } = await startLive("tick", { fish: creatureJs("fish") });
    frame.frame(FRAME_MS); // first frame only stamps lastFrameAt
    frame.frame(FRAME_MS);
    frame.frame(FRAME_MS);
    expect(frame.lastStats()?.tick).toBe(0); // ticks ran but stats only post on schedule
    frame.advance(STATS_EVERY_MS);
    expect(frame.lastStats()?.tick).toBe(2);
    // A frame after a still second has ~61 ticks due; HO4 caps the catch-up at HOST_MAX_CATCH_UP (5).
    frame.frame(FRAME_MS);
    frame.advance(STATS_EVERY_MS);
    expect(frame.lastStats()?.tick).toBe(7);
  });

  it("HO4: a pause message freezes ticks and a hidden frame does not run", async () => {
    const { frame } = await startLive("pause", { fish: creatureJs("fish") });
    frame.frame(FRAME_MS);
    frame.frame(FRAME_MS);
    frame.message({ type: "pause" });
    frame.frame(FRAME_MS); // a paused frame does not tick
    frame.advance(STATS_EVERY_MS);
    expect(frame.lastStats()?.tick).toBe(1);
    expect(frame.lastStats()?.paused).toBe(true);
    // The paused span is not banked: the frame straddling resume does not catch it up.
    frame.message({ type: "resume" });
    frame.frame(FRAME_MS);
    frame.advance(STATS_EVERY_MS);
    expect(frame.lastStats()?.tick).toBe(1);
    expect(frame.lastStats()?.paused).toBe(false);
    // Resumed, a frame after a still second catches up — at most HOST_MAX_CATCH_UP (5).
    frame.frame(FRAME_MS);
    frame.advance(STATS_EVERY_MS);
    expect(frame.lastStats()?.tick).toBe(6);
    frame.hiddenNow = true;
    frame.frame(FRAME_MS);
    frame.advance(STATS_EVERY_MS);
    expect(frame.lastStats()?.tick).toBe(6);
  });

  it("HO17: a message whose source is not the parent window is ignored", async () => {
    const { frame } = await startLive("spoof", { fish: creatureJs("fish") });
    frame.message({ type: "pause" }, {}); // not from the parent window
    frame.frame(FRAME_MS);
    frame.frame(FRAME_MS);
    frame.advance(STATS_EVERY_MS);
    expect(frame.lastStats()?.paused).toBe(false);
    expect(frame.lastStats()?.tick).toBe(1);
    frame.message("not a message");
    frame.message({ type: "highlight", kinds: ["not a kind!"] });
    expect(frame.lastStats()?.type).toBe("stats");
  });
});

describe("probes and hot swap (4.6, 4.7, SE16a)", () => {
  it("SE16a/4.7: a probe that finds a creature-only change adopts it without a reload", async () => {
    const { pool, frame, version } = await startLive("adopt", { fish: creatureJs("fish") });
    frame.frame(FRAME_MS);
    frame.frame(FRAME_MS);
    const tickBefore = frame.lastStats()?.tick ?? 0;
    const v2 = await lay(pool, "v2", { fish: creatureJs("fish"), crab: creatureJs("crab") });
    await writeHead(pool.pageDir, live(POOL, v2, 13));
    frame.message({ type: "probe" });
    await until(() => frame.lastStats()?.version === v2, "the adopt to land");
    const stats = frame.lastStats();
    expect(stats?.version).toBe(v2);
    expect(stats?.seq).toBe(13);
    expect(stats?.swap?.mode).toBe("adopt");
    expect(stats?.swap?.arrived).toContain("crab");
    expect(frame.reloads).toBe(0); // SE16a: no reload
    expect(frame.navigations).toEqual([]);
    expect(stats?.kinds.crab?.count).toBe(1);
    frame.frame(FRAME_MS);
    frame.advance(STATS_EVERY_MS);
    expect(frame.lastStats()?.tick).toBeGreaterThan(tickBefore); // the same world kept ticking
    expect(frame.lastStats()?.version).toBe(v2);
    expect(frame.imports.some((s) => s.includes("~head.js?n="))).toBe(true);
  });

  it("4.7 step 2: a probe that finds a shared-file change reports restart and reloads", async () => {
    const { pool, frame } = await startLive("restart", { fish: creatureJs("fish") });
    const v2 = await lay(pool, "v2", { fish: creatureJs("fish") }, { "world/extra.js": "export const E = 1;\n" });
    await writeHead(pool.pageDir, live(POOL, v2));
    frame.message({ type: "probe" });
    await until(() => frame.lastStats()?.swap?.mode === "restart", "the restart to post");
    expect(frame.reloads).toBe(1);
    expect(frame.navigations).toEqual([]);
    expect(frame.lastStats()?.swap?.mode).toBe("restart");
  });

  it("HO12: a swap whose registry cannot be read reports failed ['*'] and keeps the old version", async () => {
    const { pool, frame, version } = await startLive("failed", { fish: creatureJs("fish") });
    const v2 = versionOf("v2-missing"); // head points at a version with no files on disk
    await writeHead(pool.pageDir, live(POOL, v2));
    frame.message({ type: "probe" });
    await until(() => frame.lastStats()?.swap?.failed.includes("*") === true, "the failure to post");
    expect(frame.lastStats()?.version).toBe(version);
    expect(frame.reloads).toBe(0);
  });

  it("HO10: two probes inside SWAP_MIN_MS start at most one swap", async () => {
    const { pool, frame } = await startLive("throttle", { fish: creatureJs("fish") });
    const v2 = await lay(pool, "v2", { fish: creatureJs("fish"), crab: creatureJs("crab") });
    await writeHead(pool.pageDir, live(POOL, v2));
    frame.message({ type: "probe" });
    frame.message({ type: "probe" });
    frame.advance(1000); // past SWAP_MIN_MS so a remembered probe may run
    await until(() => frame.lastStats()?.version === v2, "the adopt to land");
    const withArrival = frame.stats().filter((s) => s.swap?.arrived.includes("crab"));
    expect(withArrival).toHaveLength(1);
  });

  it("HO9: ?follow=0 never imports ~head.js, even on an explicit probe", async () => {
    const { pool, frame } = await startLive("nofollow", { fish: creatureJs("fish") }, "?follow=0");
    const v2 = await lay(pool, "v2", { fish: creatureJs("fish"), crab: creatureJs("crab") });
    await writeHead(pool.pageDir, live(POOL, v2));
    frame.message({ type: "probe" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    frame.advance(6_000); // past HEAD_POLL_MS too
    expect(frame.imports.filter((s) => s.includes("~head.js"))).toEqual([]);
    expect(frame.lastStats()?.version).not.toBe(v2);
  });

  it("a creature whose file fails to load is omitted; the rest still run (4.5, HO1)", async () => {
    const { frame } = await startLive("broken-kind", {
      fish: creatureJs("fish"),
      broken: "this is not javascript {{{\n",
    });
    const stats = frame.lastStats();
    expect(stats?.total).toBe(2);
    expect(stats?.shown).toBe(1);
    expect(stats?.kinds.broken).toBeUndefined();
    expect(stats?.kinds.fish?.count).toBe(1);
  });
});

describe("commit frames (HO14) and highlight (HO15)", () => {
  it("HO14: advance on a commit frame adopts a creature-only change to the named version", async () => {
    const pool = await scratch("advance-adopt");
    const v1 = await lay(pool, "v1", { fish: creatureJs("fish") });
    const v2 = await lay(pool, "v2", { fish: creatureJs("fish"), crab: creatureJs("crab") });
    const frame = new FakeFrame(pool.pageUrl()).mount(pool.root);
    await runHost(frame.env, commit(POOL, v1));
    expect(frame.lastStats()?.source).toBe(v1.slice(2));
    frame.message({ type: "advance", version: v2 });
    await until(() => frame.lastStats()?.version === v2, "the adopt to land");
    expect(frame.lastStats()?.swap?.mode).toBe("adopt");
    expect(frame.lastStats()?.kinds.crab?.count).toBe(1);
    expect(frame.reloads).toBe(0);
    expect(frame.navigations).toEqual([]);
  });

  it("HO14: advance to a shared change navigates to the new commit address with the same query", async () => {
    const pool = await scratch("advance-restart");
    const v1 = await lay(pool, "v1", { fish: creatureJs("fish") });
    const v2 = await lay(pool, "v2", { fish: creatureJs("fish") }, { "world/extra.js": "export const E = 2;\n" });
    const frame = new FakeFrame(pool.pageUrl("?seed=3")).mount(pool.root);
    await runHost(frame.env, commit(POOL, v1));
    frame.message({ type: "advance", version: v2 });
    await until(() => frame.lastStats()?.swap?.mode === "restart", "the restart to post");
    expect(frame.navigations).toEqual([`/pool/tidepool/${v2.slice(2)}/?seed=3`]);
    expect(frame.reloads).toBe(0);
  });

  it("HO14: advance on a live frame, a bad token, and a prefix switch are each ignored with stats", async () => {
    const { frame, version } = await startLive("advance-live", { fish: creatureJs("fish") });
    const before = frame.stats().length;
    frame.message({ type: "advance", version: versionOf("v2") });
    await until(() => frame.stats().length > before, "the answer stats");
    expect(frame.lastStats()?.version).toBe(version);
    expect(frame.reloads).toBe(0);

    const pool = await scratch("advance-bad");
    const v1 = await lay(pool, "v1", { fish: creatureJs("fish") });
    const p1 = versionOf("p1", "p");
    const frame2 = new FakeFrame(pool.pageUrl()).mount(pool.root);
    await runHost(frame2.env, commit(POOL, v1));
    const count = frame2.stats().length;
    frame2.message({ type: "advance", version: "not-a-token" });
    frame2.message({ type: "advance", version: p1 }); // c- frame may not take a p- token
    await until(() => frame2.stats().length > count + 1, "two answer stats");
    expect(frame2.lastStats()?.version).toBe(v1);
    expect(frame2.navigations).toEqual([]);
  });

  it("HO15: highlight { kinds } rings those kinds on the host's own surface until cleared", async () => {
    const { frame } = await startLive("highlight", { fish: creatureJs("fish") });
    frame.frame(FRAME_MS);
    frame.frame(FRAME_MS); // one drawn frame before highlighting
    const ctx = frame.canvas.ctx;
    const mark = ctx.mark();
    frame.message({ type: "highlight", kinds: ["fish", "ghost"] });
    frame.frame(FRAME_MS);
    const ringed = ctx.since(mark);
    const clip = ringed.find((op) => op[0] === "arc" && op[3] === 34 + 3); // RADIUS+WIDTH push clip
    const ring = ringed.find((op) => op[0] === "arc" && op[3] === 34);
    expect(clip).toBeDefined();
    expect(ring).toBeDefined();
    expect(ctx.strokeStyle).toBe("#ffd23f");
    const mark2 = ctx.mark();
    frame.message({ type: "highlight", kinds: [] });
    frame.frame(FRAME_MS);
    expect(ctx.since(mark2).filter((op) => op[0] === "arc" && op[3] === 34)).toEqual([]);
  });
});

describe("taps and the self-test (HO6, 4.8)", () => {
  it("HO6: a tap on a creature posts tapped { creature, path }", async () => {
    const { frame } = await startLive("tap", {
      fish: `export function spawn() { return { x: 100, y: 50 }; }
export function update(c) {}
export function draw(c, pen) { pen.circle(0, 0, 8); }
`,
    });
    // poolSize 200x100 in a 400x300 box: scale 2, centred — world (100,50) is client (200,150).
    frame.tap(200, 150);
    const tapped = frame.posted.find((m) => m.type === "tapped");
    expect(tapped).toEqual({ type: "tapped", creature: "fish", path: "creatures/fish.js" });
    frame.tap(390, 290); // far from every creature
    expect(frame.posted.filter((m) => m.type === "tapped")).toHaveLength(1);
  });

  it("4.8: probe { selftest: true } runs selftest/run.js and reports its verdict in stats", async () => {
    const { frame, version } = await startLive("selftest", { fish: creatureJs("fish") });
    frame.message({ type: "probe", selftest: true });
    await until(
      () => frame.lastStats()?.selftest !== null && frame.lastStats()?.selftest !== undefined,
      "the selftest verdict",
    );
    expect(frame.lastStats()?.selftest).toEqual({ version, ok: true, failed: [] });
  });
});
