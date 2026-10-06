// RY25 — the judge's way in, with no key (Slice 9, acceptance items 2 and 3). A browser
// context that holds no cookies, no account and no owner key plays a recording to its end
// two ways of 8.7: way 1 — the quiet-pool start card's "Play the Replay" — and way 3 — the
// address `/replay/{id}` directly. While Replay runs, the page asks only for what RY1
// allows (`/floor.json`, `/replay/index.json`, the recording file, pool frames under
// `/pool/`, and the page's own static assets) and opens no WebSocket. Closing Replay goes
// back to the live Floor in the same view and reconnects the stream (RY20).
//
// `fixture` project: `/replay/index.json` and the recording are served with `page.route`,
// the recording being `fr27-unknown-event.ndjson` of test/fixtures/streams/ — not
// summary-only, and it carries one event type (`pool.weather`) the reducer does not know,
// so RY11's `replay.unknown` report shows too. `deployed` project: the same spec runs
// against PREMISE_URL with the id `hero-canned` and the real files.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { poolState } from "../stream.ts";

const STREAMS = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/streams");

/** The fixture recording's id — its file is `test/fixtures/streams/fr27-unknown-event.ndjson`. */
const FIXTURE_ID = "fr27";
const FIXTURE_FILE = join(STREAMS, "fr27-unknown-event.ndjson");
const FIXTURE_TITLE = "FR27: an event the page does not know"; // the header's label (RY8)

/** A request path is allowed in Replay when it is the document, the settings, anything under
 * `/replay/` (index and files), the page's built assets, a pool frame, or the icon. RY1's
 * four kinds plus the static page itself — the page cannot draw without its own bundle. */
function allowedInReplay(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/floor.json" ||
    pathname.startsWith("/replay/") ||
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/pool/") ||
    pathname.startsWith("/favicon")
  );
}

/** Every request path and every WebSocket the page opens, in order. A socket that the fixture
 * answers itself (`routeWebSocket`) raises no `websocket` event: `serveFixture` records those. */
function networkLog(page: Page): { requests: string[]; sockets: string[] } {
  const requests: string[] = [];
  const sockets: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  page.on("websocket", (socket) => sockets.push(new URL(socket.url()).pathname));
  return { requests, sockets };
}

/** `fixture` only: serves the recordings index and the one recording file (8.2, RY6), plus
 * the stream the page reconnects to when Replay is closed (RY20); each stream socket the page
 * opens is added to `sockets`. */
async function serveFixture(page: Page, sockets: string[]): Promise<void> {
  const text = readFileSync(FIXTURE_FILE, "utf8");
  const header = JSON.parse(text.split("\n")[0] ?? "{}") as { recorded_at: string; events: number };
  const index = {
    v: 1,
    default: FIXTURE_ID,
    recordings: [
      {
        id: FIXTURE_ID,
        file: `/replay/${FIXTURE_ID}.ndjson`,
        title: FIXTURE_TITLE,
        duration_ms: 3_000, // the fixture's own last-minus-first `ts` (RY13)
        events: header.events,
        bytes: Buffer.byteLength(text),
        synthetic: false,
        recorded_at: header.recorded_at,
      },
    ],
  };
  await page.route("**/replay/index.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(index) }),
  );
  await page.route(`**/replay/${FIXTURE_ID}.ndjson`, (route) =>
    route.fulfill({ contentType: "application/x-ndjson", body: text }),
  );
  // The pool the recording shows is `tidepool`; make it the default so closing Replay lands on `/`.
  const floor = {
    default_pool: "tidepool",
    swarm_pool: "tidepool-swarm",
    features: { held: false, race: false, undo: false, green: "none", clef: false, attempt_repos: false },
    prewritten: [],
    swarm_defaults: { seed: 1, launch_per_second: 1, think_ms: [0, 0], rescale_every_s: 60 },
    models: {},
    limits: [],
    related: "",
  };
  await page.route("**/floor.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(floor) }),
  );
  await page.routeWebSocket(/\/api\/pools\/[^/]+\/stream/, (ws) => {
    sockets.push(new URL(ws.url()).pathname);
    ws.onMessage((message) => {
      const request = JSON.parse(message.toString()) as { hello?: number };
      if (request.hello !== 1) return;
      ws.send(JSON.stringify({ events: [{ ...poolState(1), pool: "tidepool" }] }));
    });
  });
}

