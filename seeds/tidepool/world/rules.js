import { usesEnergy, isResting, liveOneTick } from "./energy.js";
import { moveFood, eatNearby } from "./food.js";
import { POOL_WIDTH, POOL_HEIGHT, FLOOR_Y, keepInside } from "./bounds.js";
import { MAX_CREATURES, countFor, makeCreature } from "./spawning.js";
import { drawScene, drawFood, drawArrival } from "./scene.js";

// A kind whose code fails this many times is benched: the world stops running it.
export const MAX_ERRORS = 3;

// A resting creature sinks this fast, in pool units per tick.
export const REST_SINK = 1;

// A new, empty world. Everything in it is plain data.
export function createWorld() {
  return { tick: 0, nextId: 1, creatures: [], food: [], errors: {}, benched: {} };
}

// Count one failure against a kind. The third failure benches the kind.
export function countError(world, kind) {
  world.errors[kind] = (world.errors[kind] || 0) + 1;
  if (world.errors[kind] >= MAX_ERRORS) world.benched[kind] = true;
}

// Run one creature function. A failure is counted and never stops the pool.
export function guard(world, kind, run) {
  try {
    return run();
  } catch (error) {
    countError(world, kind);
    return undefined;
  }
}

// Make the creatures of every kind that has none yet.
export function populate(world, kinds) {
  for (const kind of Object.keys(kinds).sort()) {
    if (world.benched[kind]) continue;
    if (world.creatures.some((creature) => creature.kind === kind)) continue;
    for (let i = 0; i < countFor(kinds[kind]); i += 1) {
      if (world.creatures.length >= MAX_CREATURES) return;
      const creature = guard(world, kind, () => makeCreature(world, kind, kinds[kind]));
      if (creature) world.creatures.push(creature);
    }
  }
}

// Put right what a creature must never break: a place in the water and a sane energy level.
export function settle(world, creature) {
  const numbers = [creature.x, creature.y, creature.vx, creature.vy];
  if (!numbers.every(Number.isFinite)) {
    creature.x = POOL_WIDTH / 2;
    creature.y = POOL_HEIGHT / 2;
    creature.vx = 0;
    creature.vy = 0;
    countError(world, creature.kind);
  }
  keepInside(creature);
  if (usesEnergy(creature) && Number.isNaN(creature.energy)) {
    creature.energy = 0;
    countError(world, creature.kind);
  }
}

// One tick of the whole pool. `kinds` maps each kind name to its creature file.
export function tickWorld(world, kinds) {
  moveFood(world);
  for (const creature of world.creatures) {
    const module = kinds[creature.kind];
    if (!module || world.benched[creature.kind]) continue;
    creature.age += 1;
    if (usesEnergy(creature)) {
      liveOneTick(creature);
      if (isResting(creature)) {
        creature.y = Math.min(FLOOR_Y, creature.y + REST_SINK);
        continue;
      }
    }
    guard(world, creature.kind, () => module.update(creature, world));
    if (usesEnergy(creature)) eatNearby(creature, world);
    settle(world, creature);
  }
  world.tick += 1;
}

// Draw one frame. Returns what each creature drew: { id, kind, shapes, rejected, box }.
export function drawWorld(world, kinds, control) {
  control.clear();
  control.begin(0, 0, "scene");
  drawScene(world, control.pen);
  drawFood(world, control.pen);
  for (const creature of world.creatures) drawArrival(creature, control.pen);
  control.end();
  const report = [];
  for (const creature of world.creatures) {
    const mod = kinds[creature.kind];
    if (!mod || world.benched[creature.kind]) continue;
    control.begin(creature.x, creature.y, isResting(creature) ? "resting" : "creature");
    guard(world, creature.kind, () => mod.draw(creature, control.pen, world));
    const used = control.end();
    report.push({ id: creature.id, kind: creature.kind, ...used });
  }
  return report;
}
