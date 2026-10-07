// Opt-in measurement, identical before and after a fix. Build first, then run:
// EVENT_LATENCY=1 EVENT_LATENCY_LABEL=before TMPDIR="$PWD/.tmp-test" env -u HTTP_PROXY \
// -u HTTPS_PROXY -u http_proxy -u https_proxy npx vitest run --project workerd test/workerd/landing/event-latency.test.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { bearer, createPool, KEY, waitFor } from "../collide/helpers.ts";
import { startLandingWorker } from "./harness.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { instrumentEventLatency } = await import("./event-latency-instrument.ts");
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const result = actual.readFileSync(...args);
      return String(args[0]).endsWith("/dist/worker/index.js") && typeof result === "string"
        ? instrumentEventLatency(result, 3_000)
        : result;
    },
  };
});

type Row = { epoch: number; source_n: number; committed_at: number; entry: string; event: Record<string, unknown> };
type Push = { started_at: number; answered_at: number | null };
type Snapshot = { rows: Row[]; pushes: Push[]; states: { state: string; n: number }[]; pending: number };
const enabled = process.env.EVENT_LATENCY === "1";
const label = process.env.EVENT_LATENCY_LABEL ?? "sample";
const agents = Number(process.env.EVENT_LATENCY_AGENTS ?? 12);
const bound = process.env.EVENT_LATENCY_ASSERT === "1";
const scratch = resolve(".tmp-test");
if (enabled) {
  if (resolve(process.env.TMPDIR ?? "") !== scratch) throw new Error('set TMPDIR="$PWD/.tmp-test"');
  if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error("invalid label");
  if (!Number.isInteger(agents) || agents < 1 || agents > 256) throw new Error("invalid agent count");
  mkdirSync(scratch, { recursive: true });
}

it.skipIf(!enabled)(
  "measures commit-to-Floor delay with scripted agents and 3 s Artifacts replies",
  async () => {
    const pool = "event-latency";
    const worker = await startLandingWorker({ ownerKey: KEY, repos: [pool], swarm: true, features: { held: true } });
    const snapshot = async (): Promise<Snapshot> => {
      const response = await worker.trunk(pool).fetch("/__test/event-latency");
      expect(response.status).toBe(200);
      return (await response.json()) as Snapshot;
    };
    try {
      await createPool(worker, pool, { summary_only: true });
      const response = await worker.fetch(
        "/api/swarm",
        bearer({
          pool,
          seed: 7,
          agents,
          launch_per_second: 2,
          collision_dial: 1,
          think_ms: [10, 20],
          rescale_every_s: 600,
          running: true,
          request_id: "event-latency",
        }),
      );
      expect(response.status, await response.clone().text()).toBe(200);
      await waitFor(async () => {
        const s = await snapshot();
        return (
          s.states.filter((row) => ["landed", "stopped"].includes(row.state)).reduce((n, row) => n + row.n, 0) ===
            agents && s.pending === 0
        );
      }, 120_000);
      let s = await snapshot();
      let events = (await worker.events(pool)).filter((event) => event.src === "trunk");
      await waitFor(async () => {
        s = await snapshot();
        events = (await worker.events(pool)).filter((event) => event.src === "trunk");
        return s.rows.length === events.length;
      }, 10_000);
      const rows = s.rows.map((row, i) => {
        const { n, t, ...body } = events[i]!;
        const { n: sourceN, t: sourceT, ...sourceBody } = row.event;
        expect(body, `source event ${row.source_n}`).toEqual(sourceBody);
        return {
          ...row,
          floor_n: n,
          appended_at: Number(t),
          delay_ms: Number(t) - row.committed_at,
          source_delay_ms: Number(t) - Number(row.event.ts),
        };
      });
      const delays = rows.map((row) => row.delay_ms).sort((a, b) => a - b);
      const percentile = (p: number) => delays[Math.ceil(delays.length * p) - 1]!;
      const accepted = rows.filter((row) => row.event.type === "landing.accepted");
      const cases = accepted.map((row) => ({
        source_n: row.source_n,
        batch_id: row.event.batch_id,
        committed_at: row.committed_at,
        appended_at: row.appended_at,
        delay_ms: row.delay_ms,
        push: s.pushes.find((push) => push.started_at >= row.committed_at) ?? null,
      }));
      const summary = {
        events: rows.length,
        p50_ms: percentile(0.5),
        p99_ms: percentile(0.99),
        max_ms: delays.at(-1),
        accepted_waited_for_push: cases.filter(
          (row) => row.push?.answered_at !== null && row.push !== null && row.appended_at >= row.push.answered_at!,
        ).length,
      };
      const report = {
        label,
        build: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        bundle_sha256: createHash("sha256")
          .update(readFileSync(resolve("dist/worker/index.js")))
          .digest("hex"),
        config: { agents, seed: 7, collision_dial: 1, push_delay_ms: 3_000 },
        summary,
        cases,
        pushes: s.pushes,
        rows,
        measurement:
          "EngineSession.transaction return to Floor t, wall clock milliseconds, observer SQL overhead included. Source t-ts reported separately. Local workerd only.",
      };
      writeFileSync(resolve(scratch, `event-latency-${label}.json`), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ label, ...summary, cases }));
      expect(rows.length).toBeGreaterThan(0);
      expect(accepted.length).toBeGreaterThan(0);
      expect(s.pushes.every((push) => push.answered_at !== null && push.answered_at - push.started_at >= 3_000)).toBe(
        true,
      );
      if (bound) {
        expect(summary.p99_ms).toBeLessThan(500);
        expect(summary.accepted_waited_for_push).toBe(0);
      }
    } finally {
      await worker.dispose();
    }
  },
  180_000,
);

