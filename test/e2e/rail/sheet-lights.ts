import { expect, type Locator } from "@playwright/test";
import { ev, type Frame } from "../shell/stream.ts";

/** Thirty holds, with optional changed premises recorded last to exercise CO14's ordering. */
export function densePremises(start: number, attemptId: string, changed = 0): Frame[] {
  let n = start;
  const frames: Frame[] = [];
  for (let index = 0; index < 30 + changed; index += 1) {
    const key = `facts/${index}.js`;
    frames.push(
      ev(n++, {
        type: "premise.recorded",
        attempt_id: attemptId,
        tool: "read",
        premise: { kind: "file", key, hash: "h0", seq: 0, read: true, edit: false, derived: false },
      }),
    );
    if (index >= 30) {
      frames.push(
        ev(n++, {
          type: "premise.judged",
          attempt_id: attemptId,
          kind: "file",
          key,
          old_hash: "h0",
          new_hash: "h1",
          cause: "landed 1",
          cause_seq: 1,
          rule: "R1",
          class: "rule",
          result: "repair",
          reason: "",
          clef: { model: null, p: null, error: null },
        }),
      );
    }
  }
  return frames;
}

/** Inspect rendered boxes, including each light, so clipping cannot make containment pass. */
export async function expectLightsInsideColumn(column: Locator, more: number, changed = 0): Promise<void> {
  const lights = column.locator(".card-sheet__lights");
  await expect(lights).toBeVisible();
  // LIGHTS_MAX = 14 in 01-core constants; the expectations are the CO14 count, not page output.
  await expect(lights.locator(".light")).toHaveCount(14);
  await expect(lights.locator(".card-sheet__more:last-child")).toHaveText(`+${more}`);
  await expect(lights.locator(".card-sheet__more")).toBeVisible();
  await expect(lights.locator(".light--changed")).toHaveCount(changed);
  for (let index = 0; index < changed; index += 1) {
    const light = lights.getByRole("img", { name: `the file facts/${30 + index}.js: Changed. the agent read it.` });
    await expect(light).toBeVisible();
    await expect(lights.locator(".light").nth(index)).toHaveAttribute(
      "aria-label",
      `the file facts/${30 + index}.js: Changed. the agent read it.`,
    );
    await light.focus();
    await expect(light).toBeFocused();
    await expect(light).toHaveAttribute("title", `the file facts/${30 + index}.js: Changed. the agent read it.`);
  }
  const layout = await column.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const row = element.querySelector<HTMLElement>(".card-sheet__lights")!;
    const bounds = row.getBoundingClientRect();
    const label = row.querySelector(".card-sheet__relies")!;
    const range = document.createRange();
    range.selectNodeContents(label);
    const children = [...row.children].map((child) => child.getBoundingClientRect());
    return {
      rowInside: bounds.left >= box.left && bounds.right <= box.right,
      childrenInside: children.every((child) => child.left >= bounds.left && child.right <= bounds.right),
      labelLines: range.getClientRects().length,
      lightRows: new Set([...row.querySelectorAll(".light")].map((light) => light.getBoundingClientRect().top)).size,
      // The drawn shape (the SVG), as review-lights.spec.ts measures it for VD16 and CO15…
      lightWidths: [...row.querySelectorAll(".light svg")].map((svg) => svg.getBoundingClientRect().width),
      // …and the tap target around it (the light itself), at least 44x44 by LY5.
      lightTargets: [...row.querySelectorAll(".light")].map((light) => {
        const target = light.getBoundingClientRect();
        return Math.min(target.width, target.height);
      }),
    };
  });
  expect(layout.rowInside).toBe(true);
  expect(layout.childrenInside).toBe(true);
  expect(layout.labelLines).toBe(1);
  expect(layout.lightRows).toBeGreaterThan(1);
  expect(layout.lightWidths).toEqual(Array<number>(14).fill(28));
  for (const side of layout.lightTargets) expect(side).toBeGreaterThanOrEqual(44);
}

export async function expectNoSheetOverflow(sheet: Locator): Promise<void> {
  const overflowing = await sheet.evaluate((element) =>
    [element, ...element.querySelectorAll("*")]
      .filter((node): node is HTMLElement => node instanceof HTMLElement && node.scrollWidth > node.clientWidth)
      .map((node) => ({
        tag: node.tagName,
        class: node.className,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
      })),
  );
  expect(overflowing).toEqual([]);
}
