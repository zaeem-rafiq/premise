// PV1-PV5: the real Worker and stock git, with local stand-ins for remote hosting only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, gitBytes } from "../../git/helpers.ts";
import { startLandingWorker, type LandingWorker } from "../landing/harness.ts";
import { createPool, eventsOf, KEY, launch, tool, waitFor } from "../collide/helpers.ts";
import { latestCard, tap, waitCard, waitLanding } from "./helpers.ts";

const pools = ["preview-ok", "preview-retry", "preview-fail", "preview-lost-reply"];

describe("held preview commits in local workerd (PV1-PV5)", () => {
  let worker: LandingWorker;
  beforeAll(async () => {
    worker = await startLandingWorker({ ownerKey: KEY, held: true, repos: pools.flatMap((p) => [p, `${p}-plain`]) });
  });
  afterAll(async () => worker?.dispose());

  it("PV2/PV4: pushes a parentless seed-plus-change tree and serves immutable preview files with sandbox headers", async () => {
    const pool = pools[0]!;
    await createPool(worker, pool, { seed: "tidepool" });
    const seed = worker.refs(pool).main!;
    await waitFor(async () => worker.refs(`${pool}-plain`).main !== null, 10_000);
    const plainBefore = worker.refs(`${pool}-plain`).main;
    const [attempt] = await launch(worker, pool, ["hero-s"]);
    const card = await waitCard(worker, pool, (c) => c.preview?.after[attempt!] !== undefined);
    const commit = card.preview!.after[attempt!]!.commit;
    expect(card.preview!.before).toEqual({ repo: "main", commit: seed });
    expect(card.preview!.error).toBeNull();
    expect(card.paths).toEqual([{ path: "world/energy.js", tier: "held" }]);
    expect(card.title).toBe("This change touches shared rules. Land it?");
    expect(card.body.join(" ")).toContain("It changes world/energy.js.");
    const dir = worker.repoDir(`${pool}-plain`);
    const ref = `refs/previews/${card.submit_ids[attempt!]}`;
    expect(git(dir, ["rev-parse", ref])).toBe(commit);
    expect(git(dir, ["rev-list", "--parents", "-n", "1", ref])).toBe(commit);
    expect(worker.refs(pool).main).toBe(seed);
    expect(worker.refs(`${pool}-plain`).main).toBe(plainBefore);
    // Expected files come from the real seed plus the exact operation in 02 section 7.3.
    const seedSource = gitBytes(worker.repoDir(pool), ["show", `${seed}:world/energy.js`]).toString("utf8");
    const expectedSource = seedSource.replace(
      "// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 100;",
      "// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 1;",
    );
    expect(expectedSource).not.toBe(seedSource);
    const expectedBlob = git(dir, ["hash-object", "--stdin"], expectedSource);
    const seedTree = git(worker.repoDir(pool), ["ls-tree", "-r", seed]);
    const expectedTree = seedTree
      .split("\n")
      .map((line) => (line.endsWith("\tworld/energy.js") ? `100644 blob ${expectedBlob}\tworld/energy.js` : line))
      .join("\n");
    expect(git(dir, ["ls-tree", "-r", commit])).toBe(expectedTree);
    expect(git(dir, ["fsck", "--strict"])).not.toContain("error");
    const page = await worker.fetch(`/pool/${pool}/p-${commit}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<canvas id="pool">');
    expect(page.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts");
    const file = await worker.fetch(`/pool/${pool}/v/p-${commit}/world/energy.js`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe(expectedSource);
    expect(file.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    for (const path of [
      `/pool/${pool}/p-${commit}/~head.js`,
      `/pool/${pool}/p-${commit}/~boot.js`,
      `/pool/${pool}/v/p-${commit}/~registry.js`,
    ])
      expect((await worker.fetch(path)).status, path).toBe(200);
    for (const path of [
      `/pool/${pool}/${attempt}/`,
      `/pool/${pool}/a-${attempt!.slice(2)}/`,
      `/pool/${pool}/attempt/${attempt}/`,
      `/pool/${pool}/v/a-${attempt!.slice(2)}/world/energy.js`,
      `/pool/${pool}/v/${attempt}/world/energy.js`,
    ])
      expect((await worker.fetch(path)).status, path).toBe(404);

    // T22/C34: a new operation closes the card; its immutable remote ref survives.
    await tool(
      worker,
      pool,
      attempt!,
      { tool: "replace", args: { path: "world/energy.js", old: "ENERGY_MAX = 1;", new: "ENERGY_MAX = 2;" } },
      99,
    );
    await waitFor(async () => (await eventsOf(worker, pool, "card.closed")).some((e) => e.action === "stale"), 10_000);
    const stale = await tap(worker, pool, card, "land", "stale-tap");
    expect(stale).toMatchObject({ ok: true, stale: true, message: expect.any(String) });
    expect(await eventsOf(worker, pool, "landing.landed")).toEqual([]);
    expect(git(dir, ["rev-parse", ref])).toBe(commit);
  });

  it("reports failed pushes, preserves the frozen commit through restart, and recovers on retry", async () => {
    const pool = pools[1]!;
    await createPool(worker, pool, { seed: "tidepool" });
    worker.setGitFault((r) =>
      r.path.includes(`${pool}-plain/`) ? { action: "answer", status: 503 } : { action: "forward" },
    );
    const [attempt] = await launch(worker, pool, ["hero-s"]);
    const failed = await waitCard(worker, pool, (c) => c.preview?.error === "preview_push_failed");
    expect(failed.preview!.after).toEqual({});
    expect(failed.options.map((o) => o.id)).toEqual(["land", "decline"]);
    const before = await worker.trunk(pool).state();
    const pending = JSON.parse(String((before.meta as Record<string, string>).preview_pending)) as {
      submits: Record<string, { commit: string }>;
    };
    const expectedCommit = pending.submits[failed.submit_ids[attempt!]!]!.commit;
    await worker.restart();
    worker.setGitFault(null);
    await worker.runAlarm(pool, Date.now() + 60_000);
    const recovered = await waitCard(worker, pool, (c) => c.preview?.after[attempt!] !== undefined);
    expect(recovered.preview!.after[attempt!]!.commit).toBe(expectedCommit);
    expect(recovered.preview!.error).toBeNull();
    expect((await worker.trunk(pool).state()).meta).not.toHaveProperty("preview_pending");
    await tap(worker, pool, recovered, "land");
    await waitLanding(worker, pool);
  });

  it("a preview push failure leaves Land usable and never pauses the landing path", async () => {
    const pool = pools[2]!;
    await createPool(worker, pool, { seed: "tidepool" });
    worker.setGitFault((r) =>
      r.path.includes(`${pool}-plain/`) ? { action: "answer", status: 503 } : { action: "forward" },
    );
    await launch(worker, pool, ["hero-s"]);
    const card = await waitCard(worker, pool, (c) => c.preview?.error === "preview_push_failed");
    await tap(worker, pool, card, "land");
    await waitLanding(worker, pool);
    expect(await eventsOf(worker, pool, "pool.paused")).toEqual([]);
    expect(git(worker.repoDir(pool), ["show", "main:world/energy.js"])).toContain("ENERGY_MAX = 1;");
    worker.setGitFault(null);
    expect((await latestCard(worker, pool))?.card_id).toBe(card.card_id);
  });

  it("recognizes a successful preview push whose response was lost without pushing twice", async () => {
    const pool = pools[3]!;
    await createPool(worker, pool, { seed: "tidepool" });
    let dropped = false;
    worker.setGitFault((request) => {
      if (!dropped && request.commands?.some((command) => command.ref.startsWith("refs/previews/"))) {
        dropped = true;
        return { action: "apply_then_drop" };
      }
      return { action: "forward" };
    });
    const [attempt] = await launch(worker, pool, ["hero-s"]);
    const card = await waitCard(worker, pool, (candidate) => candidate.preview?.after[attempt!] !== undefined);
    const ref = `refs/previews/${card.submit_ids[attempt!]}`;
    expect(dropped).toBe(true);
    expect(git(worker.repoDir(`${pool}-plain`), ["rev-parse", ref])).toBe(card.preview!.after[attempt!]!.commit);
    expect(
      worker.gitRequests().filter((request) => request.commands?.some((command) => command.ref === ref)),
    ).toHaveLength(1);
    expect(card.preview!.error).toBeNull();
    expect((await worker.trunk(pool).state()).meta).not.toHaveProperty("preview_pending");
    worker.setGitFault(null);
  });
});
