// The isolate runtime of the green line (01-core S4a to S4c, GR6, GR8; 02-tidepool 5.4, ST4) in
// real local workerd. A host Worker holds the Worker Loader binding and loads, unchanged, the code
// `isolateVerifier` builds: the verifier's own empty environment, `globalOutbound: null` and CPU
// limit are what run. Expected verdicts come from 02-tidepool Appendix A (A1, A5).

import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GREEN_CHECK_NAMES, GREEN_RUNTIME_CHECKS } from "../../../src/protocol/green.ts";
import {
  isolateCode,
  isolateVerifier,
  runInIsolate,
  type IsolateCode,
  type IsolateLoader,
} from "../../../src/worker/adapters/verifier/isolate.ts";
import { ENTRY_MODULE } from "../../../src/worker/adapters/verifier/harness/selftest.ts";
import { a5Tree, seedTree } from "./trees.ts";

/** The host: loads the posted code with `LOADER.load` exactly as given and answers the isolate's
 * response, or 599 with the error the load or the call threw. */
const HOST = `export default {
  async fetch(request, env) {
    const code = await request.json();
    try {
      const response = await env.LOADER.load(code).getEntrypoint().fetch("http://selftest.invalid/");
      return new Response(await response.text(), { status: response.status });
    } catch (e) {
      return new Response(e instanceof Error ? e.name + ": " + e.message : "thrown", { status: 599 });
    }
  },
};`;

let miniflare: Miniflare;
/** The Worker Loader as the verifier sees it, backed by the host's real binding. */
const loader = {
  load(code: IsolateCode) {
    return {
      getEntrypoint() {
        return {
          async fetch(_url: string) {
            const response = await miniflare.dispatchFetch("http://host.test/", {
              method: "POST",
              body: JSON.stringify(code),
            });
            const text = await response.text();
            if (response.status === 599) throw new Error(text);
            return new Response(text, { status: response.status });
          },
        };
      },
    };
  },
} satisfies IsolateLoader;

beforeAll(async () => {
  miniflare = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      telemetry: { enabled: false },
      workers: [
        { name: "host", modules: true, script: HOST, compatibilityDate: "2026-10-01", workerLoaders: { LOADER: {} } },
      ],
    }),
  );
  await miniflare.ready;
});

afterAll(async () => {
  await miniflare?.dispose();
});

const verify = (files: Map<string, string>, seq = 1, commit = "c".repeat(40)) =>
  isolateVerifier({ seq, commit, files, loader }).verify({ pool_id: "p", seq, commit });

/** GR8: every check is from the fixed list; a passed one has no code; a failed one a fixed code. */
function expectGr8(checks: Array<{ name: string; ok: boolean; code?: string }>): void {
  for (const c of checks) {
    expect(GREEN_CHECK_NAMES as readonly string[]).toContain(c.name);
    if (c.ok) expect(c).not.toHaveProperty("code");
    else expect(["no_verdict", "bad_verdict", "harness_error", `${c.name}:failed`]).toContain(c.code);
  }
}

describe("the isolate runtime in local workerd (S4a, 02-tidepool 5.4)", () => {
  it("A1: the seed commit passes — selftest_ran, then the twelve invariants in order, all ok", async () => {
    const result = await verify(seedTree());
    expect(result).toMatchObject({ seq: 1, ok: true, runtime: "isolate" });
    expect(result.checks).toEqual(GREEN_RUNTIME_CHECKS.map((name) => ({ name, ok: true })));
  }, 60_000);

  it("A5: the hero's plain-merge tree fails not_exhausted only; the shrimp's detail goes to the log", async () => {
    const result = await verify(a5Tree());
    expect(result.ok).toBe(false);
    expect(result.runtime).toBe("isolate");
    expect(result.checks).toEqual(
      GREEN_RUNTIME_CHECKS.map((name) =>
        name === "not_exhausted" ? { name, ok: false, code: "not_exhausted:failed" } : { name, ok: true },
      ),
    );
    expectGr8(result.checks);
    // GR7: the kind name and the sentence are in the log, never in a check.
    expect(JSON.stringify(result.checks)).not.toContain("shrimp");
    expect(JSON.parse(result.log)).toMatchObject({ failed: [{ name: "not_exhausted", kind: "shrimp" }] });
    expect(result.log).toContain("shrimp: resting");
  }, 60_000);

  it("ST4: a creature file that does not parse gives the single check selftest_ran with harness_error", async () => {
    const files = seedTree();
    files.set("creatures/broken.js", "export function spawn( {\n");
    const result = await verify(files);
    expect(result).toMatchObject({ ok: false, checks: [{ name: "selftest_ran", ok: false, code: "harness_error" }] });
  }, 60_000);

  it("ST4: a commit without selftest/run.js gives harness_error without loading anything", async () => {
    const files = seedTree();
    files.delete("selftest/run.js");
    const result = await verify(files);
    expect(result.checks).toEqual([{ name: "selftest_ran", ok: false, code: "harness_error" }]);
  });
});

