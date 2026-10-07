// The floor-pool lane's browser checks (04-build-plan 1.4/1.5).
//
// `describe("the pool frame component")` mounts the lane's registered PoolArea in a small harness
// page (built once into .tmp-test/, served through page.route) and plays it against a fake pool
// host that speaks the PoolToFloor channel — so the frame's own rules are exercised in a real
// browser on this branch, before the shell lands.
//
// `describe("the built Floor")` holds the route-level statements of track 1F against the
// assembled page (floor-shell).

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
// fullyParallel runs beforeAll in every worker, and a build rewrites files in place: each worker
// builds into a directory of its own, so no test reads a file that another worker is rewriting.
const HARNESS_DIR = join(ROOT, `.tmp-test/e2e-pool-${process.env.TEST_PARALLEL_INDEX ?? "0"}`);
const HARNESS_DIST = join(HARNESS_DIR, "dist");

// ---- The tracer fixture (the same recording /replay/tracer plays). ----

const TRACER = readFileSync(join(ROOT, "test/fixtures/streams/tracer.ndjson"), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Record<string, unknown>);
const EVENTS = TRACER.filter((line) => typeof line.type === "string");

const SEED_COMMIT = "seed0000seed0000seed0000seed0000seed0000";
const LANDED_1 = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0"; // landing.landed seq 1
const LANDED_2 = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0d1"; // landing.landed seq 2 (undo)
const ACCEPTED_1 = EVENTS.findIndex((e) => e.type === "landing.accepted");
const LANDED_IX_1 = EVENTS.findIndex((e) => e.type === "landing.landed");
const GREEN_IX = EVENTS.findIndex((e) => e.type === "green.advanced");

// ---- The harness page: the lane's PoolArea with a mutable FloorState. ----

const HARNESS_MAIN = `
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { PoolArea } from "../../src/floor/components/pool-frame/pool-area.tsx";
import { emptyFloorState, reduce } from "../../src/protocol/reducer/index.ts";

declare const window: Window & {
  harness?: Record<string, unknown>;
  compareTapped?: boolean;
  tappedPath?: string;
  tileWho?: string;
  tileWhy?: { path: string; seq: number };
};

function Harness() {
  const [state, setState] = useState(() => emptyFloorState());
  const [mode, setMode] = useState<"live" | "replay">("live");
  const [paused, setPaused] = useState(false);
  const [highlight, setHighlight] = useState<string[] | undefined>(undefined);
  const [selftest, setSelftest] = useState(false);
  window.harness = {
    event: (e: unknown) => setState((s) => ({ ...reduce(s, e as never) })),
    mode: setMode,
    paused: setPaused,
    compareTapped: () => window.compareTapped === true,
    tappedPath: () => window.tappedPath,
    // CO23b: pass the prop only while the panel is "open" — undefined clears it entirely.
    highlight: (k?: string[]) => setHighlight(k),
    selftest: (on: boolean) => setSelftest(on),
  };
  return (
    <PoolArea
      pool="tidepool"
      state={state}
      mode={mode}
      paused={paused}
      onPausedChange={setPaused}
      onCompare={() => { window.compareTapped = true; }}
      onTapped={(p) => { window.tappedPath = p; }}
      highlight={highlight}
      selftest={selftest}
      onTileWho={(p) => { window.tileWho = p; }}
      onTileWhy={(p, seq) => { window.tileWhy = { path: p, seq }; }}
    />
  );
}
createRoot(document.getElementById("root") as HTMLElement).render(<Harness />);
`;

const HARNESS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>pool-frame harness</title></head>
<body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>`;

const HARNESS_VITE = `
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: false },
});
`;

/** The fake pool host: a page for /pool/{pool}/{source}/ that speaks PoolToFloor (CO22): stats on
 * a heartbeat, messages it receives recorded on window.__log for the test to read. `__silent`
 * stops the heartbeat (a stall); `__v` is the version it reports. */
const POOL_PAGE = `<!doctype html><meta charset="utf-8"><title>pool</title><script>
  window.__log = [];
  window.__tick = 0;
  window.__paused = /paused=1/.test(location.search); // AS7: the paused page parameter
  window.__silent = false;
  window.__st = null;
  var part = location.pathname.split("/")[3];
  window.__v = (part === "main" || part === "green" || part === "plain") ? "c-live" : "c-" + part;
  window.addEventListener("message", function (e) {
    var d = e.data;
    window.__log.push(d);
    if (d && d.type === "advance") window.__v = d.version;
    if (d && d.type === "pause") window.__paused = true;
    if (d && d.type === "resume") window.__paused = false;
    if (d && d.type === "probe" && d.selftest === true) {
      // CO25a/NP8: the in-page self-test reports in stats.selftest at the current version.
      window.__st = { version: window.__v, ok: true, failed: [] };
    }
  });
  function beat() {
    if (window.__silent) return;
    parent.postMessage({ type: "stats", source: part, version: window.__v, seq: 1,
      tick: ++window.__tick, paused: window.__paused, kinds: {}, shown: 0, total: 0,
      swap: null, selftest: window.__st }, "*");
  }
  beat();
  setInterval(beat, 200);
