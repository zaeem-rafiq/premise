// The effects seam (04-build-plan 3.2): one handler per effect kind the engine emits. An effect is
// work that runs after the transaction commits: events to the Floor, the push, the heads-up push,
// triage, the plain-merge replay, previews, the green line. The trunk lane wires `wiring/trunk.ts`,
// the git lane `wiring/git.ts`.

import type { Env } from "../env.ts";
import { wire as wireTrunk } from "./wiring/trunk.ts";
import { wire as wireGit } from "./wiring/git.ts";

export type EffectInput = {
  /** The effect kind, one of `EngineTable.effects`. */
  kind: string;
  /** What the engine left for the handler; each kind documents its payload. */
  payload: unknown;
  env: Env;
  ctx: DurableObjectState;
};

export type EffectHandler = (input: EffectInput) => void | Promise<void>;

export type EffectTable = { handlers: Map<string, EffectHandler> };

export function effectTable(): EffectTable {
  const table: EffectTable = { handlers: new Map() };
  wireTrunk(table);
  wireGit(table);
  return table;
}
