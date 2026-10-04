# Premise tide pool specification (02-tidepool)

Status: binding for implementation. Read `01-core.md` first. Reconciled on 2026-10-04 with `01-core.md` revision 2, `03-floor.md`, `04-build-plan.md` and the platform measurements; the last section, "Changes in reconciliation (2026-10-04)", lists what changed. Sources: the architecture brief (section 5), the design brief, the concept panel's must-fix lists, `01-core.md`, `premise-cases.json` and the lead's reconciliation decisions. Where this file and `01-core.md` disagree, `01-core.md` wins.

Scope: the demo codebase (the tide pool), the drawing pen, the app server that serves a pool by ref, the self-test that the green line runs, the pool's policy file, the two scripted catches, the seeded intents, and the scripted agents of the Swarm. The Floor layout is specified in `03-floor.md`. The agent's system prompt, the tool definitions as a model receives them and the seeded-intent measurement protocol are specified in `05-agent.md` (01-core 4.11). Both consume what is defined here.

Conventions used in this file:

- "MUST", "MUST NOT" and "MAY" are requirements. Rules have ids (`TP`, `PN`, `AS`, `HO`, `ST`, `SW`) so tests can cite them. No id was renumbered in the reconciliation; a withdrawn rule keeps its id and says so.
- Words from the glossary of `01-core.md` keep their meaning. Rule ids such as `E2`, `QR1`, `B1`, `CK6`, `SE14` and section numbers such as `11.7` point to `01-core.md`.
- Two ids exist in two files. `ST1` to `ST6` here are the self-test rules of section 5; `01-core.md` has its own rule `ST1` (9.2). `TP1` to `TP24` here are the tide pool rules. Another file that cites one of them names this file with it (for example "02 ST4").
- `X1` to `X9` are the experiments E1 to E9 of the platform record (`docs/measurements/spikes/2026-10-04-platform.md`), named as in `01-core.md`. They are not the decision-table rows `E0` to `E4`.
- "Head" is Trunk's last accepted landing, as in `01-core.md`. The "landed commit" is the last landing confirmed on `main`. A pool page only ever shows a landed commit (4.1).
- Constants are written `LIKE_THIS`. Pool constants live in the pool's own files (section 2). Platform constants are in Appendix B.
- Lengths and positions are in **pool units**. The pool is 800 by 500 pool units; the page scales the picture to fit.
- This file makes no priority claim. Related work is named in `01-core.md`.

Evidence. Two kinds of check were run on 2026-10-03 and run again for this revision on 2026-10-04. (a) The seed tree (`seeds/tidepool/`) and the trees named in Appendix A were run in Node 22 with the self-test of section 5. (b) The operations in sections 7, 8, 9.4 and 9.5, and the examples of 10.3, were replayed through the reference simulator of `01-core.md` revision 2 (`reference/spec-sim/`, the one that agrees with cases `C01` to `C57` of `premise-cases.json`), on the files of `seeds/tidepool/`. Every rule id, state and number that these sections call "observed" was seen in those runs. The simulator lacks three things, so what this file says about them follows from the rules of `01-core.md` and was not observed: Race (it has no candidate flag; one ordinary attempt stood in for the candidates), scripted triage (TR8; the simulator leaves a triage pending until an answer is supplied), and the plain-merge replay (11.7; the plain-merge trees were built by hand from the operations and then run through the self-test). The simulator is a reference tool, not product code; the product's tests repeat these checks (Appendix A).

---

## 1. Purpose and constraints

### 1.1 Purpose

The tide pool is the product codebase that agents change in every demonstration. It is a small simulated rock pool drawn on one canvas. It exists so that a person who cannot read code can see three things:

1. many independent changes landing without waiting for each other;
2. a change that a text merge, a file-level check, an import index and the test suite all accept, and that is still wrong;
3. one record that explains any creature on screen.

### 1.2 Constraints

| Id | Constraint | How it is tested |
| --- | --- | --- |
| TP1 | **Real shared code.** Creatures live by shared rules in `world/`. In the seed, each of `energy`, `food`, `movement`, `time` and `bounds` has at least one referrer under `creatures/`, and every creature file references at least two entities under `world/`. | Reference table of the seed (01-core 6.2). |
| TP2 | **Buildless.** The pool holds only ES modules (`.js`), one `.html`, one `.json` and one `.md`. No package file, no bundler, no transpiler. The app server sends each file byte for byte. | File listing; AS5. |
| TP3 | **Pure modules.** No module in the pool uses a global name outside the policy allow list (section 6). The same modules run in a browser, in a Worker isolate and in Node. | CK6 applied to every seed module. |
| TP4 | **State is data.** All simulation state is in one `world` object made of plain JSON-safe data. No module keeps a changing value at its top level. | Self-test checks `state_is_data` and `deterministic`. |
| TP5 | **Small files.** A creature file has at most 60 lines. A shared module has at most 120 lines and at most 12 exported names. `pen.js` has at most 200 lines. No line of a `.js` file is longer than 125 characters. | Line counts of the seed. |
| TP6 | **Easy to edit with `replace`.** Every exported number is one line of the form `export const NAME = value;`. A comment directly above it, or above the group it belongs to, says what it means and its unit. One statement per line. No constant declaration line appears twice in a file. | Text check of the seed. |
| TP7 | **Adding a creature edits no shared file.** A new file `creatures/<kind>.js` is the complete change. The list of kinds comes from the directory listing through the app server (4.4). | Seeded intents A01 to A12 write exactly one path. |
| TP8 | **Weak models must succeed.** A working creature needs three small functions. The world supplies a place, a speed, the bounds safety net and the energy bookkeeping. The guide (2.7) fits in one read. | The seeded-intent measurement (`05-agent.md`; 01-core S5) on the intents of section 9. |
| TP9 | **Visible from the back of a room.** Every creature draws at least `MIN_DRAWN` pool units wide or tall, with a dark outline by default. A resting creature is grey and upside down. A new or changed creature gets a white ring for `ARRIVAL_TICKS`. | Self-test check `visible`; 2.4. |
| TP10 | **One bad creature never stops the pool.** Every creature function runs inside a guard. A kind that fails `MAX_ERRORS` times is benched. | Self-test check `no_errors`; unit test with a throwing creature. |
| TP11 | **Deterministic.** The same seed gives the same world after the same number of ticks. | Self-test check `deterministic`. |
| TP12 | **No text on the canvas.** The pool app draws shapes only. Words about a pool are shown by the Floor, outside the frame. | Section 3. |

### 1.3 Terms added by this file

| Term | Meaning |
| --- | --- |
| Kind | One sort of creature. One file `creatures/<kind>.js`. The kind name is the file name without `.js`. |
| Shared rule | An entity in a file under `world/`. |
| Pen | The object a creature file draws with (3.1). |
| Surface | The platform's object that the pen is built on. It hides the canvas (3.3). |
| Host | The platform's page runtime that runs a pool in a browser frame (4.5). It is not in the pool repo. |
| Pool app | The host plus the pool's modules at one version, running in one frame. |
| Source | What a viewer asked to follow: `main`, `green` or `plain` (moving), or one commit of the pool repo or of the plain-merge repo (4.1). There is no source for an attempt. |
| Version | An opaque token for one unchanging tree of files (4.1). |
| Live frame, commit frame | A pool frame on a moving source (`main`, `plain`), or one that shows a single commit (Replay, card previews) (01-core SE16a; 4.6). |
| Registry | The generated list of kinds at one version (4.4). |
| Resting | The state of a creature whose energy reached 0 (2.4). |
| Self-test | The pool's own headless check (section 5). Its result is the **verdict**. |
| Canned | Written in this file, not by a model. Canned operations are used by the Swarm, by the canned casts and by tests. |
| Canned cast | Scripted agents that play one scenario of this file, one named pattern per attempt (10.5). |
| Truth list | The premises a canned change truly depends on, as `<kind>:<key>` strings (10.3; 01-core TR8). |
| Plain-merge pool | The pool built by rule 11.7. Its on-screen label is "same changes, merged by plain git". |

---

## 2. Files and interfaces

### 2.1 File tree (the seed)

```
.premise/policy.json            which paths land by themselves and which wait for the owner (section 6)
GUIDE.md                        the guide every agent reads first (2.7)
index.html                      one canvas and one script tag (4.3)
main.js                         the pool's entry: start, tick, draw, tap, stats (2.5)
pen.js                          the pen (section 3)
world/time.js                   ticks, the day, night
world/bounds.js                 the size of the pool, the water line, the sand, the walls
world/movement.js               speed, stepping, steering
world/energy.js                 the energy scale, living cost, hunger, rest
world/food.js                   pellets: dropping, sinking, eating
world/spawning.js               how many of each kind, where they start
world/rules.js                  the world rules: the order of one tick and one frame, the guard
world/scene.js                  sky, water, sand, pellets, the arrival ring
creatures/anemone.js            sits on the sand, sways, closes at night (no energy)
creatures/fish.js               cruises, seeks food when hungry, leaves one side and returns on the other
creatures/minnow.js             a school of six that follows its first member
creatures/snail.js              crawls along the sand, turns at the walls (no energy)
creatures/turtle.js             two slow swimmers that come up for air
selftest/run.js                 the self-test (section 5)
selftest/invariants.js          the checks the self-test applies
selftest/recording-surface.js   a surface that draws nothing and counts calls
```

21 files. The seed commit of a pool repo contains exactly these. This tree is the seed `tidepool`. The seeds `tidepool-auto` and `tidepool-swarm` are generated from it (section 6, 10.1).

### 2.2 The world and a creature

```ts
type World = {
  tick: number;                         // ticks since the pool started
  nextId: number;
  creatures: Creature[];
  food: Array<{ x: number; y: number; age: number }>;
  errors: Record<string, number>;       // failures per kind
  benched: Record<string, boolean>;     // kinds the world has stopped running
};

type Creature = {
  kind: string;                         // set by the world
  id: number;                           // set by the world, unique in the pool
  x: number; y: number;                 // place, in pool units; y grows downward
  vx: number; vy: number;               // speed, in pool units per tick
  age: number;                          // ticks since it was made; set by the world
  resting: number;                      // ticks of rest left; 0 means awake; set by the world
  energy?: number;                      // present only when the kind's spawn() set it
  [own: string]: unknown;               // the creature file's own plain data
};
```

- **TP13.** Everything reachable from `world` is a number, string, boolean, `null`, array or plain object. `JSON.parse(JSON.stringify(world))` gives an equal world.
- **TP14.** Shared rules and creature files change the world only through the `creature` and `world` arguments they are given.

### 2.3 Shared modules: full public interface

Every export is listed. A function not marked "called by the world" is for creature files.

**`world/time.js`**

| Export | Value or signature | Meaning |
| --- | --- | --- |
| `TICKS_PER_SECOND` | `60` | Ticks in one second of pool time. |
| `DAY_TICKS` | `3600` | Ticks in one day and one night together. |
| `dayPhase(world)` | returns a number from 0 to just under 1 | `(world.tick % DAY_TICKS) / DAY_TICKS`. 0 is sunrise, 0.5 is sunset. |
| `isNight(world)` | returns a boolean | `dayPhase(world) >= 0.5`. |
| `seconds(s)` | returns whole ticks | `Math.round(s * TICKS_PER_SECOND)`. |

**`world/bounds.js`**

| Export | Value or signature | Meaning |
| --- | --- | --- |
| `POOL_WIDTH` | `800` | Width of the pool. x grows to the right. |
| `POOL_HEIGHT` | `500` | Height of the pool. y grows downward. |
| `SURFACE_Y` | `40` | The water line. Above it is sky. |
| `FLOOR_Y` | `460` | The top of the sand. |
| `isInside(x, y)` | returns a boolean | True when `0 <= x <= POOL_WIDTH` and `SURFACE_Y <= y <= FLOOR_Y`. |
| `keepInside(creature)` | changes `x`, `y` | Clamps the place into the water. |
| `bounce(creature)` | changes `vx`, `vy`, `x`, `y` | Reverses `vx` when x is past a side wall and `vy` when y is past the surface or the sand, then `keepInside`. |
| `wrap(creature)` | changes `x`, `y` | A creature past one side wall re-enters at the other (`x` plus or minus `POOL_WIDTH`). y is clamped. |

**`world/movement.js`**

| Export | Value or signature | Meaning |
| --- | --- | --- |
| `MAX_SPEED` | `3` | Top speed, in pool units per tick. |
| `step(creature)` | changes `x`, `y`, `vx`, `vy` | Scales (`vx`, `vy`) down to `MAX_SPEED` if faster, then adds it to the place. |
| `steer(creature, x, y, push)` | changes `vx`, `vy` | Adds `push` (speed per tick) toward the point. Does nothing when closer than 0.001. |
| `wander(creature, push)` | changes `vx`, `vy` | Adds `push` in a random direction. Uses `Math.random()` once. |
| `glide(creature, keep)` | changes `vx`, `vy` | Multiplies the speed by `keep` (for example 0.95). |
| `distance(a, b)` | returns pool units | Distance between two things that have `x` and `y`. |

**`world/energy.js`** is given in full, because the hero conflict (section 7) edits its first two lines and its text is part of the test vectors. The seed file MUST be exactly this:

```js
// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).
export const ENERGY_MAX = 100;

// What one tick of ordinary living costs.
export const LIVING_COST = ENERGY_MAX / 3600;

// A creature below this level is hungry.
export const HUNGRY_BELOW = ENERGY_MAX / 2;

// An empty creature rests for this many ticks, then wakes up full.
export const REST_TICKS = 300;

// True when the creature takes part in the energy rules.
// A creature takes part when its spawn function sets `energy`.
export function usesEnergy(creature) {
  return typeof creature.energy === "number";
}

// Take energy away. `amount` is in the same unit as ENERGY_MAX.
export function drain(creature, amount) {
  creature.energy = Math.max(0, creature.energy - amount);
}

// Give energy. `amount` is in the same unit as ENERGY_MAX.
export function feed(creature, amount) {
  creature.energy = Math.min(ENERGY_MAX, creature.energy + amount);
}

// True when the creature is below HUNGRY_BELOW.
export function isHungry(creature) {
  return creature.energy < HUNGRY_BELOW;
}

// True while an empty creature is resting. The world does not update a resting creature.
export function isResting(creature) {
  return creature.resting > 0;
}

// Called by the world once per tick for every creature that uses energy.
export function liveOneTick(creature) {
  if (creature.resting > 0) {
    creature.resting -= 1;
    if (creature.resting === 0) creature.energy = ENERGY_MAX;
    return;
  }
  drain(creature, LIVING_COST);
  if (creature.energy <= 0) creature.resting = REST_TICKS;
}
```

- **TP15 (one scale, one place).** `ENERGY_MAX` is the only literal energy amount in the seed. Every other energy amount in a shared rule is written as an expression of `ENERGY_MAX` (`LIVING_COST`, `HUNGRY_BELOW`, `FOOD_ENERGY`, the wake-up level). No seed creature contains an energy number. Consequence: changing `ENERGY_MAX` from `100` to `1` leaves the whole seed correct with a one-line edit. Code that depends on the old scale can only come from a later change: one that is in flight when the meaning changes (7.5, 7.6), or one that landed with an absolute number before it (order 2b in 7.6; TP24).
- **TP16 (opt-in).** A creature takes part in the energy rules only when its `spawn()` sets `energy`. The seed and the guide always write this as `energy: ENERGY_MAX`. A creature file that never mentions energy has no reference to `world/energy.js` and is not disturbed when the scale changes.

**`world/food.js`**

| Export | Value or signature | Meaning |
| --- | --- | --- |
| `FOOD_ENERGY` | `ENERGY_MAX / 4` | What one pellet is worth, in the unit of `ENERGY_MAX`. |
| `FOOD_EVERY` | `30` | A new pellet drops every this many ticks. |
| `FOOD_SINK` | `0.6` | Sinking speed of a pellet, in pool units per tick. |
| `FOOD_LIFE` | `1500` | A pellet nobody eats dissolves after this many ticks. |
| `EAT_RADIUS` | `16` | A creature eats a pellet this close. |
| `moveFood(world)` | called by the world once per tick | When `world.tick % FOOD_EVERY === 0`, adds a pellet at a random x on the water line. Every pellet sinks by `FOOD_SINK` down to `FLOOR_Y` and ages by 1. Pellets of age `FOOD_LIFE` are removed. |
| `nearestFood(creature, world)` | returns a pellet or `null` | The pellet closest to the creature. |
| `eatNearby(creature, world)` | called by the world once per tick for each creature that uses energy; returns a boolean | Removes the first pellet within `EAT_RADIUS` and calls `feed(creature, FOOD_ENERGY)`. |

**`world/spawning.js`**

| Export | Value or signature | Meaning |
| --- | --- | --- |
| `SPAWN_PER_KIND` | `3` | How many creatures of a kind the world makes when the file does not say. |
| `MAX_PER_KIND` | `8` | The most creatures of one kind. |
| `MAX_CREATURES` | `150` | The most creatures in the pool. Kinds later in name order get none once the pool is full. |
| `countFor(module)` | returns 1 to `MAX_PER_KIND` | The file's exported `count` when it is an integer, else `SPAWN_PER_KIND`, clamped. |
| `makeCreature(world, kind, module)` | called by the world; returns a `Creature` | Calls `module.spawn(world)`. Starts from a random place in the water with no speed, lays the returned values over that, then always sets `kind`, `id` (from `world.nextId`), `resting = 0`, `age = 0`. |

**`world/rules.js`** (the world rules)

| Export | Value or signature | Meaning |
| --- | --- | --- |
| `MAX_ERRORS` | `3` | A kind whose code fails this many times is benched. |
| `REST_SINK` | `1` | A resting creature sinks this fast, in pool units per tick. |
| `createWorld()` | returns a `World` | Tick 0, no creatures, no food. |
| `countError(world, kind)` | | Adds one failure to the kind; benches it at `MAX_ERRORS`. |
| `guard(world, kind, run)` | returns what `run()` returns, or `undefined` | Calls `run()`. A thrown error is caught and counted with `countError`. |
| `populate(world, kinds)` | | For every kind, in name order, that is not benched and has no creature yet: makes `countFor` creatures, stopping at `MAX_CREATURES`. |
| `settle(world, creature)` | | If `x`, `y`, `vx` or `vy` is not a finite number: moves the creature to the middle with no speed and counts an error. Then `keepInside`. If the creature uses energy and its energy is `NaN`: sets it to 0 and counts an error. |
| `tickWorld(world, kinds)` | | One tick (order below). |
| `drawWorld(world, kinds, control)` | returns `Array<{ id, kind, shapes, rejected, box }>` | One frame (order below). |

Order of one tick (`tickWorld`). Tests cite the step numbers.

1. `moveFood(world)`.
2. For each creature, in array order:
   1. skip it when its kind has no file in `kinds` or is benched;
   2. `age += 1`;
   3. when it uses energy: `liveOneTick(creature)`; when it is now resting: `y = min(FLOOR_Y, y + REST_SINK)` and go to the next creature (no update, no eating);
   4. `guard(world, kind, () => module.update(creature, world))`;
   5. when it uses energy: `eatNearby(creature, world)`;
   6. `settle(world, creature)`.
3. `world.tick += 1`.

Order of one frame (`drawWorld`).

1. `control.clear()`.
2. `control.begin(0, 0, "scene")`; `drawScene`; `drawFood`; `drawArrival` for every creature; `control.end()`.
3. For each creature whose kind is present and not benched: `control.begin(x, y, isResting(creature) ? "resting" : "creature")`; `guard(world, kind, () => module.draw(creature, control.pen, world))`; `control.end()`. The value returned by `end()` goes into the report with the creature's `id` and `kind`.

**`world/scene.js`**

| Export | Value or signature | Meaning |
| --- | --- | --- |
| `ARRIVAL_TICKS` | `90` | A creature younger than this gets a ring around it. |
| `drawScene(world, pen)` | called by the world | Three rectangles: sky (above `SURFACE_Y`), water, sand (below `FLOOR_Y`). Sky and water are darker when `isNight(world)`. |
| `drawFood(world, pen)` | called by the world | One small circle per pellet. |
| `drawArrival(creature, pen)` | called by the world | A white ring that grows and fades while `creature.age < ARRIVAL_TICKS`. |

### 2.4 What the shared rules do to a creature without its file asking

| Rule | Effect | Where |
| --- | --- | --- |
| Place | A creature starts at a random place in the water unless `spawn()` gives `x` or `y`. | `makeCreature` |
| Safety net | After every update the creature is put back in the water, and broken numbers are repaired and counted. | `settle` |
| Living cost | A creature that uses energy loses `LIVING_COST` each tick. A full creature is empty after 3600 ticks without food. | `liveOneTick` |
| Eating | A creature that uses energy eats a pellet within `EAT_RADIUS` and gains `FOOD_ENERGY`. | `eatNearby` |
| Rest | A creature whose energy reaches 0 rests for `REST_TICKS`. While resting it is not updated, sinks to the sand, and is drawn grey and upside down. It wakes up full. | `liveOneTick`, tick step 2.3, pen mode `resting` |
| Arrival | A creature younger than `ARRIVAL_TICKS` has a white ring. | `drawArrival` |
| Bench | A kind that fails `MAX_ERRORS` times is no longer updated or drawn. | `guard`, `countError` |

Rest is the pool's loud signal. A creature that spends energy far too fast is grey, upside down and on the sand most of the time. Section 7 relies on this.

### 2.5 `main.js`: the pool's entry

| Export | Value or signature | Meaning |
| --- | --- | --- |
| `TAP_RADIUS` | `30` | A tap within this distance of a creature picks it. |
| `poolSize()` | returns `{ width, height }` | `POOL_WIDTH` and `POOL_HEIGHT`. |
| `createPool(kinds)` | returns `{ world, kinds }` | A new world, populated. |
| `adoptPool(pool, kinds, changed)` | returns `{ world, kinds }` | Carries a running pool over to new creature files (4.7). Removes creatures whose kind is gone or is listed in `changed`, clears `errors` and `benched`, then `populate`. |
| `tick(pool)` | | `tickWorld`. |
| `draw(pool, control)` | returns the frame report | `drawWorld`. |
| `creatureAt(pool, x, y)` | returns `{ kind, id }` or `null` | The creature nearest to the point within `TAP_RADIUS`. |
| `stats(pool)` | returns `{ tick, food, kinds: { [kind]: { count, resting, errors, benched } } }` | Numbers for the people watching. |