</script>`;

async function serveHarness(page: Page): Promise<void> {
  await page.route("**/assets/**", async (route) => {
    const file = join(HARNESS_DIST, "assets", basename(new URL(route.request().url()).pathname));
    await route.fulfill({ path: file });
  });
  await page.route("**/pool/**", async (route) => {
    await route.fulfill({ contentType: "text/html", body: POOL_PAGE });
  });
  await page.route("**/harness", async (route) => {
    await route.fulfill({ path: join(HARNESS_DIST, "index.html"), contentType: "text/html" });
  });
  await page.goto("/harness");
  await expect(page.locator(".pf")).toBeVisible();
}

/** The pool frame's iframe and the frame context behind it. */
function poolFrame(page: Page) {
  return page.frames().find((f) => f.url().includes("/pool/tidepool/"));
}

/** The pool frame once it has loaded: a live frame's first load waits for the stream's
 * `pool.state` (IR12), so a lookup right after the first events may find no frame yet. */
async function loadedPoolFrame(page: Page) {
  await expect.poll(() => poolFrame(page) !== undefined, { timeout: 10_000 }).toBe(true);
  return poolFrame(page)!;
}

async function sendEvents(page: Page, throughIndex: number): Promise<void> {
  await page.evaluate(
    ([events, through]) => {
      const harness = (window as { harness?: { event: (e: unknown) => void } }).harness;
      for (const e of (events as unknown[]).slice(0, (through as number) + 1)) harness?.event(e);
    },
    [EVENTS, throughIndex] as const,
  );
}

test.beforeAll(() => {
  mkdirSync(HARNESS_DIR, { recursive: true });
  writeFileSync(join(HARNESS_DIR, "index.html"), HARNESS_HTML);
  writeFileSync(join(HARNESS_DIR, "main.tsx"), HARNESS_MAIN);
  writeFileSync(join(HARNESS_DIR, "vite.config.ts"), HARNESS_VITE);
  execFileSync("npx", ["vite", "build", "--config", join(HARNESS_DIR, "vite.config.ts")], {
    cwd: ROOT,
    stdio: "pipe",
  });
});

test.describe("the pool frame component", () => {
  test("CO20/SE16a: the live frame is a sandboxed iframe on /pool/{pool}/main/?seed=7", async ({ page }) => {
    await serveHarness(page);
    await sendEvents(page, 0); // pool.state
    const iframe = page.locator('iframe[title="The live pool, running the code on main"]');
    await expect(iframe).toHaveAttribute("src", /\/pool\/tidepool\/main\/\?seed=7$/);
    await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    // Before any landing the caption is the seed caption (3.5).
    await expect(page.locator(".pf-caption")).toContainText("Premise · main · the seed, before any landing");
  });

  test("AC3/FL3: landing.accepted without landing.landed shows '1 landing…' and moves no frame", async ({ page }) => {
    await serveHarness(page);
    await sendEvents(page, ACCEPTED_1); // through landing.accepted, before landing.landed
    await expect(page.locator(".pf-caption")).toContainText("1 landing…");
    const iframe = page.locator('iframe[title="The live pool, running the code on main"]');
    await expect(iframe).toHaveAttribute("src", /\/pool\/tidepool\/main\/\?seed=7$/);
    // The Landed-chip count is a number, not a Why card: no card opens (AC3).
    await sendEvents(page, LANDED_IX_1);
    await expect(page.locator(".pf-caption")).not.toContainText("landing…");
    await expect(page.locator(".pf-caption")).toContainText("Premise · main · landing 1");
  });

  test("CO21: landing.landed posts one debounced probe to the live frame — the src never moves", async ({ page }) => {
    await serveHarness(page);
    await sendEvents(page, 1); // pool.state + pool.files
    const frame = await loadedPoolFrame(page);
    await expect
      .poll(async () => frame?.evaluate(() => (window as never as { __v?: string }).__v !== undefined))
      .toBe(true);
    const srcBefore = await page.locator('iframe[title="The live pool, running the code on main"]').getAttribute("src");
    await sendEvents(page, LANDED_IX_1);
    await expect
      .poll(async () =>
        frame?.evaluate(() => (window as never as { __log: { type: string }[] }).__log.map((m) => m.type)),
      )
      .toContain("probe");
    expect(await page.locator('iframe[title="The live pool, running the code on main"]').getAttribute("src")).toBe(
      srcBefore,
    );
  });

  test("AC23/RY17: in Replay the frame is a commit frame that gets advance — never probe", async ({ page }) => {
    await serveHarness(page);
    await sendEvents(page, LANDED_IX_1);
    await page.evaluate(() => {
      (window as { harness?: { mode: (m: string) => void } }).harness?.mode("replay");
    });
    const iframe = page.locator('iframe[title="The live pool, running the code on main"]');
    await expect(iframe).toHaveAttribute("src", `/pool/tidepool/${LANDED_1}/?seed=7`);
    // The next landing posts advance {version}, not probe, and the src stays put (RY17).
    await sendEvents(page, EVENTS.length - 1);
    // Re-resolve the frame inside the poll: a navigation mid-test invalidates a captured handle.
    await expect
      .poll(async () =>
        poolFrame(page)?.evaluate(() =>
          (window as never as { __log: { type: string; version?: string }[] }).__log.map((m) => m.type),
        ),
      )
      .toContain("advance");
    const posts = await poolFrame(page)!.evaluate(() => (window as never as { __log: { type: string }[] }).__log);
    expect(posts.every((m) => m.type !== "probe")).toBe(true);
    await expect(iframe).toHaveAttribute("src", `/pool/tidepool/${LANDED_1}/?seed=7`);
  });

  test("CO23a: the pause control posts pause and resume to the frame", async ({ page }) => {
    await serveHarness(page);
    await sendEvents(page, 0);
    const frame = await loadedPoolFrame(page);
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.locator(".pf-caption")).toContainText("Paused.");
    await page.getByRole("button", { name: "Play" }).click();
    await expect
      .poll(async () =>
        frame?.evaluate(() => (window as never as { __log: { type: string }[] }).__log.map((m) => m.type)),
      )
      .toEqual(expect.arrayContaining(["pause", "resume"]));
  });

  test("FR28: a stalled main frame falls back to the green source, captioned stalled.green", async ({ page }) => {
    test.setTimeout(30_000);
    await serveHarness(page);
    await sendEvents(page, EVENTS.length - 1); // green.commit = c0c0…c0 at landing 1 in the tracer
    const frame = await loadedPoolFrame(page);
    await expect.poll(async () => frame?.url()).toContain("/pool/tidepool/main/");
    await frame!.evaluate(() => {
      (window as never as { __silent: boolean }).__silent = true;
    });
    // No stats for POOL_STALL_MS: the driver reloads on /pool/{pool}/green/ once.
    const iframe = page.locator('iframe[title="The live pool, running the code on main"]');
    await expect(iframe).toHaveAttribute("src", /\/pool\/tidepool\/green\/\?seed=7$/, {
      timeout: 15_000,
    });
    await expect(page.locator(".pf-caption")).toContainText(
      "The pool stopped answering. This is the last verified version, landing 1.",
    );
  });

  test("AC11/6.4: with reduced motion the frame starts paused — the page parameter carries it", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await serveHarness(page);
    await sendEvents(page, 0);
    // The load is reported through onPausedChange (the harness is controlled), so the first
    // address already carries the paused parameter — no pause post is needed for it.
    const iframe = page.locator('iframe[title="The live pool, running the code on main"]');
    await expect(iframe).toHaveAttribute("src", /\/pool\/tidepool\/main\/\?seed=7&paused=1$/);
    await expect(page.locator(".pf-caption")).toContainText("Paused.");
    const frame = await loadedPoolFrame(page);
    await expect
      .poll(async () => frame?.evaluate(() => (window as never as { __paused: boolean }).__paused))
      .toBe(true);
  });

  test("CO23a/AS14: a frame scrolled out of view posts pause, back in view resume", async ({ page }) => {
    await serveHarness(page);
    await sendEvents(page, 0);
    const frame = await loadedPoolFrame(page);
    await expect.poll(async () => frame !== undefined).toBe(true);
    await page.evaluate(() => {
      const tall = document.createElement("div");
      tall.style.height = "2000px";
      document.body.prepend(tall);
      window.scrollTo(0, 0);
    });
    await expect
      .poll(async () =>
        frame?.evaluate(() => (window as never as { __log: { type: string }[] }).__log.map((m) => m.type)),
      )
      .toContain("pause");
    await page.locator(".pf").scrollIntoViewIfNeeded();
    await expect
      .poll(async () =>
        frame?.evaluate(() => (window as never as { __log: { type: string }[] }).__log.map((m) => m.type)),
      )
      .toContain("resume");
  });

  test("CO23b: highlight posts the given kinds, then the empty list when cleared", async ({ page }) => {
    await serveHarness(page);
    await sendEvents(page, 0);
    const frame = await loadedPoolFrame(page);
    await expect.poll(async () => frame !== undefined).toBe(true);
    const log = () => frame!.evaluate(() => (window as never as { __log: { type: string; kinds?: string[] }[] }).__log);
    // Never passed: after a few stats beats the log still carries no highlight.
    await page.waitForTimeout(450);
    expect((await log()).filter((m) => m.type === "highlight")).toHaveLength(0);
    await page.evaluate(() => {
      (window as { harness?: { highlight: (k?: string[]) => void } }).harness?.highlight(["fish", "snail"]);
    });
    await expect
      .poll(async () => (await log()).filter((m) => m.type === "highlight").map((m) => m.kinds))
      .toContainEqual(["fish", "snail"]);
    await page.evaluate(() => {
      (window as { harness?: { highlight: (k?: string[]) => void } }).harness?.highlight([]);
    });
    await expect
      .poll(async () => (await log()).filter((m) => m.type === "highlight").map((m) => m.kinds))
      .toContainEqual([]);
  });

  test("CO25a: with selftest on, the frame gets probe+selftest and the badge reads passed", async ({ page }) => {
    await serveHarness(page);
    await sendEvents(page, 0);
    await expect(page.locator(".pf-selftest")).toHaveCount(0);
    await page.evaluate(() => {
      (window as { harness?: { selftest: (b: boolean) => void } }).harness?.selftest(true);
    });
    const frame = await loadedPoolFrame(page);
    await expect
      .poll(async () =>
        frame?.evaluate(() =>
          (window as never as { __log: { type: string; selftest?: boolean }[] }).__log.some(
            (m) => m.type === "probe" && m.selftest === true,
          ),
        ),
      )
      .toBe(true);
    await expect(page.locator(".pf-selftest")).toContainText("Self-test, run in this page: passed");
  });

  test("CO22: a tapped message reports its path through onTapped", async ({ page }) => {
    await serveHarness(page);
    await sendEvents(page, 0);
    const frame = await loadedPoolFrame(page);
    await expect.poll(async () => frame !== undefined).toBe(true);
    await frame!.evaluate(() => {
      window.parent.postMessage({ type: "tapped", creature: "fish", path: "creatures/fish.js" }, "*");
    });
    await expect
      .poll(() => page.evaluate(() => (window as { tappedPath?: string }).tappedPath))
      .toBe("creatures/fish.js");
    // A message from anywhere else is dropped (SE16): same shape, wrong source.
    await page.evaluate(() => {
      window.postMessage({ type: "tapped", creature: "snail", path: "creatures/snail.js" }, "*");
    });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as { tappedPath?: string }).tappedPath)).toBe("creatures/fish.js");
  });

  test("FR20: a live frame that cannot load shows frame.error and frame.reload inside it", async ({ page }) => {
    await page.route("**/assets/**", async (route) => {
      const file = join(HARNESS_DIST, "assets", basename(new URL(route.request().url()).pathname));
      await route.fulfill({ path: file });
    });
    await page.route("**/pool/**", async (route) => {
      await route.abort();
    });
    await page.route("**/harness", async (route) => {
      await route.fulfill({ path: join(HARNESS_DIST, "index.html"), contentType: "text/html" });
    });
    await page.goto("/harness");
    await sendEvents(page, 0);
    await expect(page.locator(".pf-overlay")).toContainText(
      "The pool did not load. The attempt cards and the numbers are still live.",
      { timeout: 15_000 },
    );
    await expect(page.locator(".pf-overlay").getByRole("button", { name: "Reload the pool" })).toBeVisible();
  });

  test("FR28: with no green commit the stalled main reloads once on main, then holds", async ({ page }) => {
    test.setTimeout(40_000);
    await serveHarness(page);
    await sendEvents(page, GREEN_IX - 1); // landings 1-2 reduced but green.advanced not yet
    const frame = await loadedPoolFrame(page);
    await expect.poll(async () => frame?.url()).toContain("/pool/tidepool/main/");
    await frame!.evaluate(() => {
      (window as never as { __silent: boolean }).__silent = true;
    });
    // First stall: loaded again on main, captioned frame.stalled.reloaded (FR28's no-green row).
    const iframe = page.locator('iframe[title="The live pool, running the code on main"]');
    await expect(page.locator(".pf-caption")).toContainText("The pool stopped answering and was loaded again.", {
      timeout: 15_000,
    });
    await expect(iframe).toHaveAttribute("src", /\/pool\/tidepool\/main\/\?seed=7$/);
    // The reloaded page answers again; silence it and it stalls a second time → frame.stalled.
    const frame2 = poolFrame(page);
    await expect
      .poll(async () => frame2?.evaluate(() => (window as never as { __tick: number }).__tick > 0))
      .toBe(true);
    await frame2!.evaluate(() => {
      (window as never as { __silent: boolean }).__silent = true;
    });
    await expect(page.locator(".pf-overlay")).toContainText(
      "The pool stopped answering. The attempt cards and the numbers are still live.",
      { timeout: 15_000 },
    );
    await expect(page.locator(".pf-overlay").getByRole("button", { name: "Reload the pool" })).toBeVisible();
  });

  test("CO24: the Compare button reports through onCompare when the pool has a plain remote", async ({ page }) => {
    await serveHarness(page);
    await sendEvents(page, EVENTS.length - 1); // the tracer's pool has plain_remote
    await page.getByRole("button", { name: "Compare" }).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as { harness?: { compareTapped: () => boolean } }).harness?.compareTapped()),
      )
      .toBe(true);
  });

  test("FR20/RY22: a replay frame that cannot be served shows frame.replay_gone", async ({ page }) => {
    await page.route("**/assets/**", async (route) => {
      const file = join(HARNESS_DIST, "assets", basename(new URL(route.request().url()).pathname));
      await route.fulfill({ path: file });
    });
    await page.route("**/pool/**", async (route) => {
      await route.abort();
    });
    await page.route("**/harness", async (route) => {
      await route.fulfill({ path: join(HARNESS_DIST, "index.html"), contentType: "text/html" });
    });
    await page.goto("/harness");
    await sendEvents(page, LANDED_IX_1);
    await page.evaluate(() => {
      (window as { harness?: { mode: (m: string) => void } }).harness?.mode("replay");
    });
    await expect(
      page.locator(".pf-overlay"),
      "the frame shows frame.replay_gone within FRAME_LOAD_TIMEOUT_MS",
    ).toContainText("The recorded pool is no longer stored", { timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Reload the pool" })).toBeVisible();
  });
});

// ---- Track 1F's route-level acceptance, on the merged Floor. ----

const FRAME_IFRAME = 'iframe[title="The live pool, running the code on main"]';

test.describe("the built Floor", () => {
  test("track 1F (AC25/FE7): /p/<pool> shows that pool as the main pool", async ({ page }) => {
    await page.goto("/p/tidepool");
    const iframe = page.locator(FRAME_IFRAME);
    await expect(iframe).toHaveAttribute("src", /\/pool\/tidepool\/main\/\?seed=\d+/);
    await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  });

  test("track 1F (13.6): / shows the default pool of /floor.json", async ({ page, request }) => {
    const floorJson = await request.get("/floor.json");
    const defaultPool = (await floorJson.json()) as { default_pool?: string };
    await page.goto("/");
    await expect(page.locator(FRAME_IFRAME)).toHaveAttribute(
      "src",
      new RegExp(`/pool/${defaultPool.default_pool}/main/`),
    );
  });

  test("track 1F (8.6/RY17): /replay/tracer plays the fixture under REPLAY with a commit frame", async ({ page }) => {
    await page.goto("/replay/tracer");
    // The banner is the shell's; the frame's rules are mine: a fixed commit address, never
    // the moving source, ending at the recording's last landed commit.
    await expect(page.locator("text=/^REPLAY$/").first()).toBeVisible();
    const srcs = new Set<string>();
    await expect
      .poll(
        async () => {
          const src = await page.locator(FRAME_IFRAME).getAttribute("src");
          if (src !== null) srcs.add(src);
          return src;
        },
        { timeout: 30_000 },
      )
      .toMatch(new RegExp(`/pool/tidepool/${LANDED_2}/`));
    for (const src of srcs) {
      expect(src).toMatch(/\/pool\/tidepool\/(seed0000|c0c0c0)/);
      expect(src).not.toContain("/main/");
    }
  });
});
