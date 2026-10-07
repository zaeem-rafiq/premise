// The Why card, the "show the git" drawer and the Who relies panel (04-build-plan 2.8 items 1,
// 2 and 4; 03-floor 2.5, 3.9, 3.10, 3.11; 01-core 11.6, CM1-CM5, EV6). Mounted in the lane's
// harness style: a real Chromium page with a fake pool host and a fake note route; FloorState is
// built by replaying hero-c04 / hero-c05 through the shared reducer. Expected values are read
// off the streams and the spec, never off the page (BP1).

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
const HARNESS_DIR = join(ROOT, `.tmp-test/e2e-why-${process.env.TEST_PARALLEL_INDEX ?? "0"}`);
const HARNESS_DIST = join(HARNESS_DIR, "dist");

function load(name: string): Record<string, unknown>[] {
  return readFileSync(join(ROOT, "test/fixtures/streams", name), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => typeof line.type === "string");
}

const C04 = load("hero-c04.ndjson");
const C05 = load("hero-c05.ndjson");
const C04_ALL = C04.length - 1; // last event index
const C05_ALL = C05.length - 1;
/** hero-c04, with every `landing.landed.note_json` empty — the stream then holds no note and the
 * card must call the note route of 03-floor 4.5. */
const C04_NO_NOTE = C04.map((event) => (event.type === "landing.landed" ? { ...event, note_json: null } : event));

/** The note the fake route answers for seq 2 — a record the stream alone never gave. */
const NOTE_2 = {
  v: 1,
  hash_version: "ast1",
  seq: 2,
  kind: "change",
  change_id: "c-a_A",
  revision: 1,
  intent: {
    id: "i_A",
    text: "a crab that hides when its energy is low",
    requester: "owner",
    created_at: "2024-01-01T00:00:01Z",
  },
  attempt: {
    id: "a_A",
    agent: "real",
    model: "model-a",
    repo: null,
    opened_seq: 0,
    steps: 2,
    model_calls: 2,
    tokens_in: 10,
    tokens_out: 20,
  },
  summary: "Add a crab that hides when its energy is low",
  premises: [
    {
      kind: "entity",
      key: "world/energy.js#ENERGY_MAX",
      hash: "h-energy-1",
      seq: 1,
      read: true,
      edit: false,
      derived: true,
    },
    { kind: "file", key: "creatures/crab.js", hash: "absent", seq: 0, read: false, edit: true, derived: false },
  ],
  writes: [{ kind: "entity", key: "creatures/crab.js#update", old: "h-crab-30", new: "h-crab-03" }],
  ops: [],
  go_arounds: [
    {
      n: 1,
      hn: 1,
      cause: "landing",
      cause_seqs: [1],
      keys: [{ kind: "entity", key: "world/energy.js#ENERGY_MAX", rule: "E2" }],
      statement: "Energy is now a fraction from 0 to 1, so the hide threshold is 0.3.",
      at: "2024-01-01T00:00:08Z",
    },
  ],
  confirms: [],
  judgments: [
    {
      kind: "entity",
      key: "world/energy.js#ENERGY_MAX",
      old: "h-energy-100",
      new: "h-energy-1",
      cause_seq: 1,
      rule: "E2",
      class: "rule",
      result: "repair",
      reason: "ENERGY_MAX is now 1, a fraction scale",
    },
  ],
  checks: [],
  policy: { tier: "auto", approved_by: null, approved_at: null, option: "auto", risk: null },
  pull_backs: 0,
  batch: { id: 2, index: 0, size: 1 },
  timing: {
    opened_at: "2024-01-01T00:00:01Z",
    submitted_at: "2024-01-01T00:00:08Z",
    accepted_at: "2024-01-01T00:00:09Z",
  },
};

// ---- The harness page: PoolArea plus the two sheets under ShellContext. ----

