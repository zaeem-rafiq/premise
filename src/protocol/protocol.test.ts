// Acceptance item 3 (04-build-plan 2.1): the protocol module's sets are the ones the specification
// fixes — 35 event types of 12.1, 5 event sources, the 21 rows of 13.6 and the 6 of 02-tidepool 4.2,
// 17 error codes of 4.1, 10 attempt states of 9.1, 17 stop reasons (9 in AgentStopReason), 8 card
// options of CD4, and the 6 keys of Features (FJ1). Every expected set comes from the specification
// text itself, so the module and the specification cannot drift apart unseen.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../test/support/source.ts";
import { EVENT_SOURCES, EVENT_TYPES } from "./events.ts";
import { ERROR_CODES } from "./tools.ts";
import { AGENT_STOP_REASONS, ATTEMPT_STATES, STOP_REASONS, TRUNK_STOP_REASONS } from "./attempt.ts";
import { CARD_OPTIONS } from "./cards.ts";
import { FEATURE_KEYS } from "./floor-json.ts";
import { APP_ROUTES, ROUTES } from "./routes.ts";

const SPEC = "docs/spec";

function specText(file: string): string {
  return readFileSync(`${REPO_ROOT}/${SPEC}/${file}`, "utf8");
}

/** The quoted members of `type <name> = "a" | "b" | ...` inside a ```ts block. */
function unionMembers(text: string, typeName: string): string[] {
  const match = new RegExp(`type ${typeName}\\s*=\\s*([\\s\\S]*?);`).exec(text);
  if (match === null) throw new Error(`type ${typeName} not found`);
  return [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
}

/** The `type: "<name>"` members of the `PoolEvent` union of 01-core 12.1. */
function specEventTypes(text: string): string[] {
  const start = text.indexOf("type PoolEvent = ");
  if (start < 0) throw new Error("type PoolEvent not found");
  const end = text.indexOf("```", start);
  const body = text.slice(start, end < 0 ? undefined : end);
  return [...body.matchAll(/type: "([^"]+)"/g)].map((m) => m[1] ?? "");
}

/** The data rows of the table whose header line is `marker` (the `---` row excluded). */
function specTableRowCount(text: string, marker: string): number {
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`table marker "${marker}" not found`);
  const lines = text
    .slice(start + marker.length)
    .split("\n")
    .slice(1);
  const rows: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("|")) break;
    rows.push(line);
  }
  return rows.filter((line) => !/^\|[\s\-|]+\|?$/.test(line)).length;
}

/** Backticked words of a sentence of 9.1: the two lists of stop reasons. */
function backtickedBetween(text: string, from: string, to: string): string[] {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`stop-reason span not found: "${from}" .. "${to}"`);
  return [...text.slice(start, end).matchAll(/`([^`]+)`/g)]
    .map((m) => m[1] ?? "")
    .filter((word) => /^[a-z_]+$/.test(word));
}

const core = specText("01-core.md");
const tidepool = specText("02-tidepool.md");

describe("the protocol module's fixed sets (plan 2.1, acceptance item 3)", () => {
  it("EVENT_TYPES holds the 35 event types of 01-core 12.1, in the union's order", () => {
    const spec = specEventTypes(core);
    expect(spec).toHaveLength(35);
    expect([...EVENT_TYPES]).toEqual(spec);
  });

  it("EVENT_SOURCES holds the 5 values of EventBase.src (EV2a)", () => {
    const base = /type EventBase = \{([\s\S]*?)\}/.exec(core);
    const srcs = unionMembers(`type X = ${base?.[1]?.match(/src: ([^;]+)/)?.[1] ?? ""};`, "X");
    expect(srcs).toHaveLength(5);
    expect([...EVENT_SOURCES]).toEqual(srcs);
  });

  it("ROUTES has the 21 rows of 01-core 13.6", () => {
    const count = specTableRowCount(core, "| Purpose | Method and path | Who | Answered by |");
    expect(count).toBe(21);
    expect(ROUTES).toHaveLength(21);
  });

  it("APP_ROUTES has the 6 rows of 02-tidepool 4.2", () => {
    const count = specTableRowCount(tidepool, "| Route | Response | `Cache-Control` |");
    expect(count).toBe(6);
    expect(APP_ROUTES).toHaveLength(6);
  });

  it("ERROR_CODES holds the 17 codes of 01-core 4.1", () => {
    const spec = unionMembers(core, "ErrorCode");
    expect(spec).toHaveLength(17);
    expect([...ERROR_CODES]).toEqual(spec);
  });

  it("ATTEMPT_STATES holds the 10 states of 01-core 9.1", () => {
    const spec = unionMembers(core, "AttemptState");
    expect(spec).toHaveLength(10);
    expect([...ATTEMPT_STATES]).toEqual(spec);
  });

  it("STOP_REASONS holds the 17 stop reasons of 9.1, 8 Trunk and 9 Agent", () => {
    const trunk = backtickedBetween(core, "Set by Trunk only:", "Reported by the Agent");
    const agent = backtickedBetween(core, "TA9):", "(the agent ended its own attempt");
    expect(trunk).toHaveLength(8);
    expect(agent).toHaveLength(9);
    expect([...TRUNK_STOP_REASONS]).toEqual(trunk);
    expect([...AGENT_STOP_REASONS]).toEqual(agent);
    expect(STOP_REASONS).toHaveLength(17);
    expect([...STOP_REASONS].sort()).toEqual([...trunk, ...agent].sort());
  });

  it("CARD_OPTIONS holds the 8 option ids of CD4", () => {
    const spec = unionMembers(core, "CardOption");
    expect(spec).toHaveLength(8);
    expect([...CARD_OPTIONS]).toEqual(spec);
  });

  it("FEATURE_KEYS holds the 6 keys of Features (FJ1)", () => {
    const block = /type Features = \{([\s\S]*?)\};/.exec(core);
    if (block === null) throw new Error("type Features not found");
    const keys = [...(block[1] ?? "").matchAll(/^\s*(\w+):/gm)].map((m) => m[1] ?? "");
    expect(keys).toHaveLength(6);
    expect([...FEATURE_KEYS]).toEqual(keys);
  });
});
