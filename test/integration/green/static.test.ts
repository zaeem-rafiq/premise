// The static runtime of the green line (01-core 11.5 GR5, GR5a, GR7, GR8) on the stored seed
// `tidepool`. Expected names and codes come from GR8's fixed list; what is broken comes from the
// languages themselves (a syntax error, a missing export) and from the policy file rules of 10.1.

import { describe, expect, it } from "vitest";
import { GREEN_STATIC_CHECKS } from "../../../src/protocol/green.ts";
import { staticResult, staticVerifier } from "../../../src/worker/adapters/verifier/static.ts";
import { tidepoolFiles } from "../collide/harness.ts";

const SEED = new Map(Object.entries(tidepoolFiles()));

/** The seed with `changes` applied (a null value deletes the path). */
function commit(changes: Record<string, string | null>): Map<string, string> {
  const files = new Map(SEED);
  for (const [path, content] of Object.entries(changes)) {
    if (content === null) files.delete(path);
    else files.set(path, content);
  }
  return files;
}

function verify(files: Map<string, string>, greenFiles = SEED, imported = false) {
  return staticResult({ files, greenFiles, imported });
}

const ALL_PASS = GREEN_STATIC_CHECKS.map((name) => ({ name, ok: true }));

describe("the static runtime of the green line (GR5, GR5a)", () => {
  it("GR5a: the seed passes all three checks, in GR8's order, with an empty log", () => {
    expect(verify(SEED)).toEqual({ ok: true, checks: ALL_PASS, log: "" });
  });

  it("GR5a: a creature that does not parse fails parse with parse:failed", () => {
    const r = verify(commit({ "creatures/crab.js": "export function update(crab {\n" }));
    expect(r.ok).toBe(false);
    expect(r.checks).toEqual([
      { name: "parse", ok: false, code: "parse:failed" },
      { name: "imports_resolve", ok: true },
      { name: "policy_invariants", ok: true },
    ]);
    expect(r.log).toBe("parse: creatures/crab.js");
  });

  it("GR5a: an import of a name the module does not export fails imports_resolve", () => {
    const fish = SEED.get("creatures/fish.js")!.replace(
      'import { wrap } from "../world/bounds.js";',
      'import { wrap, warp } from "../world/bounds.js";\nexport const W = warp;',
    );
    const r = verify(commit({ "creatures/fish.js": fish }));
    expect(r.checks[1]).toEqual({ name: "imports_resolve", ok: false, code: "imports_resolve:failed" });
    expect(r.log).toContain("world/bounds.js#warp");
  });

  it("GR5a: a deleted module that others import fails imports_resolve", () => {
    const r = verify(commit({ "world/bounds.js": null }));
    expect(r.checks.find((c) => c.name === "imports_resolve")).toEqual({
      name: "imports_resolve",
      ok: false,
      code: "imports_resolve:failed",
    });
  });

  it("GR5a: a bare specifier fails imports_resolve in the tide pool (CK5)", () => {
    const r = verify(commit({ "creatures/crab.js": 'import x from "lodash";\nexport const y = x;\n' }));
    expect(r.checks[1]).toMatchObject({ ok: false, code: "imports_resolve:failed" });
  });

  it("GR5a: an invalid policy file fails policy_invariants (10.1, PO3)", () => {
    const r = verify(commit({ ".premise/policy.json": JSON.stringify({ v: 1, default: "auto", extra: true }) }));
    expect(r.checks[2]).toEqual({ name: "policy_invariants", ok: false, code: "policy_invariants:failed" });
    expect(verify(commit({ ".premise/policy.json": null })).checks[2]).toMatchObject({ ok: false });
  });

  it("GR5a: a creature that uses a global outside the allow list fails policy_invariants (CK6)", () => {
    const r = verify(commit({ "creatures/crab.js": "export function update(c) { c.x = Date.now(); }\n" }));
    expect(r.checks[2]).toEqual({ name: "policy_invariants", ok: false, code: "policy_invariants:failed" });
    expect(r.log).toBe("policy_invariants: creatures/crab.js#update uses the global Date");
  });

  it("GR5a: a finding the green commit already has is not counted", () => {
    const broken = commit({ "creatures/crab.js": "export function update(crab {\n" });
    expect(verify(broken, broken)).toEqual({ ok: true, checks: ALL_PASS, log: "" });
    // A newer, different finding on top of it still counts.
    const worse = new Map(broken);
    worse.set("creatures/eel.js", "export const = 1;\n");
    expect(verify(worse, broken)).toMatchObject({ ok: false, log: "parse: creatures/eel.js" });
  });

  it("GR5a: an imported pool has no globals check (IR7) and allows bare specifiers (LG3)", () => {
    const files = new Map([
      ["src/a.ts", 'import { x } from "lodash";\nexport const a = (n: number) => console.log(x, n);\n'],
    ]);
    // IR6: imported without a policy file, the seed has that finding too, so it is not counted.
    expect(verify(files, new Map(), true)).toEqual({ ok: true, checks: ALL_PASS, log: "" });
    // A landing that deletes a policy file the green commit had is a new finding.
    const policy = JSON.stringify({ v: 1, default: "auto" });
    const green = new Map([...files, [".premise/policy.json", policy]]);
    expect(verify(files, green, true)).toEqual({
      ok: false,
      checks: [
        { name: "parse", ok: true },
        { name: "imports_resolve", ok: true },
        { name: "policy_invariants", ok: false, code: "policy_invariants:failed" },
      ],
      log: "policy_invariants: .premise/policy.json is missing",
    });
  });

  it("GR7 and GR8: checks carry names and fixed codes only; the free text stays in the log", async () => {
    const files = commit({ "creatures/crab.js": "export function update(crab {\n" });
    const verifier = staticVerifier({ seq: 4, commit: "a".repeat(40), files, greenFiles: SEED, imported: false });
    const r = await verifier.verify({ pool_id: "p", seq: 4, commit: "a".repeat(40) });
    expect(r).toMatchObject({ seq: 4, commit: "a".repeat(40), runtime: "static", ok: false });
    expect(JSON.stringify(r.checks)).not.toContain("crab");
    expect(r.log).toContain("crab");
    await expect(verifier.verify({ pool_id: "p", seq: 5, commit: "b".repeat(40) })).rejects.toThrow();
  });
});