`kinds` is a plain object that maps each kind name to its creature module. The host builds it from the registry (4.4); the self-test receives it from its harness (5.4).

### 2.6 A creature module

A creature file is `creatures/<kind>.js`. The kind name MUST match `^[a-z][a-z0-9-]{0,30}$` and MUST NOT be `constructor`. Other files in `creatures/` are ignored by the registry.

| Export | Required | Signature | Contract |
| --- | --- | --- | --- |
| `spawn` | yes | `spawn(world)` returns a plain object | The creature's starting values. MAY set `x`, `y`, `vx`, `vy`, `energy` and any names of its own. Plain data only (TP13). Setting `energy` opts the creature in to the energy rules (TP16). |
| `update` | yes | `update(creature, world)` | Called once per tick while the creature is awake. Changes `creature`. Moves by calling `step` and then one of `bounce`, `wrap`, `keepInside`, or by changing `x` and `y` itself. |
| `draw` | yes | `draw(creature, pen, world)` | Draws the creature around the point (0, 0) with the pen (3.1). MUST NOT change `creature` or `world`. |
| `count` | no | `export const count = <integer>;` | How many to make, 1 to `MAX_PER_KIND`. |

- **TP17.** A creature file imports shared rules with relative specifiers that start with `../world/`. It imports nothing else.
- **TP18.** A creature file keeps its colours in top-level constants (for example `const BODY = "orange";`). This makes a repaint a one-line `replace` per colour (section 8).

The seed's `creatures/fish.js` is the example every agent is pointed to. It MUST be exactly this:

```js
import { ENERGY_MAX, isHungry } from "../world/energy.js";
import { nearestFood } from "../world/food.js";
import { step, steer, glide } from "../world/movement.js";
import { wrap } from "../world/bounds.js";

const BODY = "orange";
const FIN = "yellow";

export function spawn() {
  return { vx: 1.5, energy: ENERGY_MAX };
}

export function update(fish, world) {
  const food = isHungry(fish) ? nearestFood(fish, world) : null;
  if (food) steer(fish, food.x, food.y, 0.2);
  else steer(fish, fish.x + (fish.vx < 0 ? -100 : 100), fish.y, 0.05);
  glide(fish, 0.98);
  step(fish);
  wrap(fish);
}

export function draw(fish, pen) {
  if (fish.vx < 0) pen.flip();
  pen.fill(FIN);
  pen.poly([-14, 0, -28, -11, -28, 11]);
  pen.fill(BODY);
  pen.ellipse(0, 0, 20, 11);
  pen.fill("black");
  pen.circle(10, -3, 2);
}
```

What the other seed creatures use (each is at most 36 lines):

| File | Colour constants | Shared entities it references | Energy | `count` |
| --- | --- | --- | --- | --- |
| `anemone.js` | `ARMS`, `BASE` | `bounds#FLOOR_Y`, `time#isNight` | no | default |
| `fish.js` | `BODY`, `FIN` | `energy#ENERGY_MAX`, `energy#isHungry`, `food#nearestFood`, `movement#step`, `#steer`, `#glide`, `bounds#wrap` | yes | default |
| `minnow.js` | `BODY` | `energy#ENERGY_MAX`, `movement#step`, `#steer`, `#wander`, `#glide`, `bounds#bounce` | yes | 6 |
| `snail.js` | `SHELL`, `BODY` | `bounds#FLOOR_Y`, `#bounce`, `movement#step` | no | default |
| `turtle.js` | `SHELL`, `SKIN` | `energy#ENERGY_MAX`, `#isHungry`, `food#nearestFood`, `bounds#SURFACE_Y`, `#POOL_HEIGHT`, `#bounce`, `time#seconds`, `movement#step`, `#steer`, `#glide` | yes | 2 |

### 2.7 `GUIDE.md`

Every agent reads this file first: the first message its model receives says so (`05-agent.md`; 01-core 4.11). It MUST be exactly this text:

````md
# Tide pool guide

The tide pool is a small world drawn on one canvas. Every file is a plain JavaScript module. There is no build step.

## Where things are

- `creatures/<kind>.js`: one file per kind of creature. Adding a file adds the creature. No other file needs to change.
- `world/*.js`: the shared rules every creature lives by: time, bounds, movement, energy, food, spawning, rules, scene.
- `main.js`, `pen.js`: how the pool starts and how drawing works.
- `selftest/`: the checks that must pass after every change.

## A creature file

A creature file exports three functions. It may also export `count`.

    export function spawn(world)                 // return the creature's starting values as a plain object
    export function update(creature, world)      // called once per tick; change `creature`
    export function draw(creature, pen, world)   // draw around (0, 0); change nothing
    export const count = 3;                      // optional: how many to make, 1 to 8

The world gives every creature `x`, `y`, `vx`, `vy`, `kind`, `id`, `age` (ticks alive) and `resting`.
`spawn()` may set `x`, `y`, `vx`, `vy` and values of its own. Values must be plain data.
Look at `creatures/fish.js` for a complete example.

## Rules

1. Import shared rules with relative paths, for example `import { step } from "../world/movement.js";`.
   Read each shared rule you use by name before you use it.
2. To move: change `vx` and `vy`, call `step()`, then call `bounce()`, `wrap()` or `keepInside()`.
3. Energy is optional. A creature takes part when `spawn()` sets `energy: ENERGY_MAX`. Never write that number yourself.
   The world then takes the living cost every tick, feeds the creature when it touches food, and makes it rest when it is empty.
   Any energy number in your file is in the unit of `ENERGY_MAX`. Read `ENERGY_MAX` before you write one.
   If `ENERGY_MAX` changes, every energy number in your file must change with it.
4. Use `Math.random()` for chance. Do not use `Date`, timers, `document`, `window`, `fetch` or `console`.
5. Keep all state on the creature or in the world. Do not keep changing values at the top of a file.
6. Draw only with the pen: `fill`, `stroke`, `alpha`, `circle`, `ellipse`, `rect`, `line`, `poly`, `arc`, `turn`, `flip`.
   Stay within 60 units of (0, 0). Use at most 40 shapes. Make the creature at least 16 units wide or tall.
7. Put the creature's colours in constants at the top of the file.
8. A shared rule is shared by every creature. After you change one, look at everything listed in `relied_on_by`
   and fix whatever relied on the old meaning in the same change.
````

---

## 3. The drawing pen

### 3.1 The pen: the complete API a creature file can draw with

`draw(creature, pen, world)` receives the pen. The origin (0, 0) is the creature's place. All methods return `undefined`. There is no other way to draw.

| Method | Arguments | Effect |
| --- | --- | --- |
| `pen.fill(colour)` | a colour, or `null` for no fill | Sets the fill for the shapes that follow. |
| `pen.stroke(colour, width = 2)` | a colour, or `null` for no outline; width is clamped to 0.5 to 8 | Sets the outline for the shapes that follow. |
| `pen.alpha(a)` | clamped to 0 to 1 | Sets how solid the shapes that follow are. |
| `pen.circle(x, y, r)` | | Filled and outlined circle. |
| `pen.ellipse(x, y, rx, ry, angle = 0)` | angle in radians | Filled and outlined ellipse. |
| `pen.rect(x, y, w, h, corner = 0)` | (x, y) is the top-left corner | Filled and outlined rectangle with rounded corners. |
| `pen.line(x1, y1, x2, y2)` | | Outlined line. |
| `pen.poly(points)` | a flat array `[x1, y1, x2, y2, ...]` of 3 to 12 points | Closed, filled and outlined polygon. |
| `pen.arc(x, y, r, from, to)` | angles in radians | Outlined open arc. |
| `pen.turn(angle)` | radians | Rotates the shapes that follow around (0, 0). Adds up within one `draw` call. |
| `pen.flip()` | | Mirrors the shapes that follow left to right. |

A **colour** is one of the names in `PALETTE`, or `#rgb`, or `#rrggbb`. Nothing else is a colour.

```
PALETTE: white #ffffff, black #10222e, grey #8a97a0, silver #c9d3da, red #e5484d, orange #ff8a1f,
         yellow #ffd23f, gold #d4a017, green #3fb950, teal #12a594, blue #3b82f6, purple #8e4ec6,
         pink #ff6fae, brown #8b5a2b, sand #e8d9a8
```

State at the start of every `draw` call: fill `white`, stroke `black` width 2, alpha 1, no turn, no flip.

What the pen does not have, by design: text, fonts, images, patterns, gradients, pixel reads, measuring, free transforms, saving and restoring state, clearing, any reference to the canvas, the context, the page or the network, and any return value.

Limits, enforced by the pen for each creature in each frame:

- **PN1.** At most `MAX_SHAPES` (40) shape calls (`circle`, `ellipse`, `rect`, `line`, `poly`, `arc`). Further shape calls draw nothing and are counted as rejected.
- **PN2.** A shape call with an argument that is not a finite number, a `poly` whose array has fewer than 6, more than 24, or an odd number of entries, and a `fill` or `stroke` whose colour is not a colour, draw nothing, change nothing, and are counted as rejected.
- **PN3.** Nothing a creature draws appears farther than `MAX_REACH` (60) pool units from its place: the surface clips to that disc.
- **PN4.** In mode `resting` every colour is replaced by the grey of the same brightness (`toGrey`) and the creature is drawn turned by half a circle.
- **PN5.** The pen object is frozen. Its methods are closures; none uses `this`.

### 3.2 The pen control (used only by `world/rules.js`)

`createPen(surface)` returns a frozen object:

| Member | Meaning |
| --- | --- |
| `pen` | The object of 3.1. The same object is passed to every `draw`. |
| `clear()` | Wipes the whole picture. |
| `begin(x, y, mode)` | Starts drawing one thing centred on (x, y). `mode` is `"scene"`, `"creature"` or `"resting"`. Resets the pen state and the counters. Mode `scene` has no shape limit and no clip; it is used only by `world/scene.js` through `drawWorld`. |
| `end()` | Finishes. Returns `{ shapes, rejected, box }`. `box` is `[left, top, right, bottom]` of what was drawn, relative to (x, y), or `null`. |

Outside `begin` and `end` every pen call is rejected.

Other exports of `pen.js`: `MAX_SHAPES`, `MAX_REACH`, `PALETTE`, `toHex(colour)` (returns `#rrggbb` or `null`) and `toGrey(hex)`.

### 3.3 The surface (provided by the host, never by the pool)

The surface is the only thing `pen.js` receives. It is a frozen object of closures over the canvas context. No member returns or exposes the context or the canvas.

| Member | Meaning |
| --- | --- |
| `reset()` | Clear the canvas and reset every setting. |
| `push(x, y, clipRadius)` | Save; move the origin to (x, y); when `clipRadius > 0`, clip to a disc of that radius. |
| `pop()` | Restore. |
| `turn(angle)`, `flip()` | Rotate; mirror left to right. |
| `style(fill, stroke, width, alpha)` | `fill` and `stroke` are `#rrggbb` or `null`. |
| `circle`, `ellipse`, `rect`, `line`, `poly`, `arc` | The six shapes, with the argument lists of 3.1. |

Host rules for its surface:

- **PN6.** The surface has exactly these 12 members. It has no text, image or pixel operation.
- **PN7.** The surface checks its own inputs and ignores a call that fails: colours MUST match `^#[0-9a-f]{6}$`; numbers MUST be finite; `clipRadius` MUST be 0 or at most `HOST_MAX_REACH`; at most `HOST_MAX_OPS` shape calls between one `push` and its `pop`; `push` depth at most 2. These caps hold even if `pen.js` is changed.
- **PN8.** The self-test uses `selftest/recording-surface.js`, which has the same 12 members, draws nothing and counts calls.

### 3.4 How the restriction is enforced

Four layers. Only the first is a security boundary; the others limit what can appear on the canvas.

| Layer | What it stops | Rule |
| --- | --- | --- |
| 1. Browser sandbox | The pool app reaching the Floor's page, cookies or storage; any network request from pool code; `eval` and `new Function`. | SE13, SE14: the `sandbox allow-scripts` directive in every app-server response (AS15), the Floor's `<iframe sandbox="allow-scripts">`, `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'`, no `'unsafe-eval'`. |
| 2. Capability | Pool code reaching the canvas or the page. Pool modules are given only `world`, `creature`, the pen, and (for `pen.js`) the surface. The host never passes the canvas, the context, an event or a DOM object into pool code. | PN5, PN6, HO3. |
| 3. Static check at submit | A change that names `document`, `window`, `globalThis`, `self`, `fetch`, `eval`, `Function`, timers, `Date`, `console` or any other global outside the allow list. | CK6 with the policy `globals` list (section 6). |
| 4. Budget | A creature covering the pool, or writing words with shapes: at most 40 shapes, inside a disc of radius 60, of a pool 800 wide. | PN1, PN3, PN7. |

- **PN9.** Before it imports any pool module, the host installs the seeded `Math.random` (HO2) and then freezes the built-in objects named in `DEFAULT_GLOBALS`, their prototypes, and `Function.prototype`. `DEFAULT_GLOBALS` is the constant of the `protocol` module (01-core PO4): the same 16 names as the `globals` list of the seed policy (section 6). The host uses the constant because it cannot read the policy file: `.premise/` is not served (AS5) and the frame has no network. A creature file cannot change a built-in to interfere with another creature or with the host.
- **PN10 (stated limit).** A creature can still arrange up to 40 shapes into a small picture. The pen makes text impractical, not impossible. This is one reason the submission build has no crowd input (13.2).
- **PN11.** `pen.js`, `main.js`, `index.html`, `world/**` and `selftest/**` are held paths (section 6). A change to the pen needs the owner's tap, and still cannot pass PN6 and PN7, which live in the host.

---

## 4. The app server contract

The app server is the part of the Worker that serves a pool's files so the pool runs in a browser with no build step. All routes are `GET`, public and read-only.

- **AS15 (headers).** Every app-server response, of every status and on every route of 4.2, carries the full header set of SE14: `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src <app-server origin>; img-src data:; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors <Floor origin>`; `X-Content-Type-Options: nosniff`; and `Access-Control-Allow-Origin: *` on module files. It sends no cookie and reads none (SE15). The `sandbox` directive travels in the response, so a pool page has an opaque origin also when a person opens its address directly (SE13).
- **AS16 (no public request reaches Trunk).** The app server reads two things only: the pool's Floor Durable Object state (to resolve a moving source, for `seq`, and for AS11; FS2) and Artifacts through the binding, by commit id (4.9). It never calls Trunk, an Agent, or the Artifacts control plane to resolve a ref (SE19). A test counts the requests Trunk receives during public reads and expects 0.

### 4.1 Sources and versions

A **source** is what a viewer follows. A **version** names one unchanging tree.

| Source segment | What it follows | Resolved from | Version token it resolves to |
| --- | --- | --- | --- |
| `main` | The landed commit of the pool repo: the last landing confirmed on `main` (LP9, LP10) | the Floor's state (`landing.landed`; `pool.state.landed_commit`) | `c-<40 hex commit id>` |
| `green` | `refs/heads/green` of the pool repo. While no green commit exists, the seed commit (SE19). | the Floor's state (`green.advanced`) | `c-<40 hex>` |
| `<40 hex>` | That commit of the pool repo | nothing to resolve | `c-<40 hex>` |
| `plain` | The newest commit of the pool's plain-merge repo (11.7) | the Floor's state (`plain.updated`) | `p-<40 hex>` |
| `p-<40 hex>` | That commit of the pool's plain-merge repo: a plain-merge landing or a preview commit (PV1, PV5) | nothing to resolve | `p-<40 hex>` |

`main`, `green` and `plain` are **moving** sources. A frame on `main` or `plain` is a **live frame**. `<40 hex>` and `p-<40 hex>` are **commit** sources, and a frame on one is a **commit frame** (SE16a). The Floor builds a frame address from a `FrameAddress` with `frameUrl` of the `protocol` module (PV5): `{ repo: "main", commit }` gives `/pool/<pool>/<40 hex>/`, and `{ repo: "plain", commit }` gives `/pool/<pool>/p-<40 hex>/`.

There is no source for an attempt. The segment `a_<ULID>` and the version token `a-…` of the earlier revision do not exist (PV4, PV5). Code that has not landed is reachable in one way only: as the preview commit of a held or race card, which exists only after the change passed CK0 to CK8.

- **AS1.** A version token is opaque to the page. Two requests with the same version and path return the same bytes. (One stated exception: the registry of a version in a pool with more than `MAX_KINDS` kinds, AS11.)
- **AS2.** `main` never resolves to a landing that is accepted but not pushed (LP10). It resolves to `pool.state.landed_commit`, which only `landing.landed` moves.
- **AS17.** Before the first `plain.updated` of a pool, `plain` resolves to the seed commit of the pool repo (version `c-<40 hex>`): the plain-merge pool starts from the seed (PM1), so the tree is the same. `01-core.md` is silent on this case; this rule is the same choice SE19 makes for `green`.

### 4.2 Routes

| Route | Response | `Cache-Control` |
| --- | --- | --- |
| `GET /pool/<pool>/<source>/` | The `index.html` of the version the source resolves to. Without the final slash: 308 to the same path with it. | `no-store` |
| `GET /pool/<pool>/<source>/~head.js` | Generated module (4.4). | `no-store` |
| `GET /pool/<pool>/<source>/~boot.js` | Generated module (4.4). | `no-store` |
| `GET /pool/<pool>/v/<version>/<path>` | The bytes of `<path>` in that version. | `public, max-age=31536000, immutable` (SE20) |
| `GET /pool/<pool>/v/<version>/~registry.js` | Generated module (4.4). | as the row above |
| `GET /pool/~host.<build>.js` | The host (4.5). A platform asset. | `public, max-age=31536000, immutable` |

- **AS3.** A path segment that starts with `~` can never be a repo path (01-core 2.1 allows only letters, digits, `.`, `_`, `-`). The app server generates exactly the three modules of 4.4 under such names and nothing else (SE15).
- **AS4 (errors).** Unknown pool, unknown source, a commit the repository does not have, or a path that does not exist in the version: 404. A file type outside AS5: 404. Any failure to reach Artifacts or the Floor Durable Object: 503. No error response has a body taken from a repo. There is no 409 answer: the `stale_version` answer of the earlier revision belonged to attempt sources.
- **AS5 (content types, SE15).** `.js` and `.mjs`, and the generated `~*.js` → `text/javascript; charset=utf-8`; `index.html` at the repo root → `text/html; charset=utf-8`; `.json` → `application/json`; `.md` → `text/plain; charset=utf-8`. Anything else is 404, including every other `.html` file. Paths under `.premise/` are not served, whatever their type.
- **AS6 (serving is not reading).** Serving a file or a listing records no premise, emits no event and changes nothing in Trunk, which it never reaches (AS16).
- **AS7.** Query strings on the page route are for the host only (4.5). The app server ignores them.
- **AS8 (rate limit, SE21).** `PUBLIC_RATE_PER_MIN` applies to the three `no-store` routes. Version-pinned routes are counted separately against `APP_FILE_RATE_PER_MIN`, on cache misses only, because one page load fetches about 25 modules.

Because every relative import inside a pool module resolves under `/pool/<pool>/v/<version>/`, a page never mixes modules of two versions by accident.

### 4.3 `index.html`

The seed file MUST be exactly this. It contains no words and no inline script.

```html
<!doctype html>
<meta charset="utf-8">
<title>Tide pool</title>
<style>html,body{margin:0;height:100%;background:#0b1d33}canvas{display:block;width:100%;height:100%}</style>
<canvas id="pool"></canvas>
<script type="module" src="./~boot.js"></script>
```

### 4.4 Generated modules

`~head.js` tells the page which version its source points to now. Its export is named `landed`, not `head`: in `01-core.md` "head" is the last accepted landing, and this module never names a landing that is not confirmed on `main` (AS2). The file name stays `~head.js` (SE15).

```js
export const landed = {
  pool: "tidepool",
  source: "main",
  version: "c-9f1c0e6a4b7d2f3581a0c4e6b8d1f3a5c7e9b2d4",
  base: "/pool/tidepool/v/c-9f1c0e6a4b7d2f3581a0c4e6b8d1f3a5c7e9b2d4/",
  seq: 12
};
```

`seq` comes from the Floor Durable Object's state (FS2), never from Trunk. For `main` it is the `seq` of the landed commit. For `green` it is the green `seq`. For `plain` it is `through_seq` of the last `plain.updated`. For a commit source `<40 hex>` it is the `seq` of the landing with that commit while the Floor's state still holds that landing (`FLOOR_KEEP_LANDINGS`), else `null`. For `p-<40 hex>` it is always `null`.

`~boot.js` starts the host:

```js
import { startHost } from "/pool/~host.<build>.js";
import { landed } from "./~head.js";
startHost(landed);
```

`~registry.js` lists the kinds of one version. It is how the list of creatures comes from the directory listing (TP7):

```js
export const registry = {
  version: "c-9f1c0e6a4b7d2f3581a0c4e6b8d1f3a5c7e9b2d4",
  shared: "5b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e",
  kinds: [
    { kind: "anemone", path: "creatures/anemone.js", oid: "<blob id>" },
    { kind: "fish", path: "creatures/fish.js", oid: "<blob id>" }
  ],
  total: 5,
  skipped: []
};
```

- **AS9.** `kinds` has one entry for every file directly in `creatures/` whose name is a valid kind name plus `.js` (2.6), sorted by kind. `oid` is the file's git blob id. Other entries of the directory are listed in `skipped` with a reason (`not_a_kind`, `reserved_name`).
- **AS10.** `shared` is `H()` (01-core conventions) of the sorted lines `<path> <blob id>` of every file in the version that is not directly in `creatures/`. It changes exactly when a file outside `creatures/` changes.
- **AS11.** At most `MAX_KINDS` entries. When the directory holds more, the app server keeps the files that changed most recently: those with the highest `seq` of the last confirmed landing that changed the path, taken from the Floor's state (FS2). Paths the Floor's state does not know, and ties, are taken in name order. It never asks Trunk (AS16). `total` is the full count. The registry of a version is generated when that version is first requested and then served from the cache (SE20), so the cut is made once per cached version. Stated limit: in a pool with more than `MAX_KINDS` kinds (in practice the Swarm pool), a cold load of an old version can show a different cut of 64 kinds than the first load did.

