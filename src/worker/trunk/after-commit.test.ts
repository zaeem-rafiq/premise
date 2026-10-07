import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Sql } from "../../protocol/ports.ts";
import type { Env } from "../env.ts";
import { deliverEvents } from "./after-commit.ts";
import { appendEvent, applyShellSchema, metaGet, metaSet, pendingEvents, timerGetDue, timerPut } from "./sql.ts";

type Delivery = {
  source: string;
  epoch: number;
  events: Array<{ source_n: number; event: Record<string, unknown> }>;
};
type Reply = (delivery: Delivery, attempt: number) => Response | Promise<Response>;

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture(reply: Reply) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const writes: Array<{ query: string; rows: number }> = [];
  const changes = () => Number(db.prepare("SELECT total_changes() AS n").get()!.n);
  const sql: Sql = {
    exec: (query, ...bindings) => {
      const before = changes();
      const rows = db.prepare(query).all(...bindings) as Array<Record<string, unknown>>;
      const changed = changes() - before;
      if (changed > 0) writes.push({ query, rows: changed });
      return { toArray: () => rows };
    },
    transaction: (run) => {
      db.exec("BEGIN");
      try {
        const result = run();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  applyShellSchema(sql);
  metaSet(sql, "epoch", 3);
  for (const attempt_id of ["a_1", "a_2"]) {
    appendEvent(sql, 1_000, {
      ts: 1_000,
      pool: "pool",
      src: "trunk",
      type: "tick.skipped",
      attempt_id,
      reason: "right_of_way",
    });
  }
  timerPut(sql, "events", "", 1_000);
  const deliveries: Delivery[] = [];
  const env = {
    FLOOR: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (_url: string, init: { body: string }) => {
          const delivery = JSON.parse(init.body) as Delivery;
          deliveries.push(delivery);
          return reply(delivery, deliveries.length);
        },
      }),
    },
  } as unknown as Env;
  const ctx = {
    id: { name: "pool" },
    storage: { sql, transactionSync: sql.transaction },
  } as unknown as DurableObjectState;
  writes.length = 0;
  const updatedEvents = () =>
    writes.filter((write) => write.query.startsWith("UPDATE events_out ")).reduce((n, write) => n + write.rows, 0);
  const deletedEvents = () =>
    writes.filter((write) => write.query.startsWith("DELETE FROM events_out ")).reduce((n, write) => n + write.rows, 0);
  return { sql, env, ctx, deliveries, writes, updatedEvents, deletedEvents };
}

