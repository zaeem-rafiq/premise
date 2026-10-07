// Slice 6 (01-core 11.7, PM1-PM7; 02-tidepool 7.8, 9.3's pairs P4/P5, TP20) in local workerd:
// the plain-merge pool `<pool>-plain`, built by Trunk's `plain` timer after every landing push,
// pushed through the same real `git http-backend` remote, and announced with `plain.updated`.
//
//   hero   — the hero conflict of 02-tidepool 7, landing order 1, on the canned casts and the
//            `tidepool` seed: the plain remote holds `ENERGY_MAX = 1`, `crab.energy < 30`,
//            `drain(shrimp, 5)`; `interrupted` lists C and H (PM4); `skipped` is empty (PM3);
//            `tree` is `git rev-parse <commit>^{tree}` on the remote; `pool.state` carries
//            `plain_remote`; `git fsck --strict` passes (plan 2.7 items 2, 3 and 4).
//   P4     — two `replace` calls on the same `DAY_TICKS` line: the later change is skipped and
//            counted (PM3); its ops_first makes it interrupted too (PM4).
//   P5     — a `same-file` pair writes the same `creatures/d<n>.js`: the later `write` is
//            counted too (PM3, PM5's sibling case of 9.3).
//   PM7    — a change that replays exactly as it landed: `plain.updated.tree` equals
//            `landing.landed.tree` of `through_seq` (TP20 is built on this fact).
//   retry  — a refused plain push is retried on the push backoff while the pool keeps landing
//            (`pool_state` stays `ready`; the refusal is never a `pool.paused`).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "../../git/helpers.ts";
import { startLandingWorker, type LandingWorker } from "../landing/harness.ts";
import { createPool, deliver, eventsOf, KEY, launch, openAttempt, release, tool, waitFor } from "../collide/helpers.ts";

type Ev = Record<string, unknown>;

const plainRepo = (pool: string) => `${pool}-plain`;

/** The pool's `plain.updated` events, in stream order. */
function plainsOf(worker: LandingWorker, pool: string): Promise<Ev[]> {
  return eventsOf(worker, pool, "plain.updated");
}

/** Wait for a `plain.updated` covering `seq` (a batch pushes once per landing batch, so the
 * event fires once per covered range — the run of interest is the one naming `seq`). */
async function waitPlain(worker: LandingWorker, pool: string, seq: number): Promise<Ev> {
  await waitFor(async () => (await plainsOf(worker, pool)).some((e) => Number(e.through_seq) === seq), 60_000);
  return (await plainsOf(worker, pool)).find((e) => Number(e.through_seq) === seq)!;
}

/** `landing.landed` rows as `{seq, attempt}` pairs (the attempt id is read off the note). */
async function landedSeqs(
  worker: LandingWorker,
  pool: string,
): Promise<Array<{ seq: number; attempt: string | null }>> {
  return (await eventsOf(worker, pool, "landing.landed")).map((e) => {
    const note = typeof e.note_json === "string" ? (JSON.parse(e.note_json) as { attempt?: { id?: string } }) : null;
    return { seq: Number(e.seq), attempt: note?.attempt?.id ?? null };
  });
}

/** The Floor's last `pool.state` for the pool (its `plain_remote` is PM6's carrier to AS17). */
async function lastPoolState(worker: LandingWorker, pool: string): Promise<Ev | undefined> {
  const states = await eventsOf(worker, pool, "pool.state");
  return states[states.length - 1];
}