/** What the checks of a Replay visit share once it has started. */
async function expectReplayPlaysOut(page: Page, deployed: boolean): Promise<void> {
  // RY3/RY27: the banner is on, and the recording's title in quotes (fixture title is known).
  const banner = page.locator('.banner[data-tone="replay"]');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("REPLAY");
  if (!deployed) await expect(banner).toContainText(`"${FIXTURE_TITLE}"`);

  if (deployed) {
    // A deployed recording can be minutes long; 8x keeps the check inside its timeout (RY15).
    const speed = page.locator(".replay-speed");
    await expect(speed).toBeVisible();
    while ((await speed.innerText()) !== "Speed 8×") await speed.click();
  }

  if (!deployed) {
    // RY11: the one `pool.weather` event of the fixture is counted and reported once (FE1).
    await expect(page.locator(".toasts")).toContainText(
      "This recording has 1 events this page does not know. They are skipped.",
      { timeout: 15_000 },
    );
  }

  // RY19: the bar says the recording ended and offers the two ways on.
  await expect(page.locator(".replay-ended")).toContainText("The recording has ended.", {
    timeout: deployed ? 120_000 : 30_000,
  });
  await expect(page.getByRole("button", { name: "Watch again" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open the live Floor" })).toBeVisible();
  await expect(banner).toBeVisible();
}

/** RY20, browser side: closing Replay returns to the live Floor in the same single-page
 * view and the stream socket reconnects — to the pool the recording showed. `pool` is known
 * in the fixture (`tidepool`); on a deployment it is whatever the recording's header says. */
async function expectReturnToLive(
  page: Page,
  sockets: string[],
  socketCount: number,
  pool: string | null,
): Promise<void> {
  await page.getByRole("button", { name: "Open the live Floor" }).click();
  await expect(page.locator(".floor")).toHaveAttribute("data-mode", "live");
  await expect(page.locator(".floor")).toHaveAttribute("data-view", "floor"); // the same view
  await expect(page.locator('.banner[data-tone="replay"]')).toHaveCount(0);
  await expect.poll(() => sockets.length, { timeout: 10_000 }).toBe(socketCount + 1);
  const socket = sockets.at(-1) ?? "";
  expect(socket).toMatch(/^\/api\/pools\/[^/]+\/stream$/);
  if (pool !== null) expect(socket).toBe(`/api/pools/${pool}/stream`);
}

test.describe("Replay with no credentials (RY25)", () => {
  test("way 3 of 8.7: /replay/{id} loads and plays to its end", async ({ page, context }, testInfo) => {
    const deployed = testInfo.project.name === "deployed";
    const id = deployed ? "hero-canned" : FIXTURE_ID;
    test.setTimeout(deployed ? 180_000 : 60_000);
    const { requests, sockets } = networkLog(page);
    if (!deployed) await serveFixture(page, sockets);
    await context.clearCookies(); // the context carries none; make the no-credential visit explicit

    await page.goto(`/replay/${id}`);
    const socketCount = sockets.length; // none yet — Replay opens no socket (RY1)
    await expectReplayPlaysOut(page, deployed);

    // RY1/RY2: while the recording loaded and played, the page asked for nothing else —
    // no /api, no WebSocket, no credentials.
    const api = requests.filter((p) => p.startsWith("/api/"));
    expect(api, `Replay asked the API: ${api.join(", ")}`).toEqual([]);
    const outside = requests.filter((p) => !allowedInReplay(p));
    expect(outside, `Replay asked for: ${outside.join(", ")}`).toEqual([]);
    expect(sockets, `Replay opened a WebSocket: ${sockets.join(", ")}`).toEqual([]);

    await expectReturnToLive(page, sockets, socketCount, deployed ? null : "tidepool");
  });

  test("way 1 of 8.7: the quiet-pool start card plays the default recording", async ({ page, context }, testInfo) => {
    const deployed = testInfo.project.name === "deployed";
    test.setTimeout(deployed ? 180_000 : 60_000);
    const { requests, sockets } = networkLog(page);
    if (!deployed) await serveFixture(page, sockets);
    await context.clearCookies();

    await page.goto("/");

    // RY23: a quiet pool shows the start card to a visitor.
    const card = page.locator(".start-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Watch a recorded run");

    // From here on the assertions are about the Replay visit itself (RY1): the live floor's
    // own session check and stream socket were opened before, and are not Replay's. The start
    // card can show before the live socket connects; a click in that moment lets the live
    // session's pending connect open a socket just before the session closes it, so the check
    // starts once the live socket is up.
    await expect.poll(() => sockets.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const requestsAtClick = requests.length;
    const socketsAtClick = sockets.length;
    await card.getByRole("button", { name: /Play the Replay/ }).click();

    // RY18/RY26: the page navigates to the default recording of the index — no reload.
    await expect(page).toHaveURL(/\/replay\/[^/]+$/);
    if (!deployed) await expect(page).toHaveURL(`/replay/${FIXTURE_ID}`);

    await expectReplayPlaysOut(page, deployed);

    // RY1: since the click, Replay asked only for the index, the file and pool frames —
    // and opened no WebSocket of its own.
    const after = requests.slice(requestsAtClick);
    const api = after.filter((p) => p.startsWith("/api/"));
    expect(api, `Replay asked the API: ${api.join(", ")}`).toEqual([]);
    const outside = after.filter((p) => !allowedInReplay(p));
    expect(outside, `Replay asked for: ${outside.join(", ")}`).toEqual([]);
    expect(sockets.slice(socketsAtClick), "Replay opened a WebSocket").toEqual([]);

    // The fixture's header.pool is `tidepool`; on a deployment it is the default recording's own.
    await expectReturnToLive(page, sockets, sockets.length, deployed ? null : "tidepool");
  });
});
