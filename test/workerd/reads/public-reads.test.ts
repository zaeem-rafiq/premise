// test/workerd/reads/public-reads.test.ts — Slice 7 acceptance item 5 (04-build-plan 2.8):
// 100 public reads in a mixed order — the note route, the stream socket's snapshot, the pool
// page, `~head.js`, a version-addressed file and `/floor.json` — while the Trunk Durable
// Object's per-entry counter stays exactly where it was (SE19, FS2, AS16). Then the same 100
// with the TRUNK binding repointed at a class that answers 503 to everything: every read
// answers exactly as before — public reads never needed Trunk.

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLandingWorker, type LandingWorker } from "../landing/harness.ts";
import { OWNER_KEY, createPool, landOne, snapshotFrame } from "./helpers.ts";

const POOL = "reads-off-trunk";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type Read = { name: string; signature: string };

describe("Slice 7 item 5: public reads never reach Trunk (SE19, FS2, AS16)", () => {
  let worker: LandingWorker;
  let landed: { seq: number; commit: string; note: string };

  beforeAll(async () => {
    worker = await startLandingWorker({ ownerKey: OWNER_KEY, repos: [POOL] });
    await createPool(worker, POOL);
    landed = await landOne(worker, POOL, "r-off-trunk-land");
  }, 120_000);
  afterAll(async () => {
    await worker?.dispose();
  });

  /** The signature of one public read: its route name, status and body hash (or stream frame). */
  async function oneRead(kind: number): Promise<Read> {
    switch (kind % 6) {
      case 0: {
        const r = await worker.fetch(`/api/pools/${POOL}/landings/${landed.seq}/note`);
        return { name: "note", signature: `${r.status}:${sha256(new Uint8Array(await r.arrayBuffer()))}` };
      }
      case 1: {
        const ws = await worker.stream(POOL);
        ws.send(JSON.stringify({ hello: 1, after: 0 }));
        const frame = (await snapshotFrame(ws)) as {
          snapshot?: { n: number; state: { pool?: { landed_seq?: number; landed_commit?: string } } };
        };
        ws.close();
        // The stream may legitimately grow between the two phases (post-landing events still
        // append), so the signature is the snapshot's stable landed markers, not the frame's n.
        const pool = frame.snapshot?.state.pool;
        return { name: "stream", signature: `101:${pool?.landed_seq}:${pool?.landed_commit}` };
      }
      case 2: {
        const r = await worker.fetch(`/pool/${POOL}/main/`);
        return { name: "page", signature: `${r.status}:${sha256(new Uint8Array(await r.arrayBuffer()))}` };
      }
      case 3: {
        const r = await worker.fetch(`/pool/${POOL}/main/~head.js`);
        return { name: "head", signature: `${r.status}:${sha256(new Uint8Array(await r.arrayBuffer()))}` };
      }
      case 4: {
        const r = await worker.fetch(`/pool/${POOL}/v/c-${landed.commit}/world/energy.js`);
        return { name: "vfile", signature: `${r.status}:${sha256(new Uint8Array(await r.arrayBuffer()))}` };
      }
      default: {
        const r = await worker.fetch("/floor.json");
        return { name: "floor.json", signature: `${r.status}:${sha256(new Uint8Array(await r.arrayBuffer()))}` };
      }
    }
  }

  /** The 100 reads of the acceptance, in a fixed mixed rotation; sequential, signatures in order. */
  async function hundredReads(): Promise<Read[]> {
    const reads: Read[] = [];
    for (let i = 0; i < 100; i += 1) reads.push(await oneRead(i));
    return reads;
  }

  const servedTotal = async () => {
    const state = (await worker.trunk(POOL).state()) as { served?: Record<string, number> };
    return Object.values(state.served ?? {}).reduce((sum, n) => sum + n, 0);
  };

  it("100 mixed public reads move Trunk's served-entries count by zero", async () => {
    const before = await servedTotal();
    const reads = await hundredReads();
    for (const [index, read] of reads.entries()) {
      expect(read.signature.startsWith("2") || read.signature.startsWith("101"), `read ${index} ${read.name}`).toBe(
        true,
      );
    }
    expect(await servedTotal()).toBe(before);
  }, 90_000);

  it("the same 100 reads answer identically while Trunk answers 503 to everything", async () => {
    const first = await hundredReads();
    await worker.breakTrunk();
    // The stand-in is really there: the object's own state read is now a 503.
    expect((await worker.trunk(POOL).fetch("/internal/state")).status).toBe(503);
    const second = await hundredReads();
    expect(second.map((read) => read.signature)).toEqual(first.map((read) => read.signature));
    const kinds = new Set(second.map((read) => read.name));
    expect([...kinds].sort()).toEqual(["floor.json", "head", "note", "page", "stream", "vfile"]);
  }, 120_000);
});
