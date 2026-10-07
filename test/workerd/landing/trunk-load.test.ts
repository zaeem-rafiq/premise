// Opt-in local replica of the live soak. Full suites only collect this test by default.
// Run both dials, serially, after building:
// TRUNK_LOAD=1 TRUNK_LOAD_LABEL=before TMPDIR="$PWD/.tmp-test" env -u HTTP_PROXY -u HTTPS_PROXY \
//   -u http_proxy -u https_proxy npx vitest run --project workerd test/workerd/landing/trunk-load.test.ts
// TRUNK_LOAD_AGENTS and TRUNK_LOAD_DIALS support a small instrumentation smoke run; reports
// always retain the actual configuration, so a smoke run cannot be mistaken for 256 agents.
// TRUNK_LOAD_HOLD=1 is a supplemental congestion run: hold every scripted pattern before
// submit, let all scheduled agents launch, settle for five seconds, then release through the
// real Swarm route. It does not replace the unheld workload matching the live configuration.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { patternIds } from "../../../src/swarm/pattern.ts";
import { SWARM_DEFAULTS } from "../../../src/config/floor-json.ts";
import { bearer, createPool, KEY } from "../collide/helpers.ts";
import { startLandingWorker } from "./harness.ts";
import {
  summarizeTrunkLoad,
  type TrunkLoadCall,
  type TrunkLoadSnapshot,
} from "../../../scripts/scale/trunk-load-instrument.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { instrumentTrunkLoad } = await import("../../../scripts/scale/trunk-load-instrument.ts");
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const result = actual.readFileSync(...args);
      if (String(args[0]).endsWith("/dist/worker/index.js") && typeof result === "string")
        return instrumentTrunkLoad(result);
      return result;
    },
  };
});

const enabled = process.env.TRUNK_LOAD === "1";
const agents = Number(process.env.TRUNK_LOAD_AGENTS ?? 256);
const dials = (process.env.TRUNK_LOAD_DIALS ?? "0.5,1").split(",").map(Number);
const timeoutMs = Number(process.env.TRUNK_LOAD_TIMEOUT_MS ?? 600_000);
const boundMs = Number(process.env.TRUNK_LOAD_BOUND_MS ?? 1_000);
const label = process.env.TRUNK_LOAD_LABEL ?? "sample";
const hold = process.env.TRUNK_LOAD_HOLD === "1";
const scratch = resolve(".tmp-test");
if (enabled) {
  if (resolve(process.env.TMPDIR ?? "") !== scratch) throw new Error('set TMPDIR="$PWD/.tmp-test"');
  if (!Number.isInteger(agents) || agents < 1 || agents > 256) throw new Error("invalid TRUNK_LOAD_AGENTS");
  if (dials.some((dial) => dial !== 0.5 && dial !== 1)) throw new Error("TRUNK_LOAD_DIALS must contain 0.5 or 1");
  if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error("invalid TRUNK_LOAD_LABEL");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) throw new Error("invalid TRUNK_LOAD_TIMEOUT_MS");
  mkdirSync(scratch, { recursive: true });
}

