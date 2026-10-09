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