### 4.5 The host

The host is platform code, served by the app server and never stored in a pool repo. Page parameters (query string): `seed=<integer>` (default `HOST_SEED`), `follow=0` (never look for a new version), `paused=1`. The parameter `selftest=1` of the earlier revision belonged to the Browser Run harness, which is not built (5.4); the host ignores it.

Start-up order: HO2, then PN9, then HO1. No pool module is imported before the first two are done.

- **HO1 (start).** Find `canvas#pool`. Build the surface (3.3). Import `<base>~registry.js`, `<base>main.js`, `<base>pen.js`, then each kind's module with its own dynamic `import()`. A kind whose import fails is left out and reported in `stats`. Call `createPen(surface)` and `createPool(kinds)`.
- **HO2 (random numbers).** Before any pool code runs, replace `Math.random` with the generator below, seeded with the page's seed. The self-test harness of 5.4 uses the same generator.

  ```js
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  ```

- **HO3 (isolation).** The host passes into pool code only: the surface (to `createPen`), the `kinds` object, and plain numbers. It never passes the canvas, the context, an event, `window` or `document`.
- **HO4 (time).** Fixed step: the pool advances `TICKS_PER_SECOND` ticks per second of wall time, at most `HOST_MAX_CATCH_UP` ticks per animation frame, then draws one frame. A hidden page and a paused pool do not tick.
- **HO5 (size).** The canvas shows `poolSize()` scaled to fit the frame, letterboxed, at the device pixel ratio. Pool code never sees screen pixels.
- **HO6 (taps).** On a pointer press the host converts the point to pool units, calls `creatureAt`, and when it returns a creature posts `{ type: "tapped", creature: <kind>, path: <path> }`. `path` is that kind's `path` in the running registry, for example `creatures/crab.js`.
- **HO7 (heartbeat).** The host posts `stats` every `STATS_EVERY_MS`, after every swap, and in answer to every `probe` and every `advance`.
- **HO8 (a stuck pool).** Pool code that never returns cannot be interrupted from inside the frame. The Floor reloads a pool frame that has sent no `stats` for `POOL_STALL_MS`. Which address it reloads, and what it says next to the frame, is fixed in `03-floor.md` section 7. This file guarantees the two kinds of address that row can use: `/pool/<pool>/green/` always resolves (to the last verified commit, or to the seed commit while no green commit exists, SE19), and a commit address never changes.

The channel (the pool side of SE16; the types are the ones of `01-core.md` 13.5). The Floor checks `event.source`, validates every field, and treats every string as text.

```ts
type FloorToPool =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "probe"; selftest?: boolean }          // live frames: look for a new version now; with selftest, also run 5.5
  | { type: "advance"; version: string }           // commit frames only: load this version token without a page reload (HO14)
  | { type: "highlight"; kinds: string[] };        // any frame: outline the creatures of these kinds; [] clears (HO15)

type PoolToFloor =
  | { type: "tapped"; creature: string; path: string }      // the kind name and its file path
  | { type: "stats";
      source: string; version: string; seq: number | null;
      tick: number; paused: boolean;
      kinds: Record<string, { count: number; resting: number; errors: number; benched: boolean }>;
      shown: number; total: number;           // kinds loaded, kinds in the listing
      swap: { mode: "adopt" | "restart"; arrived: string[]; failed: string[] } | null;   // the last swap
      selftest: { version: string; ok: boolean; failed: Array<{ name: string; kind: string | null }> } | null };
```

What the host does with each message (SE16a leaves `advance` and `highlight` to this file):

- **HO14 (`advance`, commit frames only).** `{ type: "advance", version }` asks a commit frame to show another commit of the same repository without a page reload. Replay uses it to step to the next recorded commit. The host acts only when all of these hold: the page's own source is a commit source; `version` matches `^[cp]-[0-9a-f]{40}$`; and its prefix equals the prefix of the running version (`c-` in a frame of the pool repo, `p-` in a frame of the plain-merge repo). Otherwise it changes nothing and posts `stats`. When it acts, it runs the swap of 4.7 with `{ pool, source: <the commit segment of version>, version, base: "/pool/<pool>/v/<version>/", seq: null }` in place of the result of `~head.js`: an adopt when only creature files differ, a restart when shared files differ. In a commit frame a restart loads the page address of the new version (`/pool/<pool>/<40 hex>/` or `/pool/<pool>/p-<40 hex>/`) with the same query string, because the current address would show the old commit again. The `stats` message with the new `version` is the confirmation the Floor waits for. HO10 and HO12 apply. A live frame ignores `advance`.
- **HO15 (`highlight`).** `{ type: "highlight", kinds }` sets the host's highlight set (Who relies). `kinds` must be an array of at most `MAX_KINDS` strings that are kind names (2.6); a message of any other shape is ignored. After every frame the host draws a ring of radius `HIGHLIGHT_RADIUS` and width `HIGHLIGHT_WIDTH` in the colour `HIGHLIGHT_COLOUR` around the place of every creature whose kind is in the set, resting creatures included. It draws with its own surface (one `push`, `style`, `circle` and `pop` per creature) from the places in the world's plain data, never through pool code. A kind that is not in the pool stays in the set and draws nothing until it arrives. `[]` clears the set. The set survives an adopt. It is lost on a restart and on any page load; the Floor sends it again when the first `stats` of the new page arrives. The ring is a shape, so TP12 still holds.
- **HO16 (`probe`).** In a live frame a `probe` runs the step of 4.6. In a commit frame it never looks for a new version. In both, with `selftest: true` the host then runs the in-page self-test (5.5), and it always answers with `stats`.
- **HO17 (messages are data).** The host accepts a message only when `event.source` is its parent window and the data has the shape of one member of `FloorToPool`. Anything else is ignored. No string from a message is ever evaluated or imported, except the version token of `advance` after the check of HO14.

### 4.6 How a live frame learns of a new landing

A pool page cannot poll with `fetch` (`connect-src 'none'`). A **live frame** (source `main` or `plain`, SE16a) learns of a new version in two ways, both ending in the same step:

1. **Probe.** The Floor, which reads the event stream, posts `{ type: "probe" }` to the frame when the event that moves its source arrives: `landing.landed` for a frame on `main`, and `plain.updated` for a frame on `plain`. Nothing else causes a probe: not `landing.accepted`, not `op.recorded`, not `submit.result`.
2. **Slow self-check.** Every `HEAD_POLL_MS` the host does the same step by itself. This covers a pool opened outside the Floor, a missed message, and a frame on `green`, which the Floor does not probe.

The step: `import("./~head.js?n=<counter>")` relative to the page. This is a module import, which `script-src` allows. If `landed.version` equals the running version, nothing happens. Otherwise the host swaps (4.7), without a page reload unless shared files changed.

A **commit frame** (source `<40 hex>` or `p-<40 hex>`: the frames of Replay, and the before and after frames of a card) shows one unchanging tree. It moves only when the Floor posts `advance` (HO14).

- **HO9.** With `follow=0`, and in every commit frame, the host never looks for a new version: there is no self-check, and a `probe` does only what HO16 says.
- **HO10.** At most one swap every `SWAP_MIN_MS`. What arrives during a swap is remembered: one pending probe, or the newest pending `advance`.

### 4.7 Hot swap

Input: the running version with its registry, and the new `landed` object (or the object of HO14).

1. Import the new `~registry.js`.
2. **Shared files changed** (`registry.shared` differs): **restart**. In a live frame the host reloads the page with the same query string. In a commit frame it loads the page address of the new version (HO14). The world starts again at tick 0 with the same seed under the new shared rules. No state is carried over, so no value in an old unit survives a change of unit.
3. **Only creature files changed** (`registry.shared` is equal): **adopt**.
   1. `changed` = kinds whose `oid` differs, plus kinds that are new.
   2. For each kind in `changed`, import its module from the new base. A kind whose import fails keeps its old module if it had one, and is reported in `swap.failed`.
   3. Kinds that are unchanged keep the module they have. Kinds that are gone are dropped.
   4. Between two frames: `pool = adoptPool(pool, kinds, changed)`. Unchanged creatures keep their state. Changed and new kinds are made again with age 0, so they show the arrival ring.
4. Post `stats` with `swap` set.
5. After `MAX_ADOPTS` adopts the host restarts once, to release old modules.

- **HO11.** An adopt never mixes two versions of a shared module in one tick: all running modules were loaded from versions with the same `shared` digest, so their shared code is byte-identical, and shared modules hold no state (TP4).
- **HO12.** If step 1 or the import of `main.js` or `pen.js` fails, the running version keeps running and `stats.swap.failed` is `["*"]`.
- **HO13.** Withdrawn in the reconciliation. It handled the answer 409 `stale_version` of attempt sources, which no longer exist (AS4).

### 4.8 Two or three pools side by side

- **AS12.** Each pool is its own frame with its own source: `<iframe sandbox="allow-scripts" src="/pool/<pool>/<source>/?seed=<n>">`. Frames share nothing: each has its own realm, its own seeded `Math.random`, its own module graph and its own world.
- **AS13.** For a comparison the Floor gives every frame the same `seed` and sets their `src` in the same task, so they start from the same world. Differences on screen then come only from differences in code.
- **AS14.** The Floor pauses a frame that is not visible.

One mechanism per kind of frame (SE16a):

| View | Frames | Kind of frame | Sources |
| --- | --- | --- | --- |
| The pool | 1 | live | `main` |
| Hero comparison (section 7; the Compare view) | 2 | live | `main`, `plain` |
| Held card, before and after (10.2, PV2) | 2 | commit | `<40 hex>`: the landed commit of `main` when the card opened; `p-<40 hex>`: the preview commit |
| Race card (11.4) | up to `RACE_SIZE` | commit | one `p-<40 hex>` each: each candidate's preview commit |
| Replay (12.3) | as the recorded view | commit | `<40 hex>` and `p-<40 hex>`, stepped with `advance` |

A live frame is never addressed by commit and never receives `advance`. A commit frame never receives a `probe` that moves it.

### 4.9 Where the files come from (decided: by commit id)

The routes above code against this interface. The adapter is chosen by `01-core.md` section 15, port S7.

```ts
type Version = string;   // "c-<40 hex>" | "p-<40 hex>"

interface PoolSource {
  // A moving source is resolved from the pool's Floor Durable Object state (SE19, FS2). A commit source resolves to itself.
  resolve(pool: string, source: string): Promise<{ version: Version; seq: number | null } | null>;
  read(pool: string, version: Version, path: string): Promise<{ bytes: Uint8Array; oid: string } | null>;
  list(pool: string, version: Version, dir: string):
    Promise<Array<{ name: string; type: "file" | "dir"; oid: string }> | null>;
}
```

`oid` is the git blob id of the bytes. `read` and `list` no longer answer `"stale"`: every version is an unchanging commit.

| Option | For | Description | Status |
| --- | --- | --- | --- |
| A | `c-`, `p-` | Artifacts binding by object id: `readCommit` → `readTree` (one level at a time) → `readBlob`. Trees are cached per version. | Fallback (S7) |
| B | `c-`, `p-` | Artifacts `readFile({ ref: <commit id>, path })` through the binding. A directory listing uses `readCommit` and `readTree`. | **Chosen** (S7) |
| C | none | Trunk's `files` table for the head. | Withdrawn: a public request never reaches Trunk (SE19, AS16) |
| D | none | Trunk's attempt view. | Withdrawn: previews are preview commits (PV1, PV4) |
| E | tests, local runs | A directory on disk. | Tests only |

Evidence (platform record, X4 and X6): `readFile({ ref: <commit id>, path })` returned the file for every ref tested. `readFile`, `readTree`, `readCommit` and `readBlob` took about 110 ms each (p50). After a push, reads showed the new head within 109 to 274 ms. The binding resolves commit ids and short branch names; it does not resolve full ref names or other namespaces, so the adapter always passes a commit id (S7a, S7b).

Not yet measured: a read by commit id of a commit that is reachable only from `refs/previews/*`, which is what the after frame of a card needs. If that read fails, Trunk pushes previews to `refs/heads/previews/<submit_id>` instead (PV1a); the address is still the commit id, so nothing in this section changes. Also not measured: the time to load a whole pool page (about 25 modules) on a cold cache.

---

## 5. The headless self-test

### 5.1 What it is

`selftest/run.js` exports `runSelfTest({ kinds, reseed, ticks })`. It is pure pool code: it imports only modules of the pool (`main.js`, `pen.js`, `selftest/*`, and through them `world/*`), uses no global outside the allow list, and returns the verdict as a plain object. The harness (5.4) supplies `kinds` (2.5) and `reseed(n)`, which restarts `Math.random` from seed `n` (HO2).

It runs the pool twice from `SELFTEST_SEED` for `SELFTEST_TICKS` (3600: one whole day and night), checking after every tick, and drawing a frame on the recording surface every `DRAW_EVERY` ticks and after the last tick.

### 5.2 Invariants

| Check | When | Fails when |
| --- | --- | --- |
| `files` | before the run | A creature module lacks `spawn`, `update` or `draw` as functions. That kind is left out of the run. |
| `no_errors` | end | Any kind has a counted failure (a thrown error, a non-finite place or speed, a `NaN` energy), or is benched. |
| `in_bounds` | every tick | A creature is outside the water (`isInside`). |
| `energy_range` | every tick | A creature that uses energy has energy below 0, above `ENERGY_MAX`, or not a number. |
| `population` | every tick | The number of creatures differs from the sum of `countFor` over the kinds that are not benched (capped at `MAX_CREATURES`). |
| `not_exhausted` | end | A kind's creatures were resting for more than `MAX_REST_SHARE` (0.25) of their ticks. |
| `state_is_data` | end | The world does not survive `JSON.parse(JSON.stringify(world))` unchanged, or its JSON is longer than `MAX_STATE_CHARS`. |
| `pen_rules` | every drawn frame | A creature had a rejected pen call (PN1, PN2). |
| `visible` | every drawn frame | What a creature drew is less than `MIN_DRAWN` (16) wide and tall, or it drew nothing. |
| `within_reach` | every drawn frame | An edge of what a creature drew is farther than `MAX_REACH` from its place. |
| `draw_is_pure` | every drawn frame | The world's fingerprint differs before and after `draw`. |
| `deterministic` | end | The second run's final world differs from the first run's. This also fails when a module keeps state at its top level. |

- **ST1.** The self-test knows nothing about any particular kind. Every check applies to every creature, including ones written later.
- **ST2.** The self-test never throws. A failure inside pool code is a failed check.
- **ST3 (stated limit).** The self-test checks that the pool is healthy. It does not check that a creature does what its intent asked. Sections 7 and 8 each contain a break it does not see.

### 5.3 The verdict

```ts
type SelfTestVerdict = {
  v: 1;
  ok: boolean;                                   // true when `failed` is empty
  seed: number;
  ticks: number;
  kinds: string[];                               // every kind it was given, sorted
  checks: Array<{ name: string; ok: boolean; detail?: string }>;   // always the 12 checks, in the order of 5.2
  failed: Array<{ name: string; kind: string | null }>;
  rest_share: Record<string, number>;            // per kind, 0 to 1
  creatures: number;
  state_hash: string;                            // fingerprint of the final world of the first run
};
```

`detail` is free text built by pool code and can hold kind names that agents chose. It leaves the verifier only inside `log` (5.4).

Worked example: the verdict for the plain-merge pool of section 7 (observed; `state_hash` is an example value).

```json
{
  "v": 1,
  "ok": false,
  "seed": 7,
  "ticks": 3600,
  "kinds": ["anemone", "crab", "fish", "jellyfish", "minnow", "shrimp", "snail", "turtle"],
  "checks": [
    { "name": "files", "ok": true },
    { "name": "no_errors", "ok": true },
    { "name": "in_bounds", "ok": true },
    { "name": "energy_range", "ok": true },
    { "name": "population", "ok": true },
    { "name": "not_exhausted", "ok": false, "detail": "shrimp: resting 82% of the time" },
    { "name": "state_is_data", "ok": true },
    { "name": "pen_rules", "ok": true },
    { "name": "visible", "ok": true },
    { "name": "within_reach", "ok": true },
    { "name": "draw_is_pure", "ok": true },
    { "name": "deterministic", "ok": true }
  ],
  "failed": [{ "name": "not_exhausted", "kind": "shrimp" }],
  "rest_share": { "anemone": 0, "crab": 0, "fish": 0, "jellyfish": 0, "minnow": 0, "shrimp": 0.817, "snail": 0, "turtle": 0 },
  "creatures": 26,
  "state_hash": "19d82866"
}
```

### 5.4 How the green line calls it

The green line's `Verifier` (11.5) runs `runSelfTest` from the commit under test. The runtime is decided (01-core S4, GR5): a Dynamic Worker isolate. Static checks are the fallback. Browser Run and a container are not built.

| S4 option | Status | Harness |
| --- | --- | --- |
| B, Dynamic Worker isolate (`runtime: "isolate"`) | **Chosen** | Read every `.js` file of the commit through `PoolSource`, by commit id (4.9). Load them as the modules of one Dynamic Worker through the Worker Loader binding, with an empty environment, `globalOutbound: null` and `limits: { cpuMs: GREEN_CPU_MS }` (S4a, GR6), plus a generated entry module. The entry module imports `selftest/run.js` and each `creatures/<kind>.js` statically, installs the generator of HO2, calls `runSelfTest`, and returns the verdict as JSON. One verification uses one isolate, and at most one verification is in flight (S4b, GR1). |
| D, static (`runtime: "static"`) | Fallback (`features.green` is `"static"`) | The self-test is not run. The checks are `parse`, `imports_resolve` and `policy_invariants` (GR5, GR8). The Floor says that the green line is static checks only. |
| A, Browser Run | Not built (S4c) | It would open `/pool/<pool>/<commit>/?selftest=1` and read the verdict from the page. |
| C, container | Not built (S4c) | It would check out the commit and run a Node script that does what the entry module of option B does. |

Mapping to `VerifyResult` (11.5), by the fixed list of GR8:

| `VerifyResult` field | Value |
| --- | --- |
| `ok` | `verdict.ok` |
| `checks` | First `{ name: "selftest_ran", ok: true }`. Then the twelve checks of 5.2 in their order, each as `{ name, ok: true }`, or as `{ name, ok: false, code }` where `code` is the check name followed by `:failed`, for example `not_exhausted:failed`. The verdict's `detail` is not copied. |
| `log` | JSON of `{ failed, rest_share, details }`, cut to `GREEN_LOG_MAX_CHARS`. `details` maps each failed check name to its `detail` text. The log is shown to the owner only and never enters an event, a heads-up or a model context (GR7). |
| `runtime` | `"isolate"` |

The verdict of 5.3 maps to these `checks` (thirteen entries; only the failed one has a code):

```json
[
  { "name": "selftest_ran", "ok": true },
  { "name": "files", "ok": true },
  { "name": "no_errors", "ok": true },
  { "name": "in_bounds", "ok": true },
  { "name": "energy_range", "ok": true },
  { "name": "population", "ok": true },
  { "name": "not_exhausted", "ok": false, "code": "not_exhausted:failed" },
  { "name": "state_is_data", "ok": true },
  { "name": "pen_rules", "ok": true },
  { "name": "visible", "ok": true },
  { "name": "within_reach", "ok": true },
  { "name": "draw_is_pure", "ok": true },
  { "name": "deterministic", "ok": true }
]
```

- **ST4 (fail closed).** No verdict within `SELFTEST_TIMEOUT_MS` or within the CPU limit, a verdict that is not valid JSON of the type in 5.3, or a harness error gives `ok: false` with the single check `{ name: "selftest_ran", ok: false, code }`. `code` is `no_verdict`, `bad_verdict` or `harness_error` (GR8). The reason text goes into `log` only. A pool whose code never returns is therefore red. GR3 runs the check once more on the same commit and reverts only after that second failed run.
- **ST5.** The harness adds nothing to the pool's checks and removes none.
- **ST6.** `selftest/**` is a held path. A change that weakens a check needs the owner's tap.

### 5.5 The same self-test in the page

On `{ type: "probe", selftest: true }` the host runs `runSelfTest` once for the version it is running and reports the result in `stats.selftest` (HO16). `stats.selftest.failed` carries check names and kind names only, never `detail` text. The Floor shows the result as a badge under that frame; the component and its words are in `03-floor.md` (3.6 and section 5), not here. This is how the plain-merge pool, which the green line does not verify, shows a verdict next to the real pool. The badge never moves `refs/heads/green`.

---

## 6. The policy file

`.premise/policy.json` in the seed MUST be exactly this (format: 01-core 10.1):

```json
{
  "v": 1,
  "default": "held",
  "tiers": [
    { "paths": ["creatures/*.js"], "tier": "auto" },
    { "paths": ["world/**", "main.js", "pen.js", "index.html", "selftest/**", "GUIDE.md"], "tier": "held" }
  ],
  "globals": ["Math", "Number", "String", "Boolean", "Array", "Object", "JSON", "Map", "Set", "Infinity", "NaN", "undefined", "isFinite", "isNaN", "parseInt", "parseFloat"],
  "limits": { "max_paths": 64, "max_change_bytes": 65536 }
}
```

| Path | Tier | Why |
| --- | --- | --- |
| `creatures/<kind>.js` | `auto` | A creature file affects one kind. It lands by itself when its premises hold. |
| `world/**` | `held` | Shared rules. A change here changes every creature. The owner sees a before and after preview and the blast radius (11.6), and taps once. |
| `main.js`, `pen.js`, `index.html` | `held` | How the pool starts and draws. |
| `selftest/**` | `held` | The checks the green line trusts. |
| `GUIDE.md` | `held` | Every agent reads it. |
| `.premise/**` | `held` | Always, by rule PO3. |
| anything else | `held` | The default. A new top-level file or directory waits for the owner. |

- A change that touches an `auto` path and a `held` path is `held` (PO2). Example: the shared-rule attempt of section 7 in landing order 2.
- `globals` leaves out `Date`, `console`, `Symbol`, `Promise`, timers and every page and network name. `Math.random` stays usable because the host and the self-test seed it (HO2). The 16 names are the constant `DEFAULT_GLOBALS` of the `protocol` module (PO4), which the host uses because it cannot read this file (PN9).
- Every seed module passes CK6 with this list (TP3), so any entity in the pool can be edited later without tripping over a global it already used.
- `max_paths` is 64, the cap of 01-core 4.2 (`MAX_PATHS`), so a sweep over every creature is one change while the pool has at most 64 creature files. The earlier revision said 16, which undid the core's raise to 64.

