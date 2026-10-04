import { createPool, tick, draw } from "../main.js";
import { createPen } from "../pen.js";
import { createRecordingSurface } from "./recording-surface.js";
import { MAX_REST_SHARE, MAX_STATE_CHARS, fingerprint, checkFiles, checkTick, checkFrame } from "./invariants.js";

// The self-test runs the pool for this many ticks: one whole day and night.
export const SELFTEST_TICKS = 3600;

// The self-test always starts the random numbers from this seed.
export const SELFTEST_SEED = 7;

// A frame is drawn and checked every this many ticks.
export const DRAW_EVERY = 300;

const CHECKS = [
  "files", "no_errors", "in_bounds", "energy_range", "population", "not_exhausted",
  "state_is_data", "pen_rules", "visible", "within_reach", "draw_is_pure", "deterministic",
];

// Run the pool once. Returns { failures, tally, world }.
function runOnce(kinds, reseed, ticks) {
  reseed(SELFTEST_SEED);
  const pool = createPool(kinds);
  const control = createPen(createRecordingSurface());
  const tally = { ticks: {}, resting: {} };
  const failures = [];
  for (let n = 0; n < ticks; n += 1) {
    tick(pool);
    failures.push(...checkTick(pool.world, kinds, tally));
    if (n % DRAW_EVERY === 0 || n === ticks - 1) {
      const before = fingerprint(pool.world);
      failures.push(...checkFrame(draw(pool, control)));
      if (fingerprint(pool.world) !== before) failures.push({ name: "draw_is_pure", kind: null });
    }
  }
  return { failures, tally, world: pool.world };
}

// Run the self-test. `kinds` maps each kind name to its creature file. `reseed(n)` restarts Math.random from seed n.
// Returns the verdict: a plain object that can be sent as JSON.
export function runSelfTest({ kinds, reseed, ticks = SELFTEST_TICKS }) {
  const failed = {};
  const fail = (name, kind, detail) => {
    const key = name + "|" + (kind || "");
    if (!failed[key]) failed[key] = { name, kind: kind || null, detail: detail || null, times: 0 };
    failed[key].times += 1;
  };

  for (const problem of checkFiles(kinds)) fail("files", null, problem);
  const usable = {};
  for (const kind of Object.keys(kinds).sort()) {
    if (["spawn", "update", "draw"].every((name) => typeof kinds[kind][name] === "function")) usable[kind] = kinds[kind];
  }

  const first = runOnce(usable, reseed, ticks);
  for (const problem of first.failures) fail(problem.name, problem.kind, null);
  for (const kind of Object.keys(first.world.errors).sort()) {
    fail("no_errors", kind, first.world.errors[kind] + " failures" + (first.world.benched[kind] ? ", benched" : ""));
  }
  const restShare = {};
  for (const kind of Object.keys(first.tally.ticks).sort()) {
    restShare[kind] = (first.tally.resting[kind] || 0) / first.tally.ticks[kind];
    if (restShare[kind] > MAX_REST_SHARE) {
      fail("not_exhausted", kind, "resting " + Math.round(restShare[kind] * 100) + "% of the time");
    }
  }
  const text = JSON.stringify(first.world);
  if (text.length > MAX_STATE_CHARS) fail("state_is_data", null, text.length + " characters");
  if (fingerprint(JSON.parse(text)) !== fingerprint(first.world)) fail("state_is_data", null, "the world is not plain data");

  const second = runOnce(usable, reseed, ticks);
  const stateHash = fingerprint(first.world);
  if (fingerprint(second.world) !== stateHash) fail("deterministic", null, "two runs from the same seed ended differently");

  const problems = Object.values(failed);
  const checks = CHECKS.map((name) => {
    const mine = problems.filter((problem) => problem.name === name);
    const detail = mine.map((p) => (p.kind ? p.kind + ": " : "") + (p.detail || p.times + " times")).join("; ");
    return mine.length === 0 ? { name, ok: true } : { name, ok: false, detail };
  });
  return {
    v: 1,
    ok: problems.length === 0,
    seed: SELFTEST_SEED,
    ticks,
    kinds: Object.keys(kinds).sort(),
    checks,
    failed: problems.map((p) => ({ name: p.name, kind: p.kind })),
    rest_share: restShare,
    creatures: first.world.creatures.length,
    state_hash: stateHash,
  };
}
