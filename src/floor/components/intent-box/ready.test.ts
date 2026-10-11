// The intent box sends nothing until the stream has named the pool (found on production
// 2026-10-11: a press in the first second posted to `/api/pools//intents` and answered 404).
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";
import { emptyFloorState } from "../../../protocol/reducer/state.ts";
import type { FloorJson } from "../../../protocol/floor-json.ts";
import { makeShell, ShellContext } from "../../app/context.ts";
import { IntentBox } from "./intent-box.tsx";

const settings = {
  features: { race: true },
  prewritten: [{ id: "A01", text: "a jellyfish that drifts up and down", group: "starter", race: false }],
  models: {},
} as unknown as FloorJson;

function html(poolId: string): string {
  const floor = emptyFloorState();
  floor.pool.id = poolId;
  return renderToString(
    createElement(
      ShellContext.Provider,
      { value: makeShell(settings, true, false) },
      createElement(IntentBox, { floor, mode: "live", owner: true, capReached: false }),
    ),
  );
}

it("before the stream names the pool, the starter set and the pre-written menu are disabled", () => {
  const before = html("");
  expect(before).toMatch(
    /<button[^>]*disabled=""[^>]*class="intent-starter"|<button[^>]*class="intent-starter"[^>]*disabled=""/,
  );
  expect(before).toMatch(/<select[^>]*disabled=""/);
});

it("once the pool is named they are enabled", () => {
  const after = html("tidepool");
  expect(after).not.toMatch(/<button[^>]*class="intent-starter"[^>]*disabled=""/);
  expect(after).not.toMatch(/<button[^>]*disabled=""[^>]*class="intent-starter"/);
});
