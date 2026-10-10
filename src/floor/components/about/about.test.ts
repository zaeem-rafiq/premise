import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";
import type { PoolEvent } from "../../../protocol/events.ts";
import type { FloorJson } from "../../../protocol/floor-json.ts";
import { reduce } from "../../../protocol/reducer/reduce.ts";
import { emptyFloorState } from "../../../protocol/reducer/state.ts";
import { makeShell, ShellContext } from "../../app/context.ts";
import { AboutSheet } from "./about.tsx";

const settings = {
  features: { green: "none", clef: false, attempt_repos: false },
  models: {},
  limits: [],
  related: "",
} as unknown as FloorJson;
function about(samples: number[], attemptRepos = false, events: PoolEvent[] = []) {
  const floor = emptyFloorState();
  floor.repair_ms = samples;
  for (const event of events) reduce(floor, event);
  return renderToString(
    createElement(
      ShellContext.Provider,
      {
        value: makeShell(
          { ...settings, features: { ...settings.features, attempt_repos: attemptRepos } },
          false,
          false,
        ),
      },
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

function repoEvent(n: number, ts: number, ok: boolean): PoolEvent {
  return {
    n,
    t: ts,
    ts,
    pool: "tidepool",
    src: "agent",
    type: "attempt.repo",
    attempt_id: `a_${n}`,
    ok,
    ms: 100,
    error: ok ? null : "timeout",
  };
}

it("N12 3.19 5.12: enabled attempt repositories show unknown before the first result", () => {
  const html = about([], true);
  expect(html).toContain("Attempt repositories: not reported by this build.");
  expect(html).toContain("one repository per attempt for its conversation");
  expect(html).not.toContain("Attempt repositories are not provisioned in this build.");
});

it("N12 14.8 3.19: About reports success throughput and the failure share from attempt.repo events", () => {
  const html = about([], true, [repoEvent(1, 1_000, true), repoEvent(2, 2_000, true), repoEvent(3, 5_000, false)]);
  expect(html).toContain("Attempt repositories: 0.50 per second, 33% failed. No landing waits for one.");
  expect(html).not.toContain("Attempt repositories: not reported by this build.");
});

it("N12 14.8 3.19: a first failed provisioning result is reported without inventing a throughput window", () => {
  const html = about([], true, [repoEvent(1, 1_000, false)]);
  expect(html).toContain("Attempt repositories: – per second, 100% failed. No landing waits for one.");
});

it("N12 1.4 5.12: the disabled switch keeps repositories out of About even with recorded results", () => {
  const html = about([], false, [repoEvent(1, 1_000, true), repoEvent(2, 2_000, false)]);
  expect(html).toContain("Attempt repositories are not provisioned in this build.");
  expect(html).not.toContain("No landing waits for one.");
  expect(html).not.toContain("one repository per attempt for its conversation");
});
