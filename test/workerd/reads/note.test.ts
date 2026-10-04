// test/workerd/reads/note.test.ts — Slice 7 acceptance item 2 (04-build-plan 2.8), the note route
// end to end in local workerd: NT1 (the body is the canonical note blob), EV6 (summary_only has
// no note) and the 13.6 route row (public, Floor, 404/400 shapes).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, gitBytes } from "../../git/helpers.ts";
import { startLandingWorker, type LandingWorker } from "../landing/harness.ts";
import { OWNER_KEY, createPool, landOne } from "./helpers.ts";

const POOL = "reads-note";
const SUMMARY = "reads-note-summary";

describe("Slice 7 item 2: the note route (NT1, EV6, 13.6)", () => {
  let worker: LandingWorker;
  let landed: { seq: number; commit: string; note: string; note_json: string | null };
  let summaryLanded: { seq: number; commit: string; note: string; note_json: string | null };

  beforeAll(async () => {
    worker = await startLandingWorker({ ownerKey: OWNER_KEY, repos: [POOL, SUMMARY] });
    // Both pools are created and launched up front so the two agents run together.
    await createPool(worker, POOL);
    await createPool(worker, SUMMARY, { summaryOnly: true });
    const [first, second] = await Promise.all([
      landOne(worker, POOL, "r-note-land"),
      landOne(worker, SUMMARY, "r-note-summary-land"),
    ]);
    landed = first;
    summaryLanded = second;
  }, 120_000);
  afterAll(async () => {
    await worker?.dispose();
  });

  it("the public route answers the canonical note bytes — hash equals landed.note and the remote's blob (NT1)", async () => {
    expect(landed.seq).toBe(1);
    // No key: 13.6 marks the route public; the harness sends no Authorization header at all.
    const response = await worker.fetch(`/api/pools/${POOL}/landings/1/note`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = Buffer.from(await response.arrayBuffer());

    // The served bytes are the canonical blob of NT1: the stored note JSON plus its final LF.
    expect(body.toString("utf8")).toBe(`${landed.note_json}\n`);

    // hash-object of the body's exact bytes = landing.landed.note = the blob `git notes` shows.
    const dir = worker.repoDir(POOL);
    const servedOid = git(dir, ["hash-object", "--stdin"], body);
    const shown = gitBytes(dir, ["notes", "--ref=premise", "show", landed.commit]);
    const remoteOid = git(dir, ["hash-object", "--stdin"], shown);
    expect(servedOid).toBe(landed.note);
    expect(remoteOid).toBe(landed.note);
    expect(servedOid).toBe(remoteOid);
    expect(JSON.parse(body.toString("utf8"))).toMatchObject({ seq: 1 });
  });

  it("EV6: on a summary_only pool the same route answers 404", async () => {
    expect(summaryLanded.seq).toBe(1);
    expect(summaryLanded.note_json).toBeNull();
    const response = await worker.fetch(`/api/pools/${SUMMARY}/landings/1/note`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found" } });
  });

  it("a seq that does not exist answers 404; a non-numeric seq answers 400", async () => {
    const missing = await worker.fetch(`/api/pools/${POOL}/landings/99/note`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: "not_found" } });
    const bad = await worker.fetch(`/api/pools/${POOL}/landings/abc/note`);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { code: "invalid_args" } });
  });
});
