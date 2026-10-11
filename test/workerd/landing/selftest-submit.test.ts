// CK6c (01-core 4.9): the pre-landing self-test of a submit, in local workerd over the built
// Worker with the Worker Loader bound as wrangler.jsonc binds it. With features.green "full" a
// submit runs the tide pool's self-test (02-tidepool 5.2) on the tree it would land: a creature
// whose draw throws fails `no_errors` (TP10) and is sent back with `selftest_failed` before it can
// land; fixed, it validates and lands. A failure head already has is not the submit's (GR3d). With
// green "static" no self-test runs and no `selftest` check appears. Creatures are seed content
// (seeds/tidepool, 02-tidepool Appendix A1). Run `npm run build` first.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLandingWorker, type LandingWorker } from "./harness.ts";
import { createPool, eventsOf, KEY, openAttempt, tick, tool, waitFor } from "../collide/helpers.ts";
import { seedTree } from "../green/trees.ts";

const SEED = seedTree();
const JS = [...SEED.keys()].filter((p) => p.endsWith(".js")).sort();

/** The seed's snail as a new kind (02-tidepool A1's snail, renamed). */
const creature = (kind: string) => SEED.get("creatures/snail.js")!.replace(/snail/g, kind);
/** The same creature whose draw throws a TypeError on every call. */
const throwingDraw = (kind: string) => creature(kind).replace("pen.fill(BODY);", "pen.fill(BODY.missing.colour);");
/** PN2: a pen call with a colour that is no colour (not a CSS name either, so CK6b passes it). */
const badPen = (kind: string) => creature(kind).replace('const BODY = "sand";', 'const BODY = "not-a-colour";');

type Submit = {
  status: string;
  errors?: Array<{ code: string; detail: { failed: Array<{ name: string; code: string; kind?: string }> } }>;
  checks?: Array<{ name: string; ok: boolean; detail?: string }>;
};

/** One attempt that reads every seed module (so nothing it writes is a blind spot, B1), writes
 * `files`, and submits. Returns the submit's result and the next call number. */
async function change(
  worker: LandingWorker,
  pool: string,
  attempt: string,
  files: Record<string, string>,
): Promise<{ result: Submit; n: number }> {
  await openAttempt(worker, pool, attempt);
  let n = 0;
  for (const path of JS) await tool(worker, pool, attempt, { tool: "read", args: { path } }, ++n);
  for (const [path, content] of Object.entries(files)) {
    await tool(worker, pool, attempt, { tool: "write", args: { path, content } }, ++n);
  }
  const body = await tool(worker, pool, attempt, { tool: "submit", args: { summary: attempt } }, ++n);
  return { result: body.result as Submit, n };
}

