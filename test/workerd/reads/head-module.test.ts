// test/workerd/reads/head-module.test.ts — Slice 7 acceptance item 5, the Floor-driven modules
// (04-build-plan 2.8; FS2, SE19, AS11, AS16): after two landings on different files `~head.js`
// names the second landing's seq and commit, and `~registry.js`'s newest-landed cut (AS11) is
// worked by hand from the landings' paths — with Trunk answering 503 to everything, so nothing
// in the answers can have come from it.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, gitAsync } from "../../git/helpers.ts";
import { startLandingWorker, type LandingWorker } from "../landing/harness.ts";
import { MAX_KINDS } from "../../../src/protocol/constants.ts";
import { OWNER_KEY, createPool, landOne } from "./helpers.ts";

const POOL = "reads-head";

/** The JSON object a `export const <name> = {...};` module carries. */
function moduleObject(text: string): Record<string, unknown> {
  const start = text.indexOf("=");
  return JSON.parse(
    text
      .slice(start + 1)
      .trim()
      .replace(/;\s*$/, ""),
  ) as Record<string, unknown>;
}

/** The `landing.accepted.paths` → seq map, worked by hand from the event stream (FS1). */
function landedPaths(events: Array<Record<string, unknown>>): Map<string, number> {
  const confirmed = new Set(events.filter((e) => e.type === "landing.landed").map((e) => e.seq as number));
  const paths = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "landing.accepted") continue;
    const seq = event.seq as number;
    if (!confirmed.has(seq)) continue; // only confirmed landings count (AS11's own words)
    for (const path of event.paths as string[]) paths.set(path, seq);
  }
  return paths;
}

/** The valid kind names a `creatures/` listing carries, per AS9 (2.6's kind-name rule). */
function kindsOf(dir: string, commit: string): string[] {
  const listing = git(dir, ["ls-tree", "--name-only", commit, "creatures/"]);
  return listing
    .split("\n")
    .filter((line) => line.endsWith(".js"))
    .map((line) => line.split("/").pop()!.slice(0, -3))
    .filter((kind) => /^[a-z][a-z0-9-]{0,30}$/.test(kind) && kind !== "constructor");
}

