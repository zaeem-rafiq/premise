// The floor-pool lane's browser checks of the Compare view and the plain-merge frame
// (04-build-plan 2.7 items 3, 4 and 6; AC23, AC24).
//
// `describe("the Compare view")` mounts the lane's registered `view.compare` component and its
// plain-merge frame in a small harness page (built once into .tmp-test/, served through
// page.route) against a fake pool host that speaks the PoolToFloor channel — the same pattern
// frame.spec.ts uses, so the view's own rules are exercised in a real browser while the
// shell's compare branch is still open work. The harness mirrors the shell contract: a `view`
// state toggled by the key C (6.6), the Compare button's `onCompare`, and the back callback.
//
// `describe("the built Floor")` checks the shell side that already exists on this branch: key
// C and the Compare button flip the view switch both ways (data-view), and Esc closes it.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { ev, intentCreated, attemptOpened, poolState, serveStream } from "../shell/stream.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const HARNESS_DIR = join(ROOT, ".tmp-test/e2e-compare");
const HARNESS_DIST = join(HARNESS_DIR, "dist");

const COMMIT_1 = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c1"; // landing.landed seq 1
const COMMIT_2 = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c2"; // landing.landed seq 2
const PLAIN_1 = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"; // plain.updated commit 1
const PLAIN_2 = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"; // plain.updated commit 2

// ---- Stream builders (event fields match src/protocol/events.ts; expected copy is the
// spec's, never what the page happens to draw — BP1). ----

function repairHeadsup(n: number, attemptId: string, key = "world/energy.js#ENERGY_MAX") {
  return [
    ev(n, {
      type: "headsup.sent",
      attempt_id: attemptId,
      hn: 1,
      result: "repair",
      wake: true,
      cause: { type: "landing", seqs: [0], changes: [] },
      keys: [{ kind: "entity", key, rule: "E2" }],
      items: null,
      dropped_ops: [],
      go_around: 1,
    }),
    ev(n + 1, {
      type: "headsup.resolved",
      attempt_id: attemptId,
      hn: 1,
      result: "repair",
      go_around: 1,
      changed: true,
      statement: "Changed the read to the new scale.",
    }),
  ];
}

function confirmHeadsup(n: number, attemptId: string, key = "world/energy.js#ENERGY_MAX") {
  return [
    ev(n, {
      type: "headsup.sent",
      attempt_id: attemptId,
      hn: 1,
      result: "confirm",
      wake: true,
      cause: { type: "landing", seqs: [0], changes: [] },
      keys: [{ kind: "entity", key, rule: "B1" }],
      items: null,
      dropped_ops: [],
      go_around: null,
    }),
    ev(n + 1, {
      type: "headsup.resolved",
      attempt_id: attemptId,
      hn: 1,
      result: "confirm",
      go_around: null,
      changed: false,
      statement: "Read it.",
    }),
  ];
}

function landed(n: number, seq: number, attemptId: string, intentId: string, commit: string, tree: string) {
  return [
    ev(n, {
      type: "landing.accepted",
      seq,
      batch_id: seq,
      kind: "change",
      attempt_id: attemptId,
      change_id: `c_${attemptId}`,
      intent_id: intentId,
      request_id: null,
      paths: ["world/energy.js"],
      writes: [],
    }),
    ev(n + 1, {
      type: "landing.landed",
      seq,
      batch_id: seq,
      commit,
      tree,
      note: "note-1",
      note_json: null,
      time_to_land_ms: 1000,
    }),
  ];
}

function plainUpdated(n: number, over: Record<string, unknown> = {}) {
  return ev(n, {
    type: "plain.updated",
    commit: PLAIN_1,
    tree: "tree-plain-1",
    through_seq: 1,
    skipped: [],
    interrupted: [],
    ...over,
  });
}

/** A stream where one change went around once, then landed with tree "tree-landed-1". */
function baseStream(plainOver: Record<string, unknown> = {}) {
  return [
    poolState(1, { plain_remote: "https://artifacts.invalid/testpool-plain" }),
    intentCreated(2, "i_1", "make the crab hide"),
    attemptOpened(3, "a_1", "i_1"),
    ...repairHeadsup(4, "a_1"),
    ...landed(10, 1, "a_1", "i_1", COMMIT_1, "tree-landed-1"),
    plainUpdated(12, plainOver),
  ];
}

