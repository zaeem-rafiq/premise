// Throwaway spike: (1) Dynamic Worker isolate as a sealed self-test runner, (2) Clef premise triage.
const RULES = (energyMax) => `export const ENERGY_MAX = ${energyMax};
export function drain(energy, dt) { return Math.max(0, energy - 2 * dt); }
export function feed(energy, amount) { return Math.min(ENERGY_MAX, energy + amount); }`;
const CRAB = (threshold) => `import { ENERGY_MAX, drain, feed } from "../world/rules.js";
export const name = "crab";
export function spawn() { return { x: 100, y: 100, energy: ENERGY_MAX, hiding: false }; }
export function update(self, world, dt) {
  self.energy = drain(self.energy, dt);
  self.hiding = self.energy < ${threshold};
  if (self.hiding) self.energy = feed(self.energy, 5 * dt);
  self.x = (self.x + 10 * dt) % world.width;
}`;
const SELFTEST = (extra = "") => `import * as rules from "./world/rules.js";
import * as crab from "./creatures/crab.js";
export default {
  async fetch() {
    const started = Date.now();
    const world = { width: 800, height: 600, time: 0 };
    const c = crab.spawn();
    const problems = [];
    let hidingTicks = 0;
    ${extra}
    for (let t = 0; t < 3000; t++) {
      crab.update(c, world, 1 / 60);
      world.time++;
      if (!(c.energy >= 0 && c.energy <= rules.ENERGY_MAX)) { problems.push("energy out of range at tick " + t + ": " + c.energy); break; }
      if (!(c.x >= 0 && c.x <= world.width)) { problems.push("x out of bounds at tick " + t); break; }
      if (c.hiding) hidingTicks++;
    }
    return Response.json({ ok: problems.length === 0, problems, hidingTicks, finalEnergy: c.energy, ms: Date.now() - started });
  },
};`;

async function runIsolate(env, modules, limits) {
  const t0 = Date.now();
  try {
    const worker = env.LOADER.load({ compatibilityDate: "2026-10-01", mainModule: "selftest.js", modules, globalOutbound: null, ...(limits ? { limits } : {}) });
    const res = await worker.getEntrypoint().fetch("http://selftest/");
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
    return { ms: Date.now() - t0, status: res.status, body };
  } catch (e) {
    return { ms: Date.now() - t0, threw: String(e && e.message ? e.message : e).slice(0, 400) };
  }
}

async function loaderSpike(env, n) {
  const base = { "world/rules.js": RULES(100), "creatures/crab.js": CRAB(30), "selftest.js": SELFTEST() };
  const out = {};
  out.first = await runIsolate(env, base);
  const variants = [];
  for (let i = 0; i < n; i++) variants.push(await runIsolate(env, { ...base, "creatures/crab.js": CRAB(30 + i) + `\n// v${i}` }));
  out.variant_ms = variants.map((v) => v.ms);
  out.variants_ok = variants.filter((v) => v.body && v.body.ok === true).length;
  // The hero conflict as the self-test sees it: ENERGY_MAX rescaled to 1, crab still assumes 30.
  out.broken_merge = await runIsolate(env, { ...base, "world/rules.js": RULES(1) });
  out.network_blocked = await runIsolate(env, { ...base, "selftest.js": SELFTEST(`try { await fetch("https://example.com/"); problems.push("NETWORK REACHABLE"); } catch (e) { problems.length = 0; }`) });
  out.infinite_loop = await runIsolate(env, { ...base, "creatures/crab.js": CRAB(30).replace("self.x =", "while (true) {}\n  self.x =") }, { cpuMs: 50 });
  out.syntax_error = await runIsolate(env, { ...base, "creatures/crab.js": "export function update( {" });
  out.missing_export = await runIsolate(env, { ...base, "creatures/crab.js": "export const name = 'crab';" });
  const par = await Promise.all(Array.from({ length: 8 }, (_, i) => runIsolate(env, { ...base, "creatures/crab.js": CRAB(40 + i) + `\n// p${i}` })));
  out.parallel8 = { ok: par.filter((v) => v.body && v.body.ok === true).length, threw: par.filter((v) => v.threw).map((v) => v.threw).slice(0, 3), ms: par.map((v) => v.ms) };
  return out;
}

