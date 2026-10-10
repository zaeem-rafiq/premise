// The engine half of the green line (01-core 11.5): GR1, GR1a, GR2, GR3 (with GR3b's part-14a
// end), GR4 and GR8 on a real Trunk over node:sqlite. The verifier is not run here: each test
// hands `greenDone` the result a run would produce, and checks what the engine does with it.

import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { GREEN_MIN_INTERVAL_MS, GREEN_TIMEOUT_MS } from "../../protocol/constants.ts";
import type { VerifyResult } from "../../protocol/green.ts";
import type { Sql } from "../../protocol/ports.ts";
import type { ToolRequest } from "../../protocol/tools.ts";
import { Trunk } from "./registry.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const PASS = [
  { name: "parse", ok: true },
  { name: "imports_resolve", ok: true },
  { name: "policy_invariants", ok: true },
];
const FAIL = [
  { name: "parse", ok: false, code: "parse:failed" },
  { name: "imports_resolve", ok: true },
  { name: "policy_invariants", ok: true },
];

function fixture(green: "none" | "static" = "static") {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sql: Sql = {
    exec(query, ...values) {
      const rows = db.prepare(query).all(...values) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
    transaction(run) {
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
  const clock = { now: 1_000_000 };
  const trunk = Trunk.create(
    sql,
    {
      ".premise/policy.json": JSON.stringify({ v: 1, default: "auto" }),
      "world.js": "export const LIMIT = 100;\n",
    },
    { now: () => clock.now, features: { green } },
  );
  trunk.pushOk();
  let n = 0;
  const call = (attempt_id: string, tool: ToolRequest["tool"], args: ToolRequest["args"]) => {
    const r = trunk.tool({ attempt_id, call_id: `call-${++n}`, tool, args, ack: 0 });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  };
  /** One change lands and its batch is pushed (`batch.pushed`, then `landing.landed`). */
  const land = (id: string, path: string) => {
    trunk.openAttempt(id, { intent: `add ${path}` });
    call(id, "write", { path, content: `export const ${id} = 1;\n` });
    call(id, "submit", { summary: `add ${path}` });
    trunk.tick();
    trunk.pushOk();
    expect(trunk.pool.attempts.get(id)?.state).toBe("landed");
    return trunk.pool.landings.at(-1)!;
  };
  const timer = (): number | null => {
    const row = db.prepare("SELECT due_at FROM timers WHERE kind = 'green'").get() as { due_at: number } | undefined;
    return row === undefined ? null : row.due_at;
  };
  const events = (type: string): Array<Record<string, unknown>> =>
    (db.prepare("SELECT body FROM events_out ORDER BY n").all() as Array<{ body: string }>)
      .map((r) => JSON.parse(r.body) as Record<string, unknown>)
      .filter((e) => e.type === type);
  const result = (seq: number, commit: string, checks: VerifyResult["checks"]): VerifyResult => ({
    seq,
    commit,
    ok: checks.every((c) => c.ok),
    runtime: "static",
    checks,
    duration_ms: 3,
    log: checks.every((c) => c.ok) ? "" : "parse: creatures/x.js",
  });
  return { trunk, clock, land, timer, events, result };
}

describe("the green line's engine half (01-core 11.5)", () => {
  it("GR1: batch.pushed arms the green timer, and a run verifies the newest landing on main (GR1a)", () => {
    const { trunk, clock, land, timer } = fixture();
    expect(trunk.green()).toEqual({ state: "idle" }); // the seed is green by definition (SE19)
    const l = land("A", "a.js");
    expect(timer()).toBe(clock.now);
    const start = trunk.green();
    expect(start).toMatchObject({ state: "verify", seq: 1, commit: l.commit_oid, run: 1, old_green: "" });
    if (start.state !== "verify") throw new Error("expected a run");
    expect(new Map(start.files).get("a.js")).toBe("export const A = 1;\n");
    expect(new Map(start.green_files).has("a.js")).toBe(false); // the green commit is the seed
    // The watchdog of GR1a stands while the run is in flight.
    expect(timer()).toBe(clock.now + GREEN_TIMEOUT_MS + GREEN_MIN_INTERVAL_MS);
  });

  it("GR1: one verification in flight; a landing meanwhile waits for the answer, then the interval", () => {
    const { trunk, clock, land, timer, result } = fixture();
    const first = land("A", "a.js");
    const started = clock.now;
    trunk.green();
    clock.now += 100;
    land("B", "b.js");
    expect(trunk.green()).toEqual({ state: "idle" }); // in flight: no second run
    clock.now += 100;
    expect(
      trunk.greenDone({ seq: 1, commit: first.commit_oid, run: 1, result: result(1, first.commit_oid, PASS) }),
    ).toMatchObject({
      ok: true,
      applied: "advanced",
    });
    // Landing 2 is newer than the green line: the next run is due GREEN_MIN_INTERVAL_MS after the start.
    expect(timer()).toBe(started + GREEN_MIN_INTERVAL_MS);
    expect(trunk.green()).toEqual({ state: "idle" });
    clock.now = started + GREEN_MIN_INTERVAL_MS;
    expect(trunk.green()).toMatchObject({ state: "verify", seq: 2, run: 1, old_green: first.commit_oid });
  });

  it("GR2: a pass emits green.verified (confirmed) then green.advanced, and pool.state carries green_seq", () => {
    const { trunk, land, events, result, timer } = fixture();
    const l = land("A", "a.js");
    trunk.green();
    trunk.greenDone({ seq: 1, commit: l.commit_oid, run: 1, result: result(1, l.commit_oid, PASS) });
    expect(events("green.verified")).toEqual([
      expect.objectContaining({
        seq: 1,
        commit: l.commit_oid,
        ok: true,
        runtime: "static",
        checks: PASS,
        ms: 3,
        confirmed: true,
      }),
    ]);
    expect(events("green.advanced")).toEqual([expect.objectContaining({ seq: 1, commit: l.commit_oid })]);
    expect(events("pool.state").at(-1)).toMatchObject({ green_seq: 1 });
    expect(trunk.pool.meta.get("green_commit")).toBe(l.commit_oid);
    expect(timer()).toBeNull(); // caught up: nothing left to verify
  });

  it("GR3 and GR3b: a first failure reruns the same commit; a second confirms it and takes nothing back", () => {
    const { trunk, clock, land, events, result, timer } = fixture();
    const l = land("A", "a.js");
    const landingsBefore = trunk.pool.landings.length;
    trunk.green();
    expect(
      trunk.greenDone({ seq: 1, commit: l.commit_oid, run: 1, result: result(1, l.commit_oid, FAIL) }),
    ).toMatchObject({
      applied: "rerun",
    });
    expect(events("green.verified").at(-1)).toMatchObject({ ok: false, confirmed: false, checks: FAIL });
    expect(timer()).not.toBeNull();
    clock.now += GREEN_MIN_INTERVAL_MS;
    expect(trunk.green()).toMatchObject({ state: "verify", seq: 1, commit: l.commit_oid, run: 2 });
    expect(
      trunk.greenDone({ seq: 1, commit: l.commit_oid, run: 2, result: result(1, l.commit_oid, FAIL) }),
    ).toMatchObject({
      applied: "red",
    });
    expect(events("green.verified").at(-1)).toMatchObject({ ok: false, confirmed: true });
    expect(events("green.advanced")).toEqual([]);
    expect(trunk.pool.meta.get("green_seq")).toBe("0");
    // GR3b: part 14a queues no revert and reopens nothing.
    expect(trunk.pool.undoQueue).toEqual([]);
    expect(trunk.pool.landings.length).toBe(landingsBefore);
    expect(trunk.pool.attempts.get("A")?.state).toBe("landed");
    // GR1a: the confirmed red commit is not verified again; the next landing is.
    expect(timer()).toBeNull();
    clock.now += GREEN_MIN_INTERVAL_MS;
    expect(trunk.green()).toEqual({ state: "idle" });
    land("B", "b.js");
    expect(trunk.green()).toMatchObject({ state: "verify", seq: 2, run: 1 });
  });

  it("GR7: the log never reaches an event and is stored redacted for the owner", () => {
    const { trunk, land, events, result } = fixture();
    const l = land("A", "a.js");
    trunk.green();
    const failed = { ...result(1, l.commit_oid, FAIL), log: "parse: x.js art_v1_0123456789abcdef0123" };
    trunk.greenDone({ seq: 1, commit: l.commit_oid, run: 1, result: failed });
    const stream = JSON.stringify(events("green.verified"));
    expect(stream).not.toContain("x.js");
    expect(stream).not.toContain("log");
    expect(JSON.parse(trunk.pool.meta.get("green_last")!).log).toBe("parse: x.js [redacted]");
  });

  it("GR4: a result for a commit that is not its seq's landing on main is discarded", () => {
    const { trunk, land, events, result } = fixture();
    land("A", "a.js");
    const start = trunk.green();
    if (start.state !== "verify") throw new Error("expected a run");
    // The run's own answer, but the landing of seq 1 is gone (a rebuild found another history).
    trunk.pool.landings[0]!.commit_oid = "f".repeat(40);
    expect(
      trunk.greenDone({ seq: 1, commit: start.commit, run: 1, result: result(1, start.commit, PASS) }),
    ).toMatchObject({
      applied: "discarded",
    });
    expect(events("green.verified")).toEqual([]);
    expect(trunk.pool.meta.get("green_seq")).toBe("0");
  });

  it("GR4: an answer for a run that is not in flight changes nothing", () => {
    const { trunk, land, events, result } = fixture();
    const l = land("A", "a.js");
    expect(trunk.greenDone({ seq: 1, commit: l.commit_oid, run: 1, result: result(1, l.commit_oid, PASS) })).toEqual({
      ok: false,
      error: { code: "stale" },
    });
    expect(events("green.verified")).toEqual([]);
  });

  it("GR8: a result with a check name or code outside the fixed list is refused and emits nothing", () => {
    const { trunk, land, events, result } = fixture();
    const l = land("A", "a.js");
    trunk.green();
    const bad = result(1, l.commit_oid, [{ name: "parse", ok: false, code: "crab.js line 3: unexpected token" }]);
    expect(trunk.greenDone({ seq: 1, commit: l.commit_oid, run: 1, result: bad })).toEqual({
      ok: false,
      error: { code: "invalid_result" },
    });
    trunk.green();
    const named = result(1, l.commit_oid, [{ name: "crab_hides", ok: true }]);
    expect(trunk.greenDone({ seq: 1, commit: l.commit_oid, run: 1, result: named })).toMatchObject({ ok: false });
    expect(events("green.verified")).toEqual([]);
  });

  it("GR1a: a run with no verdict emits nothing and comes back at the backoff it was given", () => {
    const { trunk, clock, land, events, timer } = fixture();
    const l = land("A", "a.js");
    trunk.green();
    expect(trunk.greenDone({ seq: 1, commit: l.commit_oid, aborted: true, retry_at: clock.now + 500 })).toMatchObject({
      applied: "aborted",
    });
    expect(events("green.verified")).toEqual([]);
    expect(timer()).toBe(clock.now + GREEN_MIN_INTERVAL_MS); // never earlier than GR1's interval
  });

  it("GR1a: a run that never answered is abandoned after the timeout, and the next one starts", () => {
    const { trunk, clock, land } = fixture();
    land("A", "a.js");
    trunk.green();
    clock.now += GREEN_TIMEOUT_MS;
    expect(trunk.green()).toEqual({ state: "idle" });
    clock.now += GREEN_MIN_INTERVAL_MS;
    expect(trunk.green()).toMatchObject({ state: "verify", seq: 1, run: 1 });
  });

  it('GR5: with features.green "none" no timer is armed and no run starts', () => {
    const { trunk, land, timer } = fixture("none");
    land("A", "a.js");
    expect(timer()).toBeNull();
    expect(trunk.green()).toEqual({ state: "idle" });
  });
});
