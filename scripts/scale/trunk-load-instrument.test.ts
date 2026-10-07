import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { instrumentTrunkLoad, summarizeTrunkLoad, type TrunkLoadCall } from "./trunk-load-instrument.ts";

function row(n: number, entry = "tick"): TrunkLoadCall {
  return {
    n,
    entry,
    call_ms: n,
    engine_ms: n - 0.1,
    transaction_ms: n - 0.2,
    transaction_max_ms: n - 0.2,
    transactions: 1,
    rows_changed: n * 2,
    judgments_written: n,
    events_written: n,
    sql_write_statements: n,
    writes_by_table: { judgments: n },
    tick_calls: 1,
    batch_size: 1,
    post_batch_classified: 2,
    analyse_calls: n,
    analyse_ms: n / 2,
    classify_calls: n,
    classify_ms: n / 2,
    failed: false,
  };
}

describe("test-only local workerd Trunk measurements", () => {
  it("reports nearest-rank p50, p99 and maximum separately for every tool", () => {
    const rows = Array.from({ length: 100 }, (_, index) => row(index + 1));
    rows.push({ ...row(101, "tool"), tool: "read" });
    rows.push({ ...row(102, "tool"), tool: "write" });
    const summary = summarizeTrunkLoad(rows);
    expect(summary.per_entry.map((entry) => entry.entry)).toEqual(["tick", "tool:read", "tool:write"]);
    expect(summary.per_entry[0]!.call_ms).toEqual({ p50: 50, p99: 99, max: 100 });
    expect(summary.per_entry[0]!.rows_changed).toEqual({ p50: 100, p99: 198, max: 200 });
    expect(summary.per_entry[0]!.writes_by_table.judgments).toEqual({ p50: 50, p99: 99, max: 100 });
    expect(summary.ten_largest.map((call) => call.n)).toEqual([102, 101, 100, 99, 98, 97, 96, 95, 94, 93]);
  });

  it("records batch context when a right-of-way alarm invokes the core tick", async () => {
    const source = `
      class DurableObject { constructor(ctx) { this.ctx = ctx; } }
      var EngineSession = class {
        exec(query) { return { toArray: () => query.includes("total_changes") ? [{ n: 0 }] : [] }; }
        transaction(run) { return run(); }
        run(name, options, run) { return run(this.trunk); }
      };
      var Trunk = class _Trunk {
        constructor(pool) { this.pool = pool; }
        tick() { this.pool.sql.transaction(() => tick(this.pool)); }
        expireRightOfWay() { this.pool.sql.transaction(() => tick(this.pool)); }
      };
      var Trunk2 = class extends DurableObject { fetch() { throw new Error("wrong route"); } };
      function sqlOf(ctx) { return ctx.sql; }
      function analyse(files, languages) { return {}; }
      function classify(pool, a, before, after, setsOverride) { return {}; }
      function tick(pool) {
        const before = pool.files;
        const after = new Map(before);
        const attempt = { id: "observer" };
        classify(pool, attempt, before, after, null);
        pool.out.landings.push({ seq: 1 });
        pool.files = after;
        classify(pool, attempt, before, after, null);
        classify(pool, attempt, before, after, null);
      }
    `;
    const measure = runInNewContext(
      instrumentTrunkLoad(source) +
        `
      async (entry, method) => {
        const sql = new EngineSession();
        const pool = { sql, files: new Map(), attempts: new Map(), headSeq: () => 0, out: { landings: [] } };
        sql.trunk = new Trunk(pool);
        sql.run(entry, {}, trunk => trunk[method]());
        const response = await new Trunk2({ sql }).fetch(new Request("http://local/__test/trunk-load"));
        return (await response.json()).rows;
      }
      `,
      { performance, URL, Request, Response },
    ) as (entry: string, method: string) => Promise<TrunkLoadCall[]>;
    for (const [entry, method] of [
      ["tick", "tick"],
      ["right_of_way", "expireRightOfWay"],
    ] as const) {
      const rows = await measure(entry, method);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        entry,
        method,
        tick_calls: 1,
        batch_size: 1,
        post_batch_classified: 1,
        classify_calls: 3,
        transactions: 1,
      });
    }
  });

  it("fails closed when bundle anchors change or duplicate", () => {
    expect(() => instrumentTrunkLoad("")).toThrow("expected one EngineSession");
    expect(() => instrumentTrunkLoad("var EngineSession = class {}; var EngineSession = class {};")).toThrow(
      "expected one EngineSession",
    );
    const anchors = [
      "var EngineSession = class {};",
      "var Trunk = class _Trunk {};",
      "var Trunk2 = class extends DurableObject {};",
      "function tick(pool) {}",
      "function classify(pool, a, before, after, setsOverride) {}",
      "function analyse(files, languages) {}",
      "function sqlOf(ctx) {}",
    ].join("\n");
    const instrumented = instrumentTrunkLoad(anchors);
    expect(instrumented.startsWith(anchors)).toBe(true);
    expect(instrumented).toContain('"/__test/trunk-load"');
    expect(instrumented).toContain('"SELECT total_changes() AS n"');
  });
});