Three seeds are built into a deployment (PL1). Only `tidepool` is stored as files, in `seeds/tidepool/`. The other two are generated from it when the deployment is built.

| Seed | Difference from `tidepool` | Used for |
| --- | --- | --- |
| `tidepool` | none | Every pool whose shared rules wait for the owner: the main pool when `features.held` is true. |
| `tidepool-auto` | One line of the policy: the first rule's paths are `["creatures/*.js", "world/*.js"]`. | The main pool while `features.held` is false (FJ1). Shared-rule changes then land by themselves, and the page says so (`03-floor.md` 1.4). |
| `tidepool-swarm` | The same policy line as `tidepool-auto`, plus the four creatures of 10.1. | The Swarm pool and the soak pools. Scripted shared-rule changes land without a tap, and the Swarm view says so under the SYNTHETIC banner. |

Under the variant line the files directly in `world/` are `auto`, because the first matching rule decides (PO1). `main.js`, `pen.js`, `index.html`, `selftest/**`, `GUIDE.md` and `.premise/**` stay `held` in every seed. A held-tier change fails closed in every build: without `features.held` it still waits on the minimal card of HD1.

---

## 7. The hero conflict

### 7.1 The shared quantity

Energy. In the seed it is counted in points from 0 to 100. The owner asks for it to be a fraction from 0 to 1. The change is the first two lines of `world/energy.js`:

```diff
-// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).
-export const ENERGY_MAX = 100;
+// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).
+export const ENERGY_MAX = 1;
```

What does not change: the name `ENERGY_MAX`, its export, its kind (`const`), its type (a number), every import of it, every other entity of `world/energy.js`, and the outline line `ENERGY_MAX|const|ENERGY_MAX|` (01-core 2.7). What changes: the entity hash of `world/energy.js#ENERGY_MAX` (the literal `100` becomes `1`), and the meaning of every energy number anywhere.

By TP15 the seed stays correct after this one edit. The only code that can still mean points is code written by attempts that are in flight when the meaning changes.

### 7.2 The attempts

| Name | Intent text | Kind of change | Paths | Tier |
| --- | --- | --- | --- | --- |
| S | "make energy a fraction from 0 to 1" | shared rule | `world/energy.js` | held |
| C | "a crab that hides in its shell when its energy drops below 30" | new creature | `creatures/crab.js` | auto |
| H | "a shrimp that darts every two seconds and spends 5 energy on each dart" | new creature | `creatures/shrimp.js` | auto |
| J | "a jellyfish that drifts up and down" | new creature | `creatures/jellyfish.js` | auto |

C and H rely on the old meaning: their intents carry numbers in points. J never mentions energy; it is in the script to show who is not disturbed. (`premise-cases.json` uses the shorter intent "a crab that hides when its energy is low" with the same code shape; the vectors `C04`, `C05`, `C10` and `C30` are this conflict on the vector pool, and `C57` shows the folding that step 3b of 7.5 uses.)

### 7.3 Canned operations

These are the exact operations of the canned version. Real agents write their own code; 7.10 lists what must hold for them.

**S.** `read GUIDE.md`; `read world/energy.js`; then one `replace` on `world/energy.js`:

- `old`: `// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 100;`
- `new`: `// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 1;`

(`\n` is a line break. The comment belongs to the entity: by rule EN6 a leading comment is part of the statement that follows it.)

Result of the `replace` (observed): `targets` and `altered` are `["world/energy.js#ENERGY_MAX"]`. By rule D2 Trunk pins `refs:world/energy.js#ENERGY_MAX` and returns the referrers at head in `relied_on_by`. In the reference implementation there are 14: the import entity and `spawn` of `fish`, `minnow` and `turtle`; `world/energy.js#HUNGRY_BELOW`, `#LIVING_COST`, `#feed`, `#liveOneTick`; `world/food.js#(import ./energy.js)` and `#FOOD_ENERGY`; and the import entity and one check function (`checkTick`) of `selftest/invariants.js`. By rule D1 the same call pins derived premises on what the other entities of `world/energy.js` reference (`ModuleRefs`): `#HUNGRY_BELOW`, `#LIVING_COST`, `#REST_TICKS` and `#drain`. Then `submit` with summary "Make energy a fraction from 0 to 1".

**C.** `list creatures/`; `read GUIDE.md`; `read` the entities `world/energy.js#ENERGY_MAX`, `world/bounds.js#FLOOR_Y`, `world/bounds.js#bounce`, `world/movement.js#step`; then `write creatures/crab.js`:

```js
import { ENERGY_MAX } from "../world/energy.js";
import { FLOOR_Y, bounce } from "../world/bounds.js";
import { step } from "../world/movement.js";

const SHELL = "orange";

export function spawn() {
  return { y: FLOOR_Y - 10, vx: 1, energy: ENERGY_MAX, hiding: false };
}

export function update(crab) {
  crab.hiding = crab.energy < 30;
  if (crab.hiding) return;
  step(crab);
  bounce(crab);
}

export function draw(crab, pen) {
  pen.fill(SHELL);
  if (crab.hiding) {
    pen.ellipse(0, 2, 16, 9);
    return;
  }
  pen.line(-14, 6, -24, 14);
  pen.line(14, 6, 24, 14);
  pen.circle(-20, -10, 6);
  pen.circle(20, -10, 6);
  pen.ellipse(0, 0, 18, 11);
}
```

Repair operation: `replace creatures/crab.js`, `old`: `crab.energy < 30`, `new`: `crab.energy < 0.3`.

**H.** `list creatures/`; `read GUIDE.md`; `read` the whole files `world/energy.js`, `world/bounds.js`, `world/time.js`, `world/movement.js`; then `write creatures/shrimp.js`:

```js
import { ENERGY_MAX, drain } from "../world/energy.js";
import { bounce } from "../world/bounds.js";
import { seconds } from "../world/time.js";
import { step, wander, glide } from "../world/movement.js";

const BODY = "pink";

export function spawn() {
  return { energy: ENERGY_MAX };
}

export function update(shrimp) {
  if (shrimp.age % seconds(2) === 0) {
    wander(shrimp, 3);
    drain(shrimp, 5);
  }
  glide(shrimp, 0.95);
  step(shrimp);
  bounce(shrimp);
}

export function draw(shrimp, pen) {
  if (shrimp.vx < 0) pen.flip();
  pen.fill(BODY);
  pen.ellipse(0, 0, 14, 6);
  pen.poly([-12, 0, -22, -7, -22, 7]);
  pen.line(12, -2, 24, -10);
  pen.line(12, 0, 26, -4);
}
```

Repair operation: `replace creatures/shrimp.js`, `old`: `drain(shrimp, 5)`, `new`: `drain(shrimp, 0.05)`.

**J.** `list creatures/`; `read GUIDE.md`; `read` the entities `world/bounds.js#SURFACE_Y` and `#FLOOR_Y`; then `write creatures/jellyfish.js`:

```js
import { SURFACE_Y, FLOOR_Y } from "../world/bounds.js";

const BELL = "purple";

export function spawn() {
  return { vy: -0.4 };
}

export function update(jellyfish) {
  if (jellyfish.y < SURFACE_Y + 40) jellyfish.vy = 0.4;
  if (jellyfish.y > FLOOR_Y - 60) jellyfish.vy = -0.4;
  jellyfish.y += jellyfish.vy;
}

export function draw(jellyfish, pen) {
  pen.alpha(0.8);
  pen.fill(BELL);
  pen.ellipse(0, 0, 16, 10);
  pen.line(-8, 6, -8, 22);
  pen.line(0, 6, 0, 26);
  pen.line(8, 6, 8, 22);
}
```

C reads by entity and H reads whole files on purpose: the two styles reach the same catch. Since core revision 2 both get the same item, rule E2, because D1 pins the reference at the write. H's file premise is judged as well, and its item is folded (7.5).

### 7.4 Premises held just before S lands (landing order 1)

Observed. Derived premises exist from the write (rule D1 pins at every operation), not from the submit.

| Attempt | Premise | Flags | From |
| --- | --- | --- | --- |
| C | `listing:creatures/` | read | `list` |
| C | `file:GUIDE.md` | read | `read` |
| C | `entity:world/energy.js#ENERGY_MAX`; `entity:world/bounds.js#FLOOR_Y`, `#bounce`; `entity:world/movement.js#step` | read, derived | `read` of each entity; `derived` is set by D1 at the `write`, because the new file references each of them |
| C | `file:creatures/crab.js` at `absent` | edit | `write` (W4) |
| H | `listing:creatures/`, `file:GUIDE.md` | read | `list`, `read` |
| H | `file:world/energy.js`, `file:world/bounds.js`, `file:world/time.js`, `file:world/movement.js` | read | `read` of each file |
| H | `entity:world/energy.js#ENERGY_MAX`, `#drain`; `entity:world/bounds.js#bounce`; `entity:world/time.js#seconds`; `entity:world/movement.js#step`, `#wander`, `#glide` | derived | D1 at the `write`: seven premises, one for each entity the new file references |
| H | `file:creatures/shrimp.js` at `absent` | edit | `write` |
| J | `listing:creatures/`, `file:GUIDE.md` | read | `list`, `read` |
| J | `entity:world/bounds.js#SURFACE_Y`, `#FLOOR_Y` | read, derived | `read` of each entity; D1 at the `write` |
| J | `file:creatures/jellyfish.js` at `absent` | edit | `write` |
| S | `file:GUIDE.md`, `file:world/energy.js` | read | `read` |
| S | `entity:world/energy.js#ENERGY_MAX` | edit, derived | `replace` (R4); `derived` because other entities of the touched module reference it (`ModuleRefs`) |
| S | `entity:world/energy.js#HUNGRY_BELOW`, `#LIVING_COST`, `#REST_TICKS`, `#drain` | derived | D1 at the `replace` (`ModuleRefs` of `world/energy.js`) |
| S | `refs:world/energy.js#ENERGY_MAX` (members: the referrers at head and their modules) | derived | D2 at the `replace` |

For both C and H, `world/energy.js#ENERGY_MAX` is in `NewRefs` (01-core 6.3): their new `spawn` and import entities reference it. From the write on, that premise is live.

### 7.5 Landing order 1: the shared rule lands while the creatures are in flight

| # | Event | Rule | What Trunk does |
| --- | --- | --- | --- |
| 1 | S submits. | CK9, T4 | Tier `held`. A held card opens. Blast radius: `repair: [C, H]`, `confirm: []`, `triage: []`. J is not on it. |
| 2 | The owner taps Land (option `land`, CD4). | T13 | S is `validated`. |
| 3 | The next tick accepts S as landing 1. | 9.4 step 5, HU1 | In the same transaction every in-flight premise changed by the batch is classified. |
| 3a | C: `entity:world/energy.js#ENERGY_MAX`, hash changed, not edited by C, referenced by C. | **E2** | `repair`, reason `referenced_entity_changed`. C: `working` → `going_around`, go-around 1. |
| 3b | H holds two premises that the landing changed. `entity:world/energy.js#ENERGY_MAX` (derived at the write): hash changed, referenced by H. `file:world/energy.js` (read): blob id changed, changed entities `{ENERGY_MAX}`, which H references. | **E2**, and **F3** folded by **HU2a** | Two judgments are recorded, both `repair`. H's heads-up carries one item, the entity's, with rule `E2`. The file item is folded, because the one changed entity that matters has its own item; the file premise's status is `holds`. H: `working` → `going_around`, go-around 1. |
| 3c | J: holds no premise on anything S wrote. | none | No judgment, no heads-up. J stays `working`. |
| 4 | Trunk writes `ops_first` for C and for H (PM2): the one `write` each holds at this moment. `submitted` is 0 for both, because neither has passed a submit. | 11.7 | Used later for the plain-merge pool (7.8). |
| 5 | Each agent receives its heads-up in its next tool result, or as a push (HU5). | TA3 | No write or submit is accepted from C or H until the heads-up is in the model's context. |
| 6 | C applies its repair operation and submits with `acknowledge: [1]` and the statement "Energy is now a fraction from 0 to 1, so the crab hides below 0.3." | CK1, CK7, CK8 | `validated`. CK7 creates no premise: every reference was pinned at the write. No blind spot: C had read each of them. |
| 7 | H applies its repair operation and submits with `acknowledge: [1]` and the statement "Energy is now a fraction from 0 to 1, so a dart costs 0.05." | CK1, CK7, CK8 | `validated`. CK7 creates no premise: H's seven entity premises exist since the write. No blind spot: H had read each file, and a whole-file read counts for B1. |
| 8 | J submits. | CK7 | `validated`, no go-around. |
| 9 | The next tick accepts C, H and J in one batch as landings 2, 3 and 4. | 9.4 step 3b | H and J each hold a `listing:creatures/` premise that an earlier member of the batch changed; rule **L3** classifies it `holds` (`listing_unused`), so the three are disjoint. |

Observed end state: S landed, 0 go-arounds; C landed, 1; H landed, 1; J landed, 0. No triage row was reached, so no Clef call is due in this order.

What C's agent receives (its `HeadsUp`, 01-core 8.2; the fields `attempt_id`, `wake`, `head_seq` and `created_at`, and the item's `old_hash` and `new_hash`, are left out here):

```json
{
  "hn": 1,
  "result": "repair",
  "cause": { "type": "landing", "seqs": [1],
             "changes": [{ "seq": 1, "change_id": "c_<S>", "intent_text": "make energy a fraction from 0 to 1" }] },
  "items": [{
    "premise": { "kind": "entity", "key": "world/energy.js#ENERGY_MAX" },
    "rule": "E2",
    "result": "repair",
    "reason": "referenced_entity_changed",
    "cause_seq": 1,
    "diff": {
      "kind": "entity",
      "before": "// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 100;",
      "after": "// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 1;"
    },
    "uses": [
      { "path": "creatures/crab.js", "entity": "(import ../world/energy.js)", "line": 1,
        "text": "import { ENERGY_MAX } from \"../world/energy.js\";" },
      { "path": "creatures/crab.js", "entity": "spawn", "line": 8,
        "text": "  return { y: FLOOR_Y - 10, vx: 1, energy: ENERGY_MAX, hiding: false };" }
    ]
  }],
  "dropped_ops": [],
  "go_around": 1
}
```

H receives a heads-up of the same shape with the same single item: premise `entity:world/energy.js#ENERGY_MAX`, rule `E2`, the same `diff`. Its `uses` are lines 1 and 9 of `creatures/shrimp.js`. H gets no `file` item: the F3 judgment on `file:world/energy.js` is recorded and folded (HU2a; vector `C57` shows the same folding).

Note on `uses`. The lines that reference `ENERGY_MAX` are the import and `spawn`. The line with the old number (`crab.energy < 30`, `drain(shrimp, 5)`) does not name `ENERGY_MAX` and is not in `uses`. The agent has to connect the two from the diff, the other change's intent text, and rule 3 of the guide. This step is the one the seeded-intent measurement reports as "30 → 0.3" (TP22).

Variant 1c: the creature's agent never read the rule. C's agent learned about energy only from `creatures/fish.js`. What happens depends on when C wrote its file (both observed):

| C writes `creatures/crab.js` | What happens | Go-arounds of C | Vector |
| --- | --- | --- | --- |
| Before S lands | D1 pins `entity:world/energy.js#ENERGY_MAX` at the write, with `derived` and without `read`. Step 3a then happens exactly as above: rule **E2**, `repair`, with the diff. The heads-up shows C the new definition, so C's submit raises no blind spot. | 1 | `C10` |
| After S landed | No premise existed when S landed, so no heads-up was due. D1 pins the premise at the write, at the new value. At C's submit, rule **B1** finds a reference that C added to an entity it was never shown: one heads-up of result `confirm` (cause `submit`) with the current source of `ENERGY_MAX` (`... = 1;`, with its comment) and C's own lines. The submit answers `needs_confirm`. C applies the same repair operation and submits again with the acknowledgement. | 0 | `C30` |

In both cases C lands with the same final file. B1 is the rule only when the meaning changed before the creature was written.

### 7.6 Landing order 2: the creatures land while the shared-rule change is in flight

S has made its `replace` (so `refs:world/energy.js#ENERGY_MAX` is pinned) and is waiting on its held card. C and H are written against points and submit.

| # | Event | Rule | What Trunk does |
| --- | --- | --- | --- |
| 1 | S submits. | T4 | Held card. Blast radius at this moment: empty, because C and H have not written yet. |
| 2 | C and H write and submit. Their premises hold: `ENERGY_MAX` is still 100 at head. | D1, CK7, CK8 | Both `validated` (tier `auto`). |
| 3 | The next tick accepts C and H as landings 1 and 2. | 9.4 | Both land. The pool is healthy: head is still in points. |
| 4 | In the same transaction S's `refs:` premise is classified: its member set gained `creatures/crab.js#(import ../world/energy.js)`, `creatures/crab.js#spawn`, `creatures/shrimp.js#(import ../world/energy.js)`, `creatures/shrimp.js#spawn`, and S alters `ENERGY_MAX`. | **QR1** | `repair`, reason `new_reference_to_altered_entity`. S: `held` → `going_around`, go-around 1. The held card closes as `stale` (T8). `ops_first` for S is written: its one `replace`, with `submitted` 1, because S had passed a submit. |
| 5 | S applies both repair operations of 7.3 itself, in its own change. It needs no read first: the item's `context` carries `creatures/crab.js#update` and `creatures/shrimp.js#update` with their sources, and a `replace` requires no prior read (R1). | R4, D1, D2 | S now also alters `creatures/crab.js#update` and `creatures/shrimp.js#update`. D2 pins a `refs:` premise for each. D1 pins what the two touched creature modules reference (derived): `world/movement.js#step`, `#wander`, `#glide`; `world/bounds.js#bounce`, `#FLOOR_Y`; `world/time.js#seconds`; and the colour constants `creatures/crab.js#SHELL` and `creatures/shrimp.js#BODY`. |
| 6 | S submits with `acknowledge: [1]` and the statement "Two new creatures used point values. Changed the crab's 30 to 0.3 and the shrimp's 5 to 0.05 in the same change." | CK1, CK7, CK8, CK9, T4 | The repair is resolved. There is no blind spot: the two `update` entities already referenced `step`, `bounce`, `seconds`, `wander` and `glide` at head, and S added no reference (B1a). Tier `held` (the change touches `world/energy.js`): the submit answers `held`, and a new held card opens for the new `submit_id`. |
| 7 | The owner taps Land. The next tick accepts S as landing 3. | T13, 9.4 | Head: `ENERGY_MAX = 1`, `crab.energy < 0.3`, `drain(shrimp, 0.05)`. |

Observed end state: C and H landed with 0 go-arounds; S landed with 1. No triage row was reached. (The earlier revision had one more step here, a blind-spot `confirm` for the five references. Rule B1a removed it.)

What S's agent receives in step 4 (the same fields are left out as in 7.5):

```json
{
  "hn": 1,
  "result": "repair",
  "cause": { "type": "landing", "seqs": [1, 2],
             "changes": [
               { "seq": 1, "change_id": "c_<C>", "intent_text": "a crab that hides in its shell when its energy drops below 30" },
               { "seq": 2, "change_id": "c_<H>", "intent_text": "a shrimp that darts every two seconds and spends 5 energy on each dart" }] },
  "items": [{
    "premise": { "kind": "query", "key": "refs:world/energy.js#ENERGY_MAX" },
    "rule": "QR1",
    "result": "repair",
    "reason": "new_reference_to_altered_entity",
    "cause_seq": 1,
    "diff": {
      "kind": "query",
      "added": [
        { "key": "creatures/crab.js#(import ../world/energy.js)",
          "source": "import { ENERGY_MAX } from \"../world/energy.js\";" },
        { "key": "creatures/crab.js#spawn",
          "source": "export function spawn() {\n  return { y: FLOOR_Y - 10, vx: 1, energy: ENERGY_MAX, hiding: false };\n}" },
        { "key": "creatures/shrimp.js#(import ../world/energy.js)",
          "source": "import { ENERGY_MAX, drain } from \"../world/energy.js\";" },
        { "key": "creatures/shrimp.js#spawn",
          "source": "export function spawn() {\n  return { energy: ENERGY_MAX };\n}" }
      ],
      "removed": [],
      "context": [
        { "key": "creatures/crab.js#update",
          "source": "export function update(crab) {\n  crab.hiding = crab.energy < 30;\n  if (crab.hiding) return;\n  step(crab);\n  bounce(crab);\n}" },
        { "key": "creatures/shrimp.js#update",
          "source": "export function update(shrimp) {\n  if (shrimp.age % seconds(2) === 0) {\n    wander(shrimp, 3);\n    drain(shrimp, 5);\n  }\n  glide(shrimp, 0.95);\n  step(shrimp);\n  bounce(shrimp);\n}" }
      ]
    },
    "uses": []
  }],
  "dropped_ops": [],
  "go_around": 1
}
```

The example shows two of the `context` entries. The real item has eleven (observed): every entity that the two landings added to the modules that hold a referrer, other than the four in `added`. For `creatures/crab.js` these are its imports of `bounds.js` and `movement.js`, `SHELL`, `draw` and `update`; for `creatures/shrimp.js` its imports of `bounds.js`, `movement.js` and `time.js`, `BODY`, `draw` and `update`.

The intent texts of the two landed changes ("below 30", "5 energy") are in `cause.changes`. The added sources are the entities that reference `ENERGY_MAX`. The lines with the old numbers are in the two `update` functions, which arrive as `context`, so S sees the lines that break without reading the files. Rule 8 of the guide tells it what to do with them.

Mixed order. If C lands before S and H after, both rules run in one session (observed): QR1 sends S around to fix the crab, S's second card lists H under `repair`, and E2 sends H around to fix itself. The outcomes are the rows above.

