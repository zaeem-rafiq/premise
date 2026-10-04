// test/cases/usage-note.test.ts — TA10/NT: `ToolRequest.usage` reaches `Note.attempt`.
// A real Agent attaches its running totals to every tool call; the engine keeps the last one
// sent and freezes it into the note at landing. A synthetic attempt sends none and its note
// keeps zeros. `steps` stays the engine's own fresh-tool-call count — not the Agent's
// event-step number (the note counts tool calls only, TL1).
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Trunk } from "../../src/core/trunk/registry.ts";
import type { ToolRequest } from "../../src/protocol/tools.ts";
import type { Note } from "../../src/protocol/note.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sqlOver, type Pools } from "./driver.ts";
import { CASES_FILE } from "./load.ts";
import { REPO_ROOT } from "../support/source.ts";
import { ScriptedTriage } from "../../src/swarm/scripted-triage.ts";

const pools = (JSON.parse(readFileSync(join(REPO_ROOT, CASES_FILE), "utf8")) as { pools: Pools }).pools;
const tidepool = pools.tidepool;

function setup(): Trunk {
  const db = new DatabaseSync(":memory:");
  if (tidepool === undefined) throw new Error("tidepool pool missing from the case file");
  const trunk = Trunk.create(sqlOver(db), tidepool.files, {
    syncTriage: ScriptedTriage,
    features: { held: true },
  });
  trunk.pushOk();
  return trunk;
}

function landNote(trunk: Trunk): Note {
  trunk.tick();
  trunk.pushOk();
  expect(trunk.pool.landings).toHaveLength(1);
  return JSON.parse((trunk.pool.landings[0] as { note: string }).note) as Note;
}

describe("TA10 usage in the note", () => {
  it("a real attempt's last sent usage is frozen into Note.attempt", () => {
    const trunk = setup();
    trunk.openAttempt("A", { intent: "a crab", agent_kind: "real", model: "model-a" });
    let n = 0;
    const req = (
      tool: ToolRequest["tool"],
      args: Record<string, unknown>,
      usage: { model_calls: number; tokens_in: number; tokens_out: number },
    ): ToolRequest => ({ attempt_id: "A", call_id: `A:${++n}`, ack: 0, tool, args, usage });
    // Three calls, three readings: the note keeps the last (running totals, TA10).
    expect(trunk.tool(req("list", { path: "creatures/" }, { model_calls: 2, tokens_in: 300, tokens_out: 60 })).ok).toBe(
      true,
    );
    expect(
      trunk.tool(
        req(
          "write",
          { path: "creatures/crab.js", content: "// crab\n", premises: ["file:creatures/crab.js absent edit"] },
          { model_calls: 5, tokens_in: 700, tokens_out: 140 },
        ),
      ).ok,
    ).toBe(true);
    expect(
      trunk.tool(req("submit", { summary: "a crab" }, { model_calls: 6, tokens_in: 900, tokens_out: 180 })).ok,
    ).toBe(true);
    const note = landNote(trunk);
    expect(note.attempt).toMatchObject({
      id: "A",
      model: "model-a",
      agent: "real",
      steps: 3,
      model_calls: 6,
      tokens_in: 900,
      tokens_out: 180,
    });
  });

  it("a synthetic attempt sends no usage and its note keeps zeros", () => {
    const trunk = setup();
    trunk.openAttempt("B", { intent: "an eel", agent_kind: "synthetic", truth: [] });
    let n = 0;
    const req = (tool: ToolRequest["tool"], args: Record<string, unknown>): ToolRequest => ({
      attempt_id: "B",
      call_id: `B:${++n}`,
      ack: 0,
      tool,
      args,
    });
    expect(
      trunk.tool(
        req("write", {
          path: "creatures/eel.js",
          content: "// eel\n",
          premises: ["file:creatures/eel.js absent edit"],
        }),
      ).ok,
    ).toBe(true);
    expect(trunk.tool(req("submit", { summary: "an eel" })).ok).toBe(true);
    const note = landNote(trunk);
    expect(note.attempt).toMatchObject({
      id: "B",
      agent: "synthetic",
      steps: 2,
      model_calls: 0,
      tokens_in: 0,
      tokens_out: 0,
    });
  });
});
