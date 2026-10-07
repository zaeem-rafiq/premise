// On demand, offline: TMPDIR="$PWD/.tmp-test" node scripts/scale/trunk.ts
// Synchronous performance.now() durations approximate CPU cost; process.cpuUsage also reports
// actual process CPU. SQLite is in memory. No network, files, timers or fixture SQL inserts.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import type { Sql } from "../../src/protocol/ports.ts";
import type { ToolRequest } from "../../src/protocol/tools.ts";
import { Trunk, persist } from "../../src/core/trunk/registry.ts";
import { EngineSession } from "../../src/worker/trunk/engine-session.ts";

const size = Number(process.env.SCALE_SIZE ?? 1000);
const samples = Number(process.env.SCALE_SAMPLES ?? 15);
assert(Number.isInteger(size) && size >= 3);
assert(Number.isInteger(samples) && samples >= 1);
const db = new DatabaseSync(":memory:");
type Timing = { ms: number; calls: number; rows: number };
let recording: Map<string, Timing> | null = null;
let depth = 0;
const sql: Sql = {
  exec(query, ...bindings) {
    const start = performance.now();
    const rows = db.prepare(query).all(...bindings) as Record<string, unknown>[];
    if (recording !== null) {
      const table = /(?:FROM|INTO|UPDATE)\s+(\w+)/i.exec(query)?.[1] ?? "schema";
      const kind = /^\s*SELECT/i.test(query) ? "read" : "write";
      const key = `${kind}:${table}`;
      const value = recording.get(key) ?? { ms: 0, calls: 0, rows: 0 };
      value.ms += performance.now() - start;
      value.calls += 1;
      value.rows += rows.length;
      recording.set(key, value);
    }
    return { toArray: () => rows };
  },
  transaction(run) {
    const savepoint = `call_${++depth}`;
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = run();
      db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO ${savepoint}`);
      db.exec(`RELEASE ${savepoint}`);
      throw error;
    } finally {
      depth -= 1;
    }
  },
};
const opts = { now: () => 1_000_000 };
let calls = 0;
function tool(trunk: Trunk, id: string, name: ToolRequest["tool"], args: ToolRequest["args"]) {
  const result = trunk.tool({ attempt_id: id, call_id: `call-${++calls}`, tool: name, args, ack: 0 });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (name === "submit") assert.equal((result.result as { status: string }).status, "validated");
}
let trunk = Trunk.create(
  sql,
  { ".premise/policy.json": '{"v":1,"default":"auto"}', "counter.txt": "0\n" },
  { ...opts, summary_only: true },
);
trunk.pushOk();
for (let n = 0; n < size - 1; n += 1) {
  const id = `history-${n}`;
  trunk.openAttempt(id, { intent: `Counter ${n}`, agent_kind: "synthetic" });
  tool(trunk, id, "read", { path: "counter.txt" });
  tool(trunk, id, "write", { path: "counter.txt", content: `${n + 1}\n` });
  tool(trunk, id, "submit", { summary: `Counter ${n}` });
  trunk.tick();
  trunk.pushOk();
  assert.equal(trunk.state(id), "landed");
  // Match eviction between batches, releasing generated object and snapshot working sets.
  trunk = Trunk.open(sql, opts);
}
// One undo is a landing without a new attempt. This leaves exactly `size` attempts and
// `size` landings, including the active probe, rather than timing rejected calls on a closed one.
assert.equal(trunk.undo({ seq: size - 1, expect_reverted: [size - 1], request_id: "fixture-undo" }).ok, true);
trunk.tick();
trunk.pushOk();
trunk.openAttempt("probe", { intent: "Add a probe", agent_kind: "synthetic" });
assert.equal(trunk.pool.attempts.size, size);
assert.equal(trunk.pool.landings.length, size);

const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * q)]!;
const round = (n: number) => Math.round(n * 1000) / 1000;
const results: Record<string, unknown>[] = [];
for (const mode of ["cold", "retained", "cached"] as const) {
  for (const kind of ["read", "write", "submit", "tick"] as const) {
    const elapsed: number[] = [];
    const cpu: number[] = [];
    const opening: number[] = [];
    const cleanPersist: number[] = [];
    const openSql = new Map<string, Timing>();
    const callSql = new Map<string, Timing>();
    // A SAVEPOINT restores exactly the same starting pool for every sample. The retained
    // facade is freshly loaded OUTSIDE its measured interval, so no failed transaction's
    // mutated Pool is reused. One warm-up sample is omitted from the statistics.
    for (let sample = -1; sample < samples; sample += 1) {
      db.exec("SAVEPOINT sample");
      let engine = Trunk.open(sql, opts);
      if (kind === "submit" || kind === "tick") tool(engine, "probe", "write", { path: "probe.txt", content: "ok\n" });
      if (kind === "tick") tool(engine, "probe", "submit", { summary: "Probe" });
      if (mode === "retained") engine = Trunk.open(sql, opts);
      const session = new EngineSession(sql);
      if (mode === "cached") session.run("sync", opts, () => undefined);
      recording = sample >= 0 ? openSql : null;
      const used = process.cpuUsage();
      const started = performance.now();
      if (mode === "cold") engine = Trunk.open(sql, opts);
      const opened = performance.now();
      recording = sample >= 0 ? callSql : null;
      const invoke = (current: Trunk) => {
        engine = current;
        if (kind === "read") tool(engine, "probe", "read", { path: "counter.txt" });
        if (kind === "write") tool(engine, "probe", "write", { path: "probe.txt", content: "ok\n" });
        if (kind === "submit") tool(engine, "probe", "submit", { summary: "Probe" });
        if (kind === "tick") {
          engine.tick();
          assert.equal(engine.state("probe"), "accepted");
        }
      };
      if (mode === "cached") session.run(kind === "tick" ? "tick" : "tool", opts, invoke);
      else invoke(engine);
      const finished = performance.now();
      const consumed = process.cpuUsage(used);
      recording = null;
      const saveStarted = performance.now();
      sql.transaction(() => persist(engine.pool));
      const saved = performance.now();
      if (sample >= 0) {
        elapsed.push(finished - started);
        cpu.push((consumed.user + consumed.system) / 1000);
        opening.push(opened - started);
        cleanPersist.push(saved - saveStarted);
      }
      db.exec("ROLLBACK TO sample");
      db.exec("RELEASE sample");
    }
    const groups = (map: Map<string, Timing>) =>
      Object.fromEntries(
        [...map]
          .sort((a, b) => b[1].ms - a[1].ms)
          .map(([key, value]) => [
            key,
            {
              ms_mean: round(value.ms / samples),
              calls_mean: value.calls / samples,
              rows_mean: value.rows / samples,
            },
          ]),
      );
    results.push({
      mode,
      kind,
      ms_p50: round(quantile(elapsed, 0.5)),
      ms_p95: round(quantile(elapsed, 0.95)),
      cpu_ms_p50: round(quantile(cpu, 0.5)),
      open_ms_p50: round(quantile(opening, 0.5)),
      unchanged_persist_ms_p50: round(quantile(cleanPersist, 0.5)),
      open_sql: groups(openSql),
      call_sql: groups(callSql),
    });
  }
}
console.log(
  JSON.stringify(
    {
      attempts: size,
      landings: size,
      change_landings: size - 1,
      undo_landings: 1,
      head_files: 2,
      samples,
      notes:
        "Cold includes openPool. Retained excludes openPool. Cached measures the production EngineSession, including its freshness witness and scratch release. SQL groups time SQLite and row materialization only; open minus SQL includes hydration. Clean persist is a separate no-change save, not the call's entire persistence cost. These local CPU measurements do not prove live-soak throughput.",
      results,
    },
    null,
    2,
  ),
);
db.close();
