// The floor-pool lane's browser checks (04-build-plan 1.4/1.5).
//
// `describe("the pool frame component")` mounts the lane's registered PoolArea in a small harness
// page (built once into .tmp-test/, served through page.route) and plays it against a fake pool
// host that speaks the PoolToFloor channel — so the frame's own rules are exercised in a real
// browser on this branch, before the shell lands.
//
// `describe("the built Floor")` holds the route-level statements of track 1F. They need the
// floor-shell lane's page; on this branch the app is still the Slice 0 stub, so each test skips
// itself with a reason after checking the page actually is the stub.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const HARNESS_DIR = join(ROOT, ".tmp-test/e2e-pool");
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

// ---- The harness page: the lane's PoolArea with a mutable FloorState. ----

const HARNESS_MAIN = `
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { PoolArea } from "../../src/floor/components/pool-frame/pool-area.tsx";
import { emptyFloorState, reduce } from "../../src/protocol/reducer/index.ts";

declare const window: Window & { harness?: Record<string, unknown>; compareTapped?: boolean };

function Harness() {
  const [state, setState] = useState(() => emptyFloorState());
  const [mode, setMode] = useState<"live" | "replay">("live");
  const [paused, setPaused] = useState(false);
  window.harness = {
    event: (e: unknown) => setState((s) => ({ ...reduce(s, e as never) })),
    mode: setMode,
    paused: setPaused,
    compareTapped: () => window.compareTapped === true,
  };
  return (
    <PoolArea
      pool="tidepool"
      state={state}
      mode={mode}
      paused={paused}
      onPausedChange={setPaused}
      onCompare={() => { window.compareTapped = true; }}
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
  build: { outDir: "dist", emptyOutDir: true },
});
`;

/** The fake pool host: a page for /pool/{pool}/{source}/ that speaks PoolToFloor (CO22): stats on
 * a heartbeat, messages it receives recorded on window.__log for the test to read. `__silent`
 * stops the heartbeat (a stall); `__v` is the version it reports. */
const POOL_PAGE = `<!doctype html><meta charset="utf-8"><title>pool</title><script>
  window.__log = [];
  window.__tick = 0;
  window.__paused = false;
  window.__silent = false;
  var part = location.pathname.split("/")[3];
  window.__v = (part === "main" || part === "green" || part === "plain") ? "c-live" : "c-" + part;
  window.addEventListener("message", function (e) {
    var d = e.data;
    window.__log.push(d);
    if (d && d.type === "advance") window.__v = d.version;
    if (d && d.type === "pause") window.__paused = true;
    if (d && d.type === "resume") window.__paused = false;
  });
  function beat() {
    if (window.__silent) return;
    parent.postMessage({ type: "stats", source: part, version: window.__v, seq: 1,
      tick: ++window.__tick, paused: window.__paused, kinds: {}, shown: 0, total: 0,
      swap: null, selftest: null }, "*");
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
    const frame = poolFrame(page);
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
    const frame = poolFrame(page);
    await expect
      .poll(async () =>
        frame?.evaluate(() =>
          (window as never as { __log: { type: string; version?: string }[] }).__log.map((m) => m.type),
        ),
      )
      .toContain("advance");
    const posts = await frame!.evaluate(() => (window as never as { __log: { type: string }[] }).__log);
    expect(posts.every((m) => m.type !== "probe")).toBe(true);
    await expect(iframe).toHaveAttribute("src", `/pool/tidepool/${LANDED_1}/?seed=7`);
  });

  test("CO23a: the pause control posts pause and resume to the frame", async ({ page }) => {
    await serveHarness(page);
    await sendEvents(page, 0);
    const frame = poolFrame(page);
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
    const frame = poolFrame(page);
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
