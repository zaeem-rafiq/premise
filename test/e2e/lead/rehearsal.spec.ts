// VE9 run 1 — the scripted rehearsal of the beat sheet (docs/spec/04-build-plan.md 5.5; the beats
// are docs/spec/03-floor.md 1.1 and 1.2). It walks beats 0 to 10 in order on a fresh pool that is
// not summary-only, opened at `/p/<pool>`, with the canned cast of 02-tidepool.md 7.3 and 9.5
// (`hero-s`, `hero-c`, `hero-h`, `hero-j`, then `sweep-a`, `sweep-b`) instead of real models. Its
// purpose is run 1's: every control of every beat exists and responds, and the run can be repeated
// after any fix. Scripted agents make no model calls.
//
// Where a beat needs real models (the starter set, "Race 3", the typed shared rule), the control is
// checked up to the point where it would start a real agent, and the canned cast plays the part.
// The record says so beat by beat ("substituted"), so run 2 knows what is still to be seen.
//
// The test runs only with REHEARSAL=1, PREMISE_URL set and `--project=deployed`; otherwise it is
// skipped, so the default browser suite is unchanged:
//
//   REHEARSAL=1 PREMISE_URL=https://premise-test.rk3469.workers.dev \
//     npx playwright test --project=deployed test/e2e/lead/rehearsal.spec.ts
//
// The owner key comes from PREMISE_OWNER_KEY or ~/.premise/test-owner-key. It is never typed into
// the page (PS2): the browser gets its owner cookie from `POST /api/session` through the page's own
// request context, and the API calls carry it as a Bearer header (httpService). It never enters a
// screenshot, a log, the record or an error message (BP7); the record is refused if it would.
//
// Output: docs/measurements/rehearsal/rehearsal-<n>.json and .md (n = REHEARSAL_RUN, default 1),
// and one screenshot per beat state under test-results/rehearsal/<pool>/.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { httpService, type EngineService } from "../../../scripts/measure/engine/service.ts";
import { parseReplayNdjson } from "../../../scripts/soak/stream.ts";

const ENABLED = process.env.REHEARSAL === "1" && (process.env.PREMISE_URL ?? "") !== "";
test.skip(!ENABLED, "The scripted rehearsal (VE9 run 1) runs only with REHEARSAL=1 and PREMISE_URL.");

// No action or navigation may wait without bound: a stalled step must fail with its name.
test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });

const RUN = process.env.REHEARSAL_RUN ?? "1";
const OUT_DIR = "docs/measurements/rehearsal";
const STAGE = { width: 1920, height: 1080 };

// The texts the beat sheet names (03-floor 1.2, 5.4; 02-tidepool 9.3). Expected values come from
// the specification, never from the page (BP1).
const P1A = "a crab that hides in its shell when its energy drops below 30";
const R01 = "make energy a fraction from 0 to 1";
const HELD_TITLE = "This change touches shared rules. Land it?";
const THESIS = "Git records only what an agent wrote. Premise also records what it read.";
const PLAIN_LABEL = "Same changes, merged by plain git";

type Ev = Record<string, unknown> & { type: string; n: number };
type Check = { name: string; ok: boolean; note: string };
type Status = "observed" | "substituted" | "failed";
type BeatRecord = {
  beat: number;
  title: string;
  window: string;
  proves: string;
  start_s: number;
  end_s: number;
  start_clock: string;
  end_clock: string;
  status: Status;
  proves_observed: boolean;
  checks: Check[];
  substitutions: string[];
  deviations: string[];
  screenshots: string[];
};

// The beat sheet's window and "Proves" column, abridged from 03-floor 1.2.
const BEATS: ReadonlyArray<{ beat: number; title: string; window: string; proves: string }> = [
  {
    beat: 0,
    title: "Compare view (cut forward)",
    window: "0:00-0:20",
    proves: "The plain-merge pool, labelled as constructed. The thesis.",
  },
  {
    beat: 1,
    title: "Floor: the pool runs, starter set, crab race",
    window: "0:20-1:05",
    proves:
      "Several agents at once on one codebase. Reads observed by the platform. Landing with no queue and no review step. The stated limit on real agents.",
  },
  { beat: 2, title: "Shared rule and Who relies", window: "1:05-1:35", proves: "Blog question 1. Who relies." },
  {
    beat: 3,
    title: "Held card, Land, heads-up and go-around",
    window: "1:35-2:50",
    proves:
      "A conflict is a broken premise caught when main moves. Held path, one tap, before and after, blast radius. The same agents adapt.",
  },
  {
    beat: 4,
    title: "Race sheet and Compare view",
    window: "2:50-3:35",
    proves: "Compare attempts and decide which ships. The plain-merge pool shows the break.",
  },
  {
    beat: 5,
    title: "The second catch (sweep and late creature)",
    window: "3:35-4:05",
    proves: "A query premise gains a match (QT1). A card never approves more than it showed.",
  },
  {
    beat: 6,
    title: "Why card and Show the git",
    window: "4:05-4:50",
    proves: "Blog question 4. The record lives in git notes on Artifacts.",
  },
  { beat: 7, title: "Causal Undo", window: "4:50-5:30", proves: "Causal Undo. A reopened author keeps its context." },
  {
    beat: 8,
    title: "Swarm view",
    window: "5:30-6:25",
    proves: "Measured scale on one Trunk, under the SYNTHETIC banner.",
  },
  { beat: 9, title: "About sheet", window: "6:25-7:05", proves: "Honest limits. Cloudflare use. No priority claim." },
  {
    beat: 10,
    title: "Lock and play the Replay",
    window: "7:05-7:30",
    proves: "Replay with no credentials. The page is a function of the stream.",
  },
];

function ownerKey(): string {
  const fromEnv = process.env.PREMISE_OWNER_KEY;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return readFileSync(join(homedir(), ".premise/test-owner-key"), "utf8").trim();
}

/** An error message without the terminal colour codes Playwright puts in it. */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function cardOf(event: Ev): Record<string, unknown> {
  return typeof event.card === "object" && event.card !== null ? (event.card as Record<string, unknown>) : {};
}