/** AS11's keep-the-newest cut, written from the rule's words — not from the module's output. */
function expectedKinds(kinds: string[], paths: Map<string, number>): string[] {
  const ordered = [...kinds].sort((a, b) => {
    const pa = `creatures/${a}.js`;
    const pb = `creatures/${b}.js`;
    const sa = paths.get(pa);
    const sb = paths.get(pb);
    if (sa !== undefined && sb !== undefined && sa !== sb) return sb - sa;
    if (sa !== undefined && sb === undefined) return -1;
    if (sa === undefined && sb !== undefined) return 1;
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
  return ordered.slice(0, MAX_KINDS).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

describe("Slice 7 item 5: generated modules from Floor state (FS2, AS11, AS16)", () => {
  let worker: LandingWorker;
  let second: { seq: number; commit: string };

  beforeAll(async () => {
    worker = await startLandingWorker({ ownerKey: OWNER_KEY, repos: [POOL] });
    await createPool(worker, POOL);
    await landOne(worker, POOL, "r-head-land-1"); // writes creatures/s0000.js (seq 1)
    second = await landOne(worker, POOL, "r-head-land-2"); // writes creatures/s0001.js (seq 2)
  }, 120_000);
  afterAll(async () => {
    await worker?.dispose();
  });

  const servedTotal = async () => {
    const state = (await worker.trunk(POOL).state()) as { served?: Record<string, number> };
    return Object.values(state.served ?? {}).reduce((sum, n) => sum + n, 0);
  };

  it("~head.js names the second landing's seq and commit, and Trunk saw nothing", async () => {
    const before = await servedTotal();
    const response = await worker.fetch(`/pool/${POOL}/main/~head.js`);
    expect(response.status).toBe(200);
    const landed = moduleObject(await response.text());
    expect(landed).toEqual({
      pool: POOL,
      source: "main",
      version: `c-${second.commit}`,
      base: `/pool/${POOL}/v/c-${second.commit}/`,
      seq: second.seq,
    });
    expect(second.seq).toBe(2);
    expect(await servedTotal()).toBe(before);
  }, 30_000);

  it("AS11: past MAX_KINDS the newest-landed paths are kept, computed by hand, Trunk down", async () => {
    // A hand-built landing on real git: 60 filler creatures pushed onto main, then the landing's
    // own two events given to the Floor through its real input route — the same way Trunk's
    // landings reach it. `paths` then knows the fillers at seq 3.
    const dir = worker.repoDir(POOL);
    const work = mkdtempSync(join(tmpdir(), "premise-head-"));
    await gitAsync(work, ["clone", "--template=", worker.remoteFor(POOL), "clone"]);
    const clone = join(work, "clone");
    const fillers: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      const name = `b-fill-${String(i).padStart(2, "0")}`;
      fillers.push(`creatures/${name}.js`);
      writeFileSync(
        join(clone, "creatures", `${name}.js`),
        `export function spawn() { return { x: ${i}, y: 0 }; }\n` +
          `export function update(c) {}\nexport function draw(c, pen) {}\n`,
      );
    }
    await gitAsync(clone, ["add", "creatures"]);
    await gitAsync(clone, ["commit", "-m", "hand-built landing for the AS11 cut"]);
    await gitAsync(clone, ["push", "origin", "HEAD:main"]);
    const commit = git(dir, ["rev-parse", "refs/heads/main"]);
    const tree = git(dir, ["rev-parse", `${commit}^{tree}`]);

    // The events go in as Trunk's own stream does: source "trunk" at an epoch above any it has
    // used — RB5 restarts the counter at source_n 1, the shape of a re-reporting incarnation.
    const trunkEpoch = Math.max(
      0,
      ...(await worker.events(POOL))
        .filter((e) => e.type === "pool.state")
        .map((e) => (e.epoch as number) ?? 0),
    );
    const inject = await worker.floor(POOL).fetch("/internal/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "trunk",
        epoch: trunkEpoch + 1,
        events: [
          {
            source_n: 1,
            event: {
              ts: 5_000,
              pool: POOL,
              src: "trunk",
              type: "landing.accepted",
              seq: 3,
              batch_id: 9,
              kind: "change",
              attempt_id: null,
              change_id: "c_hand",
              intent_id: null,
              request_id: null,
              paths: fillers,
              writes: [],
            },
          },
          {
            source_n: 2,
            event: {
              ts: 5_010,
              pool: POOL,
              src: "trunk",
              type: "landing.landed",
              seq: 3,
              batch_id: 9,
              commit,
              tree,
              note: "0000000000000000000000000000000000000000",
              note_json: null,
              time_to_land_ms: 0,
            },
          },
        ],
      }),
    });
    expect(inject.status).toBe(200);

    // The expected cut is computed from git's own listing of the commit and the paths map worked
    // by hand from the event stream — nothing is read back from the module under test.
    const kinds = kindsOf(dir, commit);
    const paths = landedPaths(await worker.events(POOL));
    const expected = expectedKinds(kinds, paths);
    const naive = [...kinds].sort().slice(0, MAX_KINDS);
    expect(kinds.length).toBeGreaterThan(MAX_KINDS);
    expect(expected).not.toEqual(naive); // the seq ordering must actually change the cut

    const url = `/pool/${POOL}/v/c-${commit}/~registry.js`;
    const up = await worker.fetch(url);
    expect(up.status).toBe(200);
    const upText = await up.text();
    await worker.breakTrunk();
    expect((await worker.trunk(POOL).fetch("/internal/state")).status).toBe(503);
    const down = await worker.fetch(url);
    expect(down.status).toBe(200);
    expect(await down.text()).toBe(upText);

    const registry = moduleObject(upText) as {
      total: number;
      kinds: Array<{ kind: string; path: string; oid: string }>;
    };
    expect(registry.total).toBe(kinds.length);
    expect(registry.kinds.map((k) => k.kind)).toEqual(expected);
    expect(registry.kinds).toHaveLength(MAX_KINDS);
    // The discriminating entry: the second landing's creature makes the cut only because its
    // seq is newest — under plain name order the fillers would have pushed it out. Its kind name
    // is read back from the landing's own `paths`, never assumed.
    const secondPath = [...paths.entries()].find(([, seq]) => seq === second.seq)?.[0];
    expect(secondPath).toBeDefined();
    const secondKind = secondPath!.split("/").pop()!.replace(/\.js$/, "");
    expect(kinds).toContain(secondKind);
    expect(registry.kinds.map((k) => k.kind)).toContain(secondKind);
    expect(naive).not.toContain(secondKind);
  }, 90_000);
});