Order 2b: S makes its edit after C has landed. Then nothing is in flight against anything, and no heads-up is due. The `replace` result's `relied_on_by` already lists `creatures/crab.js#spawn` and its import next to the seed referrers (observed: 16 referrers instead of 14), so S's agent is shown the crab at the moment it changes the meaning. Whether S then fixes the crab's number is S's own work, shown to the owner in the before and after preview of the held card. Premise guarantees the agent was shown every referrer; it does not prove the sweep was complete. This limit is stated in the README and in the limits list of About (01-core HC3; `03-floor.md` 5.12). The scripted run of the video meets this case with the starter shrimp (9.5, TP24).

### 7.7 Who is not sent back

Observed with the same attempts in flight:

| Landing | C (read the entity) | H (read the whole file) | J | Rule |
| --- | --- | --- | --- | --- |
| A comment in `world/energy.js` is reworded (intent R10) | nothing | judgment `holds`, no heads-up | nothing | E0, F2 |
| `REST_TICKS` changes from 300 to 150 (intent R07) | nothing | triage (`F4`: read, not referenced). The diff arrives at once in an `info` heads-up (TR1). Then Clef answers; with Clef off the result is a `confirm`, decided in the same transaction (TR5). | nothing | F4 |
| `ENERGY_MAX` changes meaning | `repair` | `repair` | nothing | E2 (for H also F3, folded) |

A change to the hottest shared constant sends back exactly the attempts whose code references it. A cosmetic change to the hottest shared file sends back nobody. An agent that reads a whole shared file widens its premise: an unrelated change to that file goes to triage (7.3 of 01-core) instead of passing silently. Rule 1 of the guide ("read each shared rule you use by name") keeps premises narrow.

### 7.8 The "same changes, merged by plain git" pool

Built by rule 11.7 from the same landings.

| Landing order | Landings replayed, in `seq` order | Operations used | Marked interrupted (PM4) |
| --- | --- | --- | --- |
| 1 | S, C, H, J | S: its `replace`. C and H: `ops_first`, that is the `write` each held before its first heads-up (the files of 7.3 with `30` and `5`). J: its landed `write`. | C and H, when they had not passed a submit before S landed (7.5 step 4). |
| 2 | C, H, S | C and H: their landed `write`. S: `ops_first`, that is its one `replace` on `world/energy.js`, without the two creature fixes it added during its go-around. | none: S had passed a submit. |

Both orders give the same tree: `ENERGY_MAX = 1`, `crab.energy < 30`, `drain(shrimp, 5)`. Every replay succeeds: `plain.updated.skipped` is empty, so the text-conflict count is 0.

What a person sees, side by side, same seed (observed over 3600 ticks; three crabs, three shrimp):

| | The pool (`main`) | "same changes, merged by plain git" (`plain`) |
| --- | --- | --- |
| Crabs | Walk along the sand. Hidden 1.7% of the time. Mean speed 0.98 units per tick. | Never come out of their shells. Hidden 100% of the time, from the first tick. Speed 0. |
| Shrimp | Dart every two seconds. Resting 5.6% of the time. | Dart once, turn grey, roll upside down and sink to the sand. They wake after five seconds, dart once, and collapse again. Resting 82% of the time. At any moment most of the three are grey on the sand. |
| Jellyfish and the seed creatures | Unchanged | Unchanged |
| In-page self-test (5.5) | pass | fail: `not_exhausted` for the shrimp (resting 82% of the time) |
| `stats.kinds.shrimp.resting` | 0 most of the time | 3 of 3 most of the time |

Why the numbers break: with `ENERGY_MAX = 1`, `crab.energy < 30` is always true, and `drain(shrimp, 5)` removes five full tanks in one call.

The crab is the case no test sees: the self-test passes it in both pools, because a creature that sits still is a healthy creature. Only the record of what the crab's author relied on says it is wrong. The platform record saw the same thing in the Dynamic Worker isolate: a crab written for the old scale passed every generic invariant (01-core HC3).

- **TP19.** The Floor labels the right-hand pool "same changes, merged by plain git" and "constructed", in neutral words (rule 13 of the brief). It shows no product name.
- **TP20.** If, in a live run, the real agents wrote code that does not depend on the old scale (7.10), the two pools hold the same files. The Floor then says that there is no visible difference in this run, and it says so only on the fact of PM7: `plain.updated.tree` equals `landing.landed.tree` of the landing `through_seq`. It never guesses from what the frames draw, and it never substitutes canned code into a live comparison. The sentence on screen is in `03-floor.md` section 5.

### 7.9 Why the ordinary checks accept it

| Check | What it compares | Result in both landing orders |
| --- | --- | --- |
| Text merge (three-way, per file) | Line ranges changed on both sides of one file | S changed lines 1 and 2 of `world/energy.js`. C and H added new files. No file is changed twice. Clean merge, nothing to report. |
| File-level check on writes (claims, leases, "a file I wrote has moved") | The sets of paths written | `{world/energy.js}`, `{creatures/crab.js}`, `{creatures/shrimp.js}`: disjoint. Accepts. |
| File-level check on reads ("a file I read has moved") | The paths each author read | Order 2: S never read `creatures/crab.js`; it did not exist. Accepts. Order 1: flags a creature only if its author happened to read `world/energy.js` as a file (H); accepts when the author read the entity by name (C) or never read the rule (variant 1c). It also flags every comment-only edit to that file. |
| Import index | Which names each file imports, and whether they resolve | `ENERGY_MAX` and `drain` are still exported from `world/energy.js`. Accepts. |
| Signature index | Name, kind and parameter count of each export | The outline line of `ENERGY_MAX` (7.1) is identical before and after. Accepts. |
| Parse, type of the value | Syntax; a number stays a number | Accepts. |
| The self-test (section 5) | Health of the running pool | Fails for the shrimp, after the merge. Passes the crab. |
| Premise | The hash of the entity each change references, and who references an entity a change alters | Order 1: E2 while the creature is in flight, whatever its agent read (D1 pinned the reference at the write); B1 at the submit when the rule changed before the creature was written. Order 2: QR1, with the breaking lines as `context`. In every case before the dependent change lands, with the diff, while its author still has its context. |

### 7.10 What must hold for real agents, and what happens when it does not

The canned run is deterministic. A real model writes its own crab. The rule-based catch needs one fact: **the creature's module references `ENERGY_MAX`** (HC2). TP16 and rule 3 of the guide make `energy: ENERGY_MAX` the documented way to give a creature energy.

| What the creature's agent wrote | What happens when the meaning changes | Rule-based |
| --- | --- | --- |
| `energy: ENERGY_MAX` in `spawn`, and a number in points (the seeded wording asks for one) | As 7.5 or 7.6. | yes |
| `energy: ENERGY_MAX`, and only relative amounts (`ENERGY_MAX * 0.3`) | E2 sends it around. The agent acknowledges and changes nothing. Counted as a false abort (14.4: `headsup.resolved.changed` is false). The two pools hold the same files (TP20). | yes |
| No `energy` in `spawn`, but it compares `creature.energy` with a number | The creature never had energy; the comparison is always false. Nothing depends on the scale. The creature does not do what was asked, in either pool. Not a conflict. | n/a |
| `energy: 100` written as a number, no reference to `ENERGY_MAX` anywhere in the module | No rule can decide (HC3). Order 1, if the agent read `ENERGY_MAX` or the file: triage (E3 or F4). The diff arrives at once in an `info` heads-up; then Clef decides, or, with Clef off, a `confirm`. Order 2, if the agent read it: row **QR4**, the mirror of E3. The triage goes to the shared-rule attempt, whose card cannot be approved while it is pending (observed; vector `C38`). If the agent read neither: nothing, in both orders. After both land, the self-test fails `energy_range`, and the green line reverts after its second failed run (GR3). | no; stated limit |

- **TP21.** The seeded intents of the hero (P1a, P1b) carry their numbers in the owner's words, so a model that follows the request writes a number in points.
- **TP22.** The seeded-intent measurement (`05-agent.md`; 01-core S5, MP2) reports, per model, the share of energy creatures whose module references `ENERGY_MAX`, the share that write an absolute number, and the share that repair it correctly after the heads-up. The live cast is chosen from those numbers. Its first run needs no engine: it runs the seven tools over an in-memory copy of `seeds/tidepool/`.

### 7.11 The conductor's script (rehearsals, and the `hero-canned` recording)

The conductor plays the hero conflict with the canned cast: S, C, H and J are scripted agents (`agent: "synthetic"`) with the pattern ids `hero-s`, `hero-c`, `hero-h` and `hero-j` (10.5). It starts them with `POST /api/swarm` and `patterns` (SWR2), and it holds and releases their submits with `hold_before_submit` and `release` (SWR3).

The pool. A second pool, created from seed `tidepool` with `summary_only: false` (PL1). Seed `tidepool` works in every build: without `features.held` the shared rule still waits, on the minimal card of HD1 with the options `land` and `decline`. Because it is not a summary-only pool, every event is emitted for the scripted attempts: premise lights, operations, heads-up diffs and the Why card (EV6). Because its attempts are synthetic, `pool.state.synthetic` is true and the page shows the SYNTHETIC banner (EM1a). The owner's browser opens it at `/p/{pool}` (13.6).

Landing order 1:

| # | The conductor does | Then waits for |
| --- | --- | --- |
| 1 | Starts `hero-j`, `hero-c` and `hero-h`, all three listed in `hold_before_submit`. | `op.recorded` for `creatures/crab.js` and for `creatures/shrimp.js`. |
| 2 | Starts `hero-s`. | `card.opened` of kind `held`. With `features.held`, its blast radius lists C and H under `repair`. |
| 3 | Opens the Compare view of that pool (4.8): live frames on `main` and `plain`, same seed. | Both frames report `stats`. |
| 4 | Taps Land on the card (the card route with option `land`). | `headsup.sent` with result `repair` for C and for H; `landing.landed` for S. |
| 5 | Releases `hero-c`, `hero-h` and `hero-j` (`release`). | `landing.landed` for C, H and J; then `plain.updated` with `through_seq` 4. |
| 6 | Sends `probe` with `selftest: true` to both frames. | `stats.selftest` from both. |

A held scripted agent makes every tool call of its script up to its first `submit`, then waits. It still answers a heads-up at once by applying its repair operation; only its `submit` waits for the release. The creature scripts are released after S has landed, not before: a creature that submits earlier lands in the next tick, and the run becomes order 2.

Landing order 2: the conductor starts `hero-s` with no hold and waits for its `submit.result` of status `held`. It starts `hero-c` and `hero-h` with no hold, and waits for their `landing.landed`, for `headsup.sent` (QR1) to S and for `card.closed` with action `stale`. It waits for the second held card and taps Land.

On a pool from seed `tidepool-auto` no card paces the run, because the shared rule is `auto` there. The conductor then holds `hero-s` instead: order 1 releases S while the creatures are still held, and order 2 holds S before its submit until the creatures have landed.

With real agents either order may occur, and both are handled.

Recordings (`03-floor.md` 8.2; `04-build-plan.md` SC7). The conductor's run is the recording `hero-canned`, with `synthetic: true` in its header. The recording `hero` is the video take's own session with real agents, exported after the take. The recording `rehearsal` is the earlier real-agent run.

Stated consequence of PM4 for order 1. The canned creature scripts hold their complete file before `submit`, so when S lands they have not passed a submit, and PM4 marks the landings of C and H as interrupted in `plain.updated`. The mark follows the rule and says nothing true about their work, which was complete. A run that must carry no such mark uses order 2, or creatures that wait on a card (race candidates), as the video does.

---

## 8. The second catch: a listing gains a match

### 8.1 The scenario

| Name | Intent text | Paths | Tier |
| --- | --- | --- | --- |
| A | "repaint every creature in gold" | every file in `creatures/` | auto |
| B | "a seahorse that bobs up and down" | `creatures/seahorse.js` | auto |

A's intent is about a set: every creature. A finds the set by listing the directory, then edits each member. B adds a member while A is at work. No file is written by both.

### 8.2 Canned operations

**A.** `list creatures/` (entries: `anemone.js`, `fish.js`, `minnow.js`, `snail.js`, `turtle.js`). Then for each file: `read` it, and `replace` each colour constant (TP18):

| File | Replace | With |
| --- | --- | --- |
| `anemone.js` | `const ARMS = "pink";` | `const ARMS = "gold";` |
| `anemone.js` | `const BASE = "purple";` | `const BASE = "#b8860b";` |
| `fish.js` | `const BODY = "orange";` | `const BODY = "gold";` |
| `fish.js` | `const FIN = "yellow";` | `const FIN = "#b8860b";` |
| `minnow.js` | `const BODY = "silver";` | `const BODY = "gold";` |
| `snail.js` | `const SHELL = "brown";` | `const SHELL = "gold";` |
| `snail.js` | `const BODY = "sand";` | `const BODY = "#b8860b";` |
| `turtle.js` | `const SHELL = "green";` | `const SHELL = "gold";` |
| `turtle.js` | `const SKIN = "teal";` | `const SKIN = "#b8860b";` |

**B.** `list creatures/`; `read GUIDE.md`; `read creatures/fish.js`; `read world/bounds.js`; then `write creatures/seahorse.js`:

```js
import { SURFACE_Y, FLOOR_Y } from "../world/bounds.js";

const BODY = "pink";

export function spawn() {
  return { bob: 0 };
}

export function update(seahorse, world) {
  seahorse.bob = Math.sin(world.tick / 30 + seahorse.id);
  seahorse.y += seahorse.bob * 0.5;
  if (seahorse.y < SURFACE_Y + 30) seahorse.y = SURFACE_Y + 30;
  if (seahorse.y > FLOOR_Y - 30) seahorse.y = FLOOR_Y - 30;
}

export function draw(seahorse, pen) {
  pen.fill(BODY);
  pen.ellipse(0, 0, 8, 16);
  pen.circle(4, -18, 8);
  pen.line(10, -18, 18, -16);
  pen.arc(-2, 18, 8, 0, Math.PI);
}
```

A's repair operations: `read creatures/seahorse.js`; `replace` `const BODY = "pink";` with `const BODY = "gold";`.

### 8.3 Landing order 1: the seahorse lands while the repaint is in flight

A has listed `creatures/` and has made its nine `replace` calls on the five seed files. It has not submitted (the canned script holds before `submit`). B submits.

| # | Event | Rule | What Trunk does |
| --- | --- | --- | --- |
| 1 | B submits. | CK7, CK8 | `validated` (tier `auto`). |
| 2 | The next tick accepts B as landing 1. | 9.4 | |
| 3 | A's `listing:creatures/` premise: the entry names gained `seahorse.js`, which A was not shown, and A is **sweeping** the directory: it has current operations on five existing files directly in `creatures/` (two are enough). | **L1** | `repair`, reason `sweep_incomplete`. A: `working` → `going_around`, go-around 1. `ops_first` for A is written: the nine `replace` operations it holds. |
| 3a | A alters `BODY` and `FIN` of `creatures/fish.js`, and B, which has just landed, had read that file as an example without referencing it. | **QR4** (triage; the mirror of E3) | Two more items in the same heads-up, for `refs:creatures/fish.js#BODY` and `refs:creatures/fish.js#FIN`. In the canned cast they are answered `holds` inside the transaction, because `creatures/fish.js` is not in B's truth list (TR8). With real agents they are pending until Clef answers, or `confirm` with Clef off (TR5). The heads-up's result is `repair` in every case, because of L1. |
| 4 | A receives the heads-up, reads `creatures/seahorse.js`, repaints it, and submits with `acknowledge: [1]` and the statement "A seahorse arrived during the repaint. Painted it gold too." | CK1, CK8 | `validated` once no triage is pending. No blind spot: the entities A altered are constants that reference nothing. |
| 5 | The next tick accepts A as landing 2, with ten operations. | 9.4 | Every creature is gold, the seahorse included. |

Observed: steps 1 to 5, with the two QR4 questions answered `holds`.

What A's agent receives (the L1 item; the same fields are left out as in 7.5):

```json
{
  "hn": 1,
  "result": "repair",
  "cause": { "type": "landing", "seqs": [1],
             "changes": [{ "seq": 1, "change_id": "c_<B>", "intent_text": "a seahorse that bobs up and down" }] },
  "items": [{
    "premise": { "kind": "listing", "key": "creatures/" },
    "rule": "L1",
    "result": "repair",
    "reason": "sweep_incomplete",
    "cause_seq": 1,
    "diff": { "kind": "listing", "added": ["seahorse.js"], "removed": [] },
    "uses": []
  }],
  "dropped_ops": [],
  "go_around": 1
}
```

The window before the sweep (observed in two positions; vector `C41`). L1 applies only while A is sweeping: A needs operations on at least two existing creature files (01-core 7.2). If B lands earlier, after A's `list` and before A has edited two files, rule L3 classifies the change as `holds` at the landing, with no heads-up, and the names A was shown stay the five it listed. The catch then comes from A's side. At the operation that makes A a sweep, its first `replace` on a second file, the late L1 check fires: the operation is recorded, and the same `repair` heads-up, with `added: ["seahorse.js"]`, travels in that tool response. So the seahorse is caught wherever B lands, and the conductor needs no ordering trick. (The earlier revision stated a gap here and asked `01-core.md` to close it. The late check closes it.)

### 8.4 Landing order 2: the repaint lands while the seahorse is in flight

This order is not a conflict. It is the same as the owner asking for the repaint and, a minute later, asking for a seahorse: the repaint was true of every creature when it landed. Premise does not force B to be gold.

B is still told, because B read `creatures/fish.js` as an example and A changed it (observed):

| B's state when A lands | Rule on `file:creatures/fish.js` | B receives |
| --- | --- | --- |
| Has read, has written nothing | **X0** (`no_patch_yet`) | An `info` heads-up with the diff of `fish.js` and A's intent text. No go-around. |
| Has written `seahorse.js` | **F4**, triage | At the landing: an `info` heads-up with the diff, its item marked pending (TR1). Then Clef's answer (7.3 of 01-core). With Clef off, one `confirm` with the diff, decided in the same transaction (TR5). In the canned cast: `holds`, an info-level item (TR8). |

A standing rule ("creatures are always gold") is a different intent. It belongs in shared code, for example a palette in `world/`, and would be a held change.

### 8.5 The "same changes, merged by plain git" pool

Landing order 1 replayed by rule 11.7: B's `write`, then A's `ops_first`, the nine repaints of the five seed files. The plain-merge pool shows every seed creature gold, and three pink seahorses. No text conflict is counted.

- **TP23.** `ops_first` is what an attempt held when its first heads-up of result `confirm` or `repair` arrived (PM2). It equals "what the attempt would have landed" only if the attempt had finished its work by then. Trunk cannot know that. It records whether the attempt had passed a submit before that moment, and PM4 marks a landing replayed from an `ops_first` with `submitted = 0` as **interrupted** in `plain.updated`. The Floor labels such a landing (`03-floor.md` 3.6). A change that was waiting on a card, a held change or a race candidate, had passed a submit and is not marked. A canned script that holds its complete work before `submit` is marked, as in 7.5 and in step 3 above: the mark follows the rule, not the work (7.11).

| | The pool (`main`) | "same changes, merged by plain git" (`plain`) |
| --- | --- | --- |
| What a person sees | Every creature is gold. | Every creature is gold except the three seahorses, which are pink. |
| In-page self-test | pass | pass |

Why the ordinary checks accept it: B added a new file and A edited other files (text merge: clean; file-level check: disjoint); every import resolves and no signature changed (import index: accepts); the pool is healthy (self-test: passes, observed for both trees). The only thing that knows A's work was about a set, and that the set grew, is the listing premise.

### 8.6 The same catch through a search

Seeded pair P3 (section 9) is the search form. A's intent is "make every creature that swims out one side and back in the other turn around at the walls instead". A runs `search` for `wrap(` in `creatures/` (one container in the seed: `creatures/fish.js#update`) and replaces `wrap(fish);` with `bounce(fish);` and the import. B adds `creatures/ray.js`, whose `update` calls `wrap(ray)`.

| When B lands | Rule on A's premise `text:creatures/:wrap(` | A receives |
| --- | --- | --- |
| After A altered `creatures/fish.js#update` | **QT1**, `repair`, `sweep_incomplete` | `added: ["creatures/ray.js#update"]` with its source. A changes the ray too, without a read. |
| After A's search, before A's first edit | **X0**, `holds` | An `info` heads-up with the same `added`. No go-around. |

Both rows observed. QT1 needs A to have altered the matches it found: with one pinned container, that one; with more, at least two (01-core 7.2). The sweep of the video is this catch on a held change (9.5).

Plain-merge pool: the fish turns around at the walls; the ray still leaves on one side and comes back on the other.

---

## 9. Seeded intents

Thirty-six intents in the owner's words. "Reads" and "writes" are what a correct attempt is expected to touch; tests of the agent loop compare against them. In every row the attempt also reads `GUIDE.md`. `bounds#FLOOR_Y` means the entity `world/bounds.js#FLOOR_Y`.

Difficulty for a weak model: **E** = one small file or one line, copy the nearest example; **M** = needs two or more shared rules, or a little state; **H** = several files, or reasoning about a unit.

Every row is also a pre-written request of the Floor. `/floor.json` lists them as `{ id, text, group, race }` (`03-floor.md` 4.5), in the order of the tables below: `id` and `text` are the row's id and intent text; `group` is the row's group, `"starter"` or `null`; `race` is `true` for P1a only, the request the video sends to three models. The group `starter` is the starter set that the Floor sends with one tap (`03-floor.md` CO7): A01, A03, A04, A06, A11 and P1b. The seeded-intent measurement runs these same rows (`05-agent.md`).

### 9.1 Additive creatures (tier `auto`, one new file each)

