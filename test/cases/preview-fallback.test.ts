// PV1a/RR1b: the lead selects the branch fallback after measuring a failed preview read.
// The configured prefix changes the pushed ref, never the card address or binding lookup.
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { Trunk } from "../../src/core/trunk/registry.ts";
import { frameUrl, versionToken } from "../../src/protocol/cards.ts";
import type { ToolRequest } from "../../src/protocol/tools.ts";
import { artifactsPoolSource } from "../../src/worker/adapters/pool-source/artifacts.ts";
import { sqlOver } from "./driver.ts";

vi.mock("../../src/protocol/constants.ts", async (original) => ({
  ...(await original<typeof import("../../src/protocol/constants.ts")>()),
  PREVIEW_REF_PREFIX: "refs/heads/previews/",
}));

it("PV1a: the configured branch fallback selects a preview ref and keeps reads addressed by commit id", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const trunk = Trunk.create(
      sqlOver(db),
      {
        ".premise/policy.json": '{"v":1,"default":"held"}',
        "world.js": "export const LIMIT = 100;\n",
      },
      { features: { held: true }, now: () => 1_000 },
    );
    trunk.pushOk();
    trunk.openAttempt("S", { intent: "Change the limit", agent_kind: "real" });
    let callId = 0;
    const call = (tool: ToolRequest["tool"], args: ToolRequest["args"]) => {
      const response = trunk.tool({ attempt_id: "S", call_id: `S:${++callId}`, tool, args, ack: 0 });
      expect(response.ok, JSON.stringify(response)).toBe(true);
      return response;
    };
    call("read", { path: "world.js" });
    call("replace", { path: "world.js", old: "100", new: "1" });
    expect(call("submit", { summary: "Change the limit" }).result).toMatchObject({ status: "held" });
    const card = trunk.pool.cards[0]!.body;
    const build = trunk.preview();
    expect(build.state).toBe("build");
    if (build.state !== "build") throw new Error("The held card must queue a preview");
    expect(build.errors).toEqual([]);
    expect(build.previews).toHaveLength(1);
    const pushed = build.previews[0]!;
    expect(pushed.ref).toBe(`refs/heads/previews/${card.submit_ids.S}`);
    expect(pushed.commit).toMatch(/^[0-9a-f]{40}$/);
    trunk.previewDone({ epoch: build.epoch, results: [{ submit_id: pushed.submit_id, commit: pushed.commit }] });
    expect(card.preview!.after.S).toEqual({ repo: "plain", commit: pushed.commit });
    expect(frameUrl("fallback", card.preview!.after.S!)).toBe(`/pool/fallback/p-${pushed.commit}/`);

    const calls: Array<{ repo: string; ref: string; path: string }> = [];
    const source = artifactsPoolSource({
      pools: {
        get: async (repo) => ({
          readFile: async ({ ref, path }) => {
            calls.push({ repo, ref, path });
            return new Blob(["export const LIMIT = 1;\n"]);
          },
          readCommit: async () => null,
          readTree: async () => null,
        }),
      },
      floorState: async () => {
        throw new Error("An immutable preview read must not resolve a moving source");
      },
    });
    const file = await source.read("fallback", versionToken(card.preview!.after.S!), "world.js");
    expect(calls).toEqual([{ repo: "fallback-plain", ref: pushed.commit, path: "world.js" }]);
    expect(new TextDecoder().decode(file!.bytes)).toBe("export const LIMIT = 1;\n");
  } finally {
    db.close();
  }
});