describe("Trunk event delivery (EV2)", () => {
  it.each(["confirmed", "gap", "transport", "body"])(
    "an old epoch's %s response cannot delete the rebuilt epoch's first event (RB5)",
    async (kind) => {
      const rebuilt = { ts: 2_000, pool: "pool", src: "trunk", type: "pool.state", epoch: 4 };
      const rebuild = () => {
        f.sql.transaction(() => {
          f.sql.exec("DELETE FROM events_out");
          metaSet(f.sql, "epoch", 4);
          metaSet(f.sql, "next_event_n", 1);
          appendEvent(f.sql, 2_000, rebuilt);
        });
      };
      const f = fixture((_delivery, attempt) => {
        if (attempt > 1) {
          expect(pendingEvents(f.sql).map((row) => JSON.parse(row.body))).toEqual([rebuilt]);
          return Response.json({ appended: 1 });
        }
        if (kind === "body") {
          const response = Response.json({ appended: 2 });
          const json = response.json.bind(response);
          response.json = async <T>() => {
            rebuild();
            return json<T>();
          };
          return response;
        }
        rebuild();
        if (kind === "transport") throw new Error("old request failed");
        if (kind === "gap") return Response.json({ error: { code: "gap", expected: 3 } }, { status: 409 });
        return Response.json({ appended: 2 });
      });

      await deliverEvents(f.env, f.ctx);

      expect(f.deliveries.map(({ epoch, events }) => ({ epoch, ns: events.map((e) => e.source_n) }))).toEqual([
        { epoch: 3, ns: [1, 2] },
        { epoch: 4, ns: [1] },
      ]);
      expect(f.deliveries[1]?.events[0]?.event).toEqual(rebuilt);
      expect(pendingEvents(f.sql)).toEqual([]);
      expect(metaGet(f.sql, "events_tries")).toBeNull();
    },
  );

  it.each([
    ["new", { appended: 2 }],
    ["duplicate", { duplicate: true }],
  ])("deletes %s confirmations without first marking events sent", async (_name, response) => {
    const f = fixture(() => {
      expect(pendingEvents(f.sql).map((row) => row.n)).toEqual([1, 2]);
      return Response.json(response);
    });
    metaSet(f.sql, "events_tries", 2);
    const bodies = pendingEvents(f.sql).map((row) => ({ source_n: row.n, event: JSON.parse(row.body) }));

    await deliverEvents(f.env, f.ctx);

    expect(f.deliveries).toEqual([{ source: "trunk", epoch: 3, events: bodies }]);
    expect(f.updatedEvents()).toBe(0);
    expect(f.deletedEvents()).toBe(2);
    expect(pendingEvents(f.sql)).toEqual([]);
    expect(timerGetDue(f.sql, "events", "")).toBeNull();
    expect(metaGet(f.sql, "events_tries")).toBeNull();
  });

  it("keeps unconfirmed rows and does not rewrite their sent marks on another error", async () => {
    const f = fixture(() => Response.json({ error: { code: "unavailable" } }, { status: 503 }));
    await deliverEvents(f.env, f.ctx);
    expect(pendingEvents(f.sql).map(({ n, sent }) => ({ n, sent }))).toEqual([
      { n: 1, sent: 1 },
      { n: 2, sent: 1 },
      { n: 3, sent: 0 },
    ]);
    expect(f.updatedEvents()).toBe(2);
    expect(f.deletedEvents()).toBe(0);
    expect(timerGetDue(f.sql, "events", "")).not.toBeNull();

    f.writes.length = 0;
    await deliverEvents(f.env, f.ctx);
    // Only the previous failure's newly emitted trunk.error needs its first sent mark.
    expect(f.updatedEvents()).toBe(1);
    expect(f.deletedEvents()).toBe(0);
    expect(f.deliveries.map((delivery) => delivery.events.map((event) => event.source_n))).toEqual([
      [1, 2],
      [1, 2, 3],
    ]);
    expect(metaGet(f.sql, "events_tries")).toBe("2");
  });

  it("deletes only a confirmed gap prefix and resends the retained suffix in order", async () => {
    const f = fixture((_delivery, attempt) => {
      if (attempt === 1) return Response.json({ error: { code: "gap", expected: 2 } }, { status: 409 });
      expect(pendingEvents(f.sql).map(({ n, sent }) => ({ n, sent }))).toEqual([{ n: 2, sent: 1 }]);
      return Response.json({ appended: 1 });
    });

    await deliverEvents(f.env, f.ctx);

    expect(f.deliveries.map((delivery) => delivery.events.map((event) => event.source_n))).toEqual([[1, 2], [2]]);
    expect(f.updatedEvents()).toBe(1);
    expect(f.deletedEvents()).toBe(2);
    expect(pendingEvents(f.sql)).toEqual([]);
    expect(timerGetDue(f.sql, "events", "")).toBeNull();
  });

  it("retains every event when the transport fails before a response", async () => {
    const f = fixture(() => {
      throw new Error("transport failed");
    });
    await deliverEvents(f.env, f.ctx);

    expect(pendingEvents(f.sql).map(({ n, sent }) => ({ n, sent }))).toEqual([
      { n: 1, sent: 0 },
      { n: 2, sent: 0 },
      { n: 3, sent: 0 },
    ]);
    expect(f.updatedEvents()).toBe(0);
    expect(f.deletedEvents()).toBe(0);
    expect(timerGetDue(f.sql, "events", "")).not.toBeNull();
  });

  it("keeps rows when a successful HTTP response does not confirm their events", async () => {
    const f = fixture(() => new Response("invalid JSON", { status: 200 }));
    await deliverEvents(f.env, f.ctx);

    expect(pendingEvents(f.sql).map((row) => row.n)).toEqual([1, 2, 3]);
    expect(f.updatedEvents()).toBe(2);
    expect(f.deletedEvents()).toBe(0);
    expect(timerGetDue(f.sql, "events", "")).not.toBeNull();
  });
});
