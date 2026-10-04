// Plan items 2 to 6 (T9, E2, QR1, HU5b, SWR3, SW2, EV6): the colliding scripted Agents of
// 02-tidepool 10.3, end to end in local workerd — real Agent Durable Objects on real patterns,
// a real bare git remote, and the swarm's `hold_before_submit`/`release` (SWR3) holding the
// second agent while the first lands into it.
//
//   order 1  add-energy held after its write; rescale-energy lands -> an E2 `repair`
//            reaches the held attempt (T9 going_around); release; the threshold is
//            rescaled to 0.3 x the new ENERGY_MAX and the change lands (SW2 on the remote)
//   order 2  rescale-energy held; add-energy lands -> a QR1 `repair` names the new
//            referrer; release; the stale threshold files are rescaled and it lands
//   items 4/5  add-plain in flight is never heads-up'd; a `cosmetic` landing sends no
//            heads-up; add-relative answers its E2 with no edit (`changed: false`)
//   item 6   order 1 on a `summary_only` pool: same `keys`, `items: null`,
//            `note_json: null`, and none of `premise.recorded`, `op.recorded`,
//            `attempt.step` on the stream (EV6)

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "../../git/helpers.ts";
import { sw2Escapes } from "../../../src/swarm/sw2.ts";
import { startLandingWorker, type LandingWorker } from "../landing/harness.ts";
import { createPool, eventsOf, launch, release, waitFor } from "./helpers.ts";

const KEY = "owner-key-for-tests-0123456789abcdef";
const ENERGY_KEY = "world/energy.js#ENERGY_MAX";

type Ev = Record<string, unknown>;

function headsSent(events: Ev[], attempt: string): Ev[] {
  return events.filter((e) => e.type === "headsup.sent" && e.attempt_id === attempt);
}

/** The remote's whole tree at `ref`, for the SW2 oracle. */
function remoteFiles(worker: LandingWorker, pool: string, ref: string): Map<string, string> {
  const dir = worker.repoDir(pool);
  const files = new Map<string, string>();
  for (const path of git(dir, ["ls-tree", "-r", "--name-only", ref]).split("\n").filter(Boolean)) {
    files.set(path, git(dir, ["show", `${ref}:${path}`]));
  }
  return files;
}

