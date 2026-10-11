// VE9 run 2 driven in the browser with real agents (docs/spec/04-build-plan.md 5.5; the beats are
// docs/spec/03-floor.md 1.2). The owner delegated run 2 to the lead on 2026-10-11 ("Approved").
// It walks beats 1 to 10 on an existing pool opened at `/p/<pool>`, doing what the beat sheet's
// "Owner does" column says: the starter set, the crab typed and raced, the shared rule typed and
// landed from its held card, a racer chosen, the sweep and the late creature, the Why card and the
// git drawer, the causal undo, Swarm view without Start (PS7), About, Lock and the Replay. Every
// agent is a real Workers AI agent, so the waits follow the stream, not a script.
//
//   REHEARSAL_REAL=1 PREMISE_URL=https://premise.rk3469.workers.dev REHEARSAL_POOL=rehearsal \
//     PREMISE_OWNER_KEY="$(cat ~/.premise/prod-owner-key)" \
//     npx playwright test --project=deployed test/e2e/lead/rehearsal-real.spec.ts
//
// The owner key reaches the page only through `POST /api/session` (PS2) and is never printed.
// Output: docs/measurements/rehearsal/rehearsal-<REHEARSAL_RUN, default 2>.json and .md, and one
// screenshot per beat state under test-results/rehearsal-real/<pool>/.

import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Locator } from "@playwright/test";
import { httpService } from "../../../scripts/measure/engine/service.ts";
import { parseReplayNdjson } from "../../../scripts/soak/stream.ts";

const ENABLED = process.env.REHEARSAL_REAL === "1" && (process.env.PREMISE_URL ?? "") !== "";
test.skip(!ENABLED, "Run 2 with real agents runs only with REHEARSAL_REAL=1 and PREMISE_URL.");
test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });

const RUN = process.env.REHEARSAL_RUN ?? "2";
const POOL = process.env.REHEARSAL_POOL ?? "rehearsal";
const STAGE = { width: 1920, height: 1080 };

// The requests of the take (02-tidepool section 9), word for word.
const P1A = "a crab that hides in its shell when its energy drops below 30";
const P1B = "a shrimp that darts every two seconds and spends 5 energy on each dart";
const R01 = "make energy a fraction from 0 to 1";
const P9A =
  "write every energy cost in percent of a full tank: change the drain rule so that 5 means five percent, and update every creature that drains energy";
const P9B = "a squid that shoots forward every three seconds and spends a tenth of its energy on each burst";
const HELD_TITLE = "This change touches shared rules. Land it?";
const MIN = 60_000;

type Ev = Record<string, unknown> & { type: string; n: number };
type Check = { name: string; ok: boolean; note: string };
type Beat = { beat: number; title: string; start_s: number; end_s: number; checks: Check[]; notes: string[] };

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

