// AC18/RY16: a complete 50,000-event recording goes through the page's downloader,
// parser and reducer. The last chapter rebuild must also reach the rendered strip and
// rail inside the specified budget. The real hero fixture supplies two landings, a
// repaired attempt, premises and a resolved heads-up; valid metrics extend its stream.

import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { REPLAY_MAX_BYTES, REPLAY_SEEK_BUDGET_MS } from "../../../../src/protocol/constants.ts";
import type { PoolEvent } from "../../../../src/protocol/events.ts";
import type { ReplayHeader } from "../../../../src/protocol/replay.ts";
import { FLOOR_JSON } from "../stream.ts";

const COUNT = 50_000;
const ID = "seek-budget";
const HERO = readFileSync(new URL("../../../fixtures/streams/hero-c04.ndjson", import.meta.url), "utf8")
  .trim()
  .split("\n");

function recording(): { text: string; lastChapterPosition: number; duration: number } {
  const events = HERO.slice(1).map((line) => JSON.parse(line) as PoolEvent);
  const zero = events[0]!.ts;
  // One metrics event per recorded second is EM5's normal cadence. Every event is
  // reduced; none is an unknown event or a duplicate n used merely to pad the file.
  while (events.length < COUNT - 1) {
    const n = events.length + 1;
    events.push({
      n,
      t: zero + (n - 1) * 1_000 + 5,
      ts: zero + (n - 1) * 1_000,
      pool: "tidepool",
      src: "trunk",
      type: "metrics",
      window_ms: 60_000,
      landings_per_second: 0,
      time_to_land_ms: { p50: null, p99: null },
      time_held_ms: { p50: null, p99: null },
      go_around_rate: null,
      false_abort_rate: null,
      escape_rate: null,
      waiting_behind: 0,
      push_backlog: 0,
      tick_cpu_ms: { p50: 1, p99: 2 },
    });
  }
  const duration = (COUNT - 1) * 1_000;
  events.push({
    n: COUNT,
    t: zero + duration + 5,
    ts: zero + duration,
    pool: "tidepool",
    src: "swarm",
    type: "swarm.state",
    synthetic: true,
    running: true,
    agents: 4,
    collision_dial: 0.5,
    pools: ["tidepool-swarm"],
  });
  const header: ReplayHeader = {
    ...(JSON.parse(HERO[0]!) as ReplayHeader),
    events: COUNT,
    label: "The seek budget fixture",
  };
  return {
    text: [header, ...events].map((value) => JSON.stringify(value)).join("\n") + "\n",
    // 03-floor 8.5: the last chapter starts 3,000 ms before its first event.
    lastChapterPosition: duration - 3_000,
    duration,
  };
}

test("AC18: 50,000 events load and the last chapter draws within the Replay seek budget", async ({
  page,
}, testInfo) => {
  const fixture = recording();
  expect(fixture.text.trim().split("\n")).toHaveLength(COUNT + 1);
  expect(Buffer.byteLength(fixture.text)).toBeLessThanOrEqual(REPLAY_MAX_BYTES);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.route("**/floor.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...FLOOR_JSON, default_pool: "tidepool" }),
    }),
  );
  await page.route("**/replay/index.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ v: 1, default: ID, recordings: [{ id: ID, file: `/replay/${ID}.ndjson` }] }),
    }),
  );
  await page.route(`**/replay/${ID}.ndjson`, (route) =>
    route.fulfill({ contentType: "application/x-ndjson", body: fixture.text }),
  );
  // Commit-frame service is outside this seek check. Keep those GETs local and quiet.
  await page.route("**/pool/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Commit frame fixture</title>" }),
  );
  await page.goto(`/replay/${ID}`);
  await expect(page.locator(".replay-bar")).toBeVisible();
  await expect(page.locator(".replay-track")).toHaveValue("0");
  await expect(page.locator(".replay-track")).toHaveAttribute("max", String(fixture.duration));
  await expect(page.locator('.replay-mark[title="Swarm"]')).toBeVisible();
  await expect(page.locator(".strip-cell", { hasText: "Landed" }).locator(".strip-value")).toHaveText("0");

  const measured = await page.evaluate(
    ({ position }) =>
      new Promise<{ elapsed: number; position: string; landed: string; goArounds: string; tabs: string }>(
        (resolve, reject) => {
          const lastChapter = document.querySelector<HTMLButtonElement>('.replay-mark[title="Swarm"]');
          if (lastChapter === null) throw new Error("the final Swarm chapter is missing");
          const value = (label: string): string => {
            const cell = [...document.querySelectorAll(".strip-cell")].find(
              (item) => item.querySelector(".strip-label")?.textContent?.trim() === label,
            );
            return cell?.querySelector(".strip-value")?.textContent?.trim() ?? "";
          };
          let complete = false;
          const started = performance.now();
          const observer = new MutationObserver(() => {
            const track = document.querySelector<HTMLInputElement>(".replay-track");
            if (
              complete ||
              track?.value !== String(position) ||
              value("Landed") !== "2" ||
              value("Go-arounds") !== "1" ||
              !document.querySelector(".tabs")?.textContent?.includes("Landed 2")
            ) {
              return;
            }
            complete = true;
            observer.disconnect();
            // Two animation frames include the paint following React's completed commit.
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                window.clearTimeout(timeout);
                resolve({
                  elapsed: performance.now() - started,
                  position: track.value,
                  landed: value("Landed"),
                  goArounds: value("Go-arounds"),
                  tabs: document.querySelector(".tabs")?.textContent ?? "",
                });
              }),
            );
          });
          observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
          const timeout = window.setTimeout(() => {
            observer.disconnect();
            reject(new Error("the last chapter did not draw its expected position and state within 5 seconds"));
          }, 5_000);
          lastChapter.click();
        },
      ),
    { position: fixture.lastChapterPosition },
  );
  await testInfo.attach("seek-budget.json", {
    body: Buffer.from(JSON.stringify({ events: COUNT, budget_ms: REPLAY_SEEK_BUDGET_MS, ...measured }, null, 2)),
    contentType: "application/json",
  });
  expect(measured.position).toBe(String(fixture.lastChapterPosition));
  expect(measured.landed).toBe("2");
  expect(measured.goArounds).toBe("1");
  expect(measured.tabs).toContain("Landed 2");
  expect(measured.elapsed).toBeLessThanOrEqual(REPLAY_SEEK_BUDGET_MS);
  await expect(page.locator(".replay-bar").getByRole("button", { name: "Play", exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
