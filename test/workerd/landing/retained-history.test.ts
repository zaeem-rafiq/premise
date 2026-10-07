// LP4 and LP9: every reported landing stays in main's history, with its premise note,
// while real scripted Agents interleave retained engine calls and local git pushes.
import { expect, it } from "vitest";
import { git } from "../../git/helpers.ts";
import { bearer, createPool, KEY, waitFor } from "../collide/helpers.ts";
import { startLandingWorker } from "./harness.ts";

it("retains all 128 scripted Swarm landings and notes on the remote main", async () => {
  const pool = "retained-history";
  const agents = 128;
  const zero = "0".repeat(40);
  const worker = await startLandingWorker({ ownerKey: KEY, repos: [pool], swarm: true });
  const comparisons: Array<{ ref: string; old: string; actual: string }> = [];
  try {
    // Match the live soak's summary-only pool, without plain comparison pushes.
    await createPool(worker, pool, { summary_only: true });
    const directory = worker.repoDir(pool);
    const seedMain = git(directory, ["rev-parse", "refs/heads/main"]);
    worker.setGitFault((request) => {
      if (request.method === "POST" && request.path === `/${pool}/git-receive-pack`) {
        const refs = worker.refs(pool);
        for (const command of request.commands ?? []) {
          if (command.ref !== "refs/heads/main" && command.ref !== "refs/notes/premise") continue;
          comparisons.push({
            ref: command.ref,
            old: command.old,
            actual: (command.ref === "refs/heads/main" ? refs.main : refs.notes) ?? zero,
          });
        }
      }
      // Observe the old values before the real git server accepts or refuses them.
      return { action: "forward" };
    });
    const response = await worker.fetch(
      "/api/swarm",
      bearer({
        pool,
        seed: 7,
        agents,
        launch_per_second: 16,
        collision_dial: 0,
        think_ms: [10, 20],
        rescale_every_s: 60,
        running: true,
        request_id: "retained-history-run",
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    await waitFor(async () => {
      const events = await worker.events(pool);
      const paused = events.filter((event) => event.type === "pool.paused");
      if (paused.length > 0) {
        throw new Error(
          JSON.stringify({
            paused,
            accepted: events.filter((event) => event.type === "landing.accepted").length,
            landed: events.filter((event) => event.type === "landing.landed").length,
            commits_on_main: Number(git(directory, ["rev-list", "--count", `${seedMain}..refs/heads/main`])),
            stale_parents: comparisons.filter((comparison) => comparison.old !== comparison.actual),
          }),
        );
      }
      const finished = new Set(
        events
          .filter((event) => event.type === "attempt.state" && (event.to === "landed" || event.to === "stopped"))
          .map((event) => event.attempt_id),
      );
      return finished.size === agents;
    }, 240_000);

    const events = await worker.events(pool);
    const landed = events
      .filter((event) => event.type === "landing.landed")
      .sort((a, b) => Number(a.seq) - Number(b.seq));
    expect(events.filter((event) => event.type === "pool.paused")).toEqual([]);
    expect(events.filter((event) => event.type === "landing.accepted")).toHaveLength(agents);
    expect(landed).toHaveLength(agents);
    expect(landed.map((event) => Number(event.seq))).toEqual(Array.from({ length: agents }, (_, i) => i + 1));
    expect(new Set(landed.map((event) => event.commit)).size).toBe(agents);
    expect(comparisons.filter((comparison) => comparison.ref === "refs/heads/main").length).toBeGreaterThan(1);
    expect(comparisons.filter((comparison) => comparison.old !== comparison.actual)).toEqual([]);

    // A count alone misses a replaced prefix. The entire ordered chain must contain
    // exactly one commit for every landing, in the sequence Trunk announced.
    const commits = git(directory, ["rev-list", "--reverse", `${seedMain}..refs/heads/main`]).split("\n");
    expect(commits).toEqual(landed.map((event) => event.commit));
    const notes = git(directory, ["notes", "--ref=premise", "list"]).split("\n").sort();
    expect(notes).toEqual(landed.map((event) => `${event.note} ${event.commit}`).sort());
    expect(() => git(directory, ["fsck", "--strict"])).not.toThrow();
  } finally {
    await worker.dispose();
  }
}, 300_000);