test("rehearsal 2: the beat sheet with real agents", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "deployed", "runs against a deployment only (--project=deployed)");
  test.setTimeout(75 * MIN);

  const key = process.env.PREMISE_OWNER_KEY ?? "";
  if (key === "") throw new Error("PREMISE_OWNER_KEY is not set");
  const redact = (t: string): string => t.split(key).join("[redacted]");
  const origin = new URL(process.env.PREMISE_URL!).origin;
  const service = httpService({ origin, ownerKey: key });
  const t0 = Date.now();
  const clock = () => Math.round((Date.now() - t0) / 1000);
  const log = (line: string) => console.log(`[run2 ${clock()}s] ${redact(line)}`);
  // A refused owner action names its route and status in the log (never a body: it may echo input).
  page.on("response", (r) => {
    if (r.request().method() !== "GET" && r.status() >= 400)
      log(`  ${r.request().method()} ${new URL(r.url()).pathname} -> ${r.status()}`);
  });
  const shots = `test-results/rehearsal-real/${POOL}`;
  mkdirSync(shots, { recursive: true });

  // ---- the stream, read back through the owner's export ----
  let events: Ev[] = [];
  const refresh = async (): Promise<Ev[]> => {
    const r = await service.getAuthed(`/api/pools/${POOL}/replay.ndjson`);
    if (r.status !== 200) throw new Error(`replay export answered ${r.status}`);
    events = parseReplayNdjson(r.text).events as unknown as Ev[];
    return events;
  };
  const waitFor = async (what: string, ok: (all: Ev[]) => boolean, timeoutMs = 8 * MIN): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (ok(await refresh())) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await page.waitForTimeout(2000);
    }
  };
  const intentIds = (all: Ev[], text: string): string[] =>
    all.filter((e) => str(e.text) === text && str(e.intent_id) !== "").map((e) => str(e.intent_id));
  const attemptsOf = (all: Ev[], text: string): string[] => {
    const ids = new Set(intentIds(all, text));
    return all.filter((e) => e.type === "attempt.opened" && ids.has(str(e.intent_id))).map((e) => str(e.attempt_id));
  };
  const landedAttempts = (all: Ev[]): Set<string> => {
    const seqs = new Set(all.filter((e) => e.type === "landing.landed").map((e) => e.seq));
    return new Set(all.filter((e) => e.type === "landing.accepted" && seqs.has(e.seq)).map((e) => str(e.attempt_id)));
  };
  const landedText = (text: string) => (all: Ev[]) => {
    const done = landedAttempts(all);
    return attemptsOf(all, text).some((a) => done.has(a));
  };
  /** The newest state of every card, folded from card.opened / card.updated / card.closed. */
  const cards = (all: Ev[]): Map<string, Record<string, unknown> & { closed?: boolean }> => {
    const out = new Map<string, Record<string, unknown> & { closed?: boolean }>();
    for (const e of all) {
      if (e.type === "card.opened") out.set(str(rec(e.card).card_id), { ...rec(e.card) });
      else if (e.type === "card.updated") {
        const id = str(rec(e.card).card_id || e.card_id);
        out.set(id, { ...(out.get(id) ?? {}), ...rec(e.card) });
      } else if (e.type === "card.closed") {
        const id = str(e.card_id);
        out.set(id, { ...(out.get(id) ?? {}), closed: true });
      }
    }
    return out;
  };
  const raceReady = (all: Ev[]): number => {
    for (const c of cards(all).values()) {
      if (c.kind !== "race" || c.closed === true) continue;
      return Object.values(rec(c.candidates)).filter((v) => rec(v).can_choose === true).length;
    }
    return 0;
  };
  const openHeldFor = (all: Ev[], text: string): boolean => {
    const mine = new Set(attemptsOf(all, text));
    return [...cards(all).values()].some(
      (c) =>
        c.kind === "held" && c.closed !== true && (c.attempt_ids as string[] | undefined)?.some((a) => mine.has(a)),
    );
  };

  // ---- the record ----
  const beats: Beat[] = [];
  let cur: Beat | null = null;
  const begin = (beat: number, title: string): Beat => {
    cur = { beat, title, start_s: clock(), end_s: 0, checks: [], notes: [] };
    beats.push(cur);
    log(`beat ${beat}: ${title}`);
    return cur;
  };
  const check = async (name: string, body: () => Promise<string | void>): Promise<boolean> => {
    log(`  ${name}`);
    try {
      const note = await body();
      cur!.checks.push({ name, ok: true, note: redact(note ?? "") });
      return true;
    } catch (error) {
      const m = (error instanceof Error ? error.message : String(error))
        // eslint-disable-next-line no-control-regex
        .replace(/\u001b\[[0-9;]*m/g, "")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .slice(0, 3)
        .join(" / ");
      cur!.checks.push({ name, ok: false, note: redact(m).slice(0, 300) });
      log(`    FAILED: ${redact(m).slice(0, 200)}`);
      return false;
    }
  };
  const shot = async (name: string) => {
    await page.waitForTimeout(400);
    await page
      .screenshot({ path: `${shots}/beat-${String(cur!.beat).padStart(2, "0")}-${name}.png` })
      .catch(() => undefined);
  };
  const closeSheets = async () => {
    for (let i = 0; i < 3; i += 1) await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  };
  const field = () => page.getByRole("textbox", { name: "Ask for a change in plain words." });
  const send = () => page.locator(".intent-actions").getByRole("button", { name: "Send", exact: true });
  const dialog = (name: string | RegExp): Locator => page.getByRole("dialog", { name });
  const rail = page.locator("aside.rail");
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
  const pickPrewritten = async (text: string) => {
    await page.getByRole("combobox", { name: "Pre-written requests" }).selectOption({ label: text });
    await expect(field()).toHaveValue(text);
  };

  // ===== Before the run =====
  const unlocked = await page.request.post(`${origin}/api/session`, { data: { key } });
  expect(unlocked.status(), "POST /api/session").toBe(200);
  await page.setViewportSize(STAGE);
  await page.goto(`${origin}/p/${POOL}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".pool-name")).toHaveText(POOL, { timeout: 30_000 });
  await expect(page.locator(".overview")).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("f");
  await expect(page.locator(".rail")).toBeVisible();
  const look = page.getByRole("button", { name: "Look around the live pool" });
  if (await look.isVisible().catch(() => false)) await look.click({ timeout: 3000 }).catch(() => undefined);
  await refresh();
  const startN = events.length;
  log(`pool ${POOL}: ${startN} events before the run`);

  // ===== Beat 1 =====
  begin(1, "Starter set and the crab race");
  await check('press "Send the starter set (6)"', async () => {
    await page.getByRole("button", { name: /^Send the starter set \(6\)$/ }).click();
  });
  await check('type the crab request, press "Race 3"', async () => {
    await field().fill(P1A);
    await page.getByRole("button", { name: "Race 3", exact: true }).click();
    await expect(field()).toHaveValue("", { timeout: 30_000 });
  });
  await shot("sent");
  await check("a starter creature lands by itself", async () => {
    await waitFor("a starter landing", (all) => all.slice(startN).some((e) => e.type === "landing.landed"));
  });
  await shot("first-landing");
  await check('the three crab attempts reach "Waiting for you"', async () => {
    await waitFor("race 3 of 3 ready", (all) => raceReady(all) >= 3, 10 * MIN);
    return `${raceReady(events)} of 3 ready at ${clock()} s`;
  });
  await shot("race-waiting");
  cur!.end_s = clock();

  // ===== Beat 2 =====
  begin(2, "Shared rule and Who relies");
  await check("type the shared-rule request, press Send", async () => {
    await field().fill(R01);
    await send().click();
    await expect(field()).toHaveValue("", { timeout: 30_000 });
  });
  await check("tile energy, ENERGY_MAX, Who relies: In flight lists the crabs", async () => {
    const panel = await whoReliesEnergyMax();
    await expect(panel).toContainText(/In flight \(\d+\)/i, { timeout: 30_000 });
    return (await panel.innerText()).replace(/\s+/g, " ").slice(0, 240);
  });
  await shot("who-relies");
  await closeSheets();
  cur!.end_s = clock();

  // ===== Beat 3 =====
  begin(3, "Held card, Land, heads-up and go-around");
  await check("the shared rule waits on its held card", async () => {
    await waitFor("held card of the shared rule", (all) => openHeldFor(all, R01));
  });
  await check("open the card; it names the crab attempts; tap Land", async () => {
    const row = page.locator(".tray-row", { hasText: HELD_TITLE });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Open" }).click();
    const sheet = dialog(HELD_TITLE);
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText(/Landing this sends \d+ changes? back/, { timeout: 60_000 });
    await expect(sheet).not.toContainText("Building the preview…", { timeout: 60_000 });
    const affects = (await sheet.locator(".card-sheet__affect").allInnerTexts()).join(" | ");
    await shot("held-card");
    await sheet.getByRole("button", { name: "Land", exact: true }).click();
    return affects.slice(0, 300);
  });
  await check("the shared rule lands", async () => {
    await waitFor("shared rule landed", landedText(R01));
    await closeSheets();
  });
  await check("the crabs get a heads-up and go around", async () => {
    const crabs = new Set(attemptsOf(events, P1A));
    await waitFor("crab heads-ups", (all) =>
      all.some((e) => e.type === "headsup.sent" && crabs.has(str(e.attempt_id))),
    );
  });
  await shot("go-around");
  await check('the crabs return to "Waiting for you"', async () => {
    await waitFor("race ready again", (all) => raceReady(all) >= 2, 10 * MIN);
    return `${raceReady(events)} of 3 ready at ${clock()} s`;
  });
  cur!.end_s = clock();

  // ===== Beat 4 =====
  begin(4, "Race sheet and Compare view");
  await check('open the race card, tap "Choose this one"', async () => {
    const row = page.locator(".tray-row", { hasText: /attempts? at .* (are|is) ready/ });
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.getByRole("button", { name: "Open" }).click();
    const sheet = page.getByRole("dialog", { name: /attempts? at/ });
    await expect(sheet).toBeVisible();
    await shot("race-sheet");
    await sheet.getByRole("button", { name: "Choose this one" }).first().click();
  });
  await check("the chosen crab lands", async () => {
    await waitFor("crab landed", landedText(P1A));
    await closeSheets();
  });
  await check("Compare view (key C)", async () => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("c");
    await expect(page.locator(".cmp")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(15_000);
    await shot("compare");
    return (
      await page
        .locator(".cmp-diff")
        .innerText()
        .catch(() => "")
    )
      .replace(/\s+/g, " ")
      .slice(0, 300);
  });
  await page
    .getByRole("button", { name: "Back to the Floor" })
    .click()
    .catch(() => undefined);
  cur!.end_s = clock();

  // ===== Beat 5 =====
  begin(5, "The second catch: the sweep and the late creature");
  await check("the shrimp has landed (BS7)", async () => {
    await waitFor("shrimp landed", landedText(P1B));
  });
  await check("send the sweep request", async () => {
    await pickPrewritten(P9A);
    await send().click();
    await expect(field()).toHaveValue("", { timeout: 30_000 });
  });
  const sweepCarded = await check("the sweep waits on its card", async () => {
    await waitFor("sweep card", (all) => openHeldFor(all, P9A) || landedText(P9A)(all));
    if (landedText(P9A)(events)) throw new Error("the sweep landed without a card");
  });
  await shot("sweep-waiting");
  await check("send the late creature (the squid)", async () => {
    await pickPrewritten(P9B);
    await send().click();
    await expect(field()).toHaveValue("", { timeout: 30_000 });
  });
  await check("the squid lands by itself", async () => {
    await waitFor("squid landed", landedText(P9B));
  });
  if (sweepCarded) {
    await check("the sweep gets the query heads-up and a new card; tap Land", async () => {
      const sweep = new Set(attemptsOf(events, P9A));
      await waitFor("query heads-up", (all) =>
        all.some(
          (e) =>
            e.type === "headsup.sent" &&
            sweep.has(str(e.attempt_id)) &&
            Array.isArray(e.keys) &&
            // QT1 or QT2 (a search gains a match) and QR1 (a new reference) are the same catch (01-core 7.2).
            (e.keys as Array<{ rule: string }>).some((k) => ["QT1", "QT2", "QR1"].includes(k.rule)),
        ),
      );
      await waitFor("a new sweep card", (all) => openHeldFor(all, P9A) || landedText(P9A)(all));
      if (!landedText(P9A)(events)) {
        const row = page.locator(".tray-row", { hasText: HELD_TITLE });
        await expect(row).toBeVisible({ timeout: 30_000 });
        await row.getByRole("button", { name: "Open" }).click();
        const sheet = dialog(HELD_TITLE);
        await expect(sheet).not.toContainText("Building the preview…", { timeout: 60_000 });
        await shot("sweep-second-card");
        await sheet.getByRole("button", { name: "Land", exact: true }).click();
      }
      await waitFor("sweep landed", landedText(P9A));
      await closeSheets();
    });
  }
  cur!.end_s = clock();

  // ===== Beat 6 =====
  begin(6, "Why card and Show the git");
  const why = dialog("Why is this here?");
  await check("Why card of the crab (from its landed row)", async () => {
    await closeSheets();
    await rail.getByRole("tab", { name: /^Landed/ }).click();
    await rail.locator(".landed-row", { hasText: "crab" }).first().click();
    await expect(why).toBeVisible({ timeout: 10_000 });
    await expect(why).toContainText(P1A);
    await shot("why-crab");
    return (await why.innerText()).replace(/\s+/g, " ").slice(0, 300);
  });
  await check("Show the git", async () => {
    await why.getByRole("button", { name: "Show the git" }).click();
    const drawer = page
      .locator(".git-drawer, [role='dialog']", { hasText: "This is an ordinary git commit on main" })
      .last();
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    await expect(drawer).toContainText("Change-Id:");
    await shot("show-the-git");
  });
  await closeSheets();
  await rail
    .getByRole("tab", { name: /^Working/ })
    .click()
    .catch(() => undefined);
  cur!.end_s = clock();

  // ===== Beat 7 =====
  begin(7, "Causal Undo");
  const undoSheet = dialog(/^Undo landing \d+/);
  await check("Why card of the shared-rule change, Undo", async () => {
    const panel = await whoReliesEnergyMax();
    await panel
      .getByRole("button", { name: /make energy a fraction/ })
      .first()
      .click();
    await expect(why).toBeVisible({ timeout: 10_000 });
    await why.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(undoSheet).toBeVisible({ timeout: 10_000 });
    await expect(undoSheet).not.toContainText("Working out what this undo takes back…", { timeout: 30_000 });
    await shot("undo-sheet");
    return (await undoSheet.innerText()).replace(/\s+/g, " ").slice(0, 300);
  });
  await check('tap "Undo it"; a later change reopens', async () => {
    await undoSheet.getByRole("button", { name: "Undo it" }).click();
    await waitFor("undo applied", (all) =>
      all.some((e) => e.type === "attempt.reopened" || e.type === "undo.refused" || e.type === "undo.done"),
    );
    if (events.some((e) => e.type === "undo.refused")) throw new Error("Trunk refused the undo");
    await closeSheets();
  });
  await check("the reopened change adapts and lands again", async () => {
    const before = events.filter((e) => e.type === "landing.landed").length;
    await waitFor(
      "a landing after the undo",
      (all) => all.filter((e) => e.type === "landing.landed").length > before + 1,
      8 * MIN,
    );
  });
  await shot("after-undo");
  cur!.end_s = clock();

  // ===== Beat 8 =====
  begin(8, "Swarm view (no Start: the Swarm pool stays empty for the take, PS7)");
  await check("Swarm view opens with its controls", async () => {
    await closeSheets();
    await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Swarm" }).click();
    await expect(page.locator(".swarm-view")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".swarm-controls").getByRole("button", { name: "Start", exact: true })).toBeVisible();
    await shot("swarm");
  });
  cur!.notes.push("Start not pressed: PS7 needs the production Swarm pool empty before the take.");
  cur!.end_s = clock();

  // ===== Beat 9 =====
  begin(9, "About");
  await check("About opens", async () => {
    await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "About" }).click();
    const about = page.getByRole("dialog", { name: /About/ });
    await expect(about).toBeVisible({ timeout: 10_000 });
    await expect(about).toContainText("How it runs");
    await shot("about");
  });
  await closeSheets();
  await page
    .getByRole("navigation", { name: "Views" })
    .getByRole("button", { name: "Floor" })
    .click()
    .catch(() => undefined);
  cur!.end_s = clock();

  // ===== Beat 10 =====
  begin(10, "Lock and play the Replay");
  await check("Owner, then Lock", async () => {
    await page.locator("header").getByRole("button", { name: "Owner", exact: true }).click();
    const owner = dialog("Owner key");
    await expect(owner).toBeVisible();
    await owner.getByRole("button", { name: "Lock", exact: true }).click();
    await expect(page.locator("header").getByRole("button", { name: "Visitor", exact: true })).toBeVisible({
      timeout: 10_000,
    });
  });
  await check("Play the Replay", async () => {
    // The start card shows only on a quiet pool (RY23); with an attempt still in flight the Replay
    // view's own play button is the way in.
    const play = page.getByRole("button", { name: /^Play the Replay/ }).first();
    if (await play.isVisible({ timeout: 60_000 }).catch(() => false)) await play.click();
    else {
      cur!.notes.push(
        "The pool was not quiet (an attempt was still in flight), so the Replay was opened from the Replay view.",
      );
      await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Replay" }).click();
      await page.getByRole("button", { name: /^Play/ }).first().click({ timeout: 30_000 });
    }
    await expect(page.locator(".banner[data-tone='replay']")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(3000);
    await shot("replay");
  });
  cur!.end_s = clock();

  // ===== The record =====
  const all = await refresh().catch(() => events);
  const run = all.slice(startN);
  const count = (t: string) => run.filter((e) => e.type === t).length;
  const failed = beats.filter((b) => b.checks.some((c) => !c.ok)).map((b) => b.beat);
  const result = {
    v: 1,
    run: RUN,
    driven_by: "test/e2e/lead/rehearsal-real.spec.ts, real Workers AI agents (owner delegated run 2)",
    deployment_host: new URL(origin).host,
    pool: POOL,
    recorded_at: new Date().toISOString(),
    total_s: clock(),
    landings: count("landing.landed"),
    headsups: count("headsup.sent"),
    take_backs: count("undo.planned"),
    beats_failed: failed,
    beats,
  };
  mkdirSync("docs/measurements/rehearsal", { recursive: true });
  writeFileSync(`docs/measurements/rehearsal/rehearsal-${RUN}.json`, JSON.stringify(result, null, 2) + "\n");
  const md = [
    `# Rehearsal ${RUN} (VE9 run 2, real agents, driven by the lead)`,
    "",
    `Pool \`${POOL}\` on \`${result.deployment_host}\`, ${result.recorded_at}. Total ${Math.floor(result.total_s / 60)}:${String(result.total_s % 60).padStart(2, "0")}. Landings ${result.landings}, heads-ups ${result.headsups}, undo plans ${result.take_backs}. Beats with a failed check: ${failed.length === 0 ? "none" : failed.join(", ")}.`,
    "",
    "| Beat | Start-end (s) | Checks | Notes |",
    "| --- | --- | --- | --- |",
    ...beats.map(
      (b) =>
        `| ${b.beat} ${b.title} | ${b.start_s}-${b.end_s} | ${b.checks.map((c) => `${c.ok ? "ok" : "FAILED"} ${c.name}${c.note ? ` (${c.note.replace(/\|/g, "/")})` : ""}`).join("; ")} | ${b.notes.join(" ")} |`,
    ),
    "",
  ].join("\n");
  writeFileSync(`docs/measurements/rehearsal/rehearsal-${RUN}.md`, md);
  log(`done: ${result.landings} landings, failed beats ${failed.join(",") || "none"}`);
});
