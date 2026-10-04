// src/worker/agent/scripted-driver.test.ts — the canned agent's state
// machine against SW6's default answers and the crash-recovery path. The
// driver decides tool calls only; the Agent Durable Object owns journalling,
// ordering and the submit's acknowledge field.

import { describe, expect, it } from "vitest";
import type { HeadsUpForModel } from "../../protocol/tools.ts";
import { ScriptedDriver, type Script, type ScriptState } from "./scripted-driver.ts";

const script: Script = {
  pattern: "add-plain",
  truth: ["entity:world/movement.js#bounce"],
  steps: [
    { tool: "list", args: { path: "creatures/" } },
    { tool: "write", args: { path: "creatures/s0000.js", content: "// x" } },
    { tool: "submit", args: { summary: "add a creature" } },
  ],
};

async function step(d: ScriptedDriver, last: Parameters<ScriptedDriver["next"]>[0]["last"], state: unknown) {
  return d.next({ last, state });
}

function headsUp(partial: Partial<HeadsUpForModel> & { hn: number }): HeadsUpForModel {
  return {
    action: "none",
    because: "",
    changed_by: null,
    items: [],
    dropped_edits: [],
    ...partial,
  };
}

describe("ScriptedDriver", () => {
  it("emits the script's steps in order, then waits", async () => {
    const d = new ScriptedDriver(script);
    const s1 = await step(d, null, null);
    expect(s1).toMatchObject({ kind: "tool", tool: "list", args: { path: "creatures/" } });
    const s2 = await step(d, { result: { path: "creatures/", entries: [] } }, (s1 as { state: unknown }).state);
    expect(s2).toMatchObject({ kind: "tool", tool: "write" });
    const s3 = await step(d, { result: { path: "creatures/s0000.js", op_seq: 1 } }, (s2 as { state: unknown }).state);
    expect(s3).toMatchObject({ kind: "tool", tool: "submit" });
    const s4 = await step(d, { result: { status: "validated" } }, (s3 as { state: unknown }).state);
    expect(s4).toMatchObject({ kind: "wait" });
  });

  it("re-emits the saved step when a restart lost the call (last null, state kept)", async () => {
    const d = new ScriptedDriver(script);
    const s1 = await step(d, null, null);
    // The Agent saved the driver's state but crashed before journalling the
    // call: on restart the driver is asked again with no `last`, and the
    // same step must come back out.
    const again = await step(d, null, (s1 as { state: unknown }).state);
    expect(again).toMatchObject({ kind: "tool", tool: "list", args: { path: "creatures/" } });
  });

  it("SW6 confirm: sets the pattern's statement for the next submit", async () => {
    const d = new ScriptedDriver(script);
    const s1 = await step(d, null, null);
    const s2 = await step(
      d,
      { result: { path: "creatures/", entries: [] }, heads_ups: [headsUp({ hn: 1, action: "confirm" })] },
      (s1 as { state: unknown }).state,
    );
    expect(s2).toMatchObject({ kind: "tool", tool: "write" });
    const s3 = await step(d, { result: { path: "creatures/s0000.js", op_seq: 1 } }, (s2 as { state: unknown }).state);
    expect(s3).toMatchObject({
      kind: "tool",
      tool: "submit",
      args: { summary: "add a creature", statement: "not affected" },
    });
  });

  it("SW6 repair on a truth premise: re-reads it and re-submits after go_around", async () => {
    const d = new ScriptedDriver({ ...script, repair: { reread: true, statement: "movement is unchanged" } });
    const s1 = await step(d, null, null);
    const s2 = await step(d, { result: { path: "creatures/", entries: [] } }, (s1 as { state: unknown }).state);
    const s3 = await step(d, { result: { path: "creatures/s0000.js", op_seq: 1 } }, (s2 as { state: unknown }).state);
    expect(s3).toMatchObject({ kind: "tool", tool: "submit" });
    // The submit goes around on a repair heads-up that names a truth premise.
    const s4 = await step(
      d,
      {
        result: { status: "go_around", unresolved: [1] },
        heads_ups: [
          headsUp({
            hn: 1,
            action: "repair",
            items: [{ what: "entity:world/movement.js#bounce", before: "a", after: "b", your_lines: [] }],
          }),
        ],
      },
      (s3 as { state: unknown }).state,
    );
    // The repair rule re-reads the premise first.
    expect(s4).toMatchObject({ kind: "tool", tool: "read", args: { path: "world/movement.js", entity: "bounce" } });
    const s5 = await step(
      d,
      { result: { key: "world/movement.js#bounce", source: "// x" } },
      (s4 as { state: unknown }).state,
    );
    // Then the submit is re-issued with the repair statement.
    expect(s5).toMatchObject({
      kind: "tool",
      tool: "submit",
      args: { summary: "add a creature", statement: "movement is unchanged" },
    });
  });

  it("SW6 dropped edit: applies its own edit again on the current source", async () => {
    const d = new ScriptedDriver(script);
    const s1 = await step(d, null, null);
    const s2 = await step(d, { result: { path: "creatures/", entries: [] } }, (s1 as { state: unknown }).state);
    const s3 = await step(d, { result: { path: "creatures/s0000.js", op_seq: 1 } }, (s2 as { state: unknown }).state);
    const s4 = await step(
      d,
      {
        heads_ups: [headsUp({ hn: 1, action: "repair", dropped_edits: [{ path: "creatures/s0000.js", why: "OP1" }] })],
      },
      (s3 as { state: unknown }).state,
    );
    expect(s4).toMatchObject({ kind: "tool", tool: "write", args: { path: "creatures/s0000.js", content: "// x" } });
  });

  it("SW6: limit_reached, no_match or ambiguous ends the attempt withdrawn", async () => {
    for (const code of ["limit_reached", "no_match", "ambiguous"] as const) {
      const d = new ScriptedDriver(script);
      const s1 = await step(d, null, null);
      const s2 = await step(d, { error: { code, message: code } }, (s1 as { state: unknown }).state);
      expect(s2, code).toMatchObject({ kind: "stop", reason: "withdrawn" });
    }
  });

  it("heads_up_first re-issues the blocked call", async () => {
    const d = new ScriptedDriver(script);
    const s1 = await step(d, null, null);
    const s2 = await step(d, { result: { path: "creatures/", entries: [] } }, (s1 as { state: unknown }).state);
    expect(s2).toMatchObject({ kind: "tool", tool: "write" });
    const s3 = await step(d, { error: { code: "heads_up_first", message: "x" } }, (s2 as { state: unknown }).state);
    expect(s3).toMatchObject({ kind: "tool", tool: "write" });
  });

  it("SW7: a script with give_up_after withdraws at that repair", async () => {
    const d = new ScriptedDriver({ ...script, repair: { give_up_after: 1 } });
    const s1 = await step(d, null, null);
    const s2 = await step(d, { heads_ups: [headsUp({ hn: 1, action: "repair" })] }, (s1 as { state: unknown }).state);
    expect(s2).toMatchObject({ kind: "stop", reason: "withdrawn" });
  });

  it("state serializes through JSON (it lives in the meta table)", async () => {
    const d = new ScriptedDriver(script);
    const s1 = await step(d, null, null);
    const state = JSON.parse(JSON.stringify((s1 as { state: unknown }).state)) as ScriptState;
    expect(state.queue).toHaveLength(2);
    const s2 = await step(d, null, state);
    expect(s2).toMatchObject({ kind: "tool", tool: "list" });
  });
});
