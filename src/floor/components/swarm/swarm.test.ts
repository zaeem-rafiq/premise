import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";
import { emptyFloorState } from "../../../protocol/reducer/state.ts";
import type { FloorJson } from "../../../protocol/floor-json.ts";
import { makeShell, ShellContext } from "../../app/context.ts";
import { SwarmView } from "./swarm.tsx";
const settings = { features: { green: "none" }, swarm_defaults: {}, models: {} } as FloorJson;
it("D31 CO42a 3.15: missing rates keep their labels, chart and main-pool limit", () => {
  const floor = emptyFloorState();
  floor.swarm = { running: true, agents: 64, collision_dial: 0.4, pools: ["swarm"], ever_ran: true };
  const html = renderToString(
    createElement(
      ShellContext.Provider,
      { value: makeShell(settings, false, false) },
      createElement(SwarmView, {
        floor,
        owner: false,
        pool: "swarm",
        mainPool: { ...floor.pool, max_real_agents: 12 },
      }),
    ),
  );
  expect(html).toContain("Escape rate –");
  expect(html).toContain("False-abort rate –");
  expect(html).toContain("Last push: –");
  expect(html).toContain("Real agents in the main pool: 12 at most. The limit is the model rate.");
  expect(html).toContain("swarm-chart");
});

// CP5: a string with a count has a form for 1. The expected sentences are the 5.4 table's
// forms "for 1" (and its plural with the thousands comma of 5.2).
function swarmHtml(agents: number, extra: { maxReal?: number; pushed?: number } = {}): string {
  const floor = emptyFloorState();
  floor.ts = 5_000;
  floor.swarm = { running: true, agents, collision_dial: 0, pools: ["swarm"], ever_ran: true };
  if (extra.pushed !== undefined) floor.last_push = { batch_id: 1, landings: extra.pushed, tries: 1, ms: 10 };
  return renderToString(
    createElement(
      ShellContext.Provider,
      { value: makeShell(settings, false, false) },
      createElement(SwarmView, {
        floor,
        owner: false,
        pool: "swarm",
        clock: 5_000,
        waitingSince: 5_000,
        mainPool: { ...floor.pool, max_real_agents: extra.maxReal ?? 12 },
      }),
    ),
  );
}

it("CP5 5.4: one scripted agent, one real agent and one pushed change read in the singular", () => {
  const html = swarmHtml(1, { maxReal: 1, pushed: 1 });
  expect(html).toContain("This run: 1 pool, 1 Trunk, 1 scripted agent.");
  expect(html).toContain("Starting 1 scripted agent…");
  expect(html).toContain("Real agent in the main pool: 1 at most. The limit is the model rate.");
  expect(html).toContain("Last push: 1 push, 1 change");
});

it("CP5 5.2: other counts keep the plural and the thousands comma", () => {
  const html = swarmHtml(1024, { pushed: 37 });
  expect(html).toContain("This run: 1 pool, 1 Trunk, 1,024 scripted agents.");
  expect(html).toContain("Starting 1,024 scripted agents…");
  expect(html).toContain("Real agents in the main pool: 12 at most. The limit is the model rate.");
  expect(html).toContain("Last push: 1 push, 37 changes");
});
