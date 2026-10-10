// The contract between the MCP route and an outside attempt's Agent (docs/spec/07-mcp.md 4): the
// Agent's internal paths, what they answer, and the driver of an outside attempt — which never
// chooses a call itself, because the client does.

import type { Driver } from "../../protocol/ports.ts";
import type { ModelToolMessage } from "../../protocol/tools.ts";

/** The Agent's paths for an outside attempt. */
export const OUTSIDE_PATHS = {
  /** `{ tool, args }`: one of the seven tools (MC15). */
  call: "/outside/call",
  /** `{ wait }`: `premise_status` (MC19). */
  status: "/outside/status",
  /** No body: the kill switch is on (MC22); the Agent stops with `killed`. */
  kill: "/outside/kill",
} as const;

/** The `mcp-texts` keys the Agent may answer with instead of a message. */
export type OutsideTextKey = "busy" | "not_started";

/** What the Agent answers the route. `message` is a `ModelToolMessage` (MR1); `interrupted` is
 * MC18's answer, the earlier call's message; `text` names a text of `mcp-texts`. */
export type OutsideAnswer =
  | { kind: "message"; state: string; message: ModelToolMessage }
  | { kind: "interrupted"; state: string; message: ModelToolMessage }
  | { kind: "text"; state: string; key: OutsideTextKey };

/** MC17: the turn a call belongs to. `stop` is the TL8 reason that refuses the turn's later calls. */
export type OutsideTurn = { calls: number; stop: "earlier_failed" | "heads_up" | "after_submit" | null };

/** An outside attempt's driver: it always waits (an exempt wait of AG3 is not claimed here; MC21
 * decides silence). The pump keeps the bookkeeping of stops and syncs; the calls come from the client. */
export const OUTSIDE_DRIVER: Driver = {
  next: ({ state }) => Promise.resolve({ kind: "wait", state }),
};
