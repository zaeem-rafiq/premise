// Slice 14 part 14a, acceptance item 1 (04-build-plan 2.15): in local workerd with the static
// runtime switched on for this bundle only (`withFeatures`), against a real `git http-backend`
// remote. After a landing, stock `git ls-remote` shows `refs/heads/green` at the head commit,
// and the stream carries `green.verified` with `runtime: "static"`, then `green.advanced`
// (GR1, GR2, GR2a, GR5). A landing that breaks the policy file fails the check twice: one
// unconfirmed and one confirmed `green.verified`, no `green.advanced`, and the ref stays (GR3,
// GR3b, GR5a). Run `npm run build` first: the harness starts the built Worker.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "../../git/helpers.ts";
import { startLandingWorker, type LandingWorker } from "../../workerd/landing/harness.ts";
import { createPool, eventsOf, KEY, openAttempt, tool, waitFor } from "../../workerd/collide/helpers.ts";

type Ev = Record<string, unknown>;

/** The remote's `refs/heads/green` as stock git sees it over smart HTTP, or null. Asynchronous:
 * the git server runs in this process, so a blocking spawn would wait on itself forever. */
async function lsRemoteGreen(worker: LandingWorker, repo: string): Promise<string | null> {
  const { stdout } = await promisify(execFile)("git", ["ls-remote", worker.remoteFor(repo), "refs/heads/green"], {
    cwd: worker.repoDir(repo),
    timeout: 30_000,
  });
  const out = stdout.trim();
  return out === "" ? null : out.split(/\s+/)[0]!;
}

async function landedOf(worker: LandingWorker, pool: string): Promise<Ev[]> {
  return eventsOf(worker, pool, "landing.landed");
}