const HARNESS_MAIN = `
import "../../src/floor/styles/base.css";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ShellContext, makeShell } from "../../src/floor/app/context.ts";
import { PoolArea } from "../../src/floor/components/pool-frame/pool-area.tsx";
import { WhySheet } from "../../src/floor/components/why/why.tsx";
import { WhoSheet } from "../../src/floor/components/who-relies/who-relies.tsx";
import { emptyFloorState, reduce } from "../../src/protocol/reducer/index.ts";

const SETTINGS = {
  default_pool: "tidepool",
  swarm_pool: "tidepool-swarm",
  features: { held: true, race: true, undo: true, green: "full", clef: true, attempt_repos: true },
  prewritten: [],
  swarm_defaults: { seed: 7, launch_per_second: 50, think_ms: [50, 400], rescale_every_s: 15 },
  models: { "model-a": "model-a" },
  limits: [],
  related: "",
};

declare const window: Window & {
  harness?: Record<string, unknown>;
  sheetKind?: string | null;
  lastAttempt?: string;
};

function Harness() {
  const [state, setState] = useState(() => emptyFloorState());
  const [owner, setOwner] = useState(true);
  const [mode, setMode] = useState<"live" | "replay">("live");
  const [sheet, setSheet] = useState<
    | { kind: "why"; seq: number }
    | { kind: "who"; kind_: string; key: string }
    | null
  >(null);
  const [highlight, setHighlight] = useState<string[] | undefined>(undefined);
  const [banner, setBanner] = useState(false);
  const shell = makeShell(SETTINGS as never, owner, mode === "replay");
  const close = () => { setSheet(null); window.sheetKind = null; };
  window.harness = {
    event: (e: unknown) => setState((s) => ({ ...reduce(s, e as never) })),
    owner: (value: boolean) => setOwner(value),
    mode: (m: "live" | "replay") => setMode(m),
    banner: (on: boolean) => setBanner(on),
    openWhy: (seq: number) => { setSheet({ kind: "why", seq }); window.sheetKind = "why"; },
    openWho: (kind: string, key: string) => { setSheet({ kind: "who", kind_: kind, key }); window.sheetKind = "who"; },
    closeSheet: close,
    sheet: () => sheet,
  };
  return (
    <ShellContext.Provider value={shell}>
      {banner && (
        <div className="banner" role="status" data-testid="banner">
          SYNTHETIC
        </div>
      )}
      <div className="floor-main" style={{ position: "relative", minHeight: "90vh" }}>
        <button type="button" id="why-open" onClick={() => { setSheet({ kind: "why", seq: 2 }); window.sheetKind = "why"; }}>
          open-why
        </button>
        <PoolArea
          pool="tidepool"
          state={state}
          mode={mode}
          highlight={highlight}
          onTapped={(path) => {
            const seq = state.files[path]?.last_landed_seq;
            if (seq !== null && seq !== undefined) { setSheet({ kind: "why", seq }); window.sheetKind = "why"; }
          }}
          onTileWho={(path) => { setSheet({ kind: "who", kind_: "file", key: path }); window.sheetKind = "who"; }}
          onTileWhy={(_path, seq) => { setSheet({ kind: "why", seq }); window.sheetKind = "why"; }}
        />
        {sheet?.kind === "why" && (
          <WhySheet
            floor={state}
            seq={sheet.seq}
            mode={mode}
            onClose={close}
            onOpenWho={(kind, key) => { setSheet({ kind: "who", kind_: kind, key }); window.sheetKind = "who"; }}
            onOpenUndo={(seq) => { window.lastUndo = seq; }}
          />
        )}
        {sheet?.kind === "who" && (
          <WhoSheet
            floor={state}
            kind_={sheet.kind_}
            whoKey={sheet.key}
            onClose={close}
            onOpenWhy={(seq) => { setSheet({ kind: "why", seq }); window.sheetKind = "why"; }}
            onOpenAttempt={(id) => { window.lastAttempt = id; }}
            onKinds={(kinds) => setHighlight(kinds)}
          />
        )}
      </div>
    </ShellContext.Provider>
  );
}
createRoot(document.getElementById("root") as HTMLElement).render(<Harness />);
`;

const HARNESS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>why harness</title></head>
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

/** The fake pool host of frame.spec.ts, plus `__tap(path)` posting CO22's `tapped` message. */
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
      window.__st = { version: window.__v, ok: true, failed: [] };
    }
  });
  window.__tap = function (path) {
    parent.postMessage({ type: "tapped", creature: "crab", path: path }, "*");
  };
  function beat() {
    if (window.__silent) return;
    parent.postMessage({ type: "stats", source: part, version: window.__v, seq: 1,
      tick: ++window.__tick, paused: window.__paused, kinds: {}, shown: 0, total: 0,
      swap: null, selftest: window.__st }, "*");
  }
  beat();
  setInterval(beat, 200);
