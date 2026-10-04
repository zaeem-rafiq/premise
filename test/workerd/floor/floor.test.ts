// The Floor Durable Object in workerd (Track 1E): source de-duplication (EV2/EV2a), the stream
// socket (12.2, EV7, AC1) and the app server's internal read (FS2), against the built bundle.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolEvent } from "../../../src/protocol/events.ts";
import { emptyFloorState, reduce } from "../../../src/protocol/reducer/index.ts";
import type { FloorHandle } from "./harness.ts";
import { appendBody, poolState, startFloor } from "./harness.ts";

let floor: FloorHandle;

beforeAll(async () => {
  floor = await startFloor();
});

afterAll(async () => {
  await floor?.dispose();
});

function event(ts: number, src: string, type: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { ts, pool: "tidepool", src, type, ...fields };
}

async function append(
  source: string,
  epoch: number,
  sourceNs: number[],
  body: (ts: number) => Record<string, unknown>,
  ts = 1_000,
): Promise<Response> {
  const events = sourceNs.map((source_n, index) => ({ source_n, event: body(ts + index * 10) }));
  return floor.fetch("/internal/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: appendBody(source, epoch, events),
  });
}

/** Reads one message off a client socket, with a short time-out. */
function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no message in 4 s")), 4_000);
    ws.addEventListener("message", (message) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(message.data)) as Record<string, unknown>);
    });
  });
}

describe("EV2: source numbering", () => {
  it("a repeated source_n is ignored, a gap is refused with the expected number", async () => {
    const first = await append("trunk", 1, [1], (ts) => poolState(ts));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ appended: 1, last_n: 1 });

    const repeat = await append("trunk", 1, [1], (ts) => poolState(ts));
    expect(await repeat.json()).toMatchObject({ appended: 0, duplicate: true, last_n: 1 });

    const gap = await append("trunk", 1, [3], (ts) =>
      event(ts, "trunk", "trunk.error", { where: "x", code: "transport" }),
    );
    expect(gap.status).toBe(409);
    expect(await gap.json()).toEqual({ error: { code: "gap", expected: 2 } });
  });

  it("a higher epoch restarts the source at source_n 1 (RB5)", async () => {
    const response = await append("trunk", 2, [1], (ts) =>
      event(ts, "trunk", "trunk.error", { where: "rebuilt", code: "x" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ appended: 1 });
    // and the old epoch is stale, not a gap
    const stale = await append("trunk", 1, [99], (ts) => event(ts, "trunk", "trunk.error", { where: "y", code: "x" }));
    expect(await stale.json()).toMatchObject({ appended: 0, duplicate: true });
  });

  it("EV2a: trunk and gate keep independent counters — the same source_n lands twice", async () => {
    const trunk = await append("trunk", 2, [2], (ts) => event(ts, "trunk", "trunk.error", { where: "t", code: "x" }));
    expect(await trunk.json()).toMatchObject({ appended: 1 });
    const gate = await append("gate", 1, [1], (ts) =>
      event(ts, "gate", "limits", {
        spend_usd: 1,
        reserved_usd: 0,
        cap_usd: 40,
        killed: false,
        refusing: false,
        models: [],
      }),
    );
    expect(gate.status).toBe(200);
    expect(await gate.json()).toMatchObject({ appended: 1 });
    // four events in the stream: pool.state (trunk e1 sn1), two trunk e2 events, this limits event
    const state = (await floor.state()) as { n: number; pool: { landed_seq: number } };
    expect(state.n).toBe(4);
    const trunkErrors = await append("gate", 1, [2], (ts) =>
      event(ts, "gate", "limits", {
        spend_usd: 2,
        reserved_usd: 0,
        cap_usd: 40,
        killed: false,
        refusing: false,
        models: [],
      }),
    );
    expect(await trunkErrors.json()).toMatchObject({ appended: 1 });
  });
});