test("rehearsal: the beat sheet with the canned cast", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "deployed", "runs against a deployment only (--project=deployed)");
  test.setTimeout(40 * 60_000);

  const t0 = Date.now();
  const key = ownerKey();
  // Errors the page and its pool frames log (a tap that throws in the frame shows up here).
  const frameErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") frameErrors.push(message.text().slice(0, 160));
  });
  page.on("pageerror", (error) => frameErrors.push(error.message.slice(0, 160)));
  const redact = (text: string): string => (key === "" ? text : text.split(key).join("[redacted]"));
  const origin = new URL(process.env.PREMISE_URL!).origin;
  const service: EngineService = httpService({ origin, ownerKey: key });
  // REHEARSAL_POOL reuses a pool this spec created earlier and that is still empty (no attempt yet),
  // so a run that stopped before beat 1 does not cost a new pool.
  const reuse = process.env.REHEARSAL_POOL ?? "";
  if (reuse !== "" && !/^reh-[a-z0-9]+$/.test(reuse)) throw new Error("REHEARSAL_POOL must name a reh-<stamp> pool");
  const pool = reuse !== "" ? reuse : `reh-${Date.now().toString(36)}`;
  const log = (line: string) => console.log(`[rehearsal ${((Date.now() - t0) / 1000).toFixed(0)}s] ${redact(line)}`);
  const shots = `test-results/rehearsal/${pool}`;
  mkdirSync(shots, { recursive: true });

  const clock = () => (Date.now() - t0) / 1000;
  let requestSeq = 0;
  const rid = () => `${pool}-${++requestSeq}`;
  const bindings = new Map<string, string>(); // pattern -> attempt id

  // ---- the event authority: the owner's Replay export of the pool (01-core 12.3) ----
  let events: Ev[] = [];
  const refresh = async (): Promise<Ev[]> => {
    const response = await service.getAuthed(`/api/pools/${pool}/replay.ndjson`);
    if (response.status !== 200) throw new Error(`replay export answered ${response.status}`);
    events = parseReplayNdjson(response.text).events as unknown as Ev[];
    return events;
  };
  const waitFor = async (what: string, test: (all: Ev[]) => boolean, timeoutMs = 180_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (test(await refresh())) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await page.waitForTimeout(1000);
    }
  };
  const attemptOf = (pattern: string) => bindings.get(pattern) ?? "-";
  const landingSeqOf = (all: Ev[], pattern: string): number | null => {
    const accepted = all.find((e) => e.type === "landing.accepted" && e.attempt_id === attemptOf(pattern));
    if (accepted === undefined) return null;
    const seq = accepted.seq as number;
    return all.some((e) => e.type === "landing.landed" && e.seq === seq) ? seq : null;
  };
  const landed = (pattern: string) => (all: Ev[]) => landingSeqOf(all, pattern) !== null;

  // ---- the canned cast through POST /api/swarm (SWR1), as scripts/rehearse/hero.ts drives it ----
  const swarmStart = async (patterns: string[], hold: string[]): Promise<void> => {
    const response = await service.postJson("/api/swarm", {
      pool,
      running: true,
      seed: 7,
      agents: patterns.length,
      launch_per_second: 1,
      collision_dial: 0,
      think_ms: [0, 0],
      rescale_every_s: 0,
      patterns,
      hold_before_submit: hold,
      request_id: rid(),
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`swarm start answered ${response.status}`);
    const launched = (response.body as { launched?: unknown }).launched;
    if (!Array.isArray(launched) || launched.length !== patterns.length)
      throw new Error("swarm start: no launched ids");
    patterns.forEach((pattern, index) => bindings.set(pattern, String(launched[index])));
  };
  const swarmRelease = async (patterns: string[]): Promise<void> => {
    const response = await service.postJson("/api/swarm", {
      pool,
      running: true,
      release: patterns,
      request_id: rid(),
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`swarm release answered ${response.status}`);
  };

  // ---- the record ----
  const record: BeatRecord[] = [];
  let current: BeatRecord | null = null;
  const stripClock = async (): Promise<string> => {
    const cell = page.locator(".strip-cell", { hasText: "Run clock" }).first();
    return (
      (await cell
        .locator(".strip-value")
        .innerText({ timeout: 2000 })
        .catch(() => "")) || ""
    ).trim();
  };
  const stripValue = async (label: string): Promise<string> => {
    const cell = page.locator(".strip-cell", { hasText: label }).first();
    return ((await cell.innerText({ timeout: 2000 }).catch(() => "")) || "").replace(/\s+/g, " ").trim();
  };
  const begin = async (beat: number): Promise<BeatRecord> => {
    const spec = BEATS[beat]!;
    current = {
      ...spec,
      start_s: Math.round(clock()),
      end_s: 0,
      start_clock: await stripClock(),
      end_clock: "",
      status: "observed",
      proves_observed: false,
      checks: [],
      substitutions: [],
      deviations: [],
      screenshots: [],
    };
    record.push(current);
    log(`beat ${beat} begins`);
    return current;
  };
  const end = async (beat: BeatRecord, provesObserved: boolean): Promise<void> => {
    beat.end_s = Math.round(clock());
    beat.end_clock = await stripClock();
    const failed = beat.checks.some((c) => !c.ok);
    beat.proves_observed = provesObserved && !failed;
    beat.status = failed ? "failed" : beat.substitutions.length > 0 ? "substituted" : "observed";
  };
  /** One soft check: a failure is recorded with its reason and the walk goes on. */
  const check = async (name: string, body: () => Promise<string | void>): Promise<boolean> => {
    log(`  check: ${name}`);
    try {
      const note = await body();
      current!.checks.push({ name, ok: true, note: redact(note ?? "") });
      return true;
    } catch (error) {
      const message = plain(
        error instanceof Error
          ? error.message
              .split("\n")
              .filter((line) => line.trim() !== "")
              .slice(0, 4)
              .join(" / ")
          : String(error),
      );
      current!.checks.push({ name, ok: false, note: redact(message).slice(0, 300) });
      return false;
    }
  };
  const shot = async (name: string): Promise<void> => {
    await page.waitForTimeout(350); // the 240 ms sheet motion of 03-floor 6.4 has ended
    const path = `${shots}/beat-${String(current!.beat).padStart(2, "0")}-${name}.png`;
    await page.screenshot({ path }).catch(() => undefined);
    current!.screenshots.push(path);
  };
  const closeSheets = async (): Promise<void> => {
    for (let i = 0; i < 3; i += 1) await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  };

  const rail = page.locator("aside.rail");
  const card = (intent: string): Locator => page.locator(".attempt-card", { hasText: intent }).first();
  const dialog = (name: string | RegExp): Locator => page.getByRole("dialog", { name });
  const tile = (path: string): Locator =>
    page.getByRole("button", { name: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\.`) });
  const whoReliesEnergyMax = async (): Promise<Locator> => {
    await closeSheets();
    await tile("world/energy.js").click();
    await page.getByRole("menuitem", { name: "Who relies on this" }).click();
    await page.getByRole("button", { name: "ENERGY_MAX", exact: true }).click();
    const panel = dialog(/Who relies on ENERGY_MAX/);
    await expect(panel).toBeVisible();
    return panel;
  };

  // ===== Before the run: the pool, the owner session, the page =====
  log(`pool ${pool}`);
  if (reuse === "") {
    const created = await service.postJson("/api/pools", {
      pool,
      seed: "tidepool",
      summary_only: false,
      request_id: rid(),
    });
    expect(created.status, "POST /api/pools").toBeGreaterThanOrEqual(200);
    expect(created.status, "POST /api/pools").toBeLessThan(300);
  }
  log("pool ready");

  // PS2: the owner session is unlocked without typing the key (the page's own route, 3.17).
  const unlocked = await page.request.post("/api/session", { data: { key } });
  expect(unlocked.status(), "POST /api/session").toBe(200);

  log("owner session set");
  await page.setViewportSize(STAGE);
  log("viewport set");
  await page.goto(`/p/${pool}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  log("page loaded");
  await expect(page.locator(".pool-name")).toHaveText(pool, { timeout: 30_000 });
  log("pool name shown");
  const look = page.getByRole("button", { name: "Look around the live pool" });
  // The start card can show for a moment before the session read answers, then go: never wait on it.
  if (await look.isVisible().catch(() => false)) await look.click({ timeout: 3000 }).catch(() => undefined);
  await expect(page.locator(".strip-cell", { hasText: "Landed" }).locator(".strip-value")).toHaveText(/^\d+$/, {
    timeout: 60_000,
  });

  const preflight: Check[] = [];
  const pre = async (name: string, body: () => Promise<string>) => {
    log(`preflight: ${name}`);
    try {
      preflight.push({ name, ok: true, note: redact(await body()) });
    } catch (error) {
      preflight.push({
        name,
        ok: false,
        note: redact(
          plain(
            error instanceof Error
              ? error.message
                  .split("\n")
                  .filter((line) => line.trim() !== "")
                  .slice(0, 4)
                  .join(" / ")
              : String(error),
          ),
        ),
      });
    }
  };
  const spendBefore = await stripValue("Spend");
  await pre("PS1 landed history", async () => {
    const value = await page.locator(".strip-cell", { hasText: "Landed" }).locator(".strip-value").innerText();
    return `Landed counter is ${value}: a fresh pool by design of run 1 (5.5), so PS1's earlier real-agent history is absent.`;
  });
  await pre("PS2 owner unlocked", async () => {
    await expect(page.locator("header").getByRole("button", { name: "Owner", exact: true })).toBeVisible();
    return "Header shows Owner. The key was not typed.";
  });
  await pre("PS3 spend", async () => spendBefore);
  await pre("PS4 no banner", async () => {
    await expect(page.locator(".banner")).toHaveCount(0);
    return "No banner before any agent starts.";
  });
  await pre("PS5 recordings", async () => {
    const index = await service.getJson("/replay/index.json");
    return `GET /replay/index.json answered ${index.status}: ${JSON.stringify(index.body).slice(0, 200)}`;
  });
  await pre("PS7 swarm pool", async () => {
    const floor = (await service.getJson("/floor.json")).body as { swarm_pool?: string };
    const status = await service.probe(floor.swarm_pool ?? "");
    return `Swarm pool ${floor.swarm_pool ?? "?"}: stream probe answered ${status}${status === 404 ? " (the pool does not exist on this deployment)" : ""}.`;
  });

  // ===== Beat 0: Compare view. On the fresh pool only its frame, labels and thesis are checked;
  // the crab that never comes out is seen in beat 4, from where the video cuts forward (BS2). =====
  {
    const b = await begin(0);
    b.substitutions.push(
      "Beat 0 is a cut forward from beat 4 (BS2). Here, before any landing, only the view's controls and labels are checked; the broken crab is observed in beat 4.",
    );
    await check("Compare opens with key C", async () => {
      // The single-key shortcuts of 6.6 start once the page has its settings and stream.
      await expect(page.locator(".pf-caption")).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(1500);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("c");
      await expect(page.locator(".cmp")).toBeVisible({ timeout: 10_000 });
    });
    await check("left frame Premise · main", async () => {
      await expect(page.locator(".cmp-col[data-pool='main']")).toContainText("Premise · main");
    });
    await check("right frame labelled plain merge, constructed", async () => {
      const right = page.locator(".cmp-col[data-pool='plain']");
      await expect(right).toContainText(PLAIN_LABEL);
      await expect(right).toContainText(/onstructed/);
    });
    await check("thesis is the last line", async () => {
      await expect(page.locator(".cmp-thesis")).toHaveText(THESIS);
    });
    await shot("compare-empty");
    await check("Back to the Floor", async () => {
      await page.getByRole("button", { name: "Back to the Floor" }).click();
      await expect(page.locator(".cmp")).toHaveCount(0);
    });
    await end(b, false);
  }

  // ===== Beat 1: the pool runs; starter set and race controls; the canned creatures start =====
  {
    const b = await begin(1);
    const field = page.getByRole("textbox", { name: "Ask for a change in plain words." });
    await check("starter set button exists and is enabled (not pressed)", async () => {
      const starter = page.getByRole("button", { name: /^Send the starter set \(6\)$/ });
      await expect(starter).toBeVisible();
      await expect(starter).toBeEnabled();
      return "Not pressed: it starts six real Workers AI agents. Left to run 2.";
    });
    await check("pre-written menu lists the requests of the take", async () => {
      const menu = page.getByRole("combobox", { name: "Pre-written requests" });
      await expect(menu).toBeEnabled();
      const options = await menu.locator("option").allInnerTexts();
      const want = [R01, "a shrimp that darts every two seconds and spends 5 energy on each dart"];
      for (const w of want) if (!options.includes(w)) throw new Error(`menu lacks "${w}"`);
      return `${options.length - 1} pre-written requests listed.`;
    });
    await check("crab request typed, Race 3 enabled (not pressed)", async () => {
      await field.fill(P1A);
      await expect(page.locator(".intent-count")).toHaveText(`${P1A.length} of 500`);
      const race = page.getByRole("button", { name: "Race 3", exact: true });
      await expect(race).toBeEnabled();
      await expect(page.locator(".intent-actions").getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await shot("race-control");
      await field.fill("");
      await expect(race).toBeDisabled();
      return "Race 3 would start three real models. Left to run 2; the canned crab (hero-c) plays the crab.";
    });
    b.substitutions.push(
      "Starter set: not sent (real agents). The canned jellyfish (hero-j, the starter set's A01 text) lands by itself in its place.",
      "Crab race: not sent (three real models). One canned crab (hero-c, P1a's text) and the canned shrimp (hero-h, P1b's text) stand in; they are held before submit (conductor row 1 of 02-tidepool 7.11) instead of waiting on a race card.",
    );
    await check("canned cast starts (POST /api/swarm)", async () => {
      // hero-j is not held: it shows a creature landing by itself (beat 1's "Landing…", "Landed").
      await swarmStart(["hero-j", "hero-c", "hero-h"], ["hero-c", "hero-h"]);
    });
    await check("SYNTHETIC banner", async () => {
      await expect(page.locator(".banner[data-tone='synthetic']")).toBeVisible({ timeout: 60_000 });
      await expect(page.locator(".banner[data-tone='synthetic']")).toContainText("they make no model calls");
    });
    await check("three attempt cards appear", async () => {
      await expect(card("a jellyfish that drifts up and down")).toBeVisible({ timeout: 60_000 });
      await expect(card(P1A)).toBeVisible({ timeout: 60_000 });
      await expect(card("a shrimp that darts every two seconds")).toBeVisible({ timeout: 60_000 });
    });
    await check("strip counts the agents", async () => {
      return await stripValue("Real agents");
    });
    await check("tiles show reader and writer marks", async () => {
      await expect
        .poll(
          async () => {
            const names = await page
              .locator(".tile, [role='region'][aria-label='Files'] button")
              .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""));
            return names.some((n) => /[1-9]\d* reading|[1-9]\d* writing/.test(n));
          },
          { timeout: 60_000 },
        )
        .toBe(true);
    });
    await check("crab card shows lights (relies on)", async () => {
      await expect(card(P1A).locator(".attempt-card__lights")).toBeVisible({ timeout: 60_000 });
    });
    await shot("cards-working");
    await check("jellyfish lands by itself: Landing… then Landed", async () => {
      await waitFor("hero-j landing", landed("hero-j"));
      await expect(rail.getByRole("tab", { name: /^Landed [1-9]/ })).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(".strip-cell", { hasText: "Landed" }).locator(".strip-value")).toHaveText("1", {
        timeout: 30_000,
      });
      await expect(page.locator(".pf-caption")).toContainText("landing 1", { timeout: 60_000 });
      return "Landed counter 1; the frame caption names landing 1.";
    });
    await check("crab and shrimp write their files (op.recorded)", async () => {
      await waitFor(
        "crab.js and shrimp.js writes",
        (all) =>
          all.some((e) => e.type === "op.recorded" && e.path === "creatures/crab.js") &&
          all.some((e) => e.type === "op.recorded" && e.path === "creatures/shrimp.js"),
      );
    });
    await shot("jellyfish-landed");
    b.deviations.push(
      'The crab cards do not reach "Waiting for you" on a race card: the canned crab is one attempt held before submit, so it shows as working until released in beat 3.',
    );
    await end(b, true);
  }

  // ===== Beat 2: the shared rule starts; Who relies on ENERGY_MAX =====
  {
    const b = await begin(2);
    const field = page.getByRole("textbox", { name: "Ask for a change in plain words." });
    await check("shared-rule request typed, Send enabled (not pressed)", async () => {
      await field.fill(R01);
      await expect(page.locator(".intent-actions").getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await field.fill("");
      return "Send would start a real agent. The canned hero-s (R01's text) plays it.";
    });
    b.substitutions.push("Shared rule: the canned hero-s, started through POST /api/swarm, instead of the typed R01.");
    await check("hero-s starts and its card reads Working", async () => {
      await swarmStart(["hero-s"], []);
      await expect(card(R01)).toBeVisible({ timeout: 60_000 });
      await expect(card(R01)).toContainText(/Working|Starting|Being checked|Waiting for you/, { timeout: 60_000 });
      return (await card(R01).locator(".attempt-card__word").innerText()).trim();
    });
    await shot("shared-rule-working");
    await check("tile energy, ENERGY_MAX, Who relies: In flight lists the crab", async () => {
      const panel = await whoReliesEnergyMax();
      await expect(panel).toContainText(/In flight \(\d+\)/i);
      const text = (await panel.innerText()).replace(/\s+/g, " ");
      if (!/crab/.test(text)) throw new Error(`panel does not name the crab: ${text.slice(0, 200)}`);
      return text.slice(0, 240);
    });
    await shot("who-relies");
    await closeSheets();
    await end(b, true);
  }

  // ===== Beat 3: the held card, Land, heads-ups, go-arounds =====
  {
    const b = await begin(3);
    await check("hero-s waits on a held card", async () => {
      await waitFor("held card of hero-s", (all) =>
        all.some((e) => e.type === "card.opened" && cardOf(e).kind === "held"),
      );
    });
    await check("tray row: This change touches shared rules. Land it?", async () => {
      const row = page.locator(".tray-row", { hasText: HELD_TITLE });
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.getByRole("button", { name: "Open" }).click();
    });
    const sheet = dialog(HELD_TITLE);
    await check("card sheet names the changes it sends back", async () => {
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText(/Landing this sends \d+ changes? back to (their|its) agents?/, {
        timeout: 60_000,
      });
      const affects = (await sheet.locator(".card-sheet__affect").allInnerTexts()).join(" | ");
      if (!/crab/.test(affects)) throw new Error(`blast radius does not name the crab: ${affects}`);
      return affects.slice(0, 300);
    });
    await check("card sheet shows the pool before and after", async () => {
      await expect(sheet).toContainText("Before: the pool now");
      await expect(sheet).toContainText("After: the pool with this change");
    });
    await check("card frames load (before and after)", async () => {
      await expect(sheet).not.toContainText("Loading the pool…", { timeout: 45_000 });
      await expect(sheet).not.toContainText("Building the preview…", { timeout: 45_000 });
    });
    await shot("held-card");
    await check("tap Land", async () => {
      await sheet.getByRole("button", { name: "Land", exact: true }).click();
      await expect(sheet).toContainText(/Landing…|landed|Land/, { timeout: 30_000 });
    });
    await check("shared rule lands", async () => {
      await waitFor("hero-s landing", landed("hero-s"));
      await closeSheets();
      // A landed change leaves the Working tab for a row of the Landed tab.
      await expect(rail.getByRole("tab", { name: /^Landed 2$/ })).toBeVisible({ timeout: 30_000 });
      await rail.getByRole("tab", { name: /^Landed/ }).click();
      await expect(rail.locator(".landed-row", { hasText: "make energy a fraction" })).toHaveCount(1);
      await rail.getByRole("tab", { name: /^Working/ }).click();
    });
    await check("crab and shrimp get an E2 heads-up (repair)", async () => {
      await waitFor("E2 heads-ups", (all) =>
        ["hero-c", "hero-h"].every((p) =>
          all.some(
            (e) =>
              e.type === "headsup.sent" &&
              e.attempt_id === attemptOf(p) &&
              e.result === "repair" &&
              Array.isArray(e.keys) &&
              (e.keys as Array<{ rule: string }>).some((k) => k.rule === "E2"),
          ),
        ),
      );
    });
    await check("crab card: Going around, heads-up with ENERGY_MAX before/after", async () => {
      const crab = card(P1A);
      await expect(crab).toContainText(/Going around|Heads-up|go-around/i, { timeout: 30_000 });
      if (
        !(await crab
          .locator(".attempt-card__detail")
          .isVisible()
          .catch(() => false))
      )
        await crab.click();
      await expect(crab).toContainText("ENERGY_MAX in world/energy.js changed, and this change uses it.", {
        timeout: 30_000,
      });
      await expect(crab).toContainText("export const ENERGY_MAX = 100;");
      await expect(crab).toContainText("export const ENERGY_MAX = 1;");
    });
    if (
      await card(P1A)
        .getByText(/The model has not answered/)
        .isVisible()
        .catch(() => false)
    ) {
      b.deviations.push(
        'While held before submit, the scripted crab\'s card says "The model has not answered for 30 s. It is tried again by itself. If that fails, the attempt stops." A scripted agent calls no model.',
      );
    }
    await shot("heads-up");
    b.substitutions.push(
      'The crab and the shrimp are released by the rehearsal (POST /api/swarm release) after their heads-up, as conductor row 5 of 7.11 does; on the take a race candidate returns to "Waiting for you" instead.',
    );
    await check("released creatures adapt and land by themselves", async () => {
      await swarmRelease(["hero-c", "hero-h"]);
      await waitFor("crab and shrimp landings", (all) => landed("hero-c")(all) && landed("hero-h")(all));
      await waitFor("plain.updated through 4", (all) =>
        all.some((e) => e.type === "plain.updated" && (e.through_seq as number) >= 4),
      );
      await expect(page.locator(".strip-cell", { hasText: "Landed" }).locator(".strip-value")).toHaveText("4", {
        timeout: 30_000,
      });
    });
    await check("the agent's sentence: the crab hides below 0.3", async () => {
      const said = events.find((e) => e.type === "headsup.resolved" && e.attempt_id === attemptOf("hero-c"));
      if (said === undefined || !str(said.statement).includes("so the crab hides below 0.3")) {
        throw new Error(`no matching statement from the crab: ${str(said?.statement)}`);
      }
      // The landed crab is a row of the Landed tab; its row opens the Why card, which quotes it.
      await rail.getByRole("tab", { name: /^Landed/ }).click();
      await rail.locator(".landed-row", { hasText: "crab" }).first().click();
      const why = dialog("Why is this here?");
      await expect(why).toContainText(
        'The agent said: "Energy is now a fraction from 0 to 1, so the crab hides below 0.3."',
      );
      return str(said.statement);
    });
    await shot("go-around-answered");
    await closeSheets();
    await rail.getByRole("tab", { name: /^Working/ }).click();
    await end(b, true);
  }

  // ===== Beat 4: race sheet (not reachable without real models) and Compare view =====
  {
    const b = await begin(4);
    b.substitutions.push(
      'Race sheet: not exercised. A race needs three real models (Race 3 was checked enabled in beat 1); "Choose this one", "Not chosen" and the side-by-side frames are left to run 2.',
    );
    await check("Compare view: left Premise · main, right plain merge", async () => {
      await closeSheets();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("c");
      await expect(page.locator(".cmp")).toBeVisible({ timeout: 10_000 });
      await expect(page.locator(".cmp-col[data-pool='plain']")).toContainText(PLAIN_LABEL);
    });
    await check("what differs names the crab's go-around", async () => {
      await expect(page.locator(".cmp-diff")).toContainText(/crab/, { timeout: 60_000 });
      const differs = (await page.locator(".cmp-diff").innerText()).replace(/\s+/g, " ");
      if (!/went around once after ENERGY_MAX changed/.test(differs)) {
        b.deviations.push(
          'What differs does not say the crab "went around once after ENERGY_MAX changed" with "its first version": the canned crab was held before submit, so the plain-merge pool has its unfinished work (02-tidepool 7.11 permits this in order 1).',
        );
      }
      return differs.slice(0, 300);
    });
    await check("text conflicts line", async () => {
      await expect(page.locator(".cmp-conflicts")).toContainText(/Text conflicts in the plain merge: \d+/);
      const line = await page.locator(".cmp-conflicts").innerText();
      if (!line.includes("(approximated)")) {
        b.deviations.push(`The conflicts line reads "${line.trim()}", without "(approximated)" as beat 4 has it.`);
      }
      return line;
    });
    await check("self-test badges: left passes, right fails", async () => {
      const left = page.locator(".cmp-col[data-pool='main']");
      const right = page.locator(".cmp-col[data-pool='plain']");
      await expect(left).toContainText("Self-test, run in this page: passed", { timeout: 90_000 });
      await expect(right).toContainText(/Self-test, run in this page: failed|not_exhausted/i, { timeout: 90_000 });
      return (await right.innerText()).replace(/\s+/g, " ").slice(-200);
    });
    await check("thesis line", async () => {
      await expect(page.locator(".cmp-thesis")).toHaveText(THESIS);
    });
    await shot("compare-after");
    await page
      .getByRole("button", { name: "Back to the Floor" })
      .click()
      .catch(() => undefined);
    await end(b, true);
  }

  // ===== Beat 5: the second catch — sweep-a waits on its card, sweep-b lands, QT1 =====
  {
    const b = await begin(5);
    b.substitutions.push(
      "P9a and P9b: the canned sweep-a and sweep-b (02-tidepool 9.5) through POST /api/swarm, instead of the pre-written requests (real agents).",
    );
    await check("shrimp reads Landed before the sweep starts (BS7)", async () => {
      await rail.getByRole("tab", { name: /^Landed/ }).click();
      await expect(rail.locator(".landed-row", { hasText: "shrimp" }).first()).toBeVisible({ timeout: 30_000 });
      await rail.getByRole("tab", { name: /^Working/ }).click();
    }).catch(() => false);
    await check("sweep-a starts and waits on its held card", async () => {
      await swarmStart(["sweep-a"], []);
      await waitFor("sweep-a card", (all) =>
        all.some(
          (e) =>
            e.type === "card.opened" &&
            cardOf(e).kind === "held" &&
            (cardOf(e).attempt_ids as string[] | undefined)?.includes(attemptOf("sweep-a")) === true,
        ),
      );
      await expect(page.locator(".tray-row", { hasText: HELD_TITLE })).toBeVisible({ timeout: 30_000 });
    });
    await check("sweep card's search light is listed", async () => {
      const sweep = page.locator(".attempt-card", { hasText: /percent/i }).first();
      await expect(sweep).toBeVisible();
      if (
        !(await sweep
          .locator(".attempt-card__detail")
          .isVisible()
          .catch(() => false))
      )
        await sweep.click();
      await expect(sweep).toContainText('the search for "drain(" in creatures/', { timeout: 15_000 });
    });
    await shot("sweep-waiting");
    await check("sweep-b (the squid) lands by itself", async () => {
      await swarmStart(["sweep-b"], []);
      await waitFor("sweep-b landing", landed("sweep-b"));
    });
    await check("sweep-a: card closed as stale, QT1 heads-up", async () => {
      await waitFor("QT1 heads-up to sweep-a", (all) =>
        all.some(
          (e) =>
            e.type === "headsup.sent" &&
            e.attempt_id === attemptOf("sweep-a") &&
            Array.isArray(e.keys) &&
            (e.keys as Array<{ rule: string }>).some((k) => k.rule === "QT1"),
        ),
      );
      await waitFor("stale close", (all) => all.some((e) => e.type === "card.closed" && e.action === "stale"));
    });
    await check("sweep card shows the new match", async () => {
      const sweep = page.locator(".attempt-card", { hasText: /percent/i }).first();
      await expect(sweep).toContainText(/has a new match/, { timeout: 30_000 });
    });
    await shot("sweep-caught");
    await check("a new card opens; tap Land", async () => {
      await waitFor("second sweep card", (all) => {
        const opened = all.filter(
          (e) =>
            e.type === "card.opened" &&
            (cardOf(e).attempt_ids as string[] | undefined)?.includes(attemptOf("sweep-a")) === true,
        );
        return opened.length >= 2;
      });
      const row = page.locator(".tray-row", { hasText: HELD_TITLE });
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.getByRole("button", { name: "Open" }).click();
      const sheet = dialog(HELD_TITLE);
      await expect(sheet).toBeVisible();
      await expect(sheet).not.toContainText("Building the preview…", { timeout: 45_000 });
      await shot("sweep-second-card");
      await sheet.getByRole("button", { name: "Land", exact: true }).click();
      await waitFor("sweep-a landing", landed("sweep-a"));
      await closeSheets();
    });
    await end(b, true);
  }

  // ===== Beat 6: tap the crab in the pool: Why card, Show the git =====
  {
    const b = await begin(6);
    const why = dialog("Why is this here?");
    const tapped = await check("tap the crab in the pool frame", async () => {
      await closeSheets();
      const frame = page.locator('iframe[title="The live pool, running the code on main"]');
      // Do not pause first: a frame paused before it has drawn stays on "Loading the pool…".
      await expect(page.locator(".pf-caption")).toContainText("landing", { timeout: 30_000 });
      await page.waitForTimeout(2000);
      const box = await frame.boundingBox();
      if (box === null) throw new Error("no pool frame");
      const errorsBefore = frameErrors.length;
      // The crabs walk on the sand (spawn y = FLOOR_Y - 10): scan the lower band of the frame.
      for (const fy of [0.9, 0.88, 0.92]) {
        for (let x = box.x + 20; x < box.x + box.width - 20; x += 14) {
          await page.mouse.click(x, box.y + box.height * fy);
          if (await why.isVisible().catch(() => false)) {
            const sub = await why.locator("p").first().innerText();
            if (sub.startsWith("crab"))
              return `tapped at (${Math.round(x)}, ${Math.round(box.y + box.height * fy)}): ${sub}`;
            await closeSheets();
          }
        }
      }
      const fresh = frameErrors.slice(errorsBefore);
      throw new Error(
        `no Why card opened from ${Math.round((box.width - 40) / 14) * 3} taps on the frame; the pool frame logged ${fresh.length} errors${fresh.length > 0 ? `, e.g. "${fresh[0]}"` : ""}`,
      );
    });
    if (!tapped) {
      b.deviations.push("The crab could not be hit in the frame; the Why card was opened from the crab tile instead.");
      await check("Why card from the crab tile", async () => {
        await closeSheets();
        // The crab tile may be folded under "+N more" (3.7).
        if (
          !(await tile("creatures/crab.js")
            .isVisible()
            .catch(() => false))
        ) {
          await page
            .getByRole("button", { name: /^\+\d+ more$/ })
            .first()
            .click();
        }
        await tile("creatures/crab.js").click();
        await page.getByRole("menuitem", { name: /Why/ }).click();
      });
    }
    await check("Why card: who asked, in their words", async () => {
      await expect(why).toBeVisible({ timeout: 10_000 });
      await expect(why).toContainText(P1A);
    });
    await check("Why card: what it relied on, the go-around and the agent's sentence", async () => {
      await expect(why).toContainText("What it relied on");
      await expect(why).toContainText("ENERGY_MAX in world/energy.js");
      await expect(why).toContainText(/Go-around 1: ENERGY_MAX in world\/energy.js changed/);
      await expect(why).toContainText("so the crab hides below 0.3");
    });
    await check("Why card: checks and how it landed", async () => {
      await expect(why).toContainText(/\d+ of \d+ checks passed/);
      await expect(why).toContainText("How it landed");
    });
    await shot("why-crab");
    await check("Show the git: commit, Change-Id, Intent-Id, note, git commands", async () => {
      await why.getByRole("button", { name: "Show the git" }).click();
      const drawer = page
        .locator(".git-drawer, [role='dialog']", { hasText: "This is an ordinary git commit on main" })
        .last();
      await expect(drawer).toBeVisible({ timeout: 10_000 });
      await expect(drawer).toContainText(/Commit\s*[0-9a-f]{40}/);
      await expect(drawer).toContainText("Change-Id:");
      await expect(drawer).toContainText("Intent-Id:");
      await expect(drawer).toContainText("The record above is this git note.");
      await expect(drawer).toContainText("git fetch origin refs/notes/premise:refs/notes/premise");
    });
    await shot("show-the-git");
    await closeSheets();
    const resume = page.getByRole("button", { name: /^(Play|Resume)$/ });
    if (await resume.isVisible().catch(() => false)) await resume.click();
    await end(b, true);
  }

  // ===== Beat 7: Why card of the shared rule, Undo =====
  {
    const b = await begin(7);
    const why = dialog("Why is this here?");
    await check("Why card of the shared-rule change", async () => {
      const panel = await whoReliesEnergyMax();
      await panel
        .getByRole("button", { name: /make energy a fraction/ })
        .first()
        .click();
      await expect(why).toBeVisible({ timeout: 10_000 });
      await expect(why).toContainText(R01);
    });
    const undoSheet = dialog(/^Undo landing \d+/);
    await check("Undo names the later changes built on it", async () => {
      await why.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(undoSheet).toBeVisible({ timeout: 10_000 });
      await expect(undoSheet).not.toContainText("Working out what this undo takes back…", { timeout: 30_000 });
      await expect(undoSheet).toContainText(/This also takes back \d+ later changes? that (was|were) built on it/);
      await expect(undoSheet).toContainText(/crab/);
      return (await undoSheet.innerText()).replace(/\s+/g, " ").slice(0, 400);
    });
    await shot("undo-sheet");
    await check("tap Undo it", async () => {
      await undoSheet.getByRole("button", { name: "Undo it" }).click();
      await waitFor("the undo: the crab reopened", (all) =>
        all.some(
          (e) => (e.type === "attempt.reopened" && e.attempt_id === attemptOf("hero-c")) || e.type === "undo.refused",
        ),
      );
      if (events.some((e) => e.type === "undo.refused")) throw new Error("Trunk refused the undo");
      await closeSheets();
    });
    await check("crab card: Reopened by undo, same agent, same conversation", async () => {
      const crab = card(P1A);
      await expect(crab).toContainText("Reopened by undo", { timeout: 60_000 });
      await expect(crab).toContainText("Same agent, same conversation.");
    });
    await shot("reopened");
    await check("the reopened crab adapts and lands by itself", async () => {
      await waitFor(
        "a second landing of the crab",
        (all) => {
          const seqs = all
            .filter((e) => e.type === "landing.accepted" && e.attempt_id === attemptOf("hero-c"))
            .map((e) => e.seq);
          return all.filter((e) => e.type === "landing.landed" && seqs.includes(e.seq)).length >= 2;
        },
        240_000,
      );
    });
    const after = events.filter((e) => e.type === "headsup.resolved" && e.attempt_id === attemptOf("hero-c")).at(-1);
    if (after !== undefined && str(after.statement).includes("fraction")) {
      b.deviations.push(
        `After the undo put ENERGY_MAX back to 100, the scripted crab still said "${str(after.statement)}": the canned cast has one fixed sentence (02-tidepool 7.5). A real agent would describe the reverse change.`,
      );
    }
    await shot("crab-relanded");
    await end(b, true);
  }

  // ===== Beat 8: Swarm view =====
  {
    const b = await begin(8);
    const floor = (await service.getJson("/floor.json")).body as { swarm_pool?: string };
    const swarmStatus = await service.probe(floor.swarm_pool ?? "");
    b.substitutions.push(
      swarmStatus === 404
        ? `Swarm run not started: the deployment's swarm pool ${floor.swarm_pool ?? "?"} does not exist (stream 404), so it is not idle (PS7). Controls checked only.`
        : `Swarm run not started by run 1; controls checked only (swarm pool stream answered ${swarmStatus}).`,
    );
    await check("Swarm view opens", async () => {
      await closeSheets();
      await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Swarm" }).click();
      await expect(page.locator(".swarm-view")).toBeVisible({ timeout: 10_000 });
    });
    await check("SYNTHETIC banner names the Swarm pool's rule", async () => {
      await expect(page.locator(".banner[data-tone='synthetic']")).toContainText(
        "shared rules land without a tap in this pool",
      );
    });
    await check("controls: agents, collisions dial, Start", async () => {
      const controls = page.locator(".swarm-controls");
      await expect(controls).toBeVisible();
      await expect(controls.locator("legend", { hasText: "Agents" })).toBeVisible();
      await expect(controls.getByText("Collisions")).toBeVisible();
      const start = controls.getByRole("button", { name: "Start", exact: true });
      await expect(start).toBeVisible();
      return `Start enabled: ${await start.isEnabled()}. Not pressed.`;
    });
    await check("empty state and the real-agent limit", async () => {
      await expect(page.locator(".swarm-view")).toContainText(/No Swarm run yet|scripted agents/);
      await expect(page.locator(".swarm-real-limit")).toBeVisible();
    });
    await shot("swarm-view");
    await end(b, false);
  }

  // ===== Beat 9: About =====
  {
    const b = await begin(9);
    await check("About opens with three columns", async () => {
      await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "About" }).click();
      const about = page.getByRole("dialog", { name: /About/ });
      await expect(about).toBeVisible({ timeout: 10_000 });
      await expect(about).toContainText("How it runs");
      await expect(about).toContainText("In this run");
      await expect(about).toContainText("Limits");
    });
    await check("how it runs names the Cloudflare parts", async () => {
      const about = page.getByRole("dialog", { name: /About/ });
      for (const part of ["Worker", "Trunk", "Agent", "Floor", "Workflows", "Workers AI", "Artifacts"]) {
        await expect(about).toContainText(part);
      }
    });
    await check("in this run: real, synthetic, constructed, with counts", async () => {
      const about = page.getByRole("dialog", { name: /About/ });
      await expect(about).toContainText(/Scripted agents \(SYNTHETIC\): \d+/);
      await expect(about).toContainText(/Constructed: the plain-merge pool/);
      await expect(about).toContainText(/Landed changes: \d+/);
    });
    await check("limits list and related work", async () => {
      const about = page.getByRole("dialog", { name: /About/ });
      await expect(about).toContainText(/scripted agents/i);
      return (await about.innerText()).includes("Related work")
        ? "Related work present."
        : 'No "Related work" heading found.';
    });
    await shot("about");
    await closeSheets();
    await page
      .getByRole("navigation", { name: "Views" })
      .getByRole("button", { name: "Floor" })
      .click()
      .catch(() => undefined);
    await end(b, true);
  }

  // ===== Beat 10: lock (visitor), Play the Replay =====
  {
    const b = await begin(10);
    await check("Owner, then Lock", async () => {
      await closeSheets();
      await page.locator("header").getByRole("button", { name: "Owner", exact: true }).click();
      const owner = dialog("Owner key");
      await expect(owner).toBeVisible();
      await owner.getByRole("button", { name: "Lock", exact: true }).click();
      await expect(page.locator("header").getByRole("button", { name: "Visitor", exact: true })).toBeVisible({
        timeout: 10_000,
      });
    });
    await shot("locked");
    await check("start card offers the default recording", async () => {
      // RY23: the start card is for a visitor looking at a quiet pool, one with no landing for
      // QUIET_POOL_MS (60 s); the reopened changes of beat 7 landed moments ago. Before the
      // stream's snapshot arrives the pool looks quiet, so the card can show for a moment and go:
      // it counts only when it is still there once the page has settled.
      const startCard = page.getByRole("group", { name: "Watch a recorded run" });
      const deadline = Date.now() + 150_000;
      let flashed = false;
      for (;;) {
        await page.goto(`/p/${pool}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForTimeout(1000);
        const early = await startCard.isVisible().catch(() => false);
        await page.waitForTimeout(4000);
        if (await startCard.isVisible().catch(() => false)) break;
        if (early) flashed = true;
        if (Date.now() > deadline) throw new Error("the start card did not stay on a quiet pool");
        await page.waitForTimeout(10_000);
      }
      if (flashed) {
        b.deviations.push(
          "On a pool that is not yet quiet the start card shows for a moment after the page loads, then goes when the stream's snapshot arrives.",
        );
      }
      await expect(page.getByRole("button", { name: /^Play the Replay \(/ })).toBeVisible();
    });
    await shot("start-card");
    await check("Play the Replay: the REPLAY banner and the same page", async () => {
      await page.getByRole("button", { name: /^Play the Replay \(/ }).click();
      await expect(page.locator(".banner[data-tone='replay']")).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("header")).toContainText("Replay");
      return (await page.locator(".banner[data-tone='replay']").innerText()).replace(/\s+/g, " ");
    });
    await page.waitForTimeout(3000);
    await shot("replay-playing");
    const index = (await service.getJson("/replay/index.json")).body as { default?: string };
    if (index.default !== "rehearsal") {
      b.deviations.push(
        `The default recording on this deployment is \`${index.default ?? "none"}\`, not \`rehearsal\` (PS5, RY26): run 2 makes that recording.`,
      );
    }
    await end(b, true);
  }

  // ===== The record =====
  const spendAfter = await service.getJson("/floor.json").then(() => stripValue("Spend"));
  const all = await refresh().catch(() => events);
  const total = Math.round(clock());
  const summary = {
    observed: record.filter((r) => r.status === "observed").length,
    substituted: record.filter((r) => r.status === "substituted").length,
    failed: record.filter((r) => r.status === "failed").length,
  };
  const measurement = {
    v: 1,
    run: Number(RUN),
    driven_by: "test/e2e/lead/rehearsal.spec.ts, with the canned cast",
    deployment_host: new URL(origin).host,
    pool,
    recorded_at: new Date(t0).toISOString(),
    total_s: total,
    within_10_min: total <= 600,
    key_r_used: false,
    cast: Object.fromEntries(bindings),
    events: all.length,
    landings: all.filter((e) => e.type === "landing.landed").length,
    spend_before: spendBefore,
    spend_after: spendAfter,
    preflight,
    beats: record,
    summary,
  };
  const json = JSON.stringify(measurement, null, 2) + "\n";
  if (json.includes(key) || json.includes(JSON.stringify(key).slice(1, -1))) throw new Error("secret_in_output");

  const md: string[] = [
    `# Rehearsal ${RUN} (VE9 run 1, scripted)`,
    "",
    `Driven by \`test/e2e/lead/rehearsal.spec.ts\` with the canned cast, on \`${measurement.deployment_host}\`, pool \`${pool}\`, recorded ${measurement.recorded_at}.`,
    `Total ${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")} on the run clock of the test (the waits for the scripted agents are not cut). Key R was not used. Landings: ${measurement.landings}. Events: ${measurement.events}.`,
    `Spend before: ${spendBefore || "-"}. Spend after: ${spendAfter || "-"}. Scripted agents make no model calls.`,
    "",
    `Beats observed: ${summary.observed}. Observed with a substitution: ${summary.substituted}. Failed: ${summary.failed}.`,
    "",
    "## State before the run (03-floor 1.1)",
    "",
    ...preflight.map((p) => `- ${p.ok ? "ok" : "FAILED"} ${p.name}: ${p.note}`),
    "",
    "## Beats",
    "",
    "| Beat | Window | Start-end (s) | Status | Proves observed | Substitutions and deviations |",
    "| --- | --- | --- | --- | --- | --- |",
    ...record.map(
      (r) =>
        `| ${r.beat} ${r.title} | ${r.window} | ${r.start_s}-${r.end_s} | ${r.status} | ${r.proves_observed ? "yes" : "no"} | ${[...r.substitutions, ...r.deviations, ...r.checks.filter((c) => !c.ok).map((c) => `FAILED ${c.name}: ${c.note}`)].join(" ").replace(/\|/g, "/") || "-"} |`,
    ),
    "",
    "The checks of each beat, with their notes, are in the JSON file of the same name.",
    "",
  ];
  const mdText = md.join("\n");
  if (mdText.includes(key)) throw new Error("secret_in_output");
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/rehearsal-${RUN}.json`, json);
  writeFileSync(`${OUT_DIR}/rehearsal-${RUN}.md`, mdText);
  writeFileSync(`${shots}/rehearsal.json`, json);

  const failedChecks = record.flatMap((r) =>
    r.checks.filter((c) => !c.ok).map((c) => `beat ${r.beat}: ${c.name}: ${c.note}`),
  );
  expect(failedChecks, "every control of every beat exists and responds").toEqual([]);
});