| Id | Intent | Group | Reads | Writes | Difficulty and note |
| --- | --- | --- | --- | --- | --- |
| A01 | "a jellyfish that drifts up and down" | `starter` | `bounds#SURFACE_Y`, `#FLOOR_Y` | `creatures/jellyfish.js` | E. About 20 lines. No energy. The bystander of section 7. |
| A02 | "a seahorse that bobs up and down" | | `bounds#SURFACE_Y`, `#FLOOR_Y`; `creatures/fish.js` as an example | `creatures/seahorse.js` | E. Uses `Math.sin` and `world.tick`. Attempt B of section 8. |
| A03 | "a starfish that sits on the sand and slowly turns" | `starter` | `bounds#FLOOR_Y` | `creatures/starfish.js` | E. Needs `pen.turn` and one `poly`. |
| A04 | "a sea urchin on the sand that waves its spines" | `starter` | `bounds#FLOOR_Y`; `creatures/anemone.js` as an example | `creatures/urchin.js` | E. Copy the anemone's loop of lines. |
| A05 | "a manta ray that glides in wide slow circles" | | `movement#step`, `bounds#keepInside` | `creatures/manta.js` | M. Must turn `age` into a direction with `Math.cos` and `Math.sin`. |
| A06 | "an octopus that is dark at night and bright in the day" | `starter` | `time#isNight`, `movement#wander`, `#step`, `bounds#bounce` | `creatures/octopus.js` | E. One `if` in `draw`. |
| A07 | "an anglerfish whose light only shows at night" | | `time#isNight`, `movement#step`, `bounds#bounce` | `creatures/anglerfish.js` | M. Two looks; must keep the light inside 60 units. |
| A08 | "a school of eight tiny blue fish that stay together" | | `creatures/minnow.js` as an example; `energy#ENERGY_MAX`, `movement#steer`, `#wander`, `#glide`, `#step`, `bounds#bounce` | `creatures/sardine.js` | M. Must export `count = 8` and change the kind name in the leader lookup. |
| A09 | "an eel that goes straight for the nearest food" | | `energy#ENERGY_MAX`, `food#nearestFood`, `movement#steer`, `#glide`, `#step`, `bounds#keepInside` | `creatures/eel.js` | M. Must opt in to energy and handle "no food" (`null`). No energy number needed. |
| A10 | "a pufferfish that puffs up when another creature comes close" | | `movement#distance`, `#wander`, `#step`, `bounds#bounce` | `creatures/pufferfish.js` | M. Loops over `world.creatures`; must skip itself. |
| A11 | "a lobster that walks along the sand and turns around at the walls" | `starter` | `creatures/snail.js` as an example; `bounds#FLOOR_Y`, `#bounce`, `movement#step` | `creatures/lobster.js` | E. The snail with another drawing. |
| A12 | "a little cleaner fish that follows the turtle around" | | `movement#steer`, `#glide`, `#step`, `bounds#keepInside`; `list creatures/` | `creatures/cleaner.js` | M. Finds a creature whose `kind` is `"turtle"`. The string names a listing entry. Rule L2 gives a `confirm` only when that entry itself is gained or lost while the attempt is in flight (`turtle.js` is removed). A landing that adds another creature is L3, with no heads-up (observed). |

### 9.2 Shared-rule changes (tier `held`)

No row of this table is in a group.

| Id | Intent | Reads | Writes | Difficulty and note |
| --- | --- | --- | --- | --- |
| R01 | "make energy a fraction from 0 to 1" | `world/energy.js` | `world/energy.js#ENERGY_MAX` (one `replace`) | E to edit. The meaning change of section 7. The agent must look at `relied_on_by`. When a creature with an absolute energy number has already landed (the starter shrimp, 9.5), a correct attempt also rewrites that number in the same change (guide rule 8); it then also writes that creature's `update`, and the difficulty is H. |
| R02 | "make the day twice as long" | `time#DAY_TICKS` | `world/time.js#DAY_TICKS`: `3600` → `7200` | E. |
| R03 | "let creatures swim half as fast again at top speed" | `movement#MAX_SPEED` | `world/movement.js#MAX_SPEED`: `3` → `4.5` | E. Must work out "half as fast again". |
| R04 | "lower the water line so there is more sky" | `bounds#SURFACE_Y` | `world/bounds.js#SURFACE_Y`: `40` → `120` | E. Scene, spawning and food follow because they reference the constant. |
| R05 | "drop food twice as often" | `food#FOOD_EVERY` | `world/food.js#FOOD_EVERY`: `30` → `15` | E. "Twice as often" means half the number. |
| R06 | "the side walls are solid now: nothing swims out one side and back in the other" | `world/bounds.js` | `world/bounds.js#wrap` (the body becomes `bounce(creature);`) | M. A meaning change of a function behind an unchanged name. `fish` relies on it. |
| R07 | "tired creatures should rest for half as long" | `energy#REST_TICKS` | `world/energy.js#REST_TICKS`: `300` → `150` | E. |
| R08 | "one pellet of food should fill half a creature's energy" | `food#FOOD_ENERGY`, `energy#ENERGY_MAX` | `world/food.js#FOOD_ENERGY`: `ENERGY_MAX / 4` → `ENERGY_MAX / 2` | E. Must keep the expression relative. |
| R09 | "make the night shorter: only the last third of the day is dark" | `world/time.js` | `world/time.js#isNight`: `>= 0.5` → `>= 2 / 3` | M. Must understand `dayPhase`. |
| R10 | "tidy the comments in the energy rules so they are easier to read" | `world/energy.js` | comments in `world/energy.js` only | E. Lands with no entity changed. Expected: no heads-up to anyone (7.7). |
| R11 | "resting creatures should float up to the surface instead of sinking" | `world/rules.js`, `bounds#SURFACE_Y` | `world/rules.js#tickWorld` and its import of `bounds.js` | H. Two entities in one file; a 20-line function. |
| R12 | "make the sand darker and the water greener" | `world/scene.js` | `world/scene.js#drawScene` (colour strings) | E. |

### 9.3 Intents that exist only to collide

| Id | Intent | Group | Reads | Writes | Difficulty and note |
| --- | --- | --- | --- | --- | --- |
| P1a | "a crab that hides in its shell when its energy drops below 30" | | `energy#ENERGY_MAX`, `bounds#FLOOR_Y`, `#bounce`, `movement#step` | `creatures/crab.js` | M to write. H to repair: after the heads-up the model must connect `30` to the changed unit. Attempt C of section 7. The crab race of the video (`race: true`). |
| P1b | "a shrimp that darts every two seconds and spends 5 energy on each dart" | `starter` | `energy#ENERGY_MAX`, `#drain`, `time#seconds`, `movement#wander`, `#glide`, `#step`, `bounds#bounce` | `creatures/shrimp.js` | M to write. M to repair: the number sits in a call to `drain`. Attempt H of section 7. In the starter set it is the creature on `main` that calls `drain(` before the sweep P9a starts (9.5). |
| P2a | "repaint every creature in gold" | | `list creatures/`; every creature file | colour constants in every creature file | H. Five reads and nine `replace` calls in the seed. Fits `max_paths` while the pool has at most 64 creature files. Attempt A of section 8. |
| P3a | "make every creature that swims out one side and back in the other turn around at the walls instead" | | `search` for `wrap(` in `creatures/`; each file found; `bounds#bounce` | each `update` that calls `wrap`, and its import | M. One file in the seed. |
| P3b | "a ray that glides across the pool and comes back in on the other side" | | `bounds#wrap`, `movement#step` | `creatures/ray.js` | E. |
| P4b | "make the day half as long" | | `time#DAY_TICKS` | `world/time.js#DAY_TICKS`: `3600` → `1800` | E to write. After a go-around it must halve the new value, or stop: the two intents contradict. Tier `held`. |
| P4c | "make the day three times as long" | | `time#DAY_TICKS` | `world/time.js#DAY_TICKS`: the value it reads, times 3 (`3600` → `10800` on the seed) | E. Tier `held`. The third intent of pair P4: its landing is the second change of `DAY_TICKS` under P4b, which opens the contradiction card (GL3). |
| P5b | "a crab that walks sideways and waves one big claw" | | `bounds#FLOOR_Y`, `#bounce`, `movement#step` | `creatures/crab.js` | E to write. M after the go-around: it must choose another file name or build on the crab that landed. |
| P6b | "a lily pad that floats on the water line" | | `bounds#SURFACE_Y` | `creatures/lily.js` | E. With R04 it is sent around and has nothing to change. |
| P8b | "a sailfish that always swims at top speed" | | `movement#MAX_SPEED`, `#step`, `bounds#wrap` | `creatures/sailfish.js` | E. With R03 it is sent around and has nothing to change if it used the constant. |
| P9a | "write every energy cost in percent of a full tank: change the drain rule so that 5 means five percent, and update every creature that drains energy" | | `energy#ENERGY_MAX`, `#LIVING_COST`, `#drain`, `#liveOneTick`; `search` for `drain(` in `creatures/`; each file found | `world/energy.js#drain` and `#liveOneTick`; each `update` that calls `drain` | H. Tier `held`. Three `replace` calls in two files when one creature calls `drain`. It is meant for a pool where energy is already a fraction (after R01); with energy in points a cost of 5 is already 5 percent. The sweep of the video (9.5). |
| P9b | "a squid that shoots forward every three seconds and spends a tenth of its energy on each burst" | | `energy#ENERGY_MAX`, `#drain`, `time#seconds`, `movement#wander`, `#glide`, `#step`, `bounds#bounce` | `creatures/squid.js` | M to write. M to repair: the number sits in a call to `drain`. The late creature of the video (9.5). |

### 9.4 The pairs

Every rule named in this table was observed in the simulator with the seed of 2.1 (pair P9 on the state of 9.5, after R01). "Order 1" is the row's first intent landing while the second is in flight; "order 2" is the reverse.

| Pair | Intents | The key they share | Order 1 | Order 2 | In the plain-merge pool | Self-test sees it |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | R01 with P1a and P1b | `entity:world/energy.js#ENERGY_MAX` | E2 to the creature, whatever its agent read: by entity, as a whole file (the file judgment is folded), or not at all (D1 pinned the reference at the write). B1 only when R01 landed before the creature was written and its agent never read the rule. | QR1 to R01, with the creatures' `update` functions as `context` | Crabs never leave their shells; shrimp collapse | shrimp only |
| P2 | P2a with A02 | `listing:creatures/` | no conflict (8.4): X0 or F4 on the example file | L1 to P2a: at the landing when P2a is already sweeping, else at the operation that makes it a sweep | One kind is not gold | no |
| P3 | P3a with P3b | `text:creatures/:wrap(` | no conflict | QT1 to P3a (X0 before its first edit) | The ray still crosses the walls | no |
| P4 | R02 with P4b; P4c for the choice card | `entity:world/time.js#DAY_TICKS` | E1 with OP1 (its `replace` no longer matches) to P4b. The same heads-up carries a QR1m `confirm` item. | the same to R02 | Text conflict: the later change is skipped and counted (PM3) | n/a |
| P5 | P1a with P5b | `file:creatures/crab.js` (both pinned at `absent`) | F1 with OP5 to P5b; the second candidate is skipped as `not_disjoint` | the same to P1a | Text conflict (PM3): the later `write` has a base that moved, so it is skipped and counted. The plain-merge pool keeps the first crab. | n/a |
| P6 | R04 with P6b | `entity:world/bounds.js#SURFACE_Y` | E2 to P6b; it acknowledges without an edit | QR1 to R04 | No visible break | no. The designed false-abort probe (14.4). |
| P7 | R06 with P3b | `entity:world/bounds.js#wrap` | E2 to P3b: the function it calls no longer does what it relies on | QR1 to R06 | The ray turns around instead of coming back | no |
| P8 | R03 with P8b | `entity:world/movement.js#MAX_SPEED` | E2 to P8b; nothing to change | QR1 to R03 | No visible break | no. A second false-abort probe. |
| P9 | P9a with P9b | `text:creatures/:drain(` and `refs:world/energy.js#drain` | E2 on `entity:world/energy.js#drain` to P9b: it rewrites its number | QT1 and QR1 to P9a, in one heads-up (X0 `info` when P9b lands before P9a's first edit) | The squid's cost is not rewritten: `drain(squid, 0.1)` takes a tenth of a percent, so it never tires. No visible break. | no |

P4 and P5 are the cases a text merge does report. P4 is in the list so that the plain-merge pool's text-conflict counter is not always zero, and so that the choice card has a seeded case. With two intents only GL4 can open that card, and GL4 needs Clef. The rule-based card (GL3) needs a second E1 on the same entity from another intent, so the pair has a third intent (observed): R02 lands (first E1 to P4b), P4b adapts and waits on its card again, P4c lands (second E1), and P4b stops with `contradiction` on a choice card that names P4b and P4c. Vector `C17` is this case on the vector pool. P5 is in the list because two people asking for "a crab" is the most likely accident in a live session.

### 9.5 The requests of the submission video

`03-floor.md` 1.2 fixes five request roles. These rows fill them:

| Role (`03-floor.md` 1.2) | Rows | How it is sent | Why it waits or lands |
| --- | --- | --- | --- |
| Starter set | group `starter`: A01, A03, A04, A06, A11, P1b | pre-written, one tap | Tier `auto`: each lands by itself. |
| Crab race | P1a | typed word for word, then "Race 3" | The candidates wait on the race card (RC2). The number 30 in the text is what makes the catch visible (TP21). The catch needs each candidate's module to reference `ENERGY_MAX`, which `energy: ENERGY_MAX` in `spawn` does (TP16). |
| Shared rule | R01 | typed | Tier `held`: one tap. |
| Sweep | P9a | pre-written | Tier `held`: one tap. |
| Late creature | P9b | pre-written | Tier `auto`: lands by itself. |

Canned operations of the sweep and the late creature (real agents write their own).

**P9a.** `read GUIDE.md`; `read` the entities `world/energy.js#ENERGY_MAX`, `#LIVING_COST`, `#drain`, `#liveOneTick`; `search` for `drain(` in `creatures/` (one container after beat 1: `creatures/shrimp.js#update`); then three `replace` calls:

- on `world/energy.js`, `old`: `` // Take energy away. `amount` is in the same unit as ENERGY_MAX.\nexport function drain(creature, amount) {\n  creature.energy = Math.max(0, creature.energy - amount);\n} ``, `new`: `` // Take energy away. `percent` is a share of a full tank in percent: 5 takes five percent of ENERGY_MAX.\nexport function drain(creature, percent) {\n  creature.energy = Math.max(0, creature.energy - (percent / 100) * ENERGY_MAX);\n} ``;
- on `world/energy.js`, `old`: `  drain(creature, LIVING_COST);`, `new`: `  drain(creature, (LIVING_COST / ENERGY_MAX) * 100);`;
- on `creatures/shrimp.js`, `old`: `drain(shrimp, 0.05)`, `new`: `drain(shrimp, 5)`.

Then `submit` with summary "Write energy costs in percent". Repair operation when a creature that calls `drain` arrives: `replace` its number by 100 times the number, for the squid `drain(squid, 0.1)` to `drain(squid, 10)`. The agent reads `ENERGY_MAX` before it writes the new `drain`, which references it; without that read its first submit would get a blind-spot `confirm` (B1; observed).

**P9b.** `list creatures/`; `read GUIDE.md`; `read` the entities `world/energy.js#ENERGY_MAX`, `#drain`, `world/bounds.js#bounce`, `world/time.js#seconds`, `world/movement.js#step`, `#wander`, `#glide`; then `write creatures/squid.js`:

```js
import { ENERGY_MAX, drain } from "../world/energy.js";
import { bounce } from "../world/bounds.js";
import { seconds } from "../world/time.js";
import { step, wander, glide } from "../world/movement.js";

const BODY = "purple";

export function spawn() {
  return { energy: ENERGY_MAX };
}

export function update(squid) {
  if (squid.age % seconds(3) === 0) {
    wander(squid, 3);
    drain(squid, 0.1);
  }
  glide(squid, 0.97);
  step(squid);
  bounce(squid);
}

export function draw(squid, pen) {
  if (squid.vx < 0) pen.flip();
  pen.fill(BODY);
  pen.ellipse(4, 0, 12, 8);
  pen.line(-8, -4, -22, -8);
  pen.line(-8, 0, -24, 0);
  pen.line(-8, 4, -22, 8);
}
```

The run, beat by beat. Observed in the simulator with canned operations, on the seed of 2.1, with the jellyfish and the shrimp standing for the starter set and one crab attempt standing for the three race candidates (the simulator has no Race).

| Beat | What happens | Rules | `main` afterwards |
| --- | --- | --- | --- |
| 1 | The starter set lands. Energy is in points; the shrimp has `drain(shrimp, 5)`. The crab candidates write `crab.energy < 30` and wait on the race card with their premises live. | L3; D1, RC2 | the seed plus six creatures |
| 2 and 3 | R01 replaces `ENERGY_MAX`. `relied_on_by` lists the shrimp's import and `spawn` next to the seed referrers (16 in all). The shrimp has already landed, so for it this is order 2b of 7.6: no heads-up is due, and the agent must rewrite `drain(shrimp, 5)` to `drain(shrimp, 0.05)` itself, in the same change (guide rule 8). The held card's blast radius lists the crab candidates under `repair`. The owner taps Land. Each candidate gets E2 with the diff, rewrites `30` to `0.3`, and returns to the race card. | D2; T4, 11.6; E2, T8; RC5 | `ENERGY_MAX = 1`, `drain(shrimp, 0.05)` |
| 4 | The owner chooses a crab. It lands. The plain-merge pool replays its first version, with `< 30`: the crab never comes out. The candidates had passed a submit, so nothing is marked interrupted. | RC4, RC7; PM1, PM2 | plus the crab with `< 0.3` |
| 5 | P9a searches for `drain(`, changes `drain`, `liveOneTick` and the shrimp's call, and waits on its held card (blast radius empty). P9b lands by itself. In that transaction P9a gets one heads-up of result `repair` with two items: QT1 on `text:creatures/:drain(` (the search gained `creatures/squid.js#update`, and the sweep had altered the one earlier match) and QR1 on `refs:world/energy.js#drain` (the squid's import and `update` are new referrers of the entity the sweep alters). The card closes as `stale`; a tap on it does nothing. P9a rewrites the squid's number from the item's source, with no read, and submits with the acknowledgement. A new card opens. The owner taps Land. | QT1, QR1, HU2, T8; R1, CK1; T4, T13 | `drain` takes percent; `drain(shrimp, 5)`; `drain(squid, 10)` |

Two lights of the sweep turn red in beat 5: the search, and the list of code that uses `drain`. Both items are in the same heads-up.