const Q = {
  depends: {
    type: "noul",
    instructions: "An agent read `premise.old_source` while writing `patch`. The code has since changed to `premise.new_source`. Would `patch` now behave incorrectly, or differently from what `intent` asks, because it relies on the OLD meaning?",
  },
  change_kind: {
    type: "choice",
    instructions: "What kind of change turned `premise.old_source` into `premise.new_source`?",
    criteria: {
      cosmetic: "Formatting, naming of locals, comments, or an equivalent rewrite with identical behaviour",
      internal: "Behaviour changes only in ways a caller relying on the documented meaning would not notice",
      meaning: "The value, unit, scale, range, or contract that other code relies on has changed",
      removed: "The thing was removed or renamed",
    },
  },
};
const CASES = [
  { id: "hardcoded-threshold-after-rescale", expect: true, state: { intent: "A crab that hides when its energy is low", premise: { key: "world/rules.js#ENERGY_MAX", old_source: "export const ENERGY_MAX = 100; // energy runs from 0 to 100", new_source: "export const ENERGY_MAX = 1; // energy is now a fraction from 0 to 1" }, patch: "export function update(self, world, dt) {\n  self.energy = drain(self.energy, dt);\n  self.hiding = self.energy < 30;\n}" } },
  { id: "scaled-threshold-after-rescale", expect: false, state: { intent: "A crab that hides when its energy is low", premise: { key: "world/rules.js#ENERGY_MAX", old_source: "export const ENERGY_MAX = 100; // energy runs from 0 to 100", new_source: "export const ENERGY_MAX = 1; // energy is now a fraction from 0 to 1" }, patch: "export function update(self, world, dt) {\n  self.energy = drain(self.energy, dt);\n  self.hiding = self.energy < ENERGY_MAX * 0.3;\n}" } },
  { id: "equivalent-rewrite", expect: false, state: { intent: "A fish that swims faster when hungry", premise: { key: "world/rules.js#drain", old_source: "export function drain(energy, dt) { return Math.max(0, energy - 2 * dt); }", new_source: "export function drain(energy, dt) {\n  const used = dt * 2;\n  return Math.max(0, energy - used);\n}" }, patch: "export function update(self, world, dt) {\n  self.energy = drain(self.energy, dt);\n  self.speed = self.energy < ENERGY_MAX / 2 ? 80 : 40;\n}" } },
  { id: "speed-unit-change", expect: true, state: { intent: "A slow snail that crawls along the bottom", premise: { key: "world/motion.js#step", old_source: "// velocity is in pixels per second\nexport function step(pos, velocity, dt) { return pos + velocity * dt; }", new_source: "// velocity is in pixels per tick\nexport function step(pos, velocity) { return pos + velocity; }" }, patch: "export function update(self, world, dt) {\n  self.x = step(self.x, 12, dt); // 12 pixels per second\n}" } },
  { id: "unrelated-food-rate", expect: false, state: { intent: "A starfish that sits still and slowly changes colour", premise: { key: "world/food.js#FOOD_PER_SECOND", old_source: "export const FOOD_PER_SECOND = 2;", new_source: "export const FOOD_PER_SECOND = 5;" }, patch: "export function update(self, world, dt) {\n  self.hue = (self.hue + 10 * dt) % 360;\n}" } },
  { id: "pixel-coordinates-after-normalising", expect: true, state: { intent: "A jellyfish that drifts around the middle of the pool", premise: { key: "world/bounds.js#WIDTH", old_source: "export const WIDTH = 800; // pool width in pixels", new_source: "export const WIDTH = 1; // positions are now fractions of the pool width" }, patch: "export function spawn() { return { x: 400, y: 300 }; }\nexport function update(self, world, dt) {\n  self.x += (400 - self.x) * 0.1 * dt;\n}" } },
  { id: "hardcoded-day-length", expect: true, state: { intent: "An anemone that closes at night", premise: { key: "world/time.js#DAY_LENGTH", old_source: "export const DAY_LENGTH = 600; // ticks in one full day", new_source: "export const DAY_LENGTH = 1200; // ticks in one full day" }, patch: "export function update(self, world, dt) {\n  self.closed = world.time % 600 >= 300; // night is the second half of the day\n}" } },
  { id: "new-optional-parameter", expect: false, state: { intent: "A fish that swims toward the nearest food", premise: { key: "world/food.js#nearestFood", old_source: "export function nearestFood(self, world) { return closest(self, world.food, 50); }", new_source: "export function nearestFood(self, world, radius = 50) { return closest(self, world.food, radius); }" }, patch: "export function update(self, world, dt) {\n  const f = nearestFood(self, world);\n  if (f) moveToward(self, f, dt);\n}" } },
];

async function clefOnce(env, model, state) {
  const t0 = Date.now();
  try {
    const r = await env.AI.run(`@cf/cloudflare/${model}`, { model, state, questions: Q });
    return { ms: Date.now() - t0, answers: r.answers, usage: r.usage };
  } catch (e) {
    return { ms: Date.now() - t0, threw: String(e && e.message ? e.message : e).slice(0, 300) };
  }
}

async function clefSpike(env, burst) {
  const out = { cases: [] };
  for (const c of CASES) {
    const row = { id: c.id, expect: c.expect };
    for (const model of ["clef-flash", "clef"]) {
      const r = await clefOnce(env, model, c.state);
      row[model] = r.threw ? { threw: r.threw } : { depends: r.answers?.depends, change_kind: r.answers?.change_kind, ms: r.ms, usage: r.usage };
    }
    out.cases.push(row);
  }
  const t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: burst }, (_, i) => clefOnce(env, "clef-flash", CASES[i % CASES.length].state)));
  out.burst = { n: burst, wall_ms: Date.now() - t0, ok: rs.filter((r) => !r.threw).length, errors: [...new Set(rs.filter((r) => r.threw).map((r) => r.threw))].slice(0, 4), ms: rs.map((r) => r.ms).sort((a, b) => a - b) };
  return out;
}

export default {
  async fetch(request, env) {
    if (!env.SPIKE_KEY || request.headers.get("x-spike-key") !== env.SPIKE_KEY) return new Response("forbidden", { status: 403 });
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    try {
      if (url.pathname === "/loader") return Response.json(await loaderSpike(env, Math.min(Number(body.n) || 5, 20)));
      if (url.pathname === "/clef") return Response.json(await clefSpike(env, Math.min(Number(body.burst) || 20, 60)));
      return Response.json({ routes: ["/loader", "/clef"] });
    } catch (e) {
      return Response.json({ error: String(e && e.stack ? e.stack : e).slice(0, 800) }, { status: 500 });
    }
  },
};
