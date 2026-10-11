// CK6c (01-core 4.9): with features.green "full" a submit uses the Worker's pre-landing self-test
// verdict for the very tree it validates. New failures reject it with `selftest_failed`; no
// verdict, or one for another tree, is "skipped" and the submit proceeds; green "static" adds no
// check. The verdict is what the Worker hands the engine (`Pool.selftest`); the isolate run itself
// is tested in test/workerd/landing/selftest-submit.test.ts.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Trunk } from "../../src/core/trunk/registry.ts";
import { selftestCandidate, type SelftestVerdict } from "../../src/core/trunk/selftest.ts";
import type { ToolRequest } from "../../src/protocol/tools.ts";
import { ScriptedTriage } from "../../src/swarm/scripted-triage.ts";
import { sqlOver } from "./driver.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture(green: "full" | "static", files: Record<string, string> = {}) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const trunk = Trunk.create(
    sqlOver(db),
    {
      ".premise/policy.json": '{"v":1,"default":"auto"}',
      "selftest/run.js": "export function runSelfTest() {}\n",
      "world/energy.js": "export const ENERGY_MAX = 100;\n",
      ...files,
    },
    { now: () => 1_000, syncTriage: ScriptedTriage, constants: { MAX_BATCH: 1 }, features: { green } },
  );
  trunk.pushOk();
  let n = 0;
  const request = (tool: ToolRequest["tool"], args: ToolRequest["args"]): ToolRequest => ({
    attempt_id: "a",
    call_id: `c-${++n}`,
    tool,
    args,
    ack: trunk.pool.attempts.get("a")!.heads.length,
  });
  trunk.openAttempt("a", { intent: "an eel" });
  const call = (tool: ToolRequest["tool"], args: ToolRequest["args"], selftest: SelftestVerdict | null = null) => {
    trunk.pool.selftest = selftest;
    return trunk.tool(request(tool, args));
  };
  return { trunk, call, request };
}

const EEL = "export const kind = 'eel';\n";
type Rejected = { status: string; errors: Array<{ code: string; detail: { failed: unknown } }> };
type Passed = { status: string; checks: Array<{ name: string; ok: boolean; detail?: string }> };

describe("CK6c selftest", () => {
  it("a verdict with new failures for this tree rejects with selftest_failed and its failed list", () => {
    const { trunk, call, request } = fixture("full");
    call("write", { path: "creatures/eel.js", content: EEL });
    const candidate = selftestCandidate(trunk.pool, request("submit", { summary: "an eel" }))!;
    expect(candidate.files.get("creatures/eel.js")).toBe(EEL);
    expect(candidate.headFiles.has("creatures/eel.js")).toBe(false);
    const failed = [{ name: "no_errors", code: "no_errors:failed", kind: "eel" }];
    const r = call("submit", { summary: "an eel" }, { key: candidate.key, failed }).result as Rejected;
    expect(r.status).toBe("rejected");
    expect(r.errors).toEqual([{ code: "selftest_failed", detail: { failed } }]);
    expect(trunk.pool.attempts.get("a")!.state).toBe("working");
  });

  it("a passing verdict for this tree adds the check selftest and validates", () => {
    const { trunk, call, request } = fixture("full");
    call("write", { path: "creatures/eel.js", content: EEL });
    const { key } = selftestCandidate(trunk.pool, request("submit", { summary: "an eel" }))!;
    const r = call("submit", { summary: "an eel" }, { key, failed: [] }).result as Passed;
    expect(r.status).toBe("validated");
    expect(r.checks).toContainEqual({ name: "selftest", ok: true });
  });

  it("fail open: no verdict, a verdict without answer, or one for another tree is skipped and validates", () => {
    for (const verdict of [null, "unanswered", "other"] as const) {
      const { trunk, call, request } = fixture("full");
      call("write", { path: "creatures/eel.js", content: EEL });
      const { key } = selftestCandidate(trunk.pool, request("submit", { summary: "an eel" }))!;
      const given: SelftestVerdict | null =
        verdict === null
          ? null
          : verdict === "unanswered"
            ? { key, failed: null }
            : { key: "another tree", failed: [{ name: "no_errors", code: "no_errors:failed" }] };
      const r = call("submit", { summary: "an eel" }, given).result as Passed;
      expect(r.status).toBe("validated");
      expect(r.checks).toContainEqual({ name: "selftest", ok: true, detail: "skipped" });
    }
  });

  it("green static: no candidate and no selftest check", () => {
    const { trunk, call, request } = fixture("static");
    call("write", { path: "creatures/eel.js", content: EEL });
    expect(selftestCandidate(trunk.pool, request("submit", { summary: "an eel" }))).toBeNull();
    const r = call("submit", { summary: "an eel" }).result as Passed;
    expect(r.status).toBe("validated");
    expect(r.checks.map((c) => c.name)).not.toContain("selftest");
  });

  it("no candidate for a tool other than submit, or for an empty change", () => {
    const { trunk, request } = fixture("full");
    expect(selftestCandidate(trunk.pool, request("read", { path: "world/energy.js" }))).toBeNull();
    expect(selftestCandidate(trunk.pool, request("submit", { summary: "nothing" }))).toBeNull();
  });
});
