import { expect, test, type Page } from "@playwright/test";
import {
  attemptOpened,
  attemptState,
  cardOpened,
  choiceCard,
  intentCreated,
  poolState,
  serveSession,
  serveStream,
  POOL,
  type Frame,
} from "../shell/stream.ts";

const POOL_PAGE = `<!doctype html><meta charset="utf-8"><title>pool</title><script>
 const source = location.pathname.split('/')[3];
 function beat() { parent.postMessage({type:'stats', source, version: source, seq:0,
 tick:1, paused:false, kinds:{}, shown:0, total:0, swap:null, selftest:null}, '*'); }
 beat(); setInterval(beat, 200);
</script>`;

async function openCard(page: Page, kind: "held" | "race" | "choice", theme = "light", synthetic = false) {
  await page.addInitScript((value) => localStorage.setItem("premise.theme", value), theme);
  await serveSession(page, true);
  const ids = kind === "race" ? ["a_1", "a_2", "a_3"] : ["a_1"];
  const card: Frame = {
    ...choiceCard("k_1", "held_path", "This change touches shared rules. Land it?"),
    kind,
    attempt_ids: ids,
    options:
      kind === "race"
        ? [{ id: "choose", label: "Choose this one" }]
        : [
            { id: "land", label: "Land" },
            { id: "decline", label: "Decline" },
          ],
    paths: [{ path: "world/energy.js", tier: "held" }],
    preview: {
      before: { repo: "main", commit: "before" },
      after: Object.fromEntries(ids.map((id) => [id, { repo: "main", commit: `after-${id}` }])),
      error: null,
    },
    candidates:
      kind === "race"
        ? Object.fromEntries(
            ids.map((id) => [id, { state: "submitted", can_choose: true, seconds: 48, cost_usd: 0.01 }]),
          )
        : null,
  };
  const frames = [poolState(1, { synthetic, plain_remote: "https://artifacts.invalid/plain" }), intentCreated(2)];
  let n = 3;
  for (const id of ids) {
    frames.push(attemptOpened(n++, id), attemptState(n++, id, "opened", "held"));
  }
  frames.push(cardOpened(n, card));
  await serveStream(page, frames);
  await page.route("**/pool/**", (route) => route.fulfill({ contentType: "text/html", body: POOL_PAGE }));
  await page.goto(`/p/${POOL}`);
  await page.locator(".tray").getByRole("button", { name: "Open" }).click();
  await expect(page.locator(".card-sheet")).toBeVisible();
}

for (const theme of ["dark", "light"]) {
  for (const kind of ["held", "race", "choice"] as const) {
    test(`D1 VD9/AX1/AC9: ${kind} sheet uses page colours in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await openCard(page, kind, theme);
      await expect(page.locator(".card-sheet")).toHaveCSS(
        "background-color",
        theme === "light" ? "rgb(245, 245, 247)" : "rgb(29, 29, 31)",
      );
      await expect(page.locator(".card-sheet__title")).toHaveCSS(
        "color",
        theme === "light" ? "rgb(29, 29, 31)" : "rgb(245, 245, 247)",
      );
    });
  }
}

for (const width of [1440, 1920]) {
  test(`D2 LY4/2.4: card sheets leave header, strip and banners usable at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1920 ? 1080 : 900 });
    await openCard(page, "held", "dark", true);
    const backdrop = await page.locator(".card-sheet__backdrop").boundingBox();
    const banner = await page.locator(".banners").boundingBox();
    expect(backdrop!.y).toBeGreaterThanOrEqual(banner!.y + banner!.height);
    for (const selector of [".kill-open", ".strip-cell", ".banner"]) {
      expect(
        await page
          .locator(selector)
          .first()
          .evaluate((element) => {
            const box = element.getBoundingClientRect();
            return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
          }),
      ).toBe(true);
    }
    await page.locator(".kill-open").click();
    await expect(page.locator(".card-sheet")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toBeVisible();
  });
}

for (const [width, title, thesis] of [
  [1920, 40, 30],
  [1440, 32, 24],
] as const) {
  test(`D4 VD15/6.2: sheet Title and Compare Intent roles at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1920 ? 1080 : 900 });
    await openCard(page, "held");
    await expect(page.locator(".card-sheet__title")).toHaveCSS("font-size", `${title}px`);
    await page.locator(".card-sheet__close").click();
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(page.locator(".cmp-thesis")).toHaveCSS("font-size", `${thesis}px`);
  });
}

for (const size of [
  { width: 1920, height: 1080, sheet: 1680, held: [725.3, 408], race: [536, 302] },
  { width: 1440, height: 900, sheet: 1382.4, held: [544, 306], race: [428, 241] },
]) {
  for (const kind of ["held", "race"] as const) {
    test(`D11 2.4/2.8: ${kind} sheet and frames match reference dimensions at ${size.width}`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await openCard(page, kind);
      const sheet = await page.locator(".card-sheet").boundingBox();
      expect(Math.abs(sheet!.width - size.sheet)).toBeLessThanOrEqual(1);
      const frames = page.locator(".card-sheet .sheet-frame__body");
      await expect(frames).toHaveCount(kind === "held" ? 2 : 3);
      for (const frame of await frames.all()) {
        const box = (await frame.boundingBox())!;
        expect(Math.abs(box.width - size[kind][0]!)).toBeLessThanOrEqual(1);
        expect(Math.abs(box.height - size[kind][1]!)).toBeLessThanOrEqual(1);
      }
      expect(await page.locator(".card-sheet").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    });
  }
}

for (const theme of ["dark", "light"]) {
  test(`D23 VD9/AX1: typed reason uses readable field colours in ${theme}`, async ({ page }) => {
    await openCard(page, "held", theme);
    const input = page.getByRole("textbox", { name: "Reason (optional)" });
    await input.fill("The shared change is ready.");
    await expect(input).toHaveValue("The shared change is ready.");
    await expect(input).toHaveCSS("color", theme === "dark" ? "rgb(245, 245, 247)" : "rgb(29, 29, 31)");
    await expect(input).toHaveCSS("background-color", theme === "dark" ? "rgb(44, 44, 46)" : "rgb(235, 235, 240)");
    await expect(input).toHaveCSS("border-top-color", theme === "dark" ? "rgb(142, 142, 147)" : "rgb(110, 110, 115)");
  });
}

test("D36 3.13: choice sheet omits held facts, intent and reason", async ({ page }) => {
  await openCard(page, "choice");
  const sheet = page.locator(".card-sheet");
  await expect(sheet.locator(".card-sheet__title")).toBeVisible();
  await expect(sheet.locator(".card-sheet__body")).toHaveCount(1);
  await expect(sheet.locator(".card-sheet__actions button")).toHaveCount(2);
  await expect(sheet.locator(".card-sheet__grid, .card-sheet__intent, .card-sheet__reason, .sheet-frame")).toHaveCount(
    0,
  );
});
