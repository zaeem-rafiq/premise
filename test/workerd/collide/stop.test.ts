// Plan item 8 (E1, OP1, TA9, TA9a): two `rescale-energy` agents are in flight, the first
// lands, and the second — whose own edit premise on `ENERGY_MAX` the landing broke — answers
// its `repair` (E1) heads-up with `stop` `withdrawn`. The stream shows `attempt.state` to
// `stopped` with reason `withdrawn` and no card names the attempt; a repeated `stop` answers
// `ok` with the stored reason (TA9 idempotence).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "../../git/helpers.ts";
import { startLandingWorker, type LandingWorker } from "../landing/harness.ts";
import { createPool, eventsOf, KEY, launch, release, stop, waitFor } from "./helpers.ts";

const POOL = "stop-pool";
const ENERGY_KEY = "world/energy.js#ENERGY_MAX";

describe("item 8 (E1, TA9, TA9a): the losing rescale ends its own attempt through stop", () => {
  let worker: LandingWorker;
  let landed: string;
  let loser: string;

  beforeAll(async () => {
    worker = await startLandingWorker({ ownerKey: KEY, repos: [POOL] });
    await createPool(worker, POOL);
    const launched = await launch(worker, POOL, ["rescale-energy", "rescale-energy"], {
      hold: ["rescale-energy"],
      request_id: "r-launch-stop",
    });
    expect(launched).toHaveLength(2);
    // Both agents read and write their `replace` before the submit gate: each `op.recorded`
    // on `world/energy.js` is the signal that its edit premise stands.
    await waitFor(
      async () =>
        (await worker.events(POOL)).filter(
          (e) => e.type === "op.recorded" && e.path === "world/energy.js" && launched.includes(e.attempt_id as string),
        ).length >= 2,
      60_000,
    );
    await release(worker, POOL, ["rescale-energy"]);
    await waitFor(async () => (await eventsOf(worker, POOL, "landing.landed")).length >= 1, 60_000);
    await waitFor(
      async () =>
        (await eventsOf(worker, POOL, "attempt.state")).some(
          (e) => e.to === "stopped" && launched.includes(e.attempt_id as string),
        ),
      60_000,
    );
    const landedEvt = (await eventsOf(worker, POOL, "landing.landed"))[0] as { attempt_id: string };
    landed = landedEvt.attempt_id;
    loser = launched.find((id) => id !== landed) as string;
  }, 180_000);

  afterAll(async () => {
    await worker?.dispose();
  });

  it("one rescale landed; the remote holds ENERGY_MAX = 1", () => {
    const source = git(worker.repoDir(POOL), ["show", "refs/heads/main:world/energy.js"]);
    expect(source).toContain("ENERGY_MAX = 1");
  });

  it("the loser received `repair` with E1 and its dropped op carries OP1", async () => {
    const sent = (await eventsOf(worker, POOL, "headsup.sent")).filter((e) => e.attempt_id === loser);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.result).toBe("repair");
    expect(sent[0]?.keys).toContainEqual({ kind: "entity", key: ENERGY_KEY, rule: "E1", cause_seq: 1 });
    expect(sent[0]?.dropped_ops).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "world/energy.js", rule: "OP1" })]),
    );
  });

  it("the loser is `stopped` with `withdrawn` (TA9) and no card names it (TA9a)", async () => {
    const stopped = (await eventsOf(worker, POOL, "attempt.state")).filter(
      (e) => e.attempt_id === loser && e.to === "stopped",
    );
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.reason).toBe("withdrawn");

    // TA9a: a `stop` opens no card — every card event leaves this attempt unnamed.
    for (const e of await worker.events(POOL)) {
      if (typeof e.type === "string" && e.type.startsWith("card.")) {
        const ids =
          (e.attempt_ids as string[] | undefined) ?? (e.card as { attempt_ids?: string[] })?.attempt_ids ?? [];
        expect(ids).not.toContain(loser);
      }
    }
  });

  it("a repeated stop answers ok with the stored reason (TA9 idempotence)", async () => {
    const again = await stop(worker, POOL, loser, "withdrawn");
    expect(again).toMatchObject({ ok: true, stop_reason: "withdrawn" });
    // And the stored answer did not move: still exactly one transition to stopped.
    const stopped = (await eventsOf(worker, POOL, "attempt.state")).filter(
      (e) => e.attempt_id === loser && e.to === "stopped",
    );
    expect(stopped).toHaveLength(1);
  });
});
