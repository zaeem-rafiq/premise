// Offline workerd proof of a retained pool across tools, a conflicting landing, delivery and
// withdrawal. Relate landing events through seq: only landing.accepted carries attempt_id.
import { expect, it } from "vitest";
import { startLandingWorker } from "../../workerd/landing/harness.ts";
import { createPool, eventsOf, KEY, launch, release, stop, waitFor } from "../../workerd/collide/helpers.ts";

it("a retained Trunk lands one rescale and delivers E1 to the other across shell writes", async () => {
  const pool = "scale-cached-conflict";
  const worker = await startLandingWorker({ ownerKey: KEY, repos: [pool] });
  try {
    await createPool(worker, pool);
    const attempts = await launch(worker, pool, ["rescale-energy", "rescale-energy"], {
      hold: ["rescale-energy"],
      request_id: "scale-conflict",
    });
    expect(attempts).toHaveLength(2);
    await waitFor(
      async () =>
        (await eventsOf(worker, pool, "op.recorded")).filter(
          (event) => event.path === "world/energy.js" && attempts.includes(String(event.attempt_id)),
        ).length >= 2,
      60_000,
    );
    await release(worker, pool, ["rescale-energy"]);
    await waitFor(async () => (await eventsOf(worker, pool, "landing.landed")).length >= 1, 60_000);
    await waitFor(
      async () =>
        (await eventsOf(worker, pool, "attempt.state")).some(
          (event) => event.to === "stopped" && attempts.includes(String(event.attempt_id)),
        ),
      60_000,
    );
    const landed = await eventsOf(worker, pool, "landing.landed");
    expect(landed).toHaveLength(1);
    const accepted = (await eventsOf(worker, pool, "landing.accepted")).find((event) => event.seq === landed[0]!.seq);
    expect(accepted).toBeDefined();
    expect(attempts).toContain(accepted!.attempt_id);
    const loser = attempts.find((id) => id !== accepted!.attempt_id)!;
    const heads = (await eventsOf(worker, pool, "headsup.sent")).filter((event) => event.attempt_id === loser);
    expect(heads).toHaveLength(1);
    expect(heads[0]).toMatchObject({ result: "repair" });
    expect(heads[0]!.keys).toContainEqual({ kind: "entity", key: "world/energy.js#ENERGY_MAX", rule: "E1" });
    expect(heads[0]!.dropped_ops).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "world/energy.js", rule: "OP1" })]),
    );
    const stopped = (await eventsOf(worker, pool, "attempt.state")).filter(
      (event) => event.attempt_id === loser && event.to === "stopped",
    );
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.reason).toBe("withdrawn");
    expect(await stop(worker, pool, loser, "withdrawn")).toMatchObject({ ok: true, stop_reason: "withdrawn" });
    for (const event of await worker.events(pool)) {
      if (String(event.type).startsWith("card.")) {
        const ids =
          (event.attempt_ids as string[] | undefined) ?? (event.card as { attempt_ids?: string[] })?.attempt_ids ?? [];
        expect(ids).not.toContain(loser);
      }
    }
  } finally {
    await worker.dispose();
  }
});