describe("CK6c with features.green full: the self-test runs before a submit lands", () => {
  const POOL = "st-full";
  const BASE = "st-base";
  let worker: LandingWorker;

  beforeAll(async () => {
    worker = await startLandingWorker({
      ownerKey: KEY,
      features: { green: "full" },
      repos: [POOL, `${POOL}-plain`, BASE, `${BASE}-plain`],
    });
  }, 120_000);
  afterAll(async () => worker?.dispose());

  it("a creature whose draw throws is rejected with selftest_failed and never lands; fixed, it lands", async () => {
    await createPool(worker, POOL, { seed: "tidepool" });
    const first = await change(worker, POOL, "eel", { "creatures/eel.js": throwingDraw("eel") });
    expect(first.result.status).toBe("rejected");
    expect(first.result.errors).toHaveLength(1);
    expect(first.result.errors![0]!.code).toBe("selftest_failed");
    expect(first.result.errors![0]!.detail.failed).toContainEqual({
      name: "no_errors",
      code: "no_errors:failed",
      kind: "eel",
      means: expect.stringContaining("threw an error"),
    });
    // GR7/GR8: only check names and fixed codes, never the thrown error's text.
    expect(JSON.stringify(first.result)).not.toContain("missing");
    await tick(worker, POOL);
    expect(await eventsOf(worker, POOL, "landing.accepted")).toHaveLength(0);

    // The agent repairs the file and submits again: the same attempt validates and lands.
    let n = first.n;
    await tool(
      worker,
      POOL,
      "eel",
      { tool: "write", args: { path: "creatures/eel.js", content: creature("eel") } },
      ++n,
    );
    const fixed = (await tool(worker, POOL, "eel", { tool: "submit", args: { summary: "eel" } }, ++n)).result as Submit;
    expect(fixed.status).toBe("validated");
    expect(fixed.checks).toContainEqual({ name: "selftest", ok: true });
    await tick(worker, POOL);
    await waitFor(async () => (await eventsOf(worker, POOL, "landing.landed")).length >= 1, 60_000);
    const again = (await tool(worker, POOL, "eel", { tool: "submit", args: { summary: "eel" } }, ++n)).result as Submit;
    expect(["accepted", "landed"]).toContain(again.status);
  }, 240_000);

  it("GR3d: a head that already fails pen_rules does not reject an unrelated new creature", async () => {
    // The base pool's own files carry a creature with a rejected pen call (PN2): head fails
    // pen_rules for the jelly from the start, as after a landing the green line did not take back.
    const res = await worker.trunk(BASE).fetch("/internal/create-pool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pool: BASE,
        seed: "tidepool",
        files: { ...Object.fromEntries(SEED), "creatures/jelly.js": badPen("jelly") },
        summary_only: false,
        request_id: `r-create-${BASE}`,
        remote: worker.remoteFor(BASE),
      }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    await waitFor(async () => (await worker.eventTypes(BASE)).includes("batch.pushed"), 30_000);

    const lily = await change(worker, BASE, "lily", { "creatures/lily.js": creature("lily") });
    expect(lily.result.status).toBe("validated");
    expect(lily.result.checks).toContainEqual({ name: "selftest", ok: true });

    // A second creature with its own pen_rules failure on that base is still the submit's.
    const kelp = await change(worker, BASE, "kelp", { "creatures/kelp.js": badPen("kelp") });
    expect(kelp.result.status).toBe("rejected");
    expect(kelp.result.errors![0]!.detail.failed).toEqual([
      { name: "pen_rules", code: "pen_rules:failed", kind: "kelp", means: expect.stringContaining("PALETTE") },
    ]);
  }, 240_000);
});

describe("CK6c with features.green static: no self-test at submit", () => {
  const POOL = "st-static";
  let worker: LandingWorker;

  beforeAll(async () => {
    worker = await startLandingWorker({ ownerKey: KEY, features: { green: "static" }, repos: [POOL, `${POOL}-plain`] });
  }, 120_000);
  afterAll(async () => worker?.dispose());

  it("the throwing creature validates on the static checks and no selftest check appears", async () => {
    await createPool(worker, POOL, { seed: "tidepool" });
    const { result } = await change(worker, POOL, "eel", { "creatures/eel.js": throwingDraw("eel") });
    expect(result.status).toBe("validated");
    expect(result.checks!.map((c) => c.name)).not.toContain("selftest");
  }, 240_000);
});

describe("CK6c with features.green full and SUBMIT_SELFTEST off: the run is skipped", () => {
  const POOL = "st-off";
  let worker: LandingWorker;

  beforeAll(async () => {
    worker = await startLandingWorker({
      ownerKey: KEY,
      features: { green: "full" },
      vars: { SUBMIT_SELFTEST: "off" },
      repos: [POOL, `${POOL}-plain`],
    });
  }, 120_000);
  afterAll(async () => worker?.dispose());

  it("the throwing creature validates with the check selftest skipped", async () => {
    await createPool(worker, POOL, { seed: "tidepool" });
    const { result } = await change(worker, POOL, "eel", { "creatures/eel.js": throwingDraw("eel") });
    expect(result.status).toBe("validated");
    expect(result.checks).toContainEqual({ name: "selftest", ok: true, detail: "skipped" });
  }, 240_000);
});