describe("items 2 to 5: the two orders and the undisturbed, in local workerd", () => {
  let worker: LandingWorker;

  beforeAll(async () => {
    worker = await startLandingWorker({
      ownerKey: KEY,
      repos: ["o1", "o2", "o3", "o4", "o5"],
      swarm: true,
    });
    for (const pool of ["o1", "o2", "o3", "o4"]) await createPool(worker, pool);
    // Item 6's pool: `summary_only` bounds the stream (EV6).
    await createPool(worker, "o5", { summary_only: true });
  }, 240_000);

  afterAll(async () => {
    await worker?.dispose();
  });

  it("item 2, order 1: add-energy held, rescale lands, the E2 repair is answered and lands (T9, HU5b, SWR3, SW2)", async () => {
    const pool = "o1";
    // SWR2 + SWR3's hold: the add-energy agent writes, then waits before its submit.
    const [add] = await launch(worker, pool, ["add-energy"], { hold: ["add-energy"] });
    const a = add!;
    // The `op.recorded` of its `write` is the signal that it has written (the plan's wait).
    await waitFor(
      async () => (await eventsOf(worker, pool, "op.recorded")).some((e) => e.attempt_id === a && e.op === "write"),
      60_000,
    );

    // rescale-energy lands: ENERGY_MAX 100 -> 1 breaks the held attempt's used entity (E2).
    await launch(worker, pool, ["rescale-energy"]);
    await waitFor(async () => (await eventsOf(worker, pool, "landing.landed")).length >= 1, 60_000);
    let sent: Ev | undefined;
    await waitFor(async () => {
      sent = headsSent(await worker.events(pool), a)[0];
      return sent !== undefined;
    }, 60_000);
    sent = sent!;
    expect(sent).toMatchObject({ attempt_id: a, result: "repair" });
    expect(sent.keys).toEqual([{ kind: "entity", key: ENERGY_KEY, rule: "E2" }]);
    const item = (sent.items as Array<Record<string, unknown>>)[0]!;
    const diff = item.diff as { before?: string; after?: string };
    expect(diff.before).toContain("ENERGY_MAX = 100");
    expect(diff.after).toContain("ENERGY_MAX = 1");

    await waitFor(
      async () =>
        (await eventsOf(worker, pool, "attempt.state")).some(
          (e) => e.attempt_id === a && e.to === "going_around" && e.go_arounds === 1,
        ),
      30_000,
    );

    // SWR3: the release lets the held agent answer the repair — a `replace` of its own
    // threshold, then the acknowledge on its submit (`headsup.resolved`, changed: true).
    await release(worker, pool, ["add-energy"]);
    await waitFor(
      async () => (await eventsOf(worker, pool, "headsup.resolved")).some((e) => e.attempt_id === a),
      60_000,
    );
    const resolved = (await eventsOf(worker, pool, "headsup.resolved")).find((e) => e.attempt_id === a)!;
    expect(resolved).toMatchObject({ attempt_id: a, changed: true });
    expect(typeof resolved.statement === "string" && resolved.statement.length > 0).toBe(true);

    // Then its change lands — the second landing.
    await waitFor(async () => (await eventsOf(worker, pool, "landing.landed")).length >= 2, 60_000);
    const landed = (await eventsOf(worker, pool, "landing.landed")).at(-1)!;

    // SW2 on the remote: every T-energy threshold is 0.3 x ENERGY_MAX (= 1 -> 0.3), and the
    // landing's note carries one go_arounds entry whose keys name rule E2.
    const escapes = sw2Escapes(remoteFiles(worker, pool, "main"));
    expect(escapes).toEqual([]);
    const note = JSON.parse(landed.note_json as string) as {
      go_arounds?: Array<{ keys: Array<{ rule: string }> }>;
    };
    expect(note.go_arounds).toHaveLength(1);
    expect(note.go_arounds![0]!.keys.some((k) => k.rule === "E2")).toBe(true);
    const tree = remoteFiles(worker, pool, landed.commit as string);
    const rescaled = [...tree.entries()].filter(
      ([p, c]) => p.startsWith("creatures/") && /creature\.energy\s*<\s*0\.3\b/.test(c),
    );
    expect(rescaled.length).toBeGreaterThanOrEqual(1);
  }, 240_000);

  it("item 3, order 2: rescale-energy held, add-energy lands, the QR1 repair lands too (SW2)", async () => {
    const pool = "o2";
    const [rescale] = await launch(worker, pool, ["rescale-energy"], { hold: ["rescale-energy"] });
    const r = rescale!;
    // Its write is the replace of ENERGY_MAX — `op.recorded` op "replace".
    await waitFor(
      async () => (await eventsOf(worker, pool, "op.recorded")).some((e) => e.attempt_id === r && e.op === "replace"),
      60_000,
    );

    // add-energy lands a creature that references ENERGY_MAX: a QR1 repair names it.
    await launch(worker, pool, ["add-energy"]);
    await waitFor(async () => (await eventsOf(worker, pool, "landing.landed")).length >= 1, 60_000);
    let sent: Ev | undefined;
    await waitFor(async () => {
      sent = headsSent(await worker.events(pool), r)[0];
      return sent !== undefined;
    }, 60_000);
    sent = sent!;
    expect(sent).toMatchObject({ attempt_id: r, result: "repair" });
    expect((sent.keys as Array<{ rule: string }>).some((k) => k.rule === "QR1")).toBe(true);
    const item = (sent.items as Array<Record<string, unknown>>).find((i) => i.rule === "QR1")!;
    const added = ((item.diff as { added?: Array<{ key: string }> }).added ?? []).map((x) => x.key);
    expect(added.some((k) => k.startsWith("creatures/"))).toBe(true);

    await release(worker, pool, ["rescale-energy"]);
    // The QR1 repair rescales the gained referrers' thresholds, then it lands.
    await waitFor(async () => (await eventsOf(worker, pool, "landing.landed")).length >= 2, 60_000);
    const escapes = sw2Escapes(remoteFiles(worker, pool, "main"));
    expect(escapes).toEqual([]);
  }, 240_000);

  it("item 4: add-plain in flight is never heads-up'd, and a cosmetic landing sends no heads-up (E0, F2)", async () => {
    const pool = "o3";
    const [plain] = await launch(worker, pool, ["add-plain"], { hold: ["add-plain"] });
    const p = plain!;
    await waitFor(
      async () => (await eventsOf(worker, pool, "op.recorded")).some((e) => e.attempt_id === p && e.op === "write"),
      60_000,
    );

    // A `cosmetic` landing while add-plain is in flight: it must never cause a heads-up for
    // an attempt of another pattern (E0, F2 — a run in which it does is a failed run).
    await launch(worker, pool, ["cosmetic"]);
    await waitFor(async () => (await eventsOf(worker, pool, "landing.landed")).length >= 1, 90_000);
    expect((await worker.events(pool)).filter((e) => e.type === "headsup.sent")).toHaveLength(0);

    // A `rescale-energy` landing while add-plain is in flight: ENERGY_MAX is not in its truth
    // list, so nothing it depends on broke — still no heads-up.
    await launch(worker, pool, ["rescale-energy"]);
    await waitFor(async () => (await eventsOf(worker, pool, "landing.landed")).length >= 2, 90_000);
    expect(headsSent(await worker.events(pool), p)).toHaveLength(0);

    // Released, it submits and lands — undisturbed end to end.
    await release(worker, pool, ["add-plain"]);
    await waitFor(async () => (await eventsOf(worker, pool, "landing.landed")).length >= 3, 120_000);
    expect(headsSent(await worker.events(pool), p)).toHaveLength(0);
  }, 240_000);

  it("item 5: add-relative answers the E2 repair with no edit — the designed false abort (HU12)", async () => {
    const pool = "o4";
    const [relative] = await launch(worker, pool, ["add-relative"], { hold: ["add-relative"] });
    const r = relative!;
    await waitFor(
      async () => (await eventsOf(worker, pool, "op.recorded")).some((e) => e.attempt_id === r && e.op === "write"),
      60_000,
    );

    // rescale-energy lands into it: the E2 repair arrives (its file imports ENERGY_MAX).
    await launch(worker, pool, ["rescale-energy"]);
    await waitFor(async () => (await eventsOf(worker, pool, "landing.landed")).length >= 1, 90_000);
    let sent: Ev | undefined;
    await waitFor(async () => {
      sent = headsSent(await worker.events(pool), r)[0];
      return sent !== undefined;
    }, 30_000);
    expect(sent).toMatchObject({ attempt_id: r, result: "repair" });
    expect((sent!.keys as Array<{ rule: string }>).some((k) => k.rule === "E2")).toBe(true);

    // It acknowledges "not affected" with no edit: `headsup.resolved` is `changed: false`.
    await release(worker, pool, ["add-relative"]);
    await waitFor(
      async () =>
        (await eventsOf(worker, pool, "headsup.resolved")).some((e) => e.attempt_id === r && e.changed === false),
      60_000,
    );
    await waitFor(async () => (await eventsOf(worker, pool, "landing.landed")).length >= 2, 120_000);
    expect(sw2Escapes(remoteFiles(worker, pool, "main"))).toEqual([]);
  }, 240_000);

  it("item 6: order 1 on a summary_only pool — same keys, items null, note_json null, bounded stream (EV6)", async () => {
    const pool = "o5";
    const [add] = await launch(worker, pool, ["add-energy"], { hold: ["add-energy"] });
    const a = add!;
    // EV6 suppresses `op.recorded`, so the write cannot be waited on directly: give the held
    // agent a beat to reach its write, then the E2 repair that arrives after rescale lands is
    // itself the proof the write had been recorded (pre-write it would be X0 `info`).
    await new Promise((r) => setTimeout(r, 8000));
    await launch(worker, pool, ["rescale-energy"]);
    await waitFor(async () => (await eventsOf(worker, pool, "landing.landed")).length >= 1, 90_000);
    let sent: Ev | undefined;
    await waitFor(async () => {
      sent = headsSent(await worker.events(pool), a)[0];
      return sent !== undefined;
    }, 60_000);
    // Identical `keys` to the full stream, but `items` is null (EV6).
    expect(sent).toMatchObject({ attempt_id: a, result: "repair", items: null });
    expect(sent!.keys).toEqual([{ kind: "entity", key: ENERGY_KEY, rule: "E2" }]);

    await release(worker, pool, ["add-energy"]);
    await waitFor(async () => (await eventsOf(worker, pool, "landing.landed")).length >= 2, 120_000);
    const landed = (await eventsOf(worker, pool, "landing.landed")).at(-1)!;
    expect(landed.note_json).toBeNull();

    // The bounded stream: none of the per-step events exist for any attempt of the run.
    const types = new Set((await worker.events(pool)).map((e) => e.type));
    for (const t of ["premise.recorded", "premise.removed", "op.recorded", "attempt.step"]) {
      expect(types.has(t), `${t} must not be emitted in a summary_only pool`).toBe(false);
    }
    expect(sw2Escapes(remoteFiles(worker, pool, "main"))).toEqual([]);
  }, 240_000);
});
