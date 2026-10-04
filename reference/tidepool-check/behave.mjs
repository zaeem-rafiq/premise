import { loadPool } from "./harness.mjs";
const dir = process.argv[2]; const ticks = Number(process.argv[3] || 3600);
const { kinds, main, reseed } = await loadPool(dir);
reseed(7);
const pool = main.createPool(kinds);
const acc = {};
const start = new Map(pool.world.creatures.map((c) => [c.id, { x: c.x, y: c.y }]));
const travel = {};
let prev = new Map(pool.world.creatures.map((c) => [c.id, { x: c.x, y: c.y }]));
for (let n = 0; n < ticks; n++) {
  main.tick(pool);
  for (const c of pool.world.creatures) {
    const a = (acc[c.kind] ??= { ticks: 0, resting: 0, hiding: 0, moved: 0 });
    a.ticks++; if (c.resting > 0) a.resting++; if (c.hiding) a.hiding++;
    const p = prev.get(c.id); const d = Math.hypot(c.x - p.x, c.y - p.y); if (d < 400) a.moved += d; prev.set(c.id, { x: c.x, y: c.y });
  }
}
for (const [k, a] of Object.entries(acc)) console.log(k.padEnd(10), "rest", (a.resting / a.ticks).toFixed(3), "hiding", (a.hiding / a.ticks).toFixed(3), "px/tick", (a.moved / a.ticks).toFixed(2));
console.log(JSON.stringify(main.stats(pool)));