for (const dial of dials) {
  it.skipIf(!enabled)(
    `measures every Trunk call for ${agents} scripted agents, seed 7, collision_dial ${dial}`,
    async () => {
      const pool = `trunk-load-${String(dial).replace(".", "-")}`;
      const config = {
        pool,
        seed: 7,
        agents,
        launch_per_second: 2,
        collision_dial: dial,
        think_ms: SWARM_DEFAULTS.think_ms,
        rescale_every_s: SWARM_DEFAULTS.rescale_every_s,
        running: true,
        request_id: "trunk-load-measurement",
        ...(hold ? { hold_before_submit: [...patternIds()] } : {}),
      };
      const rescales = Math.floor(agents / config.launch_per_second / config.rescale_every_s);
      const expectedAttempts = agents + rescales;
      const build = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const bundleSha256 = createHash("sha256")
        .update(readFileSync(resolve("dist/worker/index.js")))
        .digest("hex");
      const worker = await startLandingWorker({
        ownerKey: KEY,
        repos: [pool],
        swarm: true,
        // Match the shipped flag while making the harness read its in-memory bundle.
        features: { held: true },
      });
      const rows: TrunkLoadCall[] = [];
      const output = join(scratch, `trunk-load-${label}-d${String(dial).replace(".", "-")}.json`);
      const began = Date.now();
      let snapshot: TrunkLoadSnapshot = { rows: [], total: 0, states: {}, pending_outbox: 0, errors: 0 };
      let completed = false;
      let failure: string | null = null;
      let lastSaved = 0;
      let nextProgress = 0;
      let peakInflight = 0;
      let allLaunchedAt: number | null = null;
      let countConservation: {
        matched: boolean;
        session_calls: Record<string, number>;
        recorded_calls: Record<string, number>;
        outside_session_entries: Record<string, number>;
      } | null = null;
      let releasePoint: {
        started_ms: number;
        completed_ms: number | null;
        attempts: number;
        states: Record<string, number>;
        released: number | null;
      } | null = null;
      const save = () => {
        writeFileSync(
          output,
          JSON.stringify(
            {
              build,
              bundle_sha256: bundleSha256,
              label,
              supplemental_hold: hold,
              peak_inflight: peakInflight,
              release_point: releasePoint,
              count_conservation: countConservation,
              config,
              expected_attempts: expectedAttempts,
              elapsed_ms: Date.now() - began,
              completed,
              failure,
              bound_ms: boundMs,
              over_bound: rows.filter((row) => row.call_ms > boundMs || row.transaction_max_ms > boundMs).length,
              states: snapshot.states,
              pending_outbox: snapshot.pending_outbox,
              instrumentation:
                "Local workerd performance.now wall time. call_ms includes EngineSession hydration, callback, persistence and observer counters. engine_ms is facade method time; transaction_ms sums outer transactionSync intervals and transaction_max_ms is their maximum. total_changes includes repeated writes and trigger effects, including rolled-back writes if a call failed. Per-table deltas include observer SQL reads in timed intervals. Network/push/async alarm waits are excluded. Alarm engine entries and standalone shell transactions are included. No production timing claim.",
              ...summarizeTrunkLoad(rows),
              rows,
            },
            null,
            2,
          ),
        );
        lastSaved = Date.now();
      };
      const collect = async () => {
        const response = await worker.trunk(pool).fetch(`/__test/trunk-load?after=${rows.length}`);
        expect(response.status, "test-only measurement endpoint").toBe(200);
        snapshot = (await response.json()) as TrunkLoadSnapshot;
        expect(snapshot.total, "Trunk must not reset and lose its local metrics").toBeGreaterThanOrEqual(rows.length);
        rows.push(...snapshot.rows);
        for (const row of snapshot.rows) peakInflight = Math.max(peakInflight, row.inflight ?? 0);
        const total = Object.values(snapshot.states).reduce((sum, n) => sum + n, 0);
        peakInflight = Math.max(peakInflight, total - (snapshot.states.landed ?? 0) - (snapshot.states.stopped ?? 0));
      };
      try {
        await createPool(worker, pool, { summary_only: true });
        await collect();
        expect(rows.some((row) => row.entry === "pool_create")).toBe(true);
        const response = await worker.fetch("/api/swarm", bearer(config));
        expect(response.status, await response.clone().text()).toBe(200);
        while (Date.now() - began < timeoutMs) {
          await collect();
          const total = Object.values(snapshot.states).reduce((sum, n) => sum + n, 0);
          const finished = (snapshot.states.landed ?? 0) + (snapshot.states.stopped ?? 0);
          if (hold && releasePoint === null && total === expectedAttempts) {
            allLaunchedAt ??= Date.now();
            if (Date.now() - allLaunchedAt >= 5_000) {
              releasePoint = {
                started_ms: Date.now() - began,
                completed_ms: null,
                attempts: total,
                states: { ...snapshot.states },
                released: null,
              };
              save();
              const release = await worker.fetch(
                "/api/swarm",
                bearer({
                  pool,
                  running: true,
                  release: [...patternIds()],
                  request_id: "trunk-load-release-measurement",
                }),
              );
              expect(release.status, await release.clone().text()).toBe(200);
              const body = (await release.json()) as { released: string[] };
              releasePoint.completed_ms = Date.now() - began;
              releasePoint.released = body.released.length;
              save();
            }
          }
          completed = total === expectedAttempts && finished === expectedAttempts && snapshot.pending_outbox === 0;
          if (Date.now() - lastSaved >= 5_000 || completed) save();
          if (Date.now() >= nextProgress) {
            console.log(
              JSON.stringify({
                dial,
                elapsed_s: Math.round((Date.now() - began) / 1_000),
                calls: rows.length,
                expected_attempts: expectedAttempts,
                supplemental_hold: hold,
                peak_inflight: peakInflight,
                released: releasePoint?.released ?? null,
                states: snapshot.states,
              }),
            );
            nextProgress = Date.now() + 30_000;
          }
          if (completed) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
        }
        if (!completed) failure = "workload_timeout";
        if (completed) {
          const sessionCounts = async (): Promise<Record<string, number>> => {
            const state = await worker.trunk(pool).state();
            const metrics = state.engine_session as {
              calls: Record<string, { reused: number; reopened: number }>;
            };
            return Object.fromEntries(
              Object.entries(metrics.calls)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([entry, counts]) => [entry, counts.reused + counts.reopened]),
            );
          };
          // State and measurement routes are separate requests. Bracket the collection with
          // equal session counters so a final alarm cannot create a false missing-call report.
          // Current production facade calls outside EngineSession use distinct names
          // (pool_create/createImported/open); shell_transaction is deliberately extra.
          let stable = false;
          for (let pass = 0; pass < 5; pass++) {
            const before = await sessionCounts();
            await collect();
            const after = await sessionCounts();
            if (JSON.stringify(before) !== JSON.stringify(after)) continue;
            stable = true;
            const recorded = rows.reduce<Record<string, number>>((counts, row) => {
              counts[row.entry] = (counts[row.entry] ?? 0) + 1;
              return counts;
            }, {});
            const recordedSession = Object.fromEntries(
              Object.keys(after).map((entry) => [entry, recorded[entry] ?? 0]),
            );
            countConservation = {
              matched: Object.entries(after).every(([entry, count]) => recordedSession[entry] === count),
              session_calls: after,
              recorded_calls: recordedSession,
              outside_session_entries: Object.fromEntries(
                Object.entries(recorded).filter(([entry]) => !(entry in after)),
              ),
            };
            save();
            expect(recordedSession, "every EngineSession call has one measurement").toEqual(after);
            break;
          }
          expect(stable, "completed workload session counters must settle for a consistent measurement").toBe(true);
        }
        save();
        console.log(JSON.stringify({ output, completed, states: snapshot.states, ...summarizeTrunkLoad(rows) }));
        expect(completed, `unfinished workload; partial measurements saved in ${output}`).toBe(true);
        expect(snapshot.errors, "synchronous engine failures").toBe(0);
        if (hold) expect(releasePoint?.completed_ms, "all held patterns were released").toBeTypeOf("number");
        expect(rows.some((row) => row.entry === "tick" && row.batch_size > 0)).toBe(true);
        expect(rows.some((row) => row.call_ms > 0 && row.transaction_ms > 0)).toBe(true);
        if (process.env.TRUNK_LOAD_ENFORCE === "1") {
          expect(
            rows.filter((row) => row.call_ms > boundMs || row.transaction_max_ms > boundMs),
            output,
          ).toEqual([]);
        }
      } catch (error) {
        failure ??= error instanceof Error ? error.message : "measurement_failed";
        try {
          await collect();
        } catch {
          /* Preserve already collected evidence when the object stopped answering. */
        }
        save();
        throw error;
      } finally {
        await worker.dispose();
      }
    },
    timeoutMs + 60_000,
  );
}