Trees of this run through the self-test (observed; seed 7, 3600 ticks): `main` after beat 5 passes, with the squid resting 10.0% and the shrimp 5.6% of the time. The plain-merge tree of the run (`ENERGY_MAX = 1`, the crab's first version, `drain` in percent, `drain(squid, 0.1)`) also passes: the crab is hidden on every tick, and the squid never rests.

What must hold for real agents, and what happens when it does not:

- **TP24 (a landed number).** Putting P1b in the starter set puts an absolute energy number on `main` before R01 is asked for. For the shrimp, R01 is then order 2b: no rule fires, and only the agent's own sweep of `relied_on_by` rewrites the number. If it does not, `main` after beat 3 has `ENERGY_MAX = 1` and `drain(shrimp, 5)`: the shrimp collapses in the real pool, the self-test fails `not_exhausted` for it (observed: resting 82%), and with the green line in the build R01 is reverted after the second failed run. The held card's after frame shows the collapse before the tap. The seeded-intent measurement therefore also runs R01 on a pool where P1b has landed, and reports per model the share of runs that rewrite the shrimp's number in the same change.
- **Undo after the sweep.** In beat 7 the owner undoes R01. Before beat 5 the plan is: reverted R01 and the crab; reopened the crab (observed). After beat 5 the sweep and the squid are dependents of R01 as well, because each touches a module that references `ENERGY_MAX` (UN2): reverted R01, the crab, the squid and the sweep; reopened three attempts (observed). The count that the undo sheet shows follows from which beats ran before it.
- Without Race, or without the held card, `03-floor.md` 1.4 says how the beats change. Under seed `tidepool-auto` the sweep is `auto` and lands by itself; the catch of beat 5 then depends on the late creature landing first.

---

## 10. Scripted agents for the Swarm

A scripted agent is a small state machine that calls the same seven Trunk tools as a real agent (01-core section 4), with `agent_kind: "synthetic"`. It has no model. Everything it shows is under the SYNTHETIC banner: opening the first synthetic attempt in a pool sets `pool.state.synthetic` for good (EM1a).

Scripted agents are started by the Swarm launcher through `POST /api/swarm` (SWR1 to SWR4): a run takes its `SwarmConfig` (10.1) and draws patterns by the dial (10.4); a canned cast names its patterns one by one (10.5).

### 10.1 The Swarm pool

- Seed `tidepool-swarm`: the tree of 2.1, the policy variant of section 6, and four pre-made scripted creatures `creatures/s0000.js` to `s0003.js` (template T-plain below, colours `teal`, `red`, `blue`, `green`, speeds 1, 1.5, 2, 2.5).
- The Swarm pool and the soak pools are created with `summary_only: true` (PL1). Their streams leave out `attempt.step`, `premise.recorded`, `premise.removed`, `op.recorded` and the `holds` judgments that have no heads-up; `headsup.sent.items` and `landing.landed.note_json` are `null` (EV6). The flag is about the stream, not about who the agents are. A canned cast on a pool that is not `summary_only` emits every event (7.11).
- **SW1.** A Swarm run is fully determined by its `SwarmConfig`. Agent *n* (0, 1, 2, ...) draws all its choices from `mulberry32(H32(seed + ":" + n))`, where `H32` is the first 8 hex digits of `H()` read as an integer.

```ts
type SwarmConfig = {
  seed: number;
  agents: number;                 // how many to launch in total
  launch_per_second: number;
  collision_dial: number;         // 0 to 1 (10.4)
  think_ms: [number, number];     // wait between two tool calls of one agent, uniform; default [50, 400]
  rescale_every_s: number;        // 0 = never; default 15 (10.4)
  hold_before_submit?: string[];  // pattern ids whose agents wait before `submit` until a request releases them (SWR3, 7.11)
};
```

The request that carries it is `SwarmRequest` (`01-core.md` 13.6): the config plus `pool`, `running`, `patterns`, `release` and `request_id`.

- **SW4 (the same protocol as a real agent).** A scripted agent is opened with its truth list (10.3; TR8). It makes the same Agent-only calls as a real Agent: `sync`, `register` after a rebuild (with `truth`), and `stop` to end its own attempt (TA9). It answers `resume` like a real one (RS5): it calls `sync` and answers the waiting heads-ups by its pattern.
- **SW5 (triage is scripted).** No premise of a scripted agent is sent to Clef. A triage row (E3, F4, F6, QT2, QR4) is answered inside the transaction by `ScriptedTriage` from the truth list: `repair` when the premise is in the list, otherwise `holds`, delivered as an info-level item with the diff (TR5, TR8). For QR4 the list of the landed change decides. Swarm numbers therefore measure the protocol, not Clef.
- **SW6 (default answers).** A scripted agent answers every heads-up, after one `think_ms` wait. Where its row in 10.3 names the rule, it does what the row says. For any other item it uses these defaults. `info`: nothing. `confirm` (for example E2m, F3m, QR1m, L2, Z1): acknowledge with the statement "not affected" and no edit. `repair` with no dropped operation: acknowledge with no edit. `repair` with a dropped operation: apply its own edit again on the current source, then acknowledge. If that edit cannot be applied (`no_match`, `ambiguous`), or any call answers `limit_reached`, the agent ends its attempt with `stop` and the reason `withdrawn` (TA9a).
- **SW7 (a sweep gives up).** `sweep-colour` and `sweep-search` answer their first `repair`. At their second `repair`, the heads-up that starts go-around 2, or on `limit_reached`, they call `stop` with `withdrawn`. Right of way is granted at that second go-around (RW1) and ends when the attempt stops, so a scripted sweep holds it for one `think_ms` at most and cannot keep creature-adding landings waiting for `RIGHT_OF_WAY_MS`.
- **SW8 (holding).** An agent of a pattern listed in `hold_before_submit` makes every tool call of its script up to its first `submit`, then waits. It still answers a heads-up at once with its edits. Its `submit` is sent when a request with `release` names its pattern (SWR3).

### 10.2 Creature templates

`{colour}`, `{speed}` and `{threshold}` are filled in by the script.

T-plain (file `creatures/s<number>.js`, number zero-padded to at least 4 digits):

```js
import { bounce } from "../world/bounds.js";
import { step, wander } from "../world/movement.js";

const BODY = "{colour}";
const SPEED = {speed};

export function spawn() {
  return { vx: SPEED, vy: SPEED / 2 };
}

export function update(creature) {
  wander(creature, 0.05);
  step(creature);
  bounce(creature);
}

export function draw(creature, pen) {
  pen.fill(BODY);
  pen.circle(0, 0, 9);
}
```

T-energy (the same file name scheme):

```js
import { ENERGY_MAX } from "../world/energy.js";
import { bounce } from "../world/bounds.js";
import { step } from "../world/movement.js";

const BODY = "{colour}";

export function spawn() {
  return { vx: 1, vy: 0.5, energy: ENERGY_MAX };
}

export function update(creature) {
  if (creature.energy < {threshold}) return;
  step(creature);
  bounce(creature);
}

export function draw(creature, pen) {
  pen.fill(BODY);
  pen.rect(-9, -9, 18, 18, 4);
}
```

T-relative is T-energy with `{threshold}` replaced by the text `ENERGY_MAX * 0.3`.

All three pass the self-test in the seed (observed).

### 10.3 Canned edit patterns

The **truth list** of a pattern is the list of premises its change truly depends on, as `<kind>:<key>` strings (TR8). It is sent to Trunk when the attempt is opened. Scripted triage answers from it (SW5), and the soak script uses it for the truth-label rate (10.4). In the table, `bounce`, `step`, `wander` and `ENERGY_MAX` stand for `entity:world/bounds.js#bounce`, `entity:world/movement.js#step`, `entity:world/movement.js#wander` and `entity:world/energy.js#ENERGY_MAX`.

| Pattern | Tool calls, in order | Truth list | What it does when a heads-up arrives |
| --- | --- | --- | --- |
| `add-plain` | `list creatures/`; `read GUIDE.md`; `read` entities `bounds#bounce`, `movement#step`, `movement#wander`; `write` T-plain to a fresh name; `submit` | `bounce`, `step`, `wander` | `repair` (E2) on one of them: `read` it again, acknowledge "still valid". |
| `add-energy` | `list creatures/`; `read GUIDE.md`; `read` entities `bounds#bounce`, `movement#step`, `energy#ENERGY_MAX`; parse the value *V* of `ENERGY_MAX` from its source; `write` T-energy with threshold `0.3 × V` (the text `30` or `0.3`); `submit` | `ENERGY_MAX`, `bounce`, `step` | `repair` (E2) on `ENERGY_MAX`, after its write: parse the new *V* from `after`; `replace` the old threshold text with `0.3 × V`; acknowledge "rescaled the threshold". `info` (X0) on `ENERGY_MAX`, before its write: parse *V* from `after` and write with that value. |
| `add-relative` | as `add-energy`, with T-relative | `bounce`, `step` (not `ENERGY_MAX`) | `repair` (E2) on `ENERGY_MAX`: acknowledge with no edit. This is the designed false abort. |
| `rescale-energy` | `read` entity `energy#ENERGY_MAX`; `replace` `ENERGY_MAX = 100` with `ENERGY_MAX = 1`, or the reverse, whichever applies; then, for each referrer that the `replace` result names in `relied_on_by` for `ENERGY_MAX` (`01-core.md` D2) and that is the `update` entity of a creature module: `read` it, and if it holds the T-energy line with a number, `replace` the number with `0.3 × new V`; `submit` | `ENERGY_MAX`, `query:refs:world/energy.js#ENERGY_MAX` | `repair` (QR1): for each module that gained a referrer, take its `update` entity from the item (`added` or `context`); if it holds the T-energy line with a number, `replace` the number with `0.3 × new V`; acknowledge. No read is needed. `repair` (E1, with OP1): another rescale landed first; `stop` with `withdrawn`. |
| `retune` | pick one of `movement#MAX_SPEED` (3, 3.5, 4), `food#FOOD_EVERY` (30, 20, 40), `energy#REST_TICKS` (300, 240, 360), `time#DAY_TICKS` (3600, 2400, 4800); `read` the entity; `replace` its current value with the next in the cycle; `submit` | that entity, as `entity:<path>#<name>` | `repair` (E1, with OP1): `read` it again; `replace` from the new current value; acknowledge. |
| `edit-creature` | pick one of `s0000` to `s0003`; `read` entity `#SPEED`; `replace` `const SPEED = <a>;` with the next of (1, 1.5, 2, 2.5); `submit` | `entity:creatures/s000<k>.js#SPEED` | as `retune`. |
| `sweep-colour` | `list creatures/`; take the first four kinds in name order; for each: `read` the file, `replace` its first colour constant with the next palette name; `submit` | `listing:creatures/` | First `repair` (L1): for each added file, the same edit; acknowledge. Second `repair`, or `limit_reached`: `stop` with `withdrawn` (SW7). |
| `sweep-search` | `search` for `wander(creature, 0.05)` in `creatures/`; for the first three containers: `read`, `replace` with `wander(creature, 0.1)`; `submit` | `query:text:creatures/:wander(creature, 0.05)` | First `repair` (QT1): the same edit in each added container; acknowledge. Second `repair`, or `limit_reached`: `stop` with `withdrawn` (SW7). `info` (X0, a container gained before its own first edit): the same edit in the gained container too. |
| `same-file` | agents come in pairs; both `write` T-plain to the same fresh name `creatures/d<number>.js`; `submit` | `file:creatures/d<number>.js` | `repair` (F1, with OP5): `write` to the next free name; acknowledge. |
| `cosmetic` | `read world/energy.js`; `replace` one comment line with a reworded one from a fixed list; `submit` | empty | It must never cause a heads-up for an attempt of another pattern (E0, F2; observed). A run in which it does is a failed run. Two `cosmetic` attempts can meet on the same line: the later one's `replace` no longer matches (OP1), it receives a `repair` with that operation dropped, and it calls `stop` with `withdrawn`. |
| `reader` | `read` the whole file `world/energy.js`; then `add-plain` | `bounce`, `step`, `wander` | A change to `world/energy.js` gives it an `info` heads-up and nothing to acknowledge: X0 before its write; F4 after it, answered `holds` by scripted triage, because no entity of that file is in its truth list. It measures how often a wide read is hit. With real agents and no Clef each hit would cost one `confirm` turn. |
| `blind` | `read GUIDE.md`; `write` T-plain; `submit` | `bounce`, `step`, `wander` | `confirm` (B1) at submit: acknowledge. Measures the cost of blind spots. |

A T-energy creature that landed before the rescale's `replace` is not a premise break: it is already a referrer when the rescale edits, so the `replace` result names it in `relied_on_by` (D2), and repairing it is part of the rescale's own change. No heads-up is involved, and the oracle SW2 holds for it. (Added on 2026-10-04: the interleaving tests showed that the earlier wording, which repaired only referrers gained after the `replace`, left every earlier T-energy creature stranded.)

Deliberate premise breaks: who breaks whom.

| A landing by | breaks a premise of | Premise | Rule | A true dependency |
| --- | --- | --- | --- | --- |
| `rescale-energy` | `add-energy` in flight, after its write | `entity:…#ENERGY_MAX` | E2 | yes |
| `rescale-energy` | `add-energy` in flight, before its write | the same | X0 (`info`) | yes: it must use the new value |
| `rescale-energy` | `add-relative` in flight | the same | E2 | no: false abort |
| `rescale-energy` | `reader` in flight | `file:world/energy.js` | F4, scripted `holds` (X0 before its write) | no |
| `add-energy`, `add-relative` | `rescale-energy` in flight | `refs:…#ENERGY_MAX` | QR1 | yes for `add-energy` |
| `reader` | `rescale-energy` in flight | the same | QR4, scripted `holds` | no |
| `retune` of X | `retune` of X in flight | `entity:` X (edited) | E1 + OP1 | yes |
| `edit-creature` of K | `edit-creature` of K in flight | `entity:` K`#SPEED` | E1 + OP1 | yes |
| any `add-*`, `reader`, `blind`, `same-file` | `sweep-colour` that is already sweeping | `listing:creatures/` | L1 | yes |
| the same | `sweep-colour` that has listed and has edited fewer than two files | the same | L3 at the landing (no heads-up); L1 at the operation that makes it a sweep | yes |
| any landing that adds a T-plain file | `sweep-search` | `text:creatures/:wander(creature, 0.05)` | QT1, or X0 before its first edit | yes |
| `same-file` | its partner | `file:` at `absent` | F1 + OP5 | yes |
| `cosmetic` | no attempt of another pattern | | E0, F2 | |

Rule-based `confirm` items that come with core revision 2 (observed in the simulator on this seed). The default of SW6 answers each of them, and none is a true dependency:

| A landing by | gives a `confirm` to | Items |
| --- | --- | --- |
| `retune` of `energy#REST_TICKS` | `rescale-energy` in flight | E2m on `entity:world/energy.js#REST_TICKS` (a sibling entity of the module it edits references it) and QR1m on `refs:world/energy.js#ENERGY_MAX` (a module that holds a referrer changed) |
| `rescale-energy` | `cosmetic` in flight | E2m on `entity:world/energy.js#ENERGY_MAX`; the F3m judgment on the file is folded |
| `sweep-colour` that repaints `s000<k>.js` | `edit-creature` of that file in flight | E2m on its `#BODY` and QR1m on `refs:…#SPEED` |
| `edit-creature` of `s000<k>.js` | `sweep-colour` that holds an edit of that file | E2m on its `#SPEED` and QR1m on `refs:…#BODY` |
| `retune` of X | `retune` of X in flight | a QR1m item next to the E1 item, in the same heads-up |

A `confirm` that reaches an attempt before its submit costs one scripted answer and is not counted. One that reaches a `validated` attempt is a counted pull-back (GA3), and the Swarm view reports it as the confirm rate (14.3).

- **SW2 (oracle).** After a run, for every landed file made from T-energy, the threshold number divided by `ENERGY_MAX` at head MUST be 0.3. Each file that fails is one escape. This is checked from the final tree, independent of Trunk's own judgments. The expected count is 0 at every dial value. (The earlier revision counted a listing gain before a sweep's first edit as an escape. The late L1 check now catches it.)
- **SW3.** Scripted agents get no attempt repo (S3) and answer a heads-up after one `think_ms` wait. Their repair latency is never reported with real agents (14.7).

### 10.4 The collision dial

`collision_dial` is a number *d* from 0 to 1. For each launched agent, one draw *u* from its generator decides its class, and a second draw picks the pattern by weight.

| Class | Chosen when | Patterns and weights |
| --- | --- | --- |
| Independent | *u* ≥ *d* | `add-plain` 0.85, `reader` 0.10, `blind` 0.05 |
| Colliding | *u* < *d* | `add-energy` 0.35, `edit-creature` 0.20, `retune` 0.15, `add-relative` 0.10, `sweep-colour` 0.05, `sweep-search` 0.05, `same-file` 0.05, `cosmetic` 0.05 |

- `rescale-energy` is not drawn. One is launched every `rescale_every_s` seconds while *d* > 0. It is the meaning change that the colliding creatures are in flight against.
- At *d* = 0 every agent adds its own file and edits nothing else. The expected go-around rate is 0: the only shared key is `listing:creatures/`, which rule L3 holds. `blind` still takes one `confirm` turn each, which is not a go-around. A run at *d* = 0 with a non-zero go-around rate is a failed run.
- At *d* = 1 every agent is in the colliding class.
- The Floor shows *d* in `swarm.state.collision_dial`. Throughput and go-around rate are always reported together with the *d* they were measured at.

A measurement run reports, for each *d* in 0, 0.1, 0.25, 0.5 and 1, from the stream (the `metrics` events and the shared reducer, 14.1 to 14.6): landings per second, time to land p50 and p99, go-around rate, confirm rate, the false-abort rate of 14.4 (from `headsup.resolved.changed`, which exists in a `summary_only` pool), and changes waiting behind another change. It also reports the number of attempts that stopped with `withdrawn`.

Two numbers are not in the stream and not in `metrics`. The soak script computes them and publishes them in `SoakResult` (`04-build-plan.md` VE6; 01-core 14.4, 14.5):

- the **truth-label false-abort rate**: among `repair` results, the share on a key that is not in the attempt's truth list, or, for QR1 on `refs:…#ENERGY_MAX`, caused only by landings that are not `add-energy` (the column "A true dependency" above);
- the **escape count** of SW2, from the final tree.

### 10.5 Canned casts

A canned cast plays one scenario of this file with scripted agents, one pattern per attempt. The conductor starts it with `patterns` in the order it needs (SWR2). Each agent does the canned operations of its section, answers a heads-up with the repair operation given there, and otherwise follows SW4 to SW8.

| Pattern id | Attempt | Canned operations | Truth list |
| --- | --- | --- | --- |
| `hero-s` | S of 7.3 | 7.3. After its `replace` it also rewrites a canned old text (`crab.energy < 30`, `drain(shrimp, 5)`) in any landed creature file that `relied_on_by` names (order 2b of 7.6). On QR1 it applies the two repair operations of 7.3. | `entity:world/energy.js#ENERGY_MAX`, `query:refs:world/energy.js#ENERGY_MAX` |
| `hero-c` | C of 7.3 | 7.3 | `entity:world/energy.js#ENERGY_MAX`, `entity:world/bounds.js#FLOOR_Y`, `entity:world/bounds.js#bounce`, `entity:world/movement.js#step` |
| `hero-h` | H of 7.3 | 7.3 | `entity:world/energy.js#ENERGY_MAX`, `entity:world/energy.js#drain`, `entity:world/bounds.js#bounce`, `entity:world/time.js#seconds`, `entity:world/movement.js#step`, `entity:world/movement.js#wander`, `entity:world/movement.js#glide` |
| `hero-j` | J of 7.3 | 7.3 | `entity:world/bounds.js#SURFACE_Y`, `entity:world/bounds.js#FLOOR_Y` |
| `gold-a` | A of 8.2 | 8.2 | `listing:creatures/` |
| `gold-b` | B of 8.2 | 8.2 | `entity:world/bounds.js#SURFACE_Y`, `entity:world/bounds.js#FLOOR_Y` |
| `wrap-a` | A of 8.6 | 8.6 | `query:text:creatures/:wrap(`, `entity:world/bounds.js#bounce` |
| `wrap-b` | B of 8.6 | 8.6 (the ray) | `entity:world/bounds.js#wrap`, `entity:world/movement.js#step` |
| `sweep-a` | P9a of 9.5 | 9.5 | `query:text:creatures/:drain(`, `query:refs:world/energy.js#drain`, `entity:world/energy.js#ENERGY_MAX`, `entity:world/energy.js#LIVING_COST` |
| `sweep-b` | P9b of 9.5 | 9.5 | `entity:world/energy.js#ENERGY_MAX`, `entity:world/energy.js#drain`, `entity:world/bounds.js#bounce`, `entity:world/time.js#seconds`, `entity:world/movement.js#step`, `entity:world/movement.js#wander`, `entity:world/movement.js#glide` |

The canned ray of `wrap-b` is `creatures/ray.js`:

```js
import { wrap } from "../world/bounds.js";
import { step } from "../world/movement.js";

const WINGS = "blue";

export function spawn() {
  return { vx: 2 };
}

export function update(ray) {
  step(ray);
  wrap(ray);
}

export function draw(ray, pen) {
  if (ray.vx < 0) pen.flip();
  pen.fill(WINGS);
  pen.poly([24, 0, -6, -18, -14, 0, -6, 18]);
  pen.line(-14, 0, -34, 0);
}
```

---

## 11. Risks of the demo codebase

| # | Risk | What the design does | What remains |
| --- | --- | --- | --- |
| 1 | A real model writes the crab without a number in points (`ENERGY_MAX * 0.3`). The hero then has nothing to show. | The seeded wording carries the number (TP21). The seed shows no relative threshold in creature code: seed creatures use `isHungry`. | The pools hold the same files and the Floor says so (TP20). The recording `hero-canned` uses the canned cast, and the video's fallback is that cast on a second pool under the SYNTHETIC banner (`04-build-plan.md`). |
| 2 | A real model gives a creature energy without referencing `ENERGY_MAX` (`energy: 100`). No rule fires. | Opt-in (TP16), guide rule 3, every example. The seeded-intent measurement reports the rate (TP22). If the agent read the rule, triage (E3, or QR4 in the other order). The self-test's `energy_range` catches it after landing; the green line reverts after its second failed run. | A stated limit: Premise tracks direct references (01-core HC3). |
| 3 | A dependency through another shared rule. `drain(creature, 5)` passes a number in the unit of `ENERGY_MAX` to a function whose own code never changes. The call references `drain`, not `ENERGY_MAX`. | Opt-in (TP16): a creature that has energy references `ENERGY_MAX` in its `spawn`, so its module is caught as a whole. The shrimp of section 7 is this case. | A file that spends or gives energy without having energy itself (a hunter that drains its prey by a fixed amount) references only `drain`. No rule fires for it. Stated limit in the README (01-core 2.4, HC3). |
| 4 | A change to a hot shared entity sends every in-flight agent back. | Energy is opt-in, so only energy creatures reference `ENERGY_MAX`. Other amounts are derived, so one entity changes. Cosmetic edits change no hash (7.7). The held card shows the blast radius before the tap. | Energy creatures that used only relative amounts are sent back once with nothing to change (pairs P6, P8 measure this). |
| 5 | Agents read whole shared files. Every unrelated change to that file then goes to triage for them. | Shared modules are small and split by topic. Guide rule 1 asks for reads by name. `reader` measures how often it happens. | Without Clef each such case costs one `confirm` turn. |
| 6 | A weak model cannot finish a sweep over several files (P2a, P9a). | Colours are one-line constants (TP18). The seed has five kinds. | Both are marked H. The seeded-intent measurement decides whether they are in the live set. The canned sweeps (`gold-a`, `sweep-a`) serve rehearsals and the fallback. |
| 7 | A sweep touches more than 64 paths and cannot land (`max_paths`, `MAX_PATHS`). | The cap is 64, and a pool page shows at most 64 kinds (`MAX_KINDS`). Seeded sweeps are run while the pool is small. | A universal intent over a larger pool has to be done in shared code. |
| 8 | A listing gains an entry between an agent's `list` and its edits. | Closed by the late L1 check: the heads-up comes at the operation that makes the attempt a sweep (8.3, vector `C41`). The search form is covered by X0. | An attempt that edits only one existing file of a directory is not sweeping it and is not told (vector `C40`). |
| 9 | A value in an old unit survives a hot swap (a creature at 64 points in a pool whose full is now 1). | Any change outside `creatures/` restarts the pool from tick 0 (4.7 step 2). | The pool visibly restarts on shared-rule landings. |
| 10 | A creature's code throws, returns broken numbers, or loops forever. | Guard and bench (TP10); `settle`; the Floor's reload of a stalled frame (HO8); ST4 makes the green line red. | An endless loop freezes that frame until the reload. |
| 11 | A creature draws words or covers the pool. | Section 3.4: no text operation exists; 40 shapes inside 60 units; surface caps in the host. | A small picture made of shapes is possible (PN10). |
| 12 | Pool code changes a built-in to interfere with other creatures or the host. | PN9 freezes built-ins before any pool module loads. | None known inside the frame; the frame is the boundary. |
| 13 | The self-test flakes. | No clocks, no timers, seeded random numbers, a fixed number of ticks, two identical runs compared. Reference duration under 0.2 s. GR3 needs two failed runs before a revert. | The isolate harness with the full pool, and its flakiness over 50 runs, are not yet measured (01-core S4). |
| 14 | Old module graphs pile up in a long-lived frame. | A restart after `MAX_ADOPTS` adopts and on every shared-rule change (4.7). | None. |
| 15 | The pool looks dead or unreadable on a projector. | TP9; the `visible` check; saturated palette on dark water; rest and arrival are shared rules, so every kind gets them. | Three pools side by side shrink each to a third. |
| 16 | Two intents choose the same kind name. | It is a seeded pair (P5): F1 with OP5, and the second agent goes around. | The second agent may choose a poor new name. |
| 17 | Held shared rules stall a scripted run. | The Swarm seed's policy variant (section 6), stated in the Swarm view. | None. |
| 18 | The break in the plain-merge pool is called staged. | It is built by rule 11.7 from the recorded operations, served by the same app server, labelled "constructed", and never shown with substituted code (TP20). | It is a construction, and the label says so. |
| 19 | A fix to an existing creature function costs extra confirm turns. | The blind-spot `confirm` for references the function already had is gone (B1a; 7.6 step 6). | A sibling entity's reference still gives a rule-based `confirm` (E2m, QR1m) when the thing it references changes (10.3). |
| 20 | The starter set puts an absolute energy number on `main` before the shared-rule request (the shrimp, TP24). For that creature no rule fires. | Guide rule 8; `relied_on_by` names the shrimp; the held card's after frame shows the collapse; the self-test fails and the green line would revert. The measurement reports how often the model rewrites it. | If the model does not rewrite it, `main` shows a collapsed shrimp after beat 3 of the video. Whether P1b stays in the starter set is the lead's decision. |
| 21 | Undo of the shared rule after the sweep also takes back the sweep and the late creature (9.5): three attempts reopen, not one. | Stated in 9.5 with the observed plans. | The beat sheet of `03-floor.md` has to count the changes that the plan really lists, or order the beats so that the undo comes first. |
| 22 | In the canned order 1 the plain-merge pool marks the crab and the shrimp interrupted, although their files were complete (PM4, 7.11). | Stated in 7.8 and 7.11. Order 2, and creatures that wait on a card, carry no mark. | A canned order-1 comparison shows the label. |
| 23 | A scripted sweep holds right of way and keeps creature-adding landings waiting. | SW7: a scripted sweep gives up at its second repair. The run reports the number of withdrawn attempts. | Real sweeps can still hold right of way for `RIGHT_OF_WAY_MS`; that is the starvation rule working as designed. |

