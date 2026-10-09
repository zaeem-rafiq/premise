import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";
import type { FloorJson } from "../../../protocol/floor-json.ts";
import { emptyFloorState } from "../../../protocol/reducer/state.ts";
import { makeShell, ShellContext } from "../../app/context.ts";
import { AboutSheet } from "./about.tsx";

const settings = {
  features: { green: "none", clef: false, attempt_repos: false },
  models: {},
  limits: [],
  related: "",
} as unknown as FloorJson;
function about(samples: number[]) {
  const floor = emptyFloorState();
  floor.repair_ms = samples;
  return renderToString(
    createElement(
      ShellContext.Provider,
      { value: makeShell(settings, false, false) },
      createElement(AboutSheet, { floor, shortcuts: true, onShortcuts: () => {}, onClose: () => {} }),
    ),
  );
}
it("D30 3.19 1.4 5.12: About has repair time, forks-off, seven boxes and Close", () => {
  const html = about([3000, 1000, 2000, 9000]);
  expect(html).toContain("Repair time with real agents: median 2 s, p90 9 s.");
  expect(html).toContain("Attempt repositories are not provisioned in this build.");
  expect((html.match(/class="about-box"/g) ?? []).length).toBe(7);
  expect(html).toContain(">Close</button>");
  expect(html).not.toContain(">Cancel</button>");
});
it("D30 3.19: absent real-agent repair samples show dashes", () => {
  expect(about([])).toContain("Repair time with real agents: median –, p90 –.");
});
