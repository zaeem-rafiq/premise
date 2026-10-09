import { afterEach, expect, it, vi } from "vitest";
import { keysHeld } from "./keys.ts";
class ElementFixture {
  isContentEditable = false;
  readonly tagName: string;
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  closest(selector: string) {
    return selector.split(",").some((part) => part.trim() === this.tagName.toLowerCase()) ? this : null;
  }
}
afterEach(() => vi.unstubAllGlobals());
it("D29 AX13 FA4: buttons and links keep shortcuts, text fields hold them", () => {
  vi.stubGlobal("HTMLElement", ElementFixture);
  for (const tag of ["BUTTON", "A", "DIV"])
    expect(keysHeld(new ElementFixture(tag) as unknown as EventTarget)).toBe(false);
  for (const tag of ["INPUT", "TEXTAREA", "SELECT"])
    expect(keysHeld(new ElementFixture(tag) as unknown as EventTarget)).toBe(true);
  const editable = new ElementFixture("DIV");
  editable.isContentEditable = true;
  expect(keysHeld(editable as unknown as EventTarget)).toBe(true);
});