// ---- The harness page: PoolArea (floor) <-> Compare, toggled like the shell does. ----

const HARNESS_MAIN = `
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { PoolArea } from "../../src/floor/components/pool-frame/pool-area.tsx";
import { Compare } from "../../src/floor/components/compare/compare.tsx";
import { emptyFloorState, reduce } from "../../src/protocol/reducer/index.ts";

declare const window: Window & { harness?: Record<string, unknown> };

function Harness() {
  const [state, setState] = useState(() => emptyFloorState());
  const [view, setView] = useState<"floor" | "compare">("floor");
  const [mode, setMode] = useState<"live" | "replay">("live");
  const [paused, setPaused] = useState(false);
  // The harness mirrors the shell's contract (6.6, app.tsx): key C toggles the compare view
  // both ways, the pool frame's Compare button opens it, the view's Back closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "c" && !(e.target instanceof HTMLElement && e.target.closest("input,textarea,button,a"))) {
        setView((v) => (v === "compare" ? "floor" : "compare"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  window.harness = {
    event: (e: unknown) => setState((s) => ({ ...reduce(s, e as never) })),
    mode: setMode,
    paused: setPaused,
    view: () => view,
  };
  if (view === "compare") {
    return (
      <main className="floor-body floor-compare" data-view="compare">
        <Compare
          pool="tidepool"
          state={state}
          mode={mode}
          paused={paused}
          onPausedChange={setPaused}
          seed={42}
          onBack={() => setView("floor")}
        />
      </main>
    );
  }
  return (
    <main className="floor-body" data-view="floor">
      <PoolArea
        pool="tidepool"
        state={state}
        mode={mode}
        paused={paused}
        onPausedChange={setPaused}
        onCompare={state.pool.plain_remote !== null ? () => setView("compare") : undefined}
        seed={42}
        name="main"
      />
    </main>
  );
}
createRoot(document.getElementById("root") as HTMLElement).render(<Harness />);
`;

// The harness replicates the shell's stage/laptop padding (base.css --body-pad/--body-gap are
// 16px, 24px at stage width) so the frame-size checks of 2.3 measure what the page draws.
const HARNESS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>compare harness</title><style>
:root { --body-pad: 16px; --body-gap: 16px; }
@media (min-width: 1600px) { :root { --body-pad: 24px; --body-gap: 24px; } }
body { margin: 0; background: #0b1720; color: #eaf2f4; font-family: sans-serif; }
#root > .floor-body { display: grid; grid-template-columns: 1fr; padding: var(--body-pad); }
</style></head>
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

/** The fake pool host: a page for /pool/{pool}/{source}/ that speaks PoolToFloor (CO22).
 * Versions are source-true: `main` is `c-live`, `plain` is `p-live`, a commit address reports
 * its own token (`c-<commit>` / `p-<commit>`). `__log` records FloorToPool messages; `__v` is
 * the version it reports (advance moves it); `__silent` stops the heartbeat; `__stok` and
 * `__failed` script the CO25a self-test answer. */
const POOL_PAGE = `<!doctype html><meta charset="utf-8"><title>pool</title><script>
  window.__log = [];
  window.__tick = 0;
  window.__paused = /paused=1/.test(location.search);
  window.__silent = false;
  window.__stok = true;
  window.__failed = [];
  window.__asked = false; // set when a probe {selftest:true} arrives (CO25a)
  var part = location.pathname.split("/")[3];
  window.__v = part === "main" ? "c-live"
    : part === "plain" ? "p-live"
    : part === "green" ? "c-green"
    : part.slice(0, 2) === "p-" ? part : "c-" + part;
  window.addEventListener("message", function (e) {
    var d = e.data;
    window.__log.push(d);
    if (d && d.type === "advance") window.__v = d.version;
    if (d && d.type === "pause") window.__paused = true;
    if (d && d.type === "resume") window.__paused = false;
    if (d && d.type === "probe" && d.selftest === true) window.__asked = true;
  });
  // The self-test answer is read at beat time so a spec can flip __stok/__failed after the
  // frame is up; the badge then follows the newest stats.selftest (NP8).
  function beat() {
    if (window.__silent) return;
    parent.postMessage({ type: "stats", source: part, version: window.__v, seq: 1,
      tick: ++window.__tick, paused: window.__paused, kinds: {}, shown: 0, total: 0,
      swap: null,
      selftest: window.__asked ? { version: window.__v, ok: window.__stok, failed: window.__failed } : null }, "*");
  }
  beat();
  setInterval(beat, 200);
</script>`;

async function serveCompare(page: Page): Promise<void> {
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
}

/** Push events into the harness's reducer. */
async function send(page: Page, frames: Array<Record<string, unknown>>): Promise<void> {
  await page.evaluate((list) => {
    const harness = (window as { harness?: { event: (e: unknown) => void } }).harness;
    for (const e of list as Array<Record<string, unknown>>) harness?.event(e);
  }, frames);
}

const FRAME_URL = {
  main: /\/pool\/tidepool\/(main)\//,
  plain: /\/pool\/tidepool\/(plain)\//,
  // A replayed plain frame sits at a p-<commit> address, a replayed main frame at <commit>.
  "plain-replay": /\/pool\/tidepool\/p-/,
} as const;

function poolFrame(page: Page, source: keyof typeof FRAME_URL) {
  return page.frames().find((f) => FRAME_URL[source].test(f.url()));
}

async function openCompare(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "c" }));
  });
  await expect(page.locator(".cmp")).toBeVisible();
  await expect(page.locator(".floor-body")).toHaveAttribute("data-view", "compare");
}

