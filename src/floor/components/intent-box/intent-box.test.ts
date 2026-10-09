// Exercise the component's request/effect lifecycle without a DOM dependency. Effects use
// React's dependency comparison, so an in-place reducer update must invalidate the effect.
import { isValidElement, type ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { reduce } from "../../../protocol/reducer/reduce.ts";
import { emptyFloorState } from "../../../protocol/reducer/state.ts";
import { makeShell } from "../../app/context.ts";
import type { FloorJson } from "../../../protocol/floor-json.ts";
import { IntentBox } from "./intent-box.tsx";

const SETTINGS: FloorJson = {
  default_pool: "test",
  swarm_pool: "swarm",
  related: "",
  prewritten: [],
  models: {},
  limits: [],
  features: { race: true, held: true, undo: true, clef: false, green: "none", attempt_repos: false },
  swarm_defaults: { seed: 1, launch_per_second: 1, think_ms: [0, 0], rescale_every_s: 60 },
};

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  dirty: false,
  effects: [] as (() => void)[],
  shell: null as unknown,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useContext: () => hooks.shell,
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.slots)) hooks.slots[i] = initial;
    return [
      hooks.slots[i],
      (value: unknown) => {
        const next = typeof value === "function" ? value(hooks.slots[i]) : value;
        if (!Object.is(next, hooks.slots[i])) hooks.dirty = true;
        hooks.slots[i] = next;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.slots)) hooks.slots[i] = { current: initial };
    return hooks.slots[i];
  },
  useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
    const i = hooks.cursor++;
    const prev = hooks.slots[i] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (prev && deps.every((dep, n) => Object.is(dep, prev.deps[n]))) return;
    hooks.effects.push(() => {
      prev?.cleanup?.();
      hooks.slots[i] = { deps, cleanup: effect() };
    });
  },
}));

type Node = ReactElement<Record<string, unknown>>;
function find(node: unknown, type: string, label?: string): Node {
  if (isValidElement<Record<string, unknown>>(node)) {
    if (node.type === type && (label === undefined || node.props.children === label)) return node;
    for (const child of [node.props.children].flat(Infinity)) {
      try {
        return find(child, type, label);
      } catch {
        /* next child */
      }
    }
  }
  throw new Error(`Missing ${type} ${label ?? ""}`);
}

afterEach(() => {
  for (const slot of hooks.slots) (slot as { cleanup?: () => void } | undefined)?.cleanup?.();
  hooks.slots = [];
  hooks.effects = [];
  hooks.cursor = 0;
  vi.unstubAllGlobals();
});

it("D6 / CO8, FL10: intent.created after the create reply ends the wait immediately", async () => {
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  hooks.shell = makeShell(SETTINGS, true, false);
  const floor = emptyFloorState();
  floor.pool.state = "ready";
  const onSend = vi.fn(async () => ({ ok: true, intent_id: "i_new" }));
  let tree: unknown;
  function render() {
    do {
      hooks.cursor = 0;
      hooks.dirty = false;
      tree = IntentBox({ floor, mode: "live", owner: true, capReached: false, onSend });
      for (const effect of hooks.effects.splice(0)) effect();
    } while (hooks.dirty);
  }
  render();
  (find(tree, "textarea").props.onChange as Function)({ target: { value: "a crab" } });
  render();
  (find(tree, "button", "Send").props.onClick as Function)();
  await Promise.resolve();
  render();
  expect(onSend).toHaveBeenCalledOnce();
  expect(find(tree, "textarea").props.value).toBe("a crab");
  expect(find(tree, "textarea").props.readOnly).toBe(true);
  const intents = floor.intents;
  reduce(floor, {
    type: "intent.created",
    n: 1,
    ts: 1000,
    t: 1000,
    src: "trunk",
    pool: "test",
    intent_id: "i_new",
    text: "a crab",
    requester: "owner",
    race: false,
    prewritten: false,
  });
  expect(floor.intents).toBe(intents);
  render();
  expect(find(tree, "textarea").props.value).toBe("");
  expect(find(tree, "textarea").props.readOnly).toBe(false);
  expect(find(tree, "button", "Send")).toBeDefined();
});

it("D34 / FL5: the pre-written menu shows the request text without its internal id", () => {
  hooks.shell = makeShell(
    { ...SETTINGS, prewritten: [{ id: "A01", text: "a fish", group: "starter", race: false }] },
    true,
    false,
  );
  const tree = IntentBox({ floor: emptyFloorState(), mode: "live", owner: true, capReached: false });
  expect(find(tree, "option", "a fish").props.value).toBe("A01");
});