describe("Slice 14 part 14a: the green line with the static runtime (2.15 item 1)", () => {
  let worker: LandingWorker;

  beforeAll(async () => {
    worker = await startLandingWorker({
      ownerKey: KEY,
      features: { green: "static", held: true },
      repos: ["green-a", "green-a-plain", "green-r", "green-r-plain"],
    });
  }, 240_000);

  afterAll(async () => {
    await worker?.dispose();
  });

  it("GR1, GR2, GR2a, GR5: after a landing, git ls-remote shows refs/heads/green at the head commit", async () => {
    await createPool(worker, "green-a", { seed: "tidepool" });
    expect(await lsRemoteGreen(worker, "green-a")).toBeNull(); // no verification before the first landing

    await openAttempt(worker, "green-a", "eel");
    await tool(
      worker,
      "green-a",
      "eel",
      { tool: "write", args: { path: "creatures/eel.js", content: "export const BODY = 'green';\n" } },
      1,
    );
    await tool(worker, "green-a", "eel", { tool: "submit", args: { summary: "add an eel" } }, 2);
    await waitFor(async () => (await landedOf(worker, "green-a")).length >= 1, 60_000);
    const head = String((await landedOf(worker, "green-a")).at(-1)!.commit);

    await waitFor(async () => (await eventsOf(worker, "green-a", "green.advanced")).length >= 1, 60_000);
    expect(await lsRemoteGreen(worker, "green-a")).toBe(head);
    expect(worker.refs("green-a").main).toBe(head);

    // The stream: green.verified (static, passed, confirmed) then green.advanced, both at the head.
    const types = (await worker.events("green-a")).map((e) => String(e.type));
    const verifiedAt = types.indexOf("green.verified");
    expect(verifiedAt).toBeGreaterThan(types.indexOf("batch.pushed"));
    expect(types.indexOf("green.advanced")).toBeGreaterThan(verifiedAt);
    expect(await eventsOf(worker, "green-a", "green.verified")).toEqual([
      expect.objectContaining({
        seq: 1,
        commit: head,
        ok: true,
        runtime: "static",
        confirmed: true,
        checks: [
          { name: "parse", ok: true },
          { name: "imports_resolve", ok: true },
          { name: "policy_invariants", ok: true },
        ],
      }),
    ]);
    expect(await eventsOf(worker, "green-a", "green.advanced")).toEqual([
      expect.objectContaining({ seq: 1, commit: head }),
    ]);
    // EM1: `pool.state` carries the new `green_seq`; the remote stays a healthy repository.
    expect((await eventsOf(worker, "green-a", "pool.state")).at(-1)).toMatchObject({ green_seq: 1 });
    expect(() => git(worker.repoDir("green-a"), ["fsck", "--strict"])).not.toThrow();
  }, 180_000);

  it("GR3, GR3b, GR5a: a landing that breaks the policy file fails twice and leaves the ref", async () => {
    await createPool(worker, "green-r", { seed: "tidepool" });
    await openAttempt(worker, "green-r", "ok");
    await tool(
      worker,
      "green-r",
      "ok",
      { tool: "write", args: { path: "creatures/eel.js", content: "export const BODY = 'green';\n" } },
      1,
    );
    await tool(worker, "green-r", "ok", { tool: "submit", args: { summary: "add an eel" } }, 2);
    await waitFor(async () => (await eventsOf(worker, "green-r", "green.advanced")).length >= 1, 60_000);
    const green = await lsRemoteGreen(worker, "green-r");
    expect(green).not.toBeNull();

    // A policy file edit is always held (PO3); the owner lands it with one tap.
    await openAttempt(worker, "green-r", "bad");
    await tool(worker, "green-r", "bad", { tool: "read", args: { path: ".premise/policy.json" } }, 0);
    await tool(
      worker,
      "green-r",
      "bad",
      { tool: "write", args: { path: ".premise/policy.json", content: '{ "v": 1, "default": "auto", "x": 1 }\n' } },
      1,
    );
    await tool(worker, "green-r", "bad", { tool: "submit", args: { summary: "loosen the policy" } }, 2);
    await waitFor(async () => (await eventsOf(worker, "green-r", "card.opened")).length >= 1, 60_000);
    const card = (await eventsOf(worker, "green-r", "card.opened")).at(-1)!.card as {
      card_id: string;
      submit_ids: Record<string, string>;
    };
    const tap = await worker.fetch(`/api/pools/green-r/cards/${card.card_id}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ option: "land", submit_ids: card.submit_ids, request_id: "r-land-green-r" }),
    });
    expect(tap.status, await tap.clone().text()).toBe(200);
    await waitFor(async () => (await landedOf(worker, "green-r")).length >= 2, 60_000);
    const broken = String((await landedOf(worker, "green-r")).at(-1)!.commit);

    await waitFor(async () => (await eventsOf(worker, "green-r", "green.verified")).length >= 3, 60_000);
    const failed = { name: "policy_invariants", ok: false, code: "policy_invariants:failed" };
    expect((await eventsOf(worker, "green-r", "green.verified")).slice(1)).toEqual([
      expect.objectContaining({ seq: 2, commit: broken, ok: false, confirmed: false, runtime: "static" }),
      expect.objectContaining({ seq: 2, commit: broken, ok: false, confirmed: true, runtime: "static" }),
    ]);
    for (const e of (await eventsOf(worker, "green-r", "green.verified")).slice(1)) {
      expect(e.checks).toContainEqual(failed);
      // GR7: no free text of a check, and no log, in the stream.
      expect(JSON.stringify(e)).not.toContain("policy.json");
      expect(e).not.toHaveProperty("log");
    }
    // GR3b: no take-back in part 14a — one green.advanced (the first landing), no revert landing.
    expect(await eventsOf(worker, "green-r", "green.advanced")).toHaveLength(1);
    expect(await eventsOf(worker, "green-r", "undo.planned")).toEqual([]);
    expect(await lsRemoteGreen(worker, "green-r")).toBe(green);
    // GR1a: the confirmed red commit is not verified again.
    for (let i = 0; i < 3; i += 1) await worker.runAlarm("green-r", Date.now() + 120_000);
    expect(await eventsOf(worker, "green-r", "green.verified")).toHaveLength(3);
  }, 240_000);
});