type FrameLog = { type: string; version?: string; selftest?: boolean }[] | null;

/** The fake host's recorded FloorToPool log — null while the iframe is mid-navigation (a
 * replay `advance` reload swaps the element and `page.frames()` has a gap). */
const logOf = async (page: Page, source: keyof typeof FRAME_URL): Promise<FrameLog> => {
  const frame = poolFrame(page, source);
  if (frame === undefined) return null;
  return frame.evaluate(
    () => (window as never as { __log: { type: string; version?: string; selftest?: boolean }[] }).__log,
  );
};

/** The frame's log, re-read until the frame exists — navigation gaps are a swap, not data. */
async function liveLog(page: Page, source: keyof typeof FRAME_URL): Promise<FrameLog> {
  let log: FrameLog = null;
  await expect.poll(async () => (log = await logOf(page, source)) !== null).toBe(true);
  return log;
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

test.describe("the Compare view", () => {
  test("2.3/CO24a: both frames load their live sources in the same view with the same seed", async ({ page }) => {
    await serveCompare(page);
    await send(page, [poolState(1, { plain_remote: "https://artifacts.invalid/testpool-plain" })]);
    await openCompare(page);
    const main = page.locator('.cmp-col[data-pool="main"] iframe');
    const plain = page.locator('.cmp-col[data-pool="plain"] iframe');
    await expect(main).toHaveAttribute("src", /\/pool\/tidepool\/main\/\?seed=42$/);
    await expect(plain).toHaveAttribute("src", /\/pool\/tidepool\/plain\/\?seed=42$/);
    await expect(plain).toHaveAttribute("sandbox", "allow-scripts");
    // CO24: the two caption lines are always there, the second naming the through landing.
    await expect(page.locator(".plf-caption")).toContainText("Same changes, merged by plain git");
  });

  test("3.6 loading: before plain.updated the frame shows plain.loading, caption still full", async ({ page }) => {
    await serveCompare(page);
    await send(page, [poolState(1, { plain_remote: "https://artifacts.invalid/testpool-plain" })]);
    await openCompare(page);
    await expect(page.locator(".plf-overlay")).toContainText("Building the plain-merge pool");
    await expect(page.locator(".plf-caption")).toContainText("Same changes, merged by plain git");
    await expect(page.locator(".plf-caption")).toContainText("Constructed for comparison");
    // The diff section says the same thing and counts no conflicts it cannot know (CO25 4).
    await expect(page.locator(".cmp-diff")).toContainText("Building the plain-merge pool");
    await expect(page.locator(".cmp-conflicts")).toHaveCount(0);
    // The Back button and the thesis are the view's fixed tail (CO25 5, 6).
    await expect(page.getByRole("button", { name: "Back to the Floor" })).toBeVisible();
    const thesis = page.locator(".cmp-thesis");
    await expect(thesis).toContainText("Git records only what an agent wrote.");
    expect(await thesis.evaluate((el) => el.parentElement!.lastElementChild === el)).toBe(true);
  });

  test("AC23/SE16a: plain.updated posts probe to the plain frame; the src never moves", async ({ page }) => {
    await serveCompare(page);
    await send(page, baseStream());
    await openCompare(page);
    const plain = page.locator('.cmp-col[data-pool="plain"] iframe');
    await expect(plain).toHaveAttribute("src", /\/pool\/tidepool\/plain\/\?seed=42$/);
    const srcBefore = await plain.getAttribute("src");
    // A second plain.updated — the frame is told by a debounced probe, never by a new src.
    await send(page, [plainUpdated(30, { commit: PLAIN_2, tree: "tree-plain-2", through_seq: 1 })]);
    await expect.poll(async () => (await logOf(page, "plain"))?.map((m) => m.type) ?? []).toContain("probe");
    expect(await plain.getAttribute("src")).toBe(srcBefore);
    expect((await liveLog(page, "plain"))!.every((m) => m.type !== "advance")).toBe(true);
  });

  test("AC23/RY17: in Replay the plain frame is a commit frame on p-<commit> that gets advance", async ({ page }) => {
    await serveCompare(page);
    await send(page, baseStream());
    await openCompare(page);
    await page.evaluate(() => (window as never as { harness: { mode: (m: string) => void } }).harness.mode("replay"));
    const plain = page.locator('.cmp-col[data-pool="plain"] iframe');
    await expect(plain).toHaveAttribute("src", `/pool/tidepool/p-${PLAIN_1}/?seed=42`);
    await send(page, [plainUpdated(30, { commit: PLAIN_2, tree: "tree-plain-2", through_seq: 1 })]);
    // Read both claims off one log: the advance went out, and the only probes the commit
    // frame ever gets carry selftest (CO25a; SE16a forbids the live-mode probe here).
    await expect
      .poll(async () => {
        const log = await logOf(page, "plain-replay");
        if (log === null) return "navigating";
        if (!log.some((m) => m.type === "advance" && m.version === `p-${PLAIN_2}`)) return "waiting";
        return log.every((m) => m.type !== "probe" || m.selftest === true) ? "ok" : "bare-probe";
      })
      .toBe("ok");
  });

  test("AC24: equal trees show plain.no_difference; differing trees do not", async ({ page }) => {
    await serveCompare(page);
    // plain.tree equals landed.tree of landing 1 (PM7) — the one fact the line may stand on.
    await send(page, baseStream({ tree: "tree-landed-1" }));
    await openCompare(page);
    await expect(page.locator(".cmp-no-diff")).toContainText(
      "No visible difference in this run. Both pools hold the same files.",
    );
    // The same run with a different tree must not claim sameness.
    await send(page, [plainUpdated(30, { commit: PLAIN_2, tree: "tree-plain-2" })]);
    await expect(page.locator(".cmp-no-diff")).toHaveCount(0);
  });

  test("AC24/PM4: a landing in plain.interrupted is labelled plain.interrupted", async ({ page }) => {
    await serveCompare(page);
    await send(page, baseStream({ interrupted: [1] }));
    await openCompare(page);
    const items = page.locator(".cmp-diff li.cmp-line");
    await expect(items).toHaveCount(1);
    await expect(items.nth(0)).toContainText("its agent was sent back in the middle of its work");
    await expect(items.nth(0)).not.toContainText("went around");
  });

  test("AC24/PM3: the conflict count comes from plain.skipped and carries '(approximated)'", async ({ page }) => {
    await serveCompare(page);
    await send(page, baseStream({ skipped: [1, 2] }));
    await openCompare(page);
    await expect(page.locator(".cmp-conflicts")).toContainText("Text conflicts in the plain merge: 2 (approximated)");
  });

  test("CO25: the went-around and confirmed lines name the change and the key; the list is ordered", async ({
    page,
  }) => {
    await serveCompare(page);
    await send(page, [
      poolState(1, { plain_remote: "https://artifacts.invalid/testpool-plain" }),
      intentCreated(2, "i_1", "make the crab hide"),
      attemptOpened(3, "a_1", "i_1"),
      ...repairHeadsup(4, "a_1"),
      ...landed(10, 1, "a_1", "i_1", COMMIT_1, "tree-landed-1"),
      intentCreated(14, "i_2", "read the energy"),
      attemptOpened(15, "a_2", "i_2"),
      ...confirmHeadsup(16, "a_2"),
      ...landed(20, 2, "a_2", "i_2", COMMIT_2, "tree-landed-2"),
      plainUpdated(30, { through_seq: 2 }),
    ]);
    await openCompare(page);
    const lines = page.locator(".cmp-diff li.cmp-line");
    await expect(lines.nth(0)).toContainText(
      '"make the crab hide": went around once after ENERGY_MAX changed. The plain-merge pool has its first version.',
    );
    await expect(lines.nth(1)).toContainText(
      '"read the energy": confirmed ENERGY_MAX before landing. The plain-merge pool has its first version.',
    );
    // 3.6 held row: through_seq 2 vs landed_seq 2 — caught up, no behind chip.
    await expect(page.locator(".plf-chip")).toHaveCount(0);
  });

  test("3.6 held row: plain.through_seq behind landed_seq adds the plain.behind chip", async ({ page }) => {
    await serveCompare(page);
    await send(page, [
      poolState(1, { plain_remote: "https://artifacts.invalid/testpool-plain" }),
      intentCreated(2, "i_1", "make the crab hide"),
      attemptOpened(3, "a_1", "i_1"),
      ...landed(10, 1, "a_1", "i_1", COMMIT_1, "t1"),
      intentCreated(12, "i_2", "read the energy"),
      attemptOpened(13, "a_2", "i_2"),
      ...landed(14, 2, "a_2", "i_2", COMMIT_2, "t2"),
      intentCreated(16, "i_3", "add a fish"),
      attemptOpened(17, "a_3", "i_3"),
      ...landed(18, 3, "a_3", "i_3", "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c3", "t3"),
      plainUpdated(24, { through_seq: 1 }),
    ]);
    await openCompare(page);
    await expect(page.locator(".plf-chip")).toContainText("This pool is 2 landings behind.");
  });

  test("CO25a/AC24: each badge follows only its own frame's stats.selftest", async ({ page }) => {
    await serveCompare(page);
    await send(page, baseStream());
    await openCompare(page);
    const main = poolFrame(page, "main");
    const plain = poolFrame(page, "plain");
    await expect.poll(async () => main !== undefined && plain !== undefined).toBe(true);
    // The plain pool fails one check; the main pool passes. A failed check names the check's
    // own label and, in brackets, the kind it names (CO25a, selftest.fail.line, 5.7).
    await plain!.evaluate(() => {
      (window as never as { __stok: boolean }).__stok = false;
      (window as never as { __failed: { name: string; kind: string }[] }).__failed = [
        { name: "visible", kind: "fish" },
      ];
    });
    await expect(page.locator(".plf-selftest")).toContainText("failed · 1 check", { timeout: 10_000 });
    await expect(page.locator(".plf-selftest")).toContainText("Every creature can be seen (fish)", {
      timeout: 10_000,
    });
    await expect(page.locator(".pf-selftest")).toContainText("passed", { timeout: 10_000 });
    // Each badge is the pool's own self-test — a new running badge on one side cannot read as
    // the other's verdict.
    const badgeTexts = await page.locator(".pf-selftest, .plf-selftest").allTextContents();
    expect(badgeTexts.join(" ")).not.toContain("running");
  });

  test("CO23a: the shared pause posts pause and resume to both frames", async ({ page }) => {
    await serveCompare(page);
    await send(page, baseStream());
    await openCompare(page);
    await expect.poll(async () => poolFrame(page, "main") !== undefined).toBe(true);
    await expect.poll(async () => poolFrame(page, "plain") !== undefined).toBe(true);
    await page.evaluate(() => (window as never as { harness: { paused: (b: boolean) => void } }).harness.paused(true));
    for (const source of ["main", "plain"] as const) {
      await expect.poll(async () => (await logOf(page, source))?.map((m) => m.type) ?? []).toContain("pause");
    }
    await page.evaluate(() => (window as never as { harness: { paused: (b: boolean) => void } }).harness.paused(false));
    for (const source of ["main", "plain"] as const) {
      await expect.poll(async () => (await logOf(page, source))?.map((m) => m.type) ?? []).toContain("resume");
    }
  });

  test("2.3/6.6: key C, the Compare button and the Back button switch the view both ways", async ({ page }) => {
    await serveCompare(page);
    await send(page, baseStream());
    // The Compare button of the floor view's frame opens the view (CO24).
    await page.getByRole("button", { name: "Compare" }).click();
    await expect(page.locator(".cmp")).toBeVisible();
    // Its Back button closes it (CO25 item 5).
    await page.getByRole("button", { name: "Back to the Floor" }).click();
    await expect(page.locator(".cmp")).toHaveCount(0);
    await expect(page.locator(".floor-body")).toHaveAttribute("data-view", "floor");
    // Key C opens; key C closes (2.3: "Closed by the same").
    await page.keyboard.press("c");
    await expect(page.locator(".cmp")).toBeVisible();
    await page.keyboard.press("c");
    await expect(page.locator(".cmp")).toHaveCount(0);
  });

  test("2.3: at 1920x1080 each frame is about 924x520 and nothing scrolls sideways", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await serveCompare(page);
    await send(page, baseStream());
    await openCompare(page);
    const main = page.locator('.cmp-col[data-pool="main"] .pf-body');
    const plain = page.locator('.cmp-col[data-pool="plain"] .plf-body');
    await expect(main).toBeVisible();
    await expect(plain).toBeVisible();
    const mainBox = await main.boundingBox();
    const plainBox = await plain.boundingBox();
    expect(Math.abs((mainBox?.width ?? 0) - 924)).toBeLessThanOrEqual(2);
    expect(Math.abs((mainBox?.height ?? 0) - 520)).toBeLessThanOrEqual(2);
    expect(Math.abs((plainBox?.width ?? 0) - 924)).toBeLessThanOrEqual(2);
    expect(Math.abs((plainBox?.height ?? 0) - 520)).toBeLessThanOrEqual(2);
    // 2.8: nothing past the viewport's edge.
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(1920);
  });

  test("2.8: at 1440x900 the two frames fit the laptop width and nothing scrolls sideways", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await serveCompare(page);
    await send(page, baseStream());
    await openCompare(page);
    // (1440 - 2*16 padding - 16 gap) / 2 = 696 per column, 16:9 -> ~391.5 high.
    const plainBox = await page.locator('.cmp-col[data-pool="plain"] .plf-body').boundingBox();
    const mainBox = await page.locator('.cmp-col[data-pool="main"] .pf-body').boundingBox();
    expect(Math.abs((plainBox?.width ?? 0) - 696)).toBeLessThanOrEqual(2);
    expect(Math.abs((plainBox?.height ?? 0) - 392)).toBeLessThanOrEqual(2);
    expect(Math.abs((mainBox?.width ?? 0) - 696)).toBeLessThanOrEqual(2);
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(1440);
  });
});

test.describe("the built Floor", () => {
  test("6.6/2.3: key C and the Compare button flip the view switch; Esc closes it", async ({ page }) => {
    await serveStream(page, [poolState(1, { plain_remote: "https://artifacts.invalid/testpool-plain" })]);
    await page.route("**/pool/**", async (route) => {
      await route.fulfill({ contentType: "text/html", body: POOL_PAGE });
    });
    await page.goto("/p/testpool");
    await expect(page.locator(".floor-body")).toHaveAttribute("data-view", "floor");
    // The Compare button (frame.compare) opens the view when the pool has a plain remote.
    await page.getByRole("button", { name: "Compare" }).click();
    await expect(page.locator(".floor-body")).toHaveAttribute("data-view", "compare");
    // Keys are held while a control has focus (6.6/AX13) — release it before pressing C.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("c");
    await expect(page.locator(".floor-body")).toHaveAttribute("data-view", "floor");
    await page.keyboard.press("c");
    await expect(page.locator(".floor-body")).toHaveAttribute("data-view", "compare");
    await page.keyboard.press("Escape");
    await expect(page.locator(".floor-body")).toHaveAttribute("data-view", "floor");
  });
});