/** Tap `land` on the pool's open held card — the card route the conductor uses (7.11 step 4). */
async function tapLand(worker: LandingWorker, pool: string): Promise<void> {
  const cards = await eventsOf(worker, pool, "card.opened");
  const open = cards.map((e) => (e as { card: { card_id: string; submit_ids: Record<string, string> } }).card).at(-1);
  expect(open, `${pool}: no card.opened to tap`).toBeTruthy();
  const res = await worker.fetch(`/api/pools/${pool}/cards/${open!.card_id}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      option: "land",
      submit_ids: open!.submit_ids,
      request_id: `r-land-${pool}-${open!.card_id}`,
    }),
  });
  expect(res.status, `tap land on ${pool}: ${await res.clone().text()}`).toBe(200);
}

describe("the plain-merge pool (11.7) in local workerd", () => {
  let worker: LandingWorker;

  beforeAll(async () => {
    worker = await startLandingWorker({
      ownerKey: KEY,
      swarm: true,
      repos: [
        "hero-p",
        plainRepo("hero-p"),
        "clean-p",
        plainRepo("clean-p"),
        "p4-p",
        plainRepo("p4-p"),
        "p5-p",
        plainRepo("p5-p"),
        // A summary-only pool: no plain-merge repository is made for it (11.7 amended).
        "sum-p",
      ],
    });
  }, 240_000);

  afterAll(async () => {
    await worker?.dispose();
  });

  it("hero, landing order 1: the plain remote holds the pre-repair files; PM4 marks C and H (PM6, 7.8, plan 2.7 items 2-4)", async () => {
    await createPool(worker, "hero-p", { seed: "tidepool" });

    // 7.11's rows 1-2: the creatures first, their submits held; then the shared rule.
    const ids = await launch(worker, "hero-p", ["hero-j", "hero-c", "hero-h"], {
      hold: ["hero-j", "hero-c", "hero-h"],
    });
    const jId = ids[0]!;
    const cId = ids[1]!;
    const hId = ids[2]!;
    await waitFor(async () => {
      const ops = await eventsOf(worker, "hero-p", "op.recorded");
      const written = new Set(ops.map((e) => String(e.path)));
      return written.has("creatures/crab.js") && written.has("creatures/shrimp.js");
    }, 60_000);
    await launch(worker, "hero-p", ["hero-s"]);
    await waitFor(async () => (await eventsOf(worker, "hero-p", "card.opened")).length >= 1, 60_000);

    // Row 4: Land — S lands; C and H take their E2 repairs (ops_first frozen before the drop).
    await tapLand(worker, "hero-p");
    await waitFor(async () => {
      const repairs = (await eventsOf(worker, "hero-p", "headsup.sent")).filter((e) => e.result === "repair");
      const to = new Set(repairs.map((e) => String(e.attempt_id)));
      return to.has(cId) && to.has(hId);
    }, 60_000);
    await waitFor(async () => (await landedSeqs(worker, "hero-p")).length >= 1, 60_000);

    // Row 5: release — C, H and J land; the `plain` timer then runs the replay and pushes.
    await release(worker, "hero-p", ["hero-c", "hero-h", "hero-j"]);
    await waitFor(async () => (await landedSeqs(worker, "hero-p")).length >= 4, 60_000);
    const updated = await waitPlain(worker, "hero-p", 4);
    const landed = await landedSeqs(worker, "hero-p");
    const seqOf = (attempt: string) => landed.find((l) => l.attempt === attempt)!.seq;
    expect(landed, "S, C, H, J all landed").toHaveLength(4);
    expect(Number(updated.through_seq)).toBe(4);

    // PM3: every landing replayed — the text-conflict count is empty (7.8).
    expect(updated.skipped).toEqual([]);
    // PM4: C and H had not passed a submit when S's landing wrote their `ops_first` rows.
    expect(updated.interrupted).toEqual([seqOf(cId), seqOf(hId)].sort((a, b) => a - b));

    // The commit the event names is `main` of `<pool>-plain`, and its tree is the remote's own.
    const dir = worker.repoDir(plainRepo("hero-p"));
    const remoteMain = worker.refs(plainRepo("hero-p")).main;
    expect(remoteMain, "plain remote main").toBe(String(updated.commit));
    expect(git(dir, ["rev-parse", `${remoteMain}^{tree}`])).toBe(String(updated.tree));

    // Stock git on the remote shows the un-checked world (7.8): the fraction ENERGY_MAX with
    // the point-scale creatures — crab.energy < 30 and drain(shrimp, 5).
    expect(git(dir, ["show", "main:world/energy.js"])).toContain("export const ENERGY_MAX = 1;");
    expect(git(dir, ["show", "main:creatures/crab.js"])).toContain("crab.energy < 30");
    expect(git(dir, ["show", "main:creatures/shrimp.js"])).toContain("drain(shrimp, 5)");
    expect(git(dir, ["show", "main:creatures/jellyfish.js"])).toContain('const BELL = "purple"');

    // PM6's `plain_remote` reaches `pool.state` (EM1), and the remote is a healthy repository.
    expect(String((await lastPoolState(worker, "hero-p"))?.plain_remote)).toBe(worker.remoteFor(plainRepo("hero-p")));
    expect(() => git(dir, ["fsck", "--strict"])).not.toThrow();
  }, 240_000);

  it("11.7: a summary-only pool (a Swarm pool) builds no plain-merge pool", async () => {
    // Its Floor shows no Compare view, and replaying every landing from the seed after each
    // push kept a busy Swarm pool's Trunk from its pushes (2026-10-05). The stand-in has no
    // `sum-p-plain` repository: a build would fail its push and leave a `trunk.error`.
    await createPool(worker, "sum-p", { seed: "tidepool", summary_only: true });
    await launch(worker, "sum-p", ["add-plain"], { request_id: "r-launch-sum-p" });
    await waitFor(async () => (await landedSeqs(worker, "sum-p")).length >= 1, 60_000);
    for (let i = 0; i < 5; i += 1) await worker.runAlarm("sum-p", Date.now() + 60_000);
    expect(await plainsOf(worker, "sum-p")).toEqual([]);
    const plainErrors = (await eventsOf(worker, "sum-p", "trunk.error")).filter((e) =>
      String(e.where).includes("plain"),
    );
    expect(plainErrors).toEqual([]);
    expect((await lastPoolState(worker, "sum-p"))?.plain_remote ?? null).toBeNull();
  }, 180_000);

  it("PM7/TP20: a change that replays as it landed gives `tree` = `landing.landed.tree` of `through_seq`", async () => {
    await createPool(worker, "clean-p", { seed: "tidepool" });
    await launch(worker, "clean-p", ["add-plain"], { request_id: "r-launch-clean-p" });
    await waitFor(async () => (await landedSeqs(worker, "clean-p")).length >= 1, 60_000);
    const updated = await waitPlain(worker, "clean-p", 1);
    const landed = await landedSeqs(worker, "clean-p");
    const last = landed.at(-1)!;
    const landedEv = (await eventsOf(worker, "clean-p", "landing.landed")).find((e) => Number(e.seq) === last.seq)!;
    expect(Number(updated.through_seq)).toBe(last.seq);
    expect(String(updated.tree)).toBe(String(landedEv.tree));
    expect(updated.skipped).toEqual([]);
    expect(updated.interrupted).toEqual([]);
  }, 180_000);

  it("P4 (9.3): two `replace` calls on `DAY_TICKS` — the later change is skipped and counted (PM3)", async () => {
    await createPool(worker, "p4-p", { seed: "tidepool" });
    // B holds a stale `replace` while A's lands first — B's E1 repair freezes its ops_first.
    await openAttempt(worker, "p4-p", "p4-b", { intent: "make the day a third longer" });
    await tool(worker, "p4-p", "p4-b", { tool: "read", args: { path: "world/time.js", entity: "DAY_TICKS" } }, 1);
    await tool(
      worker,
      "p4-p",
      "p4-b",
      { tool: "replace", args: { path: "world/time.js", old: "DAY_TICKS = 3600", new: "DAY_TICKS = 4800" } },
      2,
    );
    await openAttempt(worker, "p4-p", "p4-a", { intent: "make the day shorter" });
    await tool(worker, "p4-p", "p4-a", { tool: "read", args: { path: "world/time.js", entity: "DAY_TICKS" } }, 1);
    await tool(
      worker,
      "p4-p",
      "p4-a",
      { tool: "replace", args: { path: "world/time.js", old: "DAY_TICKS = 3600", new: "DAY_TICKS = 2400" } },
      2,
    );
    await tool(worker, "p4-p", "p4-a", { tool: "submit", args: { summary: "DAY_TICKS 3600 to 2400" } }, 3);
    await waitFor(async () => (await eventsOf(worker, "p4-p", "card.opened")).length >= 1, 60_000);
    await tapLand(worker, "p4-p"); // `world/` is the held tier on `tidepool`
    await waitFor(async () => (await landedSeqs(worker, "p4-p")).length >= 1, 60_000);

    // The repair heads-up reached p4-b (its ops_first holds the stale `3600 -> 4800` replace);
    // it reads the moved file, replaces from the new value, submits and lands behind a card.
    await waitFor(
      async () =>
        (await eventsOf(worker, "p4-p", "headsup.sent")).some((e) => e.attempt_id === "p4-b" && e.result === "repair"),
      60_000,
    );
    // TA3: every call past a heads-up carries `ack`; the submit acknowledges it (4.9, CK1).
    await deliver(worker, "p4-p", "p4-b");
    await tool(worker, "p4-p", "p4-b", { tool: "read", args: { path: "world/time.js", entity: "DAY_TICKS" } }, 3, 1);
    await tool(
      worker,
      "p4-p",
      "p4-b",
      { tool: "replace", args: { path: "world/time.js", old: "DAY_TICKS = 2400", new: "DAY_TICKS = 4800" } },
      4,
      1,
    );
    await tool(
      worker,
      "p4-p",
      "p4-b",
      {
        tool: "submit",
        args: { summary: "DAY_TICKS to 4800", acknowledge: [1], statement: "replaced against the moved value" },
      },
      5,
      1,
    );
    await waitFor(async () => (await eventsOf(worker, "p4-p", "card.opened")).length >= 2, 60_000);
    await tapLand(worker, "p4-p");
    await waitFor(async () => (await landedSeqs(worker, "p4-p")).length >= 2, 60_000);
    const updated = await waitPlain(worker, "p4-p", 2);

    // PM3: the second change's ops_first `replace` names text the first change rewrote — a text
    // conflict; the whole change is skipped and counted. PM4 marks it interrupted too: its
    // ops_first predates its first submit.
    expect(Number(updated.through_seq)).toBe(2);
    expect(updated.skipped).toEqual([2]);
    expect(updated.interrupted).toEqual([2]);
    // And on the remote: `main` still shows the first change's value, the second's is absent.
    const time = git(worker.repoDir(plainRepo("p4-p")), ["show", "main:world/time.js"]);
    expect(time).toContain("DAY_TICKS = 2400");
    expect(time).not.toContain("DAY_TICKS = 4800");
  }, 240_000);

  it("P5 (9.3): two `write` calls on the same new path — the later `write` has a moved base and is counted too (PM3)", async () => {
    await createPool(worker, "p5-p", { seed: "tidepool" });
    // p5-b pins `write creatures/p5.js` at `absent` while in flight; p5-a lands the same path
    // first. The F1 repair freezes p5-b's ops_first — the plain replay then conflicts on it.
    await openAttempt(worker, "p5-p", "p5-b", { intent: "a creature at p5.js" });
    await tool(
      worker,
      "p5-p",
      "p5-b",
      { tool: "write", args: { path: "creatures/p5.js", content: "export const WHO = 'b';\n" } },
      1,
    );
    await openAttempt(worker, "p5-p", "p5-a", { intent: "a creature at p5.js" });
    await tool(
      worker,
      "p5-p",
      "p5-a",
      { tool: "write", args: { path: "creatures/p5.js", content: "export const WHO = 'a';\n" } },
      1,
    );
    await tool(worker, "p5-p", "p5-a", { tool: "submit", args: { summary: "add p5.js" } }, 2);
    await waitFor(async () => (await landedSeqs(worker, "p5-p")).length >= 1, 60_000);
    await waitFor(
      async () =>
        (await eventsOf(worker, "p5-p", "headsup.sent")).some((e) => e.attempt_id === "p5-b" && e.result === "repair"),
      60_000,
    );

    // p5-b takes the F1 repair: the write that lost the name is dropped, a new path is written.
    await deliver(worker, "p5-p", "p5-b");
    await tool(
      worker,
      "p5-p",
      "p5-b",
      { tool: "write", args: { path: "creatures/p5-b.js", content: "export const WHO = 'b';\n" } },
      2,
      1,
    );
    await tool(
      worker,
      "p5-p",
      "p5-b",
      { tool: "submit", args: { summary: "add p5-b.js", acknowledge: [1], statement: "name taken; moved" } },
      3,
      1,
    );
    await waitFor(async () => (await landedSeqs(worker, "p5-p")).length >= 2, 60_000);
    const updated = await waitPlain(worker, "p5-p", 2);

    // PM3: the second change's ops_first `write` names a base that moved — a text conflict;
    // the whole change is skipped and counted. PM4 marks it interrupted too (ops_first predates
    // its first submit). The plain remote keeps `p5.js` only — `p5-b.js` never exists there.
    expect(Number(updated.through_seq)).toBe(2);
    expect(updated.skipped).toEqual([2]);
    expect(updated.interrupted).toEqual([2]);
    const dir = worker.repoDir(plainRepo("p5-p"));
    expect(git(dir, ["show", "main:creatures/p5.js"])).toContain("WHO = 'a'");
    const names = git(dir, ["ls-tree", "-r", "--name-only", "main", "--", "creatures/"])
      .split("\n")
      .filter((n) => /p5/.test(n));
    expect(names).toEqual(["creatures/p5.js"]);
  }, 240_000);

  it("PM6/PM7: a refused plain push retries on the push backoff and never pauses the pool (plan 2.7 item 6)", async () => {
    // Reuse clean-p (one landing already replayed). Refuse every push to clean-p-plain until
    // the counter lets one through — the receive-pack POST is the push itself.
    const repo = plainRepo("clean-p");
    let refused = 0;
    worker.setGitFault((request) => {
      if (request.method === "POST" && request.path.includes(`/${repo}/git-receive-pack`) && refused < 2) {
        refused += 1;
        return { action: "answer", status: 503 };
      }
      return { action: "forward" };
    });
    try {
      // A second clean change lands and pushes normally — the plain push is refused twice.
      await openAttempt(worker, "clean-p", "clean-b", { intent: "add a second clean creature" });
      await tool(
        worker,
        "clean-p",
        "clean-b",
        { tool: "write", args: { path: "creatures/clean-b.js", content: "export const CLEAN_B = 2;\n" } },
        1,
      );
      await tool(worker, "clean-p", "clean-b", { tool: "submit", args: { summary: "add clean-b" } }, 2);
      await waitFor(async () => (await landedSeqs(worker, "clean-p")).length >= 2, 60_000);

      // The plain timer fires (real alarm or this drive), the push is refused, and the job's
      // own retry row — not the pool's — carries the failure. Give the real alarms a moment,
      // then drive the backoff explicitly so the retry is observed within the test.
      const t0 = Date.now();
      for (let i = 0; i < 8 && (await plainsOf(worker, "clean-p")).every((e) => Number(e.through_seq) < 2); i += 1) {
        await worker.runAlarm("clean-p", t0 + 60_000 * (i + 1));
        await new Promise((r) => setTimeout(r, 250));
      }
      const updated = await waitPlain(worker, "clean-p", 2);

      // The pool kept landing and never paused: no `pool.paused`, `pool_state` still `ready`,
      // and the refusal shows only as `trunk.error` events against `plain`.
      const meta = (await worker.trunk("clean-p").state()).meta as Record<string, unknown>;
      expect(String(meta.pool_state)).toBe("ready");
      expect(await eventsOf(worker, "clean-p", "pool.paused")).toEqual([]);
      expect(refused, "the fault refused two plain pushes").toBe(2);
      const pushes = worker
        .gitRequests()
        .filter((r) => r.method === "POST" && r.path.includes(`/${repo}/git-receive-pack`));
      expect(pushes.length, "the refused pushes plus the retries that followed").toBeGreaterThanOrEqual(3);
      const errors = (await eventsOf(worker, "clean-p", "trunk.error")).filter((e) => e.where === "plain");
      expect(errors.length).toBeGreaterThanOrEqual(1);

      expect(worker.refs(repo).main).toBe(String(updated.commit));
    } finally {
      worker.setGitFault(null);
    }
  }, 240_000);
});