---

## Appendix A. Acceptance checks

Observed on the reference implementation with seed 7 and 3600 ticks unless stated, on 2026-10-03 and again on 2026-10-04. Tests assert the bounds, not the observed values.

| # | Tree | Bound that MUST hold | Observed |
| --- | --- | --- | --- |
| A1 | The seed | Verdict `ok`. Every kind's rest share at most 0.10. | `ok`; all 0. Two runs of 3600 ticks in under 0.1 s in Node 22. |
| A2 | The seed, 36,000 ticks | Every kind's rest share at most 0.10. | Highest: minnow 0.060. |
| A3 | Seed + canned crab, shrimp, jellyfish, energy in points (before S lands in order 2) | Verdict `ok`. Shrimp rest share at most 0.15. | `ok`; shrimp 0.056. |
| A4 | The result of section 7 in the real pool (`ENERGY_MAX = 1`, `< 0.3`, `0.05`) | Verdict `ok`. Shrimp rest share at most 0.15. Crab hidden at most 0.10 of ticks. Crab mean speed at least 0.8. | `ok`; 0.056; 0.017; 0.98. |
| A5 | The plain-merge pool of section 7 (`ENERGY_MAX = 1`, `< 30`, `5`) | Verdict not `ok`. `failed` is exactly `[{ not_exhausted, shrimp }]`. Shrimp rest share at least 0.60. Crab hidden on every tick. Crab speed 0. Crab rest share at most 0.25. | not `ok`; exactly that; 0.817; 1.000; 0; 0.000 (0.035 over 14,400 ticks). |
| A6 | Section 8, both pools (all gold; all gold but the seahorse) | Both verdicts `ok`. | both `ok`. |
| A7 | Seed + the three templates of 10.2 | Verdict `ok`. | `ok`. |
| A8 | Every seed module and every canned file (7.3, 8.2, 9.5, 10.5), and `world/energy.js` after P9a | Parses; every import resolves (CK5); every global is in the policy list (CK6). | Globals used: `Array`, `Boolean`, `Infinity`, `JSON`, `Math`, `NaN`, `Number`, `Object`, `parseInt`, `undefined`. No unresolved import. |
| A17 | `main` after beat 5 of 9.5 (`ENERGY_MAX = 1`, `drain` in percent, `drain(shrimp, 5)`, `drain(squid, 10)`, `< 0.3`) | Verdict `ok`. Squid rest share at most 0.25. Shrimp rest share at most 0.15. | `ok`; 0.100; 0.056. |
| A18 | The plain-merge tree of 9.5 (as A17, with `< 30` and `drain(squid, 0.1)`) | Verdict `ok`. Crab hidden on every tick. Squid rest share 0. | `ok`; 1.000; 0. |
| A19 | `main` if R01 lands without rewriting the landed shrimp (`ENERGY_MAX = 1`, `drain(shrimp, 5)`, `< 0.3`) | Verdict not `ok`. `failed` is exactly `[{ not_exhausted, shrimp }]`. | not `ok`; exactly that; shrimp 0.817. |

Rule outcomes that tests MUST reproduce with the pure core, using the seed of 2.1 and the canned operations. Every row was observed in the reference simulator of core revision 2. Triage rows are stated as the core records them when Clef is on and has not answered (class `triage`, result pending); the scripted and the Clef-off outcomes are in the cited sections.

| # | Scenario | Expected judgments, in order |
| --- | --- | --- |
| A9 | 7.5 | Premises as in 7.4: the derived premises exist after each `write` and after S's `replace`. Card for S with blast radius `repair: [C, H]`. At S's landing: C `entity:world/energy.js#ENERGY_MAX` E2 `repair`; H `entity:world/energy.js#ENERGY_MAX` E2 `repair` and `file:world/energy.js` F3 `repair`, with exactly one item in H's heads-up (the entity; the file item is folded, HU2a); nothing for J. C's and H's next submits: no new premise, no B1, `validated`. Final: S, C, H, J landed as 1, 2, 3, 4; go-arounds 0, 1, 1, 0. |
| A10 | 7.5 variant 1c | C never reads `ENERGY_MAX`. Written before S lands: at the write a derived premise `entity:world/energy.js#ENERGY_MAX` with `read` false; at S's landing E2 `repair`; no B1 at the submit; 1 go-around (as `C10`). Written after S landed: nothing at S's landing; at C's submit B1 `confirm`, status `needs_confirm`; then `validated`; 0 go-arounds (as `C30`). |
| A11 | 7.6 | At the landing of C and H: S `refs:world/energy.js#ENERGY_MAX` QR1 `repair` with the four added referrers and a `context` of eleven entities that includes `creatures/crab.js#update` and `creatures/shrimp.js#update`; S's card closed as `stale`. S's two `replace` calls on the creature files are accepted without a read. S's next submit: no B1 judgment; status `held`. Final head as in 7.6 step 7; go-arounds C 0, H 0, S 1. |
| A12 | 7.7 | Comment-only landing: F2 `holds` for H, nothing for C, no heads-up. `REST_TICKS` landing: F4 triage for H with an `info` heads-up, nothing for C. |
| A13 | 8.3 | B lands after A's nine edits: A `listing:creatures/` L1 `repair`, `added: ["seahorse.js"]`, and two QR4 triage judgments on `refs:creatures/fish.js#BODY` and `#FIN`, in one heads-up. B lands after A's `list` and before A has edited two files: L3 `holds` and no heads-up at the landing; L1 `repair` in the response to A's first `replace` on a second file (as `C41`). Final: every creature gold, A landed with ten operations and 1 go-around. |
| A14 | 8.4 | B `file:creatures/fish.js`: X0 with an `info` heads-up when B has no operation; F4 triage with an `info` heads-up when it has. |
| A15 | 8.6 | A `text:creatures/:wrap(` QT1 `repair`, `added: ["creatures/ray.js#update"]`; X0 `info` in the early window. |
| A16 | 9.4, P4 to P8 | P4: E1 `repair` with dropped operation OP1, and a QR1m `confirm` item in the same heads-up; after P4b's second E1, caused by P4c: P4b `stopped` (`contradiction`) and a `choice` card for P4b and P4c. P5: F1 `repair` with dropped operation OP5; the second candidate is skipped as `not_disjoint` in the tick. P6: E2 `repair`, then `validated` with no new operation; other order QR1 to R04. P7: E2 `repair` on `world/bounds.js#wrap`; other order QR1 to R06. P8: E2 `repair` on `world/movement.js#MAX_SPEED`; other order QR1 to R03. A12 with a jellyfish landing: L3 `holds`, no L2. |
| A20 | 9.5, the canned run | R01 with the landed shrimp: `relied_on_by` has 16 referrers; S's change holds `world/energy.js` and `creatures/shrimp.js`; card with `repair: [crab]`; E2 `repair` to the crab. P9a: `held` with an empty blast radius. At P9b's landing: P9a `text:creatures/:drain(` QT1 `repair` with `added: ["creatures/squid.js#update"]` and `refs:world/energy.js#drain` QR1 `repair`, in one heads-up; P9a's card closed as `stale`; a tap on it changes nothing. P9a's `replace` on the squid is accepted without a read; its next submit answers `held`. Final: landings in the order starter, R01, crab, P9b, P9a; `main` as A17. Other order (P9a lands first): E2 `repair` on `entity:world/energy.js#drain` to P9b. P9a without a read of `ENERGY_MAX`: B1 `confirm` at its first submit. |
| A21 | 9.5, undo of R01 | Before the sweep: reverted R01 and the crab; reopened the crab; no kept reader. After the sweep: reverted R01, the crab, P9b and P9a; reopened three attempts. |
| A22 | 10.3, rule-based confirms | `retune` of `REST_TICKS` lands while `rescale-energy` is in flight: E2m and QR1m `confirm`. `rescale-energy` lands while `cosmetic` is in flight: E2m `confirm`, F3m folded. `cosmetic` lands while `rescale-energy`, `add-energy` and `reader` are in flight: F2 `holds` for `reader`, no heads-up to anyone. `sweep-colour` and `edit-creature` on one file, in both orders: E2m and QR1m `confirm`. A `reader` lands while `rescale-energy` is in flight: QR4 triage. A T-plain file lands while `sweep-search` has altered three containers: QT1 `repair`. |

Not observed, because the reference simulator does not have them; each needs its own test in the build: scripted triage outcomes (TR8), the `stop` call with `withdrawn`, Race candidates on a card, `plain.updated` with `interrupted`, and everything in section 4.

---

## Appendix B. Constants

Pool constants are exported by the pool's files and listed in section 2. Platform constants of this file:

| Constant | Value | Notes |
| --- | --- | --- |
| `HOST_SEED` | 7 | Default seed of a pool page. |
| `HOST_MAX_CATCH_UP` | 5 | Ticks per animation frame at most. |
| `HOST_MAX_REACH` | 200 | Largest clip radius the surface accepts. |
| `HOST_MAX_OPS` | 256 | Shape calls between one `push` and its `pop`. |
| `STATS_EVERY_MS` | 1,000 | |
| `HEAD_POLL_MS` | 5,000 | The slow self-check of a live frame. |
| `SWAP_MIN_MS` | 500 | |
| `MAX_ADOPTS` | 100 | Adopts before one restart. |
| `POOL_STALL_MS` | 5,000 | The Floor's watchdog for a frame. |
| `MAX_KINDS` | 64 | Kinds in one registry; also the largest `highlight` set. |
| `HIGHLIGHT_RADIUS` | 34 | Pool units. The ring of HO15. |
| `HIGHLIGHT_WIDTH` | 3 | Pool units. |
| `HIGHLIGHT_COLOUR` | `#ffd23f` | The palette's yellow. One constant, so the Floor's visual direction can change it in one place. |
| `APP_FILE_RATE_PER_MIN` | 1,200 | Version-pinned file requests per client address, cache misses only (SE21). The same constant as in 01-core Appendix C. |
| `SELFTEST_TIMEOUT_MS` | 10,000 | The whole harness: loading the modules and both runs. |

`PLAIN_PROBE_DELAY_MS` was removed in the reconciliation: a frame on `plain` is probed on `plain.updated` (4.6). Constants of `01-core.md` that this file uses keep their values there: `DEFAULT_GLOBALS`, `FLOOR_KEEP_LANDINGS`, `GREEN_CPU_MS`, `GREEN_LOG_MAX_CHARS`, `MAX_PATHS`, `RACE_SIZE`, `PUBLIC_RATE_PER_MIN`.

Self-test constants (exported by `selftest/`): `SELFTEST_TICKS` 3600, `SELFTEST_SEED` 7, `DRAW_EVERY` 300, `MAX_REST_SHARE` 0.25, `MIN_DRAWN` 16, `MAX_STATE_CHARS` 200,000.

---

## Appendix C. Points this file raised, and what `01-core.md` decided

The earlier revision listed fifteen points where this file needed `01-core.md` to agree. Core revision 2 decided each one ("From the tide pool specification" there). The item numbers are kept, because other files cite them.

| # | Point | Decision in `01-core.md` | Where this file follows it |
| --- | --- | --- | --- |
| 1 | Three generated modules under names that start with `~` | Adopted (SE15). | 4.2, 4.4 |
| 2 | The channel: `probe` with `selftest`, the fields of `stats` | Adopted (SE16), with `advance`, `highlight` and `tapped.path` added. One mechanism per kind of frame (SE16a). | 4.5, 4.6, 4.8 |
| 3 | No event said that the plain-merge repo moved | `plain.updated` (PM6), with `tree` and `interrupted`. | 4.6; `PLAIN_PROBE_DELAY_MS` removed |
| 4 | A read-only Trunk call for an attempt view | Not adopted. Previews are preview commits (PV1 to PV5); no public request reaches Trunk (SE19). | 4.1, 4.9, AS16 |
| 5 | A listing gain before the first edit was missed | Closed by the late L1 check, not by an `info` heads-up (vector `C41`). | 8.3, 10.3, risk 8 |
| 6 | B1 fired for references that already existed | Adopted: blind spots are limited to references the attempt added (B1a). | 7.6 step 6, risk 19 |
| 7 | Direct references only | Stated limit (HC3; 2.4 "Known limits"). The measurement reports the share (MP2). | risk 3, TP22 |
| 8 | A separate rate limit for version-pinned files | Adopted (SE21). | AS8 |
| 9 | `MAX_PATHS` 16 | Raised to 64; a pool's policy may lower it. The seed policy now says 64 (finding F31). | section 6, P2a, risk 7 |
| 10 | The example policy | Replaced by the file of section 6 (10.1). | section 6 |
| 11 | The vector pool's creatures use plain energy numbers | The vectors stay valid as vectors; the real pool is the one in this file (6.5). | 7.2 |
| 12 | `ops_first` and half-finished work | PM2 records `submitted`; PM4 marks the landing interrupted. | TP23, 7.8, 7.11 |
| 13 | L2 fired for any named kind | Adopted: only gained or lost names. | A12 in 9.1 |
| 14 | Two attempts that create one file, in the plain-merge pool | PM3: a `write` whose base moved is a text conflict, skipped and counted. | pair P5 in 9.4 |
| 15 | L3 judgments at Swarm scale | Kept as rows. Their events are not emitted in a `summary_only` pool (EV6). The scale run reports tick CPU time. | 10.1 |

---

## Changes in reconciliation (2026-10-04)

Inputs: the lead's decisions, the cross-document critic's findings F01 to F43, the architect's corrections for this file, the planner's gaps GP1 to GP5, the reconciled `01-core.md`, and the platform record. No rule id was renumbered. New rules: AS15, AS16, AS17, HO14, HO15, HO16, HO17, SW4 to SW8, TP24. Withdrawn, with the id kept: HO13. The scenarios of sections 7 to 10 were run again in the reference simulator of core revision 2 on `seeds/tidepool/` (see "Evidence").

### Lead decisions

| Decision | What changed in this file | Section |
| --- | --- | --- |
| 1. Live pool frame | Live frames use `main` and `plain` and move by `probe` on `landing.landed` and `plain.updated`; commit frames use commit sources and `advance`. The host's behaviour on `advance` (HO14) and `highlight` (HO15) is defined. | 4.1, 4.5, 4.6, 4.8 |
| 3. Hero walk-through | Rewritten for core revision 2: derived premises at the write; one E2 item for H with the F3 judgment folded; variant 1c split by `C10` and `C30`; order 2 without the blind-spot step; rows A9 to A11. | 7.3 to 7.11, Appendix A |
| 4. Stopping from the Agent side | Scripted agents end their own attempt with the `stop` call and the reason `withdrawn`. | 10.1 (SW4, SW6, SW7), 10.3 |
| GP1 | The source segment `p-<40 hex>`. | 4.1, 4.8 |
| GP2 | The conductor and the casts use `POST /api/swarm` with `patterns`, `hold_before_submit` and `release`; pattern ids of the casts. | 7.11, 10.1 (SW8), 10.5 |
| GP3 | The missing requests of the video: group `starter`, the sweep P9a and the late creature P9b, with canned operations and the run beat by beat. | 9, 9.5 |
| GP4 | The seed variant `tidepool-auto`. | 2.1, 6, 7.11 |
| GP5 | `summary_only`: the Swarm and soak pools are summary-only; a canned cast runs on a pool that is not. | 7.11, 10.1 |
| Platform: reading pool files | `PoolSource` reads by commit id (S7); options C and D withdrawn. | 4.9 |
| Platform: green-line runtime | The Dynamic Worker isolate is the harness; static checks are the fallback; Browser Run and the container are not built. | 5.4 |
| Agent prompt and tools | Pointers to `05-agent.md`. | header, 2.7, TP8, TP22 |
| Early model measurement | TP22 says that the first run needs no engine; TP24 adds one case to measure. | 7.10, 9.5 |

### Critic findings

| Finding | What changed in this file | Section |
| --- | --- | --- |
| F01 | As decision 1. | 4.5, 4.6, 4.8 |
| F03 | As decision 3. | 7.4 to 7.6, 7.9, Appendix A |
| F04 | `withdrawn` replaces the invented reason `superseded`. | 10.3 |
| F05 | The agent prompt is in `05-agent.md`. | header, 2.7 |
| F06 | Scripted agents answer `resume` (RS5). | 10.1 (SW4) |
| F08 | "No visible difference" rests on PM7; the interrupted mark on PM4; the badge's words are left to `03-floor.md`. | 5.5, TP20, TP23, 7.8 |
| F09 | The canned hero runs on a second pool opened at `/p/{pool}`. | 7.11 |
| F10 | The conductor's run is the recording `hero-canned`; `hero` and `rehearsal` are real-agent runs. | 7.11, risks 1 and 6 |
| F12 | The crab request of the video is P1a, typed word for word; why the number matters. | 9.5 |
| F13 | As GP3; pair P9; the `Group` column. | 9.1, 9.3, 9.4, 9.5 |
| F14 | The truth-label rate and the SW2 escape count are computed by the soak script and published in `SoakResult`; the stream's false-abort rate comes from `headsup.resolved.changed`. | 10.3, 10.4 |
| F16 | Truth lists as `<kind>:<key>` strings; scripted triage answers `repair` or `holds`; the `reader` row is an `info` heads-up with nothing to confirm. | 10.1 (SW5), 10.3, 10.5 |
| F18 | Option C deleted; AS11 and `seq` take their facts from the Floor's state; AS16. | 4, 4.4, 4.9 |
| F19 | The self-test maps to `{ name, ok, code }` with the codes of GR8; `detail`, `failed` and `rest_share` go to `log` only; ST4 uses `no_verdict`, `bad_verdict`, `harness_error`. | 5.4, 5.5 |
| F20 | ST4 and the risk rows say that a revert follows the second failed run. | 5.4, 7.10, risks 2 and 13 |
| F23 | As "Early model measurement" above. | 7.10 |
| F25 | A scripted sweep answers its first repair and withdraws at its second or on `limit_reached`. | 10.1 (SW7), 10.3, risk 23 |
| F26 | HO8 leaves the reload target and the label to `03-floor.md` and guarantees that `green` always resolves. | 4.5 |
| F27 | The flag is `summary_only` (the lead's name). | 7.11, 10.1 |
| F30 | The export of `~head.js` is named `landed`; the platform experiments are cited as X1 to X9. The rule ids ST1 to ST6 were **not** renamed to SF: the lead's rule is to keep every rule id stable. The conventions say how to cite them. | header, 4.4, 4.9 |
| F31 | `max_paths` is 64 in the seed policy. | 6, P2a, risk 7, Appendix C item 9 |
| F37 | Order 2b names the README and the About limits list. | 7.6 |
| F38 | P5 counts one text conflict (PM3); A12 follows the narrowed L2; `PLAIN_PROBE_DELAY_MS` deleted; only the root `index.html` is served as HTML; pair P4 has a third intent for the rule-based contradiction card. | 9.1, 9.3, 9.4, AS5, Appendix B |
| F39 | PN9 freezes `DEFAULT_GLOBALS`. | 3.4, 6 |
| F40 | The preview-commit read is listed as not yet measured, with the fallback of PV1a. | 4.9 |
| F02, F07, F11, F15, F17, F21, F22, F24, F28, F29, F32 to F36, F41 to F43 | No change of substance in this file. Where it touches them it follows the core: the option id `land` (CD4), RC7 for the chosen crab, `features.held` (FJ1), kept readers in the undo plans of 9.5 (UN4). | |

### Architect's corrections

| Correction | What changed in this file | Section |
| --- | --- | --- |
| No attempt source, no `a-` token, no 409, no options C and D; previews are `p-<commit>` | Done. The before frame of a held card is the commit source `<40 hex>` (PV2), the after frame `p-<40 hex>`. | 4.1, 4.2, 4.6, 4.8, 4.9, AS4, AS6, HO13 |
| AS5: only the root `index.html` as HTML; `.mjs` as JavaScript | Done. | 4.2 |
| Channel: `advance`, `highlight`, `tapped.path` | Done. | 4.5 (HO6, HO14, HO15) |
| Probe `plain` frames on `plain.updated`; no probe on `op.recorded` or `submit.result` | Done. | 4.6 |
| `seq` and the "most recently changed" order from the Floor's state; the full header set of SE14 | Done (AS15, AS16, AS11). | 4, 4.4 |
| 7.5: derived premises at the write; H gets one E2 item; variant 1c | Done. | 7.4, 7.5, 7.9, 9.4 (P1), 10.3, A9, A10 |
| 7.6: `context`; no blind-spot confirm; straight to `held` | Done. The `context` has eleven entries on the real pool, not two. | 7.6, A11 |
| 7.10 row 4: QR4 in order 2 | Done. | 7.10 |
| 8.3: L1 needs two files; the gap is closed by the late check; 8.4: a pending triage delivers an `info` heads-up | Done. Also stated: QR4 reaches the repaint in 8.3, because the seahorse's agent read `fish.js`. | 8.3, 8.4, A13, A14 |
| Plain-merge replay applies OP5; `interrupted` | Done. | 7.8, 8.5, 9.4 (P5), Appendix C items 12 and 14 |
| `max_paths` | Raised to 64 (F31). | 6 |
