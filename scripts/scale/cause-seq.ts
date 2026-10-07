// Offline: TMPDIR="$PWD/.tmp-test" node scripts/scale/cause-seq.ts
// Only this Node harness instruments source at load time; pure production modules keep no clock.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import type { Sql } from "../../src/protocol/ports.ts";
import type { ModelToolMessage, ToolRequest } from "../../src/protocol/tools.ts";
import type { Trunk as TrunkType } from "../../src/core/trunk/registry.ts";

type Timing = { ms: number; calls: number };
const samples = Number(process.env.SCALE_SAMPLES ?? 7);
const target = Number(process.env.SCALE_FILES ?? 260);
assert(Number.isInteger(samples) && samples > 0);
assert(Number.isInteger(target) && target >= 30);
let recording: Map<string, Timing> | null = null;
let causeDepth = 0;
let mode: "exact" | "first" = "exact";
function measure<T>(name: string, run: () => T): T {
  if (recording === null) return run();
  const start = performance.now();
  const inCause = causeDepth > 0;
  if (name === "cause") causeDepth++;
  try {
    return run();
  } finally {
    if (name === "cause") causeDepth--;
    const elapsed = performance.now() - start;
    for (const key of inCause ? [name, `cause.${name}`] : [name]) {
      const timing = recording.get(key) ?? { ms: 0, calls: 0 };
      timing.ms += elapsed;
      timing.calls++;
      recording.set(key, timing);
    }
  }
}
const meterKey = "__premiseCauseScale";
Object.assign(globalThis, { [meterKey]: { measure, first: () => mode === "first" } });
const instrumented = new Set<string>();
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    const names = url.endsWith("/src/core/entities/entities.ts")
      ? ["parseModule"]
      : url.endsWith("/src/core/refs/refs.ts")
        ? ["analyse", "refsMembers"]
        : url.endsWith("/src/core/keys/members.ts")
          ? ["membersHash"]
          : url.endsWith("/src/core/trunk/cause-seq.ts")
            ? ["batchCauseSeq"]
            : [];
    if (names.length === 0) return loaded;
    let source = String(loaded.source);
    for (const name of names) {
      const declaration = `export function ${name}(`;
      assert(source.includes(declaration), `instrumentation missing ${name}`);
      source = source.replace(declaration, `function __scale_${name}(`);
      const meter = `globalThis.${meterKey}`;
      source +=
        name === "batchCauseSeq"
          ? `\nexport function batchCauseSeq(...args) {
            if (${meter}.first()) return () => args[1][0]?.seq ?? null;
            const resolve = __scale_batchCauseSeq(...args);
            return (...query) => ${meter}.measure("cause", () => resolve(...query));
          }\n`
          : `\nexport function ${name}(...args) {
            return ${meter}.measure("${name}", () => __scale_${name}(...args));
          }\n`;
      instrumented.add(name);
    }
    return { ...loaded, source };
  },
});
// Dynamic imports ensure the harness installs its hooks before any pure module loads.
const { Trunk } = await import("../../src/core/trunk/registry.ts");
const { keyHash } = await import("../../src/core/trunk/sets.ts");
const { buildSeeds } = await import("../seeds/build.ts");
const { patternById } = await import("../../src/swarm/pattern.ts");
const { agentRandom } = await import("../../src/swarm/prng.ts");
const { ScriptedTriage } = await import("../../src/swarm/scripted-triage.ts");
assert.equal(instrumented.size, 5);
const db = new DatabaseSync(":memory:");
let depth = 0;
const sql: Sql = {
  exec(query, ...bindings) {
    const rows = db.prepare(query).all(...bindings) as Record<string, unknown>[];
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
      depth--;
    }
  },
};
const opts = { now: () => 1_000_000, summary_only: true, syncTriage: ScriptedTriage };
let calls = 0;
function tool(trunk: TrunkType, id: string, name: ToolRequest["tool"], args: ToolRequest["args"]) {
  const response = trunk.tool({ attempt_id: id, call_id: `scale-${++calls}`, tool: name, args, ack: 0 });
  assert.equal(response.ok, true, JSON.stringify(response));
  return response;
}
function prepare(trunk: TrunkType, id: string, patternId: string, n: number) {
  const pattern = patternById(patternId)!;
  trunk.openAttempt(id, { intent: pattern.intent, agent_kind: "synthetic", truth: [...pattern.truth] });
  let state: unknown = null;
  let last: ModelToolMessage | null = null;
  const rand = agentRandom(42017, n);
  for (let step = 0; step < 30; step++) {
    const next = pattern.next({ state, last, heads_ups: [], hold: false, released: true, attempt_id: id, rand });
    assert.equal(next.kind, "tool");
    if (next.kind !== "tool") throw new Error("pattern did not validate");
    state = next.state;
    const response = tool(trunk, id, next.tool, next.args as ToolRequest["args"]);
    last = { result: response.result, heads_ups: [] };
    if (next.tool === "submit") {
      assert.equal((response.result as { status: string }).status, "validated");
      return;
    }
  }
  throw new Error("pattern exhausted its step bound");
}
let trunk = Trunk.create(sql, Object.fromEntries(buildSeeds().get("tidepool-swarm")!), opts);
trunk.pushOk();
let grown = 0;
while (trunk.pool.files.size < target) {
  const count = Math.min(16, target - trunk.pool.files.size);
  for (let i = 0; i < count; i++, grown++) {
    prepare(
      trunk,
      `a_g${String(grown).padStart(6, "0")}`,
      ["add-plain", "add-energy", "add-relative"][grown % 3]!,
      grown,
    );
  }
  trunk.tick();
  assert.equal(trunk.out.accepted.length, count);
  trunk.pushOk();
  trunk = Trunk.open(sql, opts);
}
const fixture = {
  files: trunk.pool.files.size,
  bytes: [...trunk.pool.files.values()].reduce((n, source) => n + Buffer.byteLength(source), 0),
  landings: trunk.pool.landings.length,
};
console.error(`Grew tidepool-swarm: ${JSON.stringify(fixture)}`);
const query = "refs:world/energy.js#ENERGY_MAX";
const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * q)]!;
const round = (n: number) => Math.round(n * 1000) / 1000;
const results: Record<string, unknown>[] = [];
for (const batch of [1, 8, 16]) {
  const rows: Array<{ mode: string; ms: number; cpu: number; timings: Map<string, Timing> }> = [];
  // Paired samples alternate order. Each opens the same grown DB snapshot, prepares the same
  // calls, and warms ordinary analysis before the timed tick, as a retained Trunk does.
  for (let sample = -1; sample < samples; sample++) {
    for (const candidate of sample % 2 === 0 ? (["exact", "first"] as const) : (["first", "exact"] as const)) {
      mode = candidate;
      db.exec("SAVEPOINT sample");
      trunk = Trunk.open(sql, opts);
      for (const id of ["observer-a", "observer-b"]) {
        trunk.openAttempt(id, { intent: "Rescale energy", agent_kind: "synthetic" });
        tool(trunk, id, "read", { path: "world/energy.js", entity: "ENERGY_MAX" });
        tool(trunk, id, "replace", { path: "world/energy.js", old: "ENERGY_MAX = 100", new: "ENERGY_MAX = 1" });
        assert(trunk.pool.attempts.get(id)!.premises.has(`query|${query}`));
      }
      for (let i = 0; i < batch; i++) {
        prepare(trunk, `a_z${String(i).padStart(6, "0")}`, i === batch - 1 ? "add-energy" : "add-plain", 1000 + i);
      }
      const pre = keyHash(trunk.pool.files, "query", query).hash;
      const seq = trunk.pool.headSeq();
      const timings = new Map<string, Timing>();
      recording = timings;
      const used = process.cpuUsage();
      const started = performance.now();
      trunk.tick();
      const ms = performance.now() - started;
      const cpu = process.cpuUsage(used);
      recording = null;
      assert.equal(trunk.out.accepted.length, batch);
      const landings = trunk.pool.landings.slice(-batch);
      assert.deepEqual(
        landings.map((l) => keyHash(l.after, "query", query).hash === pre),
        Array.from({ length: batch }, (_, i) => i < batch - 1),
      );
      for (const id of ["observer-a", "observer-b"]) {
        const judgment = trunk.out.judgments.find((j) => j.attempt_id === id && j.key === query);
        assert.equal(judgment?.rule, "QR1");
        assert.equal(judgment.cause_seq, seq + (mode === "exact" ? batch : 1));
      }
      if (sample >= 0) rows.push({ mode, ms, cpu: (cpu.user + cpu.system) / 1000, timings });
      db.exec("ROLLBACK TO sample");
      db.exec("RELEASE sample");
    }
  }
  for (const candidate of ["first", "exact"]) {
    const selected = rows.filter((row) => row.mode === candidate);
    const total = selected.reduce((n, row) => n + row.ms, 0);
    const names = [...new Set(selected.flatMap((row) => [...row.timings.keys()]))];
    results.push({
      batch,
      mode: candidate,
      tick_ms_p50: round(
        quantile(
          selected.map((r) => r.ms),
          0.5,
        ),
      ),
      tick_ms_p95: round(
        quantile(
          selected.map((r) => r.ms),
          0.95,
        ),
      ),
      tick_ms_max: round(Math.max(...selected.map((r) => r.ms))),
      cpu_ms_p50: round(
        quantile(
          selected.map((r) => r.cpu),
          0.5,
        ),
      ),
      timings: Object.fromEntries(
        names.map((name) => {
          const ms = selected.reduce((n, row) => n + (row.timings.get(name)?.ms ?? 0), 0);
          return [
            name,
            {
              ms_mean: round(ms / samples),
              share_pct: round((100 * ms) / total),
              calls_mean: selected.reduce((n, row) => n + (row.timings.get(name)?.calls ?? 0), 0) / samples,
            },
          ];
        }),
      ),
      raw_tick_ms: selected.map((row) => round(row.ms)),
      raw_cause_ms: selected.map((row) => round(row.timings.get("cause")?.ms ?? 0)),
    });
  }
}
console.log(
  JSON.stringify(
    {
      fixture,
      samples,
      notes:
        "Local Node SQLite synchronous wall and process CPU time. Instrumented inclusive timings overlap: analyse includes parseModule; cause includes its analyse, refsMembers and membersHash. first is a harness-only counterfactual using the old batch-first cause, not valid production attribution. Preparation, open, correctness assertions and simulated pushOk are outside tick. No remote service. Raw maxima include GC/scheduling; no live CPU claim.",
      results,
    },
    null,
    2,
  ),
);
db.close();
