// loadState over a snapshot written before `metrics_active` existed (CO42b). node:sqlite stands
// in for the Durable Object's SqlStorage: both answer `exec(query, ...bindings).toArray()`.

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { PoolEvent } from "../../protocol/events.ts";
import { emptyFloorState } from "../../protocol/reducer/index.ts";
import { initSchema, insertEvent, loadState, writeSnapshot } from "./store.ts";

function sqlite(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (query: string, ...bindings: unknown[]) => {
      const statement = db.prepare(query);
      const rows = /^\s*select/i.test(query)
        ? (statement.all(...(bindings as never[])) as unknown[])
        : (statement.run(...(bindings as never[])), []);
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
}

function metrics(n: number, landingsPerSecond: number): PoolEvent {
  return {
    n,
    t: n,
    ts: n,
    pool: "p",
    src: "trunk",
    type: "metrics",
    window_ms: 10_000,
    landings_per_second: landingsPerSecond,
    time_to_land_ms: { p50: null, p99: null },
    time_held_ms: { p50: null, p99: null },
    go_around_rate: null,
    false_abort_rate: null,
    escape_rate: null,
    waiting_behind: 0,
    push_backlog: 0,
    tick_cpu_ms: { p50: null, p99: null },
  } as unknown as PoolEvent;
}

describe("loadState fills metrics_active for an old snapshot (CO42b)", () => {
  it("takes the newest metrics event with landings at or before the snapshot", () => {
    const sql = sqlite();
    initSchema(sql);
    insertEvent(sql, metrics(1, 2.5));
    insertEvent(sql, metrics(2, 4));
    insertEvent(sql, metrics(3, 0));
    const old = emptyFloorState() as Partial<ReturnType<typeof emptyFloorState>>;
    delete old.metrics_active;
    writeSnapshot(sql, 3, old as ReturnType<typeof emptyFloorState>);
    insertEvent(sql, metrics(4, 0));

    const { n, state } = loadState(sql);
    expect(n).toBe(4);
    expect(state.metrics_active?.n).toBe(2);
    expect(state.metrics_active?.landings_per_second).toBe(4);
  });

  it("is null when no window measured a landing", () => {
    const sql = sqlite();
    initSchema(sql);
    insertEvent(sql, metrics(1, 0));
    const old = emptyFloorState() as Partial<ReturnType<typeof emptyFloorState>>;
    delete old.metrics_active;
    writeSnapshot(sql, 1, old as ReturnType<typeof emptyFloorState>);
    expect(loadState(sql).state.metrics_active).toBeNull();
  });
});
