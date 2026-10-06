// Slice 11 acceptance 1-2 / 02 Appendix A9: real Trunk+Agent+Floor in local workerd,
// the real tidepool seed, the canned S/C/H cast, and stock-git remote assertions.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "../../git/helpers.ts";
import { startLandingWorker, type LandingWorker } from "../../workerd/landing/harness.ts";
import { createPool, eventsOf, KEY, launch, release, waitFor } from "../../workerd/collide/helpers.ts";
import { tap, waitCard, waitLanding } from "../../workerd/held/helpers.ts";

const pool = "held-cast";

describe("Slice 11: held S with C and H in flight (02 Appendix A9)", () => {
  let worker: LandingWorker;
  beforeAll(async () => {
    worker = await startLandingWorker({ ownerKey: KEY, held: true, repos: [pool, `${pool}-plain`] });
  });
  afterAll(async () => worker?.dispose());

  it("opens with repair [C, H] and a remote preview; Land lands S and repairs both creatures", async () => {
    await createPool(worker, pool, { seed: "tidepool" });
    const before = worker.refs(pool).main!;
    const [c, h] = await launch(worker, pool, ["hero-c", "hero-h"], { hold: ["hero-c", "hero-h"] });
    await waitFor(async () => {
      const writes = (await eventsOf(worker, pool, "op.recorded")).map((e) => e.path);
      return writes.includes("creatures/crab.js") && writes.includes("creatures/shrimp.js");
    }, 30_000);
    const [s] = await launch(worker, pool, ["hero-s"]);
    const card = await waitCard(worker, pool, (candidate) => candidate.preview?.after[s!] !== undefined);
    expect(card.blast_radius[s!]).toEqual({ repair: [c, h].sort(), confirm: [], triage: [], right_of_way: [] });
    expect(card.body.join(" ")).toContain("Landing this sends 2 changes back to their agents:");
    expect(card.preview!.before).toEqual({ repo: "main", commit: before });
    expect(card.options.map((o) => o.id)).toEqual(["land", "decline"]);
    const preview = card.preview!.after[s!]!.commit;
    const ref = `refs/previews/${card.submit_ids[s!]}`;
    expect(git(worker.repoDir(`${pool}-plain`), ["rev-parse", ref])).toBe(preview);
    const frame = await worker.fetch(`/pool/${pool}/p-${preview}/`);
    expect(frame.status).toBe(200);
    const file = await worker.fetch(`/pool/${pool}/v/p-${preview}/world/energy.js`);
    expect(file.status).toBe(200);
    expect(await file.text()).toContain("export const ENERGY_MAX = 1;");
    expect(await eventsOf(worker, pool, "landing.landed")).toEqual([]);

    await tap(worker, pool, card, "land");
    await waitLanding(worker, pool);
    await waitFor(async () => {
      const recipients = (await eventsOf(worker, pool, "headsup.sent"))
        .filter((e) => e.result === "repair")
        .map((e) => e.attempt_id);
      return recipients.includes(c) && recipients.includes(h);
    }, 30_000);
    for (const attempt of [c, h]) {
      const repair = (await eventsOf(worker, pool, "headsup.sent")).find(
        (e) => e.attempt_id === attempt && e.result === "repair",
      );
      expect(repair).toMatchObject({
        result: "repair",
        items: [{ premise: { kind: "entity", key: "world/energy.js#ENERGY_MAX" }, rule: "E2", result: "repair" }],
      });
      expect(repair!.items as unknown[]).toHaveLength(1); // H's F3 is folded by HU2a.
    }
    const closed = (await eventsOf(worker, pool, "card.closed")).find((e) => e.card_id === card.card_id);
    expect(closed).toMatchObject({ action: "land", by: "owner", attempt_id: null, reason: null });
    const firstLanding = (await eventsOf(worker, pool, "landing.landed"))[0]!;
    const note = JSON.parse(String(firstLanding.note_json));
    expect(note.attempt.id).toBe(s);
    expect(note.policy).toMatchObject({ tier: "held", approved_by: "owner", option: "land" });
    expect(note.policy.approved_at).not.toBeNull();
    expect(git(worker.repoDir(`${pool}-plain`), ["rev-parse", ref])).toBe(preview);

    await release(worker, pool, ["hero-c", "hero-h"]);
    await waitFor(async () => (await eventsOf(worker, pool, "landing.landed")).length === 3, 30_000);
    const dir = worker.repoDir(pool);
    expect(git(dir, ["show", "main:world/energy.js"])).toContain("ENERGY_MAX = 1;");
    expect(git(dir, ["show", "main:creatures/crab.js"])).toContain("crab.energy < 0.3");
    expect(git(dir, ["show", "main:creatures/shrimp.js"])).toContain("drain(shrimp, 0.05)");
    for (const attempt of [c, h]) {
      expect(
        (await eventsOf(worker, pool, "attempt.state")).find((e) => e.attempt_id === attempt && e.to === "landed"),
      ).toMatchObject({ go_arounds: 1 });
    }
  });
});