describe("GR3d: a failure the green commit already has is not the landing's (production pool check-1011)", () => {
  // A creature with a rejected pen call (PN2: a colour that is not a colour): pen_rules fails on it.
  const badPen = (name: string) =>
    seedTree()
      .get("creatures/snail.js")!
      .replace('const BODY = "sand";', 'const BODY = "not-a-colour";')
      .replace(/snail/g, name);
  const verifyAgainst = (files: Map<string, string>, greenFiles: Map<string, string>) =>
    isolateVerifier({ seq: 2, commit: "h".repeat(40), files, greenFiles, loader }).verify({
      pool_id: "p",
      seq: 2,
      commit: "h".repeat(40),
    });

  it("the base fails pen_rules alone; a clean landing on it passes against the green commit", async () => {
    const base = seedTree();
    base.set("creatures/jelly.js", badPen("jelly"));
    expect((await verify(base)).checks).toContainEqual({ name: "pen_rules", ok: false, code: "pen_rules:failed" });

    const head = new Map(base);
    head.set("creatures/lily.js", seedTree().get("creatures/turtle.js")!);
    const result = await verifyAgainst(head, base);
    expect(result.ok).toBe(true);
    expect(result.checks).toEqual(GREEN_RUNTIME_CHECKS.map((name) => ({ name, ok: true })));
    expect(result.log).toContain("also at the green commit, not counted: pen_rules|jelly");
  }, 60_000);

  it("a landing that adds its own pen_rules failure on such a base still fails", async () => {
    const base = seedTree();
    base.set("creatures/jelly.js", badPen("jelly"));
    const head = new Map(base);
    head.set("creatures/lily.js", badPen("lily"));
    const result = await verifyAgainst(head, base);
    expect(result.ok).toBe(false);
    expect(result.checks.filter((c) => !c.ok)).toEqual([{ name: "pen_rules", ok: false, code: "pen_rules:failed" }]);
  }, 60_000);

  it("a revert back to the green commit's own tree passes", async () => {
    const base = seedTree();
    base.set("creatures/jelly.js", badPen("jelly"));
    expect((await verifyAgainst(new Map(base), base)).ok).toBe(true);
  }, 60_000);
});

describe("GR6: the verifier's isolate has no binding and no outbound network (2.15 item 3)", () => {
  // A test creature that tries both: it reads every binding it was given and calls the network.
  const PROBE_CREATURE = `export function spawn() { return {}; }
export function update() {}
export function draw() {}
export async function probe(env) {
  const bindings = Object.keys(env ?? {});
  let network;
  try {
    const response = await fetch("https://example.com/");
    network = "reached: " + response.status;
  } catch (e) {
    network = "refused: " + (e instanceof Error ? e.message : String(e));
  }
  return { bindings, network };
}
`;

  it("the code the verifier loads has an empty environment, globalOutbound null and the CPU limit", () => {
    const code = isolateCode(seedTree(), 5_000);
    expect(code.env).toEqual({});
    expect(code.globalOutbound).toBeNull();
    expect(code.limits).toEqual({ cpuMs: 5_000 });
  });

  it("a creature that tries a binding and the network in that isolate gets neither", async () => {
    const files = seedTree();
    files.set("creatures/probe.js", PROBE_CREATURE);
    const code = isolateCode(files);
    // The same code, with the entry swapped for one that runs the creature's probe in a handler.
    code.modules[ENTRY_MODULE] = {
      js: `import { probe } from "./creatures/probe.js";
export default { async fetch(request, env) { return Response.json(await probe(env)); } };`,
    };
    const answer = (await (await loader.load(code).getEntrypoint().fetch("http://x/")).json()) as {
      bindings: string[];
      network: string;
    };
    expect(answer.bindings).toEqual([]);
    expect(answer.network).toMatch(/^refused: /);
  }, 60_000);
});

// Last in the file: local workerd does not enforce `cpuMs` (the platform does, S4 evidence), so the
// runaway isolate keeps the local runtime busy after the verifier has given up on it.
describe("ST4: a runaway self-test", () => {
  it("ST4: pool code that never returns gives no_verdict within the time limit", async () => {
    const files = seedTree();
    files.set(
      "creatures/fish.js",
      files
        .get("creatures/fish.js")!
        .replace(/export function update\(([^)]*)\) \{/, "export function update($1) { for (;;) {}"),
    );
    expect(files.get("creatures/fish.js")).toContain("for (;;) {}");
    const result = await runInIsolate({ seq: 1, commit: "c", files, loader, timeoutMs: 3_000, cpuMs: 50 });
    expect(result.checks).toEqual([{ name: "selftest_ran", ok: false, code: "no_verdict" }]);
  }, 60_000);
});