it("delivers a tick's accepted event before the alarm's slow push retry answers", async () => {
  const { openAttempt, tool } = await import("../collide/helpers.ts");
  mkdirSync(scratch, { recursive: true });
  const pool = "event-latency-retry";
  const worker = await startLandingWorker({ ownerKey: KEY, repos: [pool], floorFaults: true });
  let alarm: Promise<Response> | undefined;
  try {
    await createPool(worker, pool, { summary_only: true });
    await openAttempt(worker, pool, "retry-agent");
    await tool(
      worker,
      pool,
      "retry-agent",
      { tool: "write", args: { path: "creatures/latency.js", content: "export const value = 1;\n" } },
      1,
    );
    await worker.setFloorFault(pool, "block");
    worker.setGitFault((request) =>
      request.method === "POST" ? { action: "answer", status: 503 } : { action: "forward" },
    );
    await tool(worker, pool, "retry-agent", { tool: "submit", args: { summary: "latency retry" } }, 2);
    await waitFor(
      async () => Number(((await worker.trunk(pool).state()).outbox as { tries?: number } | null)?.tries ?? 0) > 0,
      15_000,
    );
    expect((await worker.events(pool)).some((event) => event.type === "landing.accepted")).toBe(false);
    // Isolate the legal ordering: pending push is due, failed event delivery is in backoff.
    // No future engine clock is used, so the measurement remains wall-clock based.
    const at = Date.now();
    await worker.sql("TRUNK", pool, "UPDATE timers SET due_at = ? WHERE kind != 'push'", at + 60_000);
    await worker.sql("TRUNK", pool, "UPDATE timers SET due_at = ? WHERE kind = 'push'", at);
    await worker.sql("TRUNK", pool, "UPDATE outbox SET next_try = ? WHERE state = 'pending'", at);
    await worker.setFloorFault(pool, "pass");
    worker.setGitFault(null);
    const read = async (): Promise<Snapshot> =>
      (await (await worker.trunk(pool).fetch("/__test/event-latency")).json()) as Snapshot;
    const before = await read();
    alarm = worker.runAlarm(pool, at);
    await waitFor(async () => (await read()).pushes.length > before.pushes.length, 5_000);
    const during = (await worker.events(pool)).find((event) => event.type === "landing.accepted");
    const response = await alarm;
    expect(response.status).toBe(200);
    alarm = undefined;
    await waitFor(async () => (await worker.events(pool)).some((event) => event.type === "landing.accepted"), 5_000);
    const s = await read();
    const accepted = s.rows.find((row) => row.event.type === "landing.accepted")!;
    const appended = (await worker.events(pool)).find((event) => event.type === "landing.accepted")!;
    const push = s.pushes.at(-1)!;
    const report = {
      label,
      committed_at: accepted.committed_at,
      appended_at: Number(appended.t),
      delay_ms: Number(appended.t) - accepted.committed_at,
      visible_during_push: during !== undefined,
      recovery_started_at: at,
      recovery_delay_ms: Number(appended.t) - at,
      push,
    };
    writeFileSync(resolve(scratch, `event-latency-retry-${label}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    expect(report.visible_during_push).toBe(true);
    expect(report.appended_at).toBeLessThan(push.answered_at!);
    expect(report.recovery_delay_ms).toBeLessThan(500);
  } finally {
    await alarm;
    await worker.dispose();
  }
}, 60_000);

it("hands a tick's landing.accepted to the Floor before its slow push answers", async () => {
  const { openAttempt, tool } = await import("../collide/helpers.ts");
  const pool = "event-latency-tick";
  const worker = await startLandingWorker({ ownerKey: KEY, repos: [pool], features: { held: true } });
  try {
    await createPool(worker, pool, { summary_only: true });
    await openAttempt(worker, pool, "tick-agent");
    await tool(
      worker,
      pool,
      "tick-agent",
      { tool: "write", args: { path: "creatures/tick.js", content: "export const value = 1;\n" } },
      1,
    );
    await tool(worker, pool, "tick-agent", { tool: "submit", args: { summary: "tick timing" } }, 2);
    const read = async (): Promise<Snapshot> =>
      (await (await worker.trunk(pool).fetch("/__test/event-latency")).json()) as Snapshot;
    await waitFor(async () => (await read()).pushes.length === 2, 5_000);
    const pending = await read();
    expect(pending.pushes[1]!.answered_at).toBeNull();
    const committed = pending.rows.find((row) => row.event.type === "landing.accepted")!;
    expect(committed.entry).toBe("tick");
    const accepted = (await worker.events(pool)).find((event) => event.type === "landing.accepted");
    expect(accepted).toBeDefined();
    expect(Number(accepted!.t) - committed.committed_at).toBeLessThan(500);
    await waitFor(async () => (await read()).pushes[1]!.answered_at !== null, 5_000);
    expect(Number(accepted!.t)).toBeLessThan((await read()).pushes[1]!.answered_at!);
  } finally {
    await worker.dispose();
  }
}, 30_000);

it("does not make a request wait for a held Floor confirmation", async () => {
  const { openAttempt } = await import("../collide/helpers.ts");
  const pool = "event-latency-confirmation";
  const worker = await startLandingWorker({ ownerKey: KEY, repos: [pool], floorFaults: true });
  let request: Promise<void> | undefined;
  try {
    await createPool(worker, pool, { summary_only: true });
    await worker.setFloorFault(pool, "hold");
    let answered = false;
    request = openAttempt(worker, pool, "held-confirmation").then(() => {
      answered = true;
    });
    await waitFor(async () => (await worker.floorFaultState(pool)).held, 5_000);
    await waitFor(() => answered, 1_000);
    expect((await worker.floorFaultState(pool)).held).toBe(true);
  } finally {
    await worker.releaseFloorResponse(pool);
    await request;
    await worker.dispose();
  }
}, 30_000);
