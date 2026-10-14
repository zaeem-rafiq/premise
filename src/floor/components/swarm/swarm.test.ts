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

function ownerHtml(swarm: ReturnType<typeof emptyFloorState>["swarm"], ts = 5_000, watched = false): string {
  const floor = emptyFloorState();
  floor.ts = ts;
  floor.swarm = swarm;
  if (watched)
    floor.metrics_active = {
      window_ms: 10_000,
      landings_per_second: 1,
      time_to_land_ms: { p50: 1_000, p99: 2_000 },
      go_around_rate: 0,
      waiting_behind: 0,
      push_backlog: 0,
      false_abort_rate: null,
      escape_rate: 0,
    } as never;
  return renderToString(
    createElement(
      ShellContext.Provider,
      { value: makeShell(settings, true, false) },
      createElement(SwarmView, { floor, owner: true, pool: "swarm", clock: ts }),
    ),
  );
}

// 3.15 "ended": `swarm.final` names the time of day of the last numbers (5.4). Found on `test`,
// 2026-10-11: the view threw "no value for placeholder {time of day}" after a run stopped.
it("3.15 ended: a stopped run says when its last numbers were measured", () => {
  const ts = new Date(2026, 9, 11, 4, 5, 6).getTime();
  const html = ownerHtml({ running: false, agents: 64, collision_dial: 0, pools: ["swarm"], ever_ran: true }, ts, true);
  expect(html).toContain("The run has ended. These are its last measured numbers, at 04:05:06.");
});

// 3.15 "empty": a swarm.state that never ran is not a Swarm run. A canned cast started through
// /api/swarm on another pool leaves one (agents 1, running false, ever_ran false; found on
// `production`, 2026-10-11), and PS7 needs `swarm.empty` before the take.
it("3.15 empty: a swarm.state that never ran shows swarm.empty and the default controls", () => {
  const html = ownerHtml({ running: false, agents: 1, collision_dial: 0, pools: ["a", "b", "swarm"], ever_ran: false });
  expect(html).toContain("No Swarm run yet. A run uses scripted agents and makes no model calls.");
  expect(html).not.toContain("This run:");
  expect(html).toMatch(/checked="" value="64"/);
  expect(html).not.toContain("swarm-agent-count");
});

// CO44b: the shape line names the run's one pool, not every pool the state was delivered to.
it("CO44b: a run on the Swarm pool reads as one pool and one Trunk", () => {
  const html = ownerHtml({
    running: true,
    agents: 1024,
    collision_dial: 0,
    pools: ["a", "b", "swarm"],
    ever_ran: true,
  });
  expect(html).toContain("This run: 1 pool, 1 Trunk, 1,024 scripted agents.");
});

// CO42b: after the run, the numbers are the last window that measured it, not the empty ones after.
it("CO42b: an ended run shows the last window that held landings", () => {
  const floor = emptyFloorState();
  floor.ts = 9_000;
  floor.swarm = { running: false, agents: 256, collision_dial: 0.25, pools: ["swarm"], ever_ran: true };
  const window = {
    window_ms: 10_000,
    time_to_land_ms: { p50: 1_500, p99: 4_000 },
    go_around_rate: 0.04,
    waiting_behind: 2,
    push_backlog: 0,
    false_abort_rate: null,
    escape_rate: 0,
  };
  floor.metrics_active = { ...window, landings_per_second: 1.6 } as never;
  floor.metrics = {
    ...window,
    landings_per_second: 0,
    time_to_land_ms: { p50: null, p99: null },
    go_around_rate: null,
  } as never;
  const html = renderToString(
    createElement(
      ShellContext.Provider,
      { value: makeShell(settings, false, false) },
      createElement(SwarmView, { floor, owner: false, pool: "swarm", clock: 9_000 }),
    ),
  );
  expect(html).toContain("1.60");
  expect(html).toContain("4%");
});

// CO42c: a run nobody watched has no measured window; the view points at the recorded run.
it("CO42c: an ended, unwatched run links the Swarm recording instead of empty numbers", () => {
  const floor = emptyFloorState();
  floor.swarm = { running: false, agents: 256, collision_dial: 0.25, pools: ["swarm"], ever_ran: true };
  const html = renderToString(
    createElement(
      ShellContext.Provider,
      { value: makeShell(settings, false, false) },
      createElement(SwarmView, { floor, owner: false, pool: "swarm" }),
    ),
  );
  expect(html).toContain("Its numbers are measured while a page watches it, and this run had none.");
  expect(html).toContain('href="/replay/swarm"');
  expect(html).not.toContain("These are its last measured numbers");
});
