// RY10/03-floor 8.6: recorded frame addresses still serve their retained Git commits after
// later landings and a Worker restart. BP12/SC10's future production retention is operational;
// this local proof does not authorize deletion or establish how long a live host keeps a repo.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitBytes } from "../../git/helpers.ts";
import { startLandingWorker, type LandingWorker } from "../landing/harness.ts";
import { createPool, eventsOf, KEY, openAttempt, tool, waitFor } from "../collide/helpers.ts";

const POOL = "replay-kept";
const PLAIN = `${POOL}-plain`;
const FILE_PATH = "creatures/recorded.js";
const RECORDED = "export const RECORDED = 1;\n";
const LATER = "export const RECORDED = 2;\n";

describe("recorded pool repositories in local workerd", () => {
  let worker: LandingWorker;
  beforeAll(async () => {
    worker = await startLandingWorker({ ownerKey: KEY, repos: [POOL, PLAIN] });
  }, 60_000);
  afterAll(async () => worker?.dispose());

  async function land(version: 1 | 2): Promise<void> {
    const attempt = `recorded-${version}`;
    await openAttempt(worker, POOL, attempt, { intent: `Set the recorded value to ${version}` });
    if (version === 1) {
      await tool(worker, POOL, attempt, { tool: "write", args: { path: FILE_PATH, content: RECORDED } }, 1);
    } else {
      await tool(worker, POOL, attempt, { tool: "read", args: { path: FILE_PATH } }, 1);
      await tool(
        worker,
        POOL,
        attempt,
        { tool: "replace", args: { path: FILE_PATH, old: "RECORDED = 1", new: "RECORDED = 2" } },
        2,
      );
    }
    await tool(worker, POOL, attempt, { tool: "submit", args: { summary: `Record value ${version}` } }, 3);
    await waitFor(
      async () => (await eventsOf(worker, POOL, "landing.landed")).some((event) => event.seq === version),
      60_000,
    );
    await waitFor(
      async () => (await eventsOf(worker, POOL, "plain.updated")).some((event) => event.through_seq === version),
      60_000,
    );
  }

  it("RY10: recorded main and plain commits remain served after later landings and a Worker restart", async () => {
    await createPool(worker, POOL, { seed: "tidepool" });
    await land(1);
    const exported = await worker.fetch(`/api/pools/${POOL}/replay.ndjson?label=retained%20commits`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(exported.status).toBe(200);
    const lines = (await exported.text()).trimEnd().split("\n");
    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(header).toMatchObject({ premise_replay: 2, pool: POOL, events: lines.length - 1 });
    const recordedEvents = lines.slice(1).map((line) => JSON.parse(line) as Record<string, unknown>);
    const main = recordedEvents.findLast((event) => event.type === "landing.landed");
    const plain = recordedEvents.findLast((event) => event.type === "plain.updated");
    expect(main).toMatchObject({ seq: 1 });
    expect(plain).toMatchObject({ through_seq: 1, skipped: [], interrupted: [] });
    const mainCommit = String(main!.commit);
    const plainCommit = String(plain!.commit);
    expect(mainCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(plainCommit).toMatch(/^[0-9a-f]{40}$/);

    await land(2);
    expect(worker.refs(POOL).main).not.toBe(mainCommit);
    expect(worker.refs(PLAIN).main).not.toBe(plainCommit);
    for (const repo of [POOL, PLAIN]) {
      expect(gitBytes(worker.repoDir(repo), ["show", `main:${FILE_PATH}`]).toString("utf8")).toBe(LATER);
    }
    await worker.restart();

    // RY10's retained repositories back both frame addresses extracted from the recording.
    for (const address of [
      { repo: POOL, commit: mainCommit, segment: mainCommit, version: `c-${mainCommit}` },
      { repo: PLAIN, commit: plainCommit, segment: `p-${plainCommit}`, version: `p-${plainCommit}` },
    ]) {
      expect(gitBytes(worker.repoDir(address.repo), ["show", `${address.commit}:${FILE_PATH}`]).toString("utf8")).toBe(
        RECORDED,
      );
      const page = await worker.fetch(`/pool/${POOL}/${address.segment}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<canvas id="pool">');
      const file = await worker.fetch(`/pool/${POOL}/v/${address.version}/${FILE_PATH}`);
      expect(file.status).toBe(200);
      expect(await file.text()).toBe(RECORDED);
      expect(file.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    }
  }, 180_000);
});