describe("the stream socket (12.2, EV7)", () => {
  it("a hello with after: 0 gets a snapshot frame holding the whole state", async () => {
    const ws = await floor.stream();
    ws.send(JSON.stringify({ hello: 1, after: 0 }));
    const frame = (await nextMessage(ws)) as { snapshot?: { n: number; state: unknown } };
    expect(frame.snapshot).toBeDefined();
    expect(frame.snapshot?.n).toBe((await floor.state()).n);
    ws.close();
  });

  it("a second client message closes the socket", async () => {
    const ws = await floor.stream();
    ws.send(JSON.stringify({ hello: 1, after: 0 }));
    await nextMessage(ws); // the snapshot frame
    const closed = new Promise<number>((resolve) => ws.addEventListener("close", (c) => resolve(c.code)));
    ws.send(JSON.stringify({ hello: 1, after: 0 }));
    expect(await closed).toBeTypeOf("number");
    ws.close();
  });

  it("AC1: the snapshot state equals replaying every stored event through the reducer", async () => {
    const ws = await floor.stream();
    ws.send(JSON.stringify({ hello: 1, after: 0 }));
    const frame = (await nextMessage(ws)) as { snapshot: { n: number; state: unknown } };
    const replayed = emptyFloorState();
    const events = (await floor.fetch("/api/pools/tidepool/replay.ndjson").then((r) => r.text()))
      .split("\n")
      .filter((line) => line !== "")
      .slice(1)
      .map((line) => JSON.parse(line) as PoolEvent);
    for (const stored of events) reduce(replayed, stored);
    expect(JSON.stringify(frame.snapshot.state)).toBe(JSON.stringify(replayed));
    expect(frame.snapshot.n).toBe(events.length);
    ws.close();
  });
});

describe("EV7/FS3: hibernated sockets survive eviction", () => {
  it("an event appended after eviction reaches a socket opened before, from its attachment's after", async () => {
    const ws = await floor.stream();
    ws.send(JSON.stringify({ hello: 1, after: 0 }));
    await nextMessage(ws); // snapshot frame: attachment is now at the newest n
    const before = await floor.marker();
    await floor.evict();
    const after = await floor.marker();
    expect(after).not.toBe(before); // the object really was evicted (the in-memory marker is gone)
    const n = ((await floor.state()) as { n: number }).n;
    const framePromise = nextMessage(ws) as Promise<{ events?: Array<{ n: number; type: string }> }>;
    const appended = await append("trunk", 2, [3], (ts) =>
      event(ts, "trunk", "trunk.error", { where: "post-eviction", code: "x" }),
    );
    expect(await appended.json()).toMatchObject({ appended: 1 });
    const frame = await framePromise;
    expect(frame.events).toBeDefined();
    expect(frame.events?.map((stored) => stored.n)).toEqual([n + 1]);
    expect(frame.events?.[0]?.type).toBe("trunk.error");
    ws.close();
  });
});

describe("FS2: the app server's internal read", () => {
  it("/internal/state answers landed commit, landed seq and newest paths from reducer state", async () => {
    // land seq 1 through the stream itself
    await floor.fetch("/internal/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: appendBody("trunk", 2, [
        {
          source_n: 4,
          event: event(1, "trunk", "intent.created", {
            intent_id: "i_fs",
            text: "fs2",
            requester: "o",
            race: false,
            prewritten: false,
          }),
        },
        {
          source_n: 5,
          event: event(2, "trunk", "landing.accepted", {
            seq: 1,
            batch_id: 1,
            kind: "change",
            attempt_id: "a_fs",
            change_id: "c_fs",
            intent_id: "i_fs",
            request_id: null,
            paths: ["world/energy.js"],
            writes: [],
          }),
        },
        {
          source_n: 6,
          event: event(3, "trunk", "landing.landed", {
            seq: 1,
            batch_id: 1,
            commit: "f5c0ffee",
            tree: "t",
            note: "n",
            note_json: null,
            time_to_land_ms: 10,
          }),
        },
      ]),
    });
    const read = (await floor.state()) as {
      pool: { landed_commit: string; landed_seq: number };
      paths: Record<string, number>;
      landings_by_commit: Record<string, number>;
    };
    expect(read.pool.landed_commit).toBe("f5c0ffee");
    expect(read.pool.landed_seq).toBe(1);
    expect(read.paths["world/energy.js"]).toBe(1); // the newest path by its last confirmed landing
    expect(read.landings_by_commit.f5c0ffee).toBe(1);
  });

  it("the note route answers the landing's note_json, 404 for a summary_only landing (EV6)", async () => {
    await floor.fetch("/internal/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: appendBody("trunk", 2, [
        {
          source_n: 7,
          event: event(4, "trunk", "landing.landed", {
            seq: 9,
            batch_id: 2,
            commit: "aa11bb22",
            tree: "t2",
            note: "n2",
            note_json: '{"premises":[]}',
            time_to_land_ms: 5,
          }),
        },
      ]),
    });
    const note = await floor.fetch("/api/pools/x/landings/9/note");
    expect(note.status).toBe(200);
    expect(note.headers.get("content-type")).toBe("application/json");
    expect(await note.text()).toBe('{"premises":[]}');
    const missing = await floor.fetch("/api/pools/x/landings/42/note");
    expect(missing.status).toBe(404);
  });
});
