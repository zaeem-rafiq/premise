// Slice 9 acceptance item 1 (04-build-plan 2.10): the owner-only export
// `GET /api/pools/{pool}/replay.ndjson` (01-core 13.6, 12.3), on the built bundle in local
// workerd. Proved here:
//   RP1   a stream whose line matches a redact() pattern is refused with 409 naming the
//         line (never the line itself) — once on an Artifacts token, once on the key itself
//   12.3  a clean stream answers premise_replay 2: the header's events count, the pool's
//         synthetic flag, the query's build and label, and one event per line in `n` order
//   SE1/SE2-3  no owner credential is refused; a deployment with no OWNER_KEY fails closed
//
// The planted strings are made up for the test (SE5a's patterns), never real secrets.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPLAY_FORMAT } from "../../../src/protocol/replay.ts";
import { appendBody, poolState } from "./harness.ts";
import { startTrunkWorker, type TrunkWorker } from "../trunk/harness.ts";

const KEY = "owner-key-for-tests-0123456789abcdef"; // the made-up key of test/workerd/reads/helpers.ts
const WRONG_KEY = "wrong" + "-key"; // joined so no secret-shaped literal sits in the source (check:secrets)
// `art_v1_...` is the pattern of SE5a, made up here — never a real token; built in parts for
// the same reason (the scanner reads source text, the DO reads the runtime string).
const FAKE_TOKEN = "art" + "_v1_deadbeef00cafe";

const auth = { headers: { authorization: `Bearer ${KEY}` } };

function intentEvent(ts: number, text: string): Record<string, unknown> {
  return {
    ts,
    pool: "unused",
    src: "trunk",
    type: "intent.created",
    intent_id: "i_1",
    text,
    requester: "owner",
    race: false,
    prewritten: false,
  };
}

describe("the Replay export, `GET /api/pools/{pool}/replay.ndjson`", () => {
  let worker: TrunkWorker;
  beforeAll(async () => {
    worker = await startTrunkWorker({ ownerKey: KEY });
  }, 60_000);
  afterAll(async () => {
    await worker?.dispose();
  });

  /** Stores `events` on the pool's Floor object through the source-append path (EV2). */
  async function seed(pool: string, events: Record<string, unknown>[]): Promise<void> {
    const response = await worker.floor(pool).fetch("/internal/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: appendBody(
        "trunk",
        1,
        events.map((event, index) => ({ source_n: index + 1, event })),
      ),
    });
    expect(response.status).toBe(200);
  }

  it("RP1: a line carrying an Artifacts token pattern is refused with 409 and its line number", async () => {
    await seed("export-leak", [poolState(1_000), intentEvent(1_010, `kept token ${FAKE_TOKEN}`)]);
    const response = await worker.fetch("/api/pools/export-leak/replay.ndjson", auth);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; line: number; family: string } };
    // The planted event is stream event 2, so file line 3 (line 1 is the header).
    expect(body.error).toEqual({ code: "redacted", line: 3, family: "artifacts_token" });
    expect(JSON.stringify(body)).not.toContain(FAKE_TOKEN);
  });

  it("RP1: a line carrying the owner key itself is refused, family `secret`", async () => {
    await seed("export-key", [poolState(1_000), intentEvent(1_010, `the key ${KEY} inside a line`)]);
    const response = await worker.fetch("/api/pools/export-key/replay.ndjson", auth);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; line: number; family: string } };
    expect(body.error).toEqual({ code: "redacted", line: 3, family: "secret" });
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it("12.3: a clean stream exports as premise_replay 2 — header fields, n order, event count", async () => {
    await seed("export-clean", [poolState(1_000), intentEvent(1_010, "a tracer fish")]);
    const response = await worker.fetch(
      "/api/pools/export-clean/replay.ndjson?label=the%20take&build=0123456789abcdef",
      auth,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");

    const lines = (await response.text()).split("\n").filter((line) => line !== "");
    const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(header.premise_replay).toBe(REPLAY_FORMAT);
    expect(header.pool).toBe("export-clean");
    expect(header.events).toBe(lines.length - 1);
    expect(header.synthetic).toBe(false);
    expect(header.build).toBe("0123456789abcdef");
    expect(header.label).toBe("the take");

    const events = lines.slice(1).map((line) => JSON.parse(line) as { n: number; t: number; type: string });
    for (const [index, event] of events.entries()) expect(event.n).toBe(index + 1);
    expect(events.map((event) => event.type)).toEqual(["pool.state", "intent.created"]);
    // recorded_at is the ISO time of the newest stored event.
    expect(header.recorded_at).toBe(new Date(events[events.length - 1]!.t).toISOString());
  });

  it("the header's synthetic follows the pool's pool.state (12.3)", async () => {
    await seed("export-synth", [{ ...poolState(1_000), synthetic: true }, intentEvent(1_010, "x")]);
    const response = await worker.fetch("/api/pools/export-synth/replay.ndjson", auth);
    expect(response.status).toBe(200);
    const header = JSON.parse((await response.text()).split("\n", 1)[0] ?? "{}") as { synthetic: boolean };
    expect(header.synthetic).toBe(true);
  });

  it("an empty stream answers 404 (there is nothing to record)", async () => {
    const response = await worker.fetch("/api/pools/export-empty/replay.ndjson", auth);
    expect(response.status).toBe(404);
  });

  it("SE2/SE3: no owner credential is refused with 401 before the object is asked", async () => {
    const response = await worker.fetch("/api/pools/export-clean/replay.ndjson");
    expect(response.status).toBe(401);
    const wrong = await worker.fetch("/api/pools/export-clean/replay.ndjson", {
      headers: { authorization: `Bearer ${WRONG_KEY}` },
    });
    expect(wrong.status).toBe(401);
  });
});

describe("a deployment with no owner key at all (SE1, RY2)", () => {
  let bare: TrunkWorker;
  beforeAll(async () => {
    bare = await startTrunkWorker();
  }, 60_000);
  afterAll(async () => {
    await bare?.dispose();
  });

  it("the owner route fails closed with 503, key or no key", async () => {
    expect((await bare.fetch("/api/pools/anything/replay.ndjson")).status).toBe(503);
    const withKey = await bare.fetch("/api/pools/anything/replay.ndjson", {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(withKey.status).toBe(503);
  });
});