</script>`;

/** The note route's answer for the next fetch; `null` means 404. */
let noteAnswer: { status: number; body: unknown } | null = null;

async function serveHarness(page: Page): Promise<void> {
  await page.route("**/assets/**", async (route) => {
    const file = join(HARNESS_DIST, "assets", basename(new URL(route.request().url()).pathname));
    await route.fulfill({ path: file });
  });
  await page.route("**/pool/**", async (route) => {
    await route.fulfill({ contentType: "text/html", body: POOL_PAGE });
  });
  await page.route("**/api/pools/*/landings/*/note", async (route) => {
    if (noteAnswer === null) {
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    } else {
      await route.fulfill({
        status: noteAnswer.status,
        contentType: "application/json",
        body: JSON.stringify(noteAnswer.body),
      });
    }
  });
  await page.route("**/harness", async (route) => {
    await route.fulfill({ path: join(HARNESS_DIST, "index.html"), contentType: "text/html" });
  });
  await page.goto("/harness");
  await expect(page.locator(".pf")).toBeVisible();
}

function poolFrame(page: Page) {
  return page.frames().find((f) => f.url().includes("/pool/tidepool/"));
}

async function sendEvents(page: Page, events: Record<string, unknown>[], throughIndex: number): Promise<void> {
  await page.evaluate(
    ([list, through]) => {
      const harness = (window as { harness?: { event: (e: unknown) => void } }).harness;
      for (const e of (list as unknown[]).slice(0, (through as number) + 1)) harness?.event(e);
    },
    [events, throughIndex] as const,
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

test.beforeEach(() => {
  noteAnswer = null;
});

test.describe("2.8 item 1 — the Why card (3.9, CO22)", () => {
  for (const { role, owner, mode, canUndo } of [
    { role: "owner", owner: true, mode: "live", canUndo: true },
    { role: "visitor", owner: false, mode: "live", canUndo: false },
    { role: "owner in Replay", owner: true, mode: "replay", canUndo: false },
    { role: "visitor in Replay", owner: false, mode: "replay", canUndo: false },
  ] as const) {
    test(`FL7 / 3.12: ${role} ${canUndo ? "has" : "has no"} Undo button on a change Why card`, async ({ page }) => {
      await serveHarness(page);
      await sendEvents(page, C04, C04_ALL);
      await page.evaluate(
        ({ owner, mode }) => {
          const harness = (
            window as { harness?: { owner: (value: boolean) => void; mode: (value: "live" | "replay") => void } }
          ).harness;
          harness?.owner(owner);
          harness?.mode(mode);
        },
        { owner, mode },
      );
      await page.locator("#why-open").click();
      const sheet = page.getByRole("dialog", { name: "Why is this here?", exact: true });
      await expect(sheet).toBeVisible();
      await expect(sheet).toHaveAttribute("data-status", "live");
      await expect(sheet.locator(".why-head")).toContainText("landing 2");
      await expect(sheet.getByRole("button", { name: "Show the git", exact: true })).toBeVisible();
      const undo = sheet.getByRole("button", { name: "Undo", exact: true });
      if (canUndo) {
        await expect(undo).toBeVisible();
        await expect(undo).toBeEnabled();
        await undo.click();
        await expect.poll(() => page.evaluate(() => (window as { lastUndo?: number }).lastUndo)).toBe(2);
      } else {
        await expect(undo).toHaveCount(0);
      }
    });
  }

  test("a tapped creature opens the Why card of its newest change (hero-c04)", async ({ page }) => {
    await serveHarness(page);
    await sendEvents(page, C04, C04_ALL);
    await expect.poll(async () => (await poolFrame(page)?.evaluate(() => true)) ?? false).toBe(true);
    const frame = poolFrame(page)!;
    // The frame reports a tap on creatures/crab.js (CO22); the shell opens the newest landing.
    await frame.evaluate(() => (window as never as { __tap: (p: string) => void }).__tap("creatures/crab.js"));
    const sheet = page.getByRole("dialog", { name: "Why is this here?" });
    await expect(sheet).toBeVisible();
    await expect(sheet).toBeFocused(); // AX4
    // who asked: requester + intent words (hero-c04's a_A intent).
    await expect(sheet).toContainText('owner: "a crab that hides when its energy is low"');
    // who wrote it: a real agent on the model the stream named.
    await expect(sheet).toContainText("A real agent on model-a.");
    // what it relied on: the frozen lights, keyLabel words.
    await expect(sheet.locator('[data-section="relied"]')).toContainText("ENERGY_MAX in world/energy.js");
    await expect(sheet.locator('[data-section="relied"]')).toContainText("the file creatures/crab.js");
    // what changed under it: go-around 1, rule sentence, cause landing + its intent, statement.
    await expect(sheet).toContainText(
      'Go-around 1: ENERGY_MAX in world/energy.js changed (E2, ENERGY_MAX is now 1, a fraction scale). (landing 1: "make energy a fraction from 0 to 1").',
    );
    await expect(sheet).toContainText(
      'The agent said: "Energy is now a fraction from 0 to 1, so the hide threshold is 0.3."',
    );
    // checks and how it landed.
    await expect(sheet).toContainText("0 of 0 checks passed.");
    await expect(sheet).toContainText(
      "By itself. Everything it relied on was still true, and no held path was touched.",
    );
    await expect(sheet).toContainText("landing 2");
  });

  test("a tapped creature opens the Why card (hero-c05: the crab's newest change is seq 2)", async ({ page }) => {
    await serveHarness(page);
    await sendEvents(page, C05, C05_ALL);
    await expect.poll(async () => (await poolFrame(page)?.evaluate(() => true)) ?? false).toBe(true);
    const frame = poolFrame(page)!;
    await frame.evaluate(() => (window as never as { __tap: (p: string) => void }).__tap("creatures/crab.js"));
    const sheet = page.getByRole("dialog", { name: "Why is this here?" });
    await expect(sheet).toBeVisible();
    // In c05 landing 2 (i_S) wrote world/energy.js AND creatures/crab.js, so the
    // newest change on the crab's file is a_S's "make energy" landing (4.4).
    await expect(sheet).toContainText('owner: "make energy a fraction from 0 to 1"');
    await expect(sheet).toContainText("landing 2");
    // its go-around: the QR1 referrers judgment, its cause landing and its statement.
    await expect(sheet).toContainText(
      'Go-around 1: the list of code that uses ENERGY_MAX in world/energy.js changed (QR1, new referrers of ENERGY_MAX: creatures/crab.js). (landing 1: "a crab that hides when its energy is low").',
    );
    await expect(sheet).toContainText(
      'The agent said: "The new crab compared energy with 30; changed it to 0.3 in the same change."',
    );
  });

  test("3.9 state: an accepted, not yet landed landing shows why.landing only (FL3)", async ({ page }) => {
    await serveHarness(page);
    // hero-c04: landing.accepted of seq 1 is index 25; landing.landed is index 30.
    await sendEvents(page, C04, 29);
    await page.evaluate(() => (window as { harness?: { openWhy: (s: number) => void } }).harness?.openWhy(1));
    const sheet = page.getByRole("dialog", { name: "Why is this here?" });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("This change is landing. Its record appears when main has it.");
    await expect(sheet).not.toContainText("Who asked");
  });
});

test.describe("2.8 item 2 — the git drawer (3.10, CM1-CM5)", () => {
  test("'Show the git' shows the commit, the trailers, the note and the commands", async ({ page }) => {
    await serveHarness(page);
    await sendEvents(page, C04, C04_ALL);
    await page.evaluate(() => (window as { harness?: { openWhy: (s: number) => void } }).harness?.openWhy(2));
    const sheet = page.getByRole("dialog", { name: "Why is this here?" });
    await sheet.getByRole("button", { name: "Show the git" }).click();
    const drawer = page.locator(".git-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText("This is an ordinary git commit on main, in Artifacts.");
    // commit id, parent (the commit of landing 1, CM1) and tree in full.
    await expect(drawer).toContainText("c044bbbb04c04c04c04c04c04c04c04c04c04c04");
    await expect(drawer).toContainText("c044aaaa04c04c04c04c04c04c04c04c04c04c04");
    await expect(drawer).toContainText("tree-2");
    // the two trailers of CM4.
    await expect(drawer).toContainText("Change-Id: c-a_A");
    await expect(drawer).toContainText("Intent-Id: i_A");
    await expect(drawer).toContainText("Intent: a crab that hides when its energy is low");
    // the note, re-indented (the stream's note_json as stored).
    await expect(drawer.locator(".git-note")).toContainText('"change_id": "c-a_A"');
    // the two plain-git commands of 01-core 3.5 and the clone command of 3.10.
    await expect(drawer).toContainText("git fetch origin refs/notes/premise:refs/notes/premise");
    await expect(drawer).toContainText("git log --notes=premise");
    await expect(drawer).toContainText("git clone https://artifacts.test/tidepool");
    await expect(drawer).toContainText("read token");
    // G closes the drawer (6.6); G again reopens.
    await page.keyboard.press("g");
    await expect(drawer).not.toBeVisible();
    await page.keyboard.press("g");
    await expect(drawer).toBeVisible();
  });

  test("the drawer fetches the note route when the stream has no note_json (4.5)", async ({ page }) => {
    await serveHarness(page);
    let routeHits = 0;
    await page.route("**/api/pools/*/landings/*/note", async (route) => {
      routeHits += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(NOTE_2) });
    });
    await sendEvents(page, C04_NO_NOTE, C04_NO_NOTE.length - 1);
    await page.evaluate(() => (window as { harness?: { openWhy: (s: number) => void } }).harness?.openWhy(2));
    const sheet = page.getByRole("dialog", { name: "Why is this here?" });
    await expect(sheet).toBeVisible();
    await expect.poll(() => routeHits).toBe(1);
    // the drawer then shows the fetched note and the fetched fields.
    await sheet.getByRole("button", { name: "Show the git" }).click();
    const drawer = page.locator(".git-drawer");
    await expect(drawer.locator(".git-note")).toContainText('"change_id": "c-a_A"');
    await expect(drawer.locator(".git-note")).toContainText('"model_calls": 2');
  });

  test("a 404 from the note route shows git.no_note (EV6)", async ({ page }) => {
    noteAnswer = null; // 404
    await serveHarness(page);
    await sendEvents(page, C04_NO_NOTE, C04_NO_NOTE.length - 1);
    await page.evaluate(() => (window as { harness?: { openWhy: (s: number) => void } }).harness?.openWhy(2));
    const sheet = page.getByRole("dialog", { name: "Why is this here?" });
    // the card keeps the stream's fields, then why.partial (3.9's error row).
    await expect(sheet).toContainText('owner: "a crab that hides when its energy is low"');
    await expect(sheet).toContainText(
      "This is what the page received. The full record is the git note on this commit.",
    );
    await sheet.getByRole("button", { name: "Show the git" }).click();
    const drawer = page.locator(".git-drawer");
    await expect(drawer).toContainText("The note is not loaded here. The two commands below show it.");
    await expect(drawer).toContainText("git log --notes=premise");
  });
});

test.describe("2.8 item 4 — Who relies (3.11, 11.6, CO23b)", () => {
  test("Who relies on ENERGY_MAX lists in-flight and landed, then clears the outline", async ({ page }) => {
    await serveHarness(page);
    // hero-c04 past seq 1's landing (index 30) but before a_A submits (index 37):
    // seq 1 is landed, a_A is going around on the ENERGY_MAX premise.
    await sendEvents(page, C04, 33);
    await page.evaluate(() =>
      (window as { harness?: { openWho: (k: string, key: string) => void } }).harness?.openWho(
        "entity",
        "world/energy.js#ENERGY_MAX",
      ),
    );
    const sheet = page.getByRole("dialog", { name: "Who relies on ENERGY_MAX in world/energy.js" });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('[data-list="in_flight"]')).toContainText("In flight (1)");
    await expect(sheet.locator('[data-list="in_flight"]')).toContainText('"a crab that hides when its…"');
    await expect(sheet.locator('[data-list="in_flight"]')).toContainText("Going around");
    await expect(sheet.locator('[data-list="landed"]')).toContainText("Landed (1)");
    await expect(sheet.locator('[data-list="landed"]')).toContainText("landing 1");
    // An in-flight row opens its attempt card (the shell's callback reports it).
    await sheet.locator('[data-list="in_flight"] .who-row').click();
    await expect.poll(async () => page.evaluate(() => (window as { lastAttempt?: string }).lastAttempt)).toBe("a_A");
    // CO23b: while open, the frame gets the kinds of the listed creature files.
    const frame = () => poolFrame(page);
    await expect
      .poll(async () =>
        frame()?.evaluate(() =>
          (window as never as { __log: { type: string; kinds?: string[] }[] }).__log
            .filter((m) => m.type === "highlight")
            .map((m) => m.kinds),
        ),
      )
      .toContainEqual(["crab"]);
    // A landed row opens its Why card.
    await sheet.locator('[data-list="landed"] .who-row').click();
    await expect(page.getByRole("dialog", { name: "Why is this here?" })).toBeVisible();
    // Closing posts the empty highlight list (CO23b).
    await page.keyboard.press("Escape");
    await expect
      .poll(async () => await page.evaluate(() => (window as { sheetKind?: string | null }).sheetKind))
      .toBeNull();
    await expect
      .poll(async () =>
        frame()?.evaluate(() =>
          (window as never as { __log: { type: string; kinds?: string[] }[] }).__log
            .filter((m) => m.type === "highlight")
            .map((m) => m.kinds)
            .at(-1),
        ),
      )
      .toEqual([]);
  });

  test("a file tile's Who relies first lists the parts of the file (3.11)", async ({ page }) => {
    await serveHarness(page);
    await sendEvents(page, C04, C04_ALL);
    const crab = page.locator(".tile", { hasText: "crab" });
    await crab.click();
    await page.getByRole("menuitem", { name: "Who relies on this" }).click();
    const sheet = page.getByRole("dialog", { name: "Who relies on the file creatures/crab.js" });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Choose a part of creatures/crab.js:");
    // the known entity keys of the path, plus the file itself.
    await expect(sheet.locator(".who-pick")).toContainText("spawn");
    await expect(sheet.locator(".who-pick")).toContainText("update");
    await expect(sheet.locator(".who-pick")).toContainText("crab.js");
    await sheet.locator(".who-pick").getByRole("button", { name: "update" }).click();
    // the panel now names the picked part; landing 2 froze file:creatures/crab.js.
    const picked = page.getByRole("dialog", { name: "Who relies on update in creatures/crab.js" });
    await expect(picked.locator('[data-list="landed"]')).toContainText("Landed (1)");
    await expect(picked.locator('[data-list="landed"]')).toContainText("landing 2");
  });

  test("the tile menu's Why entry opens the newest change's card (3.7)", async ({ page }) => {
    await serveHarness(page);
    await sendEvents(page, C04, C04_ALL);
    const crab = page.locator(".tile", { hasText: "crab" });
    await crab.click();
    await page.getByRole("menuitem", { name: "Why (newest change)" }).click();
    const sheet = page.getByRole("dialog", { name: "Why is this here?" });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("landing 2");
  });

  test("an empty result reads who.none", async ({ page }) => {
    await serveHarness(page);
    await sendEvents(page, C04, C04_ALL);
    await page.evaluate(() =>
      (window as { harness?: { openWho: (k: string, key: string) => void } }).harness?.openWho(
        "entity",
        "world/movement.js#SPEED",
      ),
    );
    const sheet = page.getByRole("dialog", { name: "Who relies on SPEED in world/movement.js" });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Nothing relies on this yet.");
  });
});

test.describe("6.5 / AC4 — sheet behaviour", () => {
  test("Escape closes the sheet and focus returns to the opener (AX4)", async ({ page }) => {
    await serveHarness(page);
    await sendEvents(page, C04, C04_ALL);
    const opener = page.locator("#why-open");
    await opener.click();
    const sheet = page.getByRole("dialog", { name: "Why is this here?" });
    await expect(sheet).toBeVisible();
    await expect(sheet).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sheet).not.toBeVisible();
    await expect(opener).toBeFocused();
  });

  test("the SYNTHETIC banner stays visible above the sheet (AC4)", async ({ page }) => {
    await serveHarness(page);
    await sendEvents(page, C04, C04_ALL);
    await page.evaluate(() => (window as { harness?: { banner: (on: boolean) => void } }).harness?.banner(true));
    await page.evaluate(() => (window as { harness?: { openWhy: (s: number) => void } }).harness?.openWhy(2));
    const sheet = page.getByRole("dialog", { name: "Why is this here?" });
    await expect(sheet).toBeVisible();
    const banner = page.getByTestId("banner");
    await expect(banner).toBeVisible();
    // The sheet lives inside .floor-main, below the banner — it must not overlap it.
    const bannerBox = await banner.boundingBox();
    const sheetBox = await sheet.boundingBox();
    expect(bannerBox).not.toBeNull();
    expect(sheetBox).not.toBeNull();
    expect(sheetBox!.y).toBeGreaterThanOrEqual(bannerBox!.y + bannerBox!.height);
  });
});
