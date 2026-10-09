import { expect, test } from "@playwright/test";
import { attempts, ev, serveReview } from "./review-fixtures.ts";

for (const theme of ["dark", "light"]) {
  test(`D22 / VD16: five light shapes remain different at 7 px without colour in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.addInitScript((theme) => localStorage.setItem("premise.theme", theme), theme);
    const frames = attempts(1);
    const states = ["holds", "changed", "confirm", "blind_spot", "checking"];
    let n = 5;
    for (const state of states) {
      frames.push(
        ev(n++, {
          type: "premise.recorded",
          attempt_id: "a_1",
          tool: "read",
          premise: { kind: "entity", key: `f.js#${state}`, hash: "h", seq: 0, read: true, edit: false, derived: false },
        }),
      );
      if (state !== "holds")
        frames.push(
          ev(n++, {
            type: "premise.judged",
            attempt_id: "a_1",
            kind: "entity",
            key: `f.js#${state}`,
            old_hash: "h",
            new_hash: "h1",
            cause: "landing",
            cause_seq: 1,
            rule: state === "blind_spot" ? "B1" : "E2",
            class: state === "checking" ? "triage" : "rule",
            result: state === "changed" ? "repair" : state === "checking" ? null : "confirm",
            reason: "changed",
            clef: { model: null, p: null, error: null },
          }),
        );
    }
    await serveReview(page, frames);
    await page.goto("/p/testpool");
    const lights = page.locator(".attempt-card__lights .light");
    await expect(lights).toHaveCount(5);
    const masks: number[][] = [];
    for (const state of states) {
      const light = page.locator(`.attempt-card__lights .light--${state}`);
      // VD16 and CO15: the drawn shape, the light's SVG, is 28 across on a full attempt card.
      // LY5: the light itself is the tap target, at least 44x44 around that shape (D40).
      await expect(light.locator("svg")).toHaveCSS("width", "28px");
      await expect(light.locator("svg")).toHaveCSS("height", "28px");
      const target = await light.boundingBox();
      expect(target!.width).toBeGreaterThanOrEqual(44);
      expect(target!.height).toBeGreaterThanOrEqual(44);
      const pixels = await light.locator("svg").evaluate(async (svg) => {
        const copy = svg.cloneNode(true) as SVGElement;
        copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        copy.setAttribute("width", "28");
        copy.setAttribute("height", "28");
        copy.style.color = "black";
        const image = new Image();
        image.src = `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = 7;
        canvas.height = 7;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(image, 0, 0, 7, 7);
        return Array.from(ctx.getImageData(0, 0, 7, 7).data).filter((_, i) => i % 4 === 3);
      });
      masks.push(pixels);
      // Keep an actual quarter-size rendered screenshot for the visual comparison.
      await light.evaluate((el) => {
        el.style.width = "7px";
        el.style.height = "7px";
        const svg = el.querySelector("svg")!;
        svg.style.width = "7px";
        svg.style.height = "7px";
      });
      await info.attach(`${state}-7px`, { body: await light.screenshot(), contentType: "image/png" });
    }
    for (let i = 0; i < masks.length; i++) for (let j = 0; j < i; j++) expect(masks[i]).not.toEqual(masks[j]);
    expect(masks[0]![24]).toBe(255); // filled circle centre
    expect(masks[3]![24]).toBe(0); // hollow circle centre
    expect(masks[4]![23]).toBe(0); // half-circle empty left
    expect(masks[4]![25]).toBe(255); // half-circle filled right
  });
}
