# Premise tide pool specification (02-tidepool)

Status: binding for implementation. Read `01-core.md` first. Sources: the architecture brief (section 5), the design brief, the concept panel's must-fix lists, `01-core.md` and `premise-cases.json`.

Scope: the demo codebase (the tide pool), the drawing pen, the app server that serves a pool by ref, the self-test that the green line runs, the pool's policy file, the two scripted catches, the seeded intents, and the scripted agents of the Swarm. The Floor layout and the agent prompt are specified elsewhere and consume what is defined here.

Conventions used in this file:

- "MUST", "MUST NOT" and "MAY" are requirements. Rules have ids (`TP`, `PN`, `AS`, `HO`, `ST`, `SW`) so tests can cite them.
- Words from the glossary of `01-core.md` keep their meaning. Rule ids such as `E2`, `QR1`, `B1`, `CK6`, `SE14` and section numbers such as `11.7` point to `01-core.md`.
- Constants are written `LIKE_THIS`. Pool constants live in the pool's own files (section 2). Platform constants are in Appendix B.
- Lengths and positions are in **pool units**. The pool is 800 by 500 pool units; the page scales the picture to fit.
- This file makes no priority claim. Related work is named in `01-core.md`.

Evidence. On 2026-10-03 two checks were run. (a) A reference implementation of the file tree in 2.1 was run in Node 22 with the self-test of section 5. (b) The operations in sections 7, 8 and 9.4 were replayed through the scratch simulator of `01-core.md` that also checks `premise-cases.json`. Every rule id, state and number quoted in sections 7 and 8 was observed in those runs. Appendix A lists the observed values and the bounds that tests MUST assert. The simulator is a scratch tool, not product code; the product's unit tests repeat these checks.

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
| TP8 | **Weak models must succeed.** A working creature needs three small functions. The world supplies a place, a speed, the bounds safety net and the energy bookkeeping. The guide (2.7) fits in one read. | Spike S5 on the seeded intents (section 9). |
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
| Source | What a viewer asked to follow: `main`, `green`, `plain`, a commit, or an attempt (4.1). |
| Version | An opaque token for one unchanging tree of files (4.1). |
| Registry | The generated list of kinds at one version (4.4). |
| Resting | The state of a creature whose energy reached 0 (2.4). |
| Self-test | The pool's own headless check (section 5). Its result is the **verdict**. |
| Canned | Written in this file, not by a model. Canned operations are used by the Swarm, by Replay recordings and by tests. |
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

21 files. The seed commit of a pool repo contains exactly these.

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

- **TP15 (one scale, one place).** `ENERGY_MAX` is the only literal energy amount in the seed. Every other energy amount in a shared rule is written as an expression of `ENERGY_MAX` (`LIVING_COST`, `HUNGRY_BELOW`, `FOOD_ENERGY`, the wake-up level). No seed creature contains an energy number. Consequence: changing `ENERGY_MAX` from `100` to `1` leaves the whole seed correct with a one-line edit, and the only code that can depend on the old scale is code written by an in-flight attempt.
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

Every agent reads this file first. It MUST be exactly this text:

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
| 1. Browser sandbox | The pool app reaching the Floor's page, cookies or storage; any network request from pool code; `eval` and `new Function`. | SE13, SE14: `<iframe sandbox="allow-scripts">`, `connect-src 'none'`, no `'unsafe-eval'`. |
| 2. Capability | Pool code reaching the canvas or the page. Pool modules are given only `world`, `creature`, the pen, and (for `pen.js`) the surface. The host never passes the canvas, the context, an event or a DOM object into pool code. | PN5, PN6, HO3. |
| 3. Static check at submit | A change that names `document`, `window`, `globalThis`, `self`, `fetch`, `eval`, `Function`, timers, `Date`, `console` or any other global outside the allow list. | CK6 with the policy `globals` list (section 6). |
| 4. Budget | A creature covering the pool, or writing words with shapes: at most 40 shapes, inside a disc of radius 60, of a pool 800 wide. | PN1, PN3, PN7. |

- **PN9.** Before it imports any pool module, the host installs the seeded `Math.random` (HO2) and then freezes the built-in objects named in the policy `globals` list, their prototypes, and `Function.prototype`. A creature file cannot change a built-in to interfere with another creature or with the host.
- **PN10 (stated limit).** A creature can still arrange up to 40 shapes into a small picture. The pen makes text impractical, not impossible. This is one reason the submission build has no crowd input (13.2).
- **PN11.** `pen.js`, `main.js`, `index.html`, `world/**` and `selftest/**` are held paths (section 6). A change to the pen needs the owner's tap, and still cannot pass PN6 and PN7, which live in the host.

---

## 4. The app server contract

The app server is the part of the Worker that serves a pool's files so the pool runs in a browser with no build step. All routes are `GET`, public and read-only. Every response carries the headers of SE14 and no cookie (SE15).

### 4.1 Sources and versions

A **source** is what a viewer follows. A **version** names one unchanging tree.

| Source segment | What it follows | Backed by | Version token it resolves to |
| --- | --- | --- | --- |
| `main` | `refs/heads/main` of the pool repo, as confirmed pushed (LP10) | Artifacts | `c-<40 hex commit id>` |
| `green` | `refs/heads/green` of the pool repo | Artifacts | `c-<40 hex>` |
| `<40 hex>` | That commit of the pool repo | Artifacts | `c-<40 hex>` |
| `plain` | `refs/heads/main` of the pool's plain-merge repo (11.7) | Artifacts | `p-<40 hex>` |
| `a_<ULID>` | The attempt view of that attempt (5.2): head plus its current operations | Trunk | `a-<attempt id>-<head_seq>-<last op_seq>` |

- **AS1.** A version token is opaque to the page. Two requests with the same version and path return the same bytes, or the second returns 409 (AS4).
- **AS2.** `main` never resolves to a landing that is accepted but not pushed (LP10).

### 4.2 Routes

| Route | Response | `Cache-Control` |
| --- | --- | --- |
| `GET /pool/<pool>/<source>/` | The `index.html` of the version the source resolves to. Without the final slash: 308 to the same path with it. | `no-store` |
| `GET /pool/<pool>/<source>/~head.js` | Generated module (4.4). | `no-store` |
| `GET /pool/<pool>/<source>/~boot.js` | Generated module (4.4). | `no-store` |
| `GET /pool/<pool>/v/<version>/<path>` | The bytes of `<path>` in that version. | `public, max-age=31536000, immutable` for `c-` and `p-` versions; `no-store` for `a-` versions |
| `GET /pool/<pool>/v/<version>/~registry.js` | Generated module (4.4). | as the row above |
| `GET /pool/~host.<build>.js` | The host (4.5). A platform asset. | `public, max-age=31536000, immutable` |

- **AS3.** A path segment that starts with `~` can never be a repo path (01-core 2.1 allows only letters, digits, `.`, `_`, `-`). The app server generates exactly the three modules of 4.4 under such names and nothing else.
- **AS4 (errors).** Unknown pool, unknown source, or a path that does not exist in the version: 404. A file type outside AS5: 404. An `a-` version that is no longer the attempt's current view: 409 with body `stale_version`. Any failure to reach Artifacts or Trunk: 503. No error response has a body taken from a repo.
- **AS5 (content types).** `.js` → `text/javascript; charset=utf-8`; `.html` → `text/html; charset=utf-8`; `.json` → `application/json`; `.md` → `text/plain; charset=utf-8`. Nothing else is served. Paths under `.premise/` are not served.
- **AS6 (previews are not reads).** Serving a file, a listing or an attempt view records no premise, emits no event and changes nothing in Trunk.
- **AS7.** Query strings on the page route are for the host only (4.5). The app server ignores them.
- **AS8 (rate limit).** `PUBLIC_RATE_PER_MIN` applies to the three `no-store` routes. Version-pinned routes are counted separately against `APP_FILE_RATE_PER_MIN`, because one page load fetches about 25 modules.

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

`~head.js` tells the page which version its source points to now:

```js
export const head = {
  pool: "tidepool",
  source: "main",
  version: "c-9f1c0e6a4b7d2f3581a0c4e6b8d1f3a5c7e9b2d4",
  base: "/pool/tidepool/v/c-9f1c0e6a4b7d2f3581a0c4e6b8d1f3a5c7e9b2d4/",
  seq: 12
};
```

`seq` is the landing number for `main`, `green` and commit sources when Trunk knows it, else `null`.

`~boot.js` starts the host:

```js
import { startHost } from "/pool/~host.<build>.js";
import { head } from "./~head.js";
startHost(head);
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
- **AS11.** At most `MAX_KINDS` entries. When the directory holds more, the app server keeps the most recently changed files (`files.changed_seq` from Trunk when the version is the pool repo's head; name order otherwise). `total` is the full count.

### 4.5 The host

The host is platform code, served by the app server and never stored in a pool repo. Page parameters (query string): `seed=<integer>` (default `HOST_SEED`), `follow=0` (never swap), `paused=1`, `selftest=1` (5.4).

Start-up order: HO2, then PN9, then HO1. No pool module is imported before the first two are done.

- **HO1 (start).** Find `canvas#pool`. Build the surface (3.3). Import `<base>~registry.js`, `<base>main.js`, `<base>pen.js`, then each kind's module with its own dynamic `import()`. A kind whose import fails is left out and reported in `stats`. Call `createPen(surface)` and `createPool(kinds)`.
- **HO2 (random numbers).** Before any pool code runs, replace `Math.random` with the generator below, seeded with the page's seed. The self-test harnesses of 5.4 use the same generator.

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
- **HO6 (taps).** On a pointer press the host converts the point to pool units, calls `creatureAt`, and when it returns a creature posts `{ type: "tapped", creature: <kind> }`.
- **HO7 (heartbeat).** The host posts `stats` every `STATS_EVERY_MS`, after every swap and in answer to every `probe`.
- **HO8 (a stuck pool).** Pool code that never returns cannot be interrupted from inside the frame. The Floor reloads a pool frame that has sent no `stats` for `POOL_STALL_MS`, with source `green` when the frame was following `main`, and labels it "showing the last verified version".

The channel (the pool side of SE16). The Floor checks `event.source`, validates every field, and treats every string as text.

```ts
type FloorToPool =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "probe"; selftest?: boolean };   // "look for a new version now"; with selftest, also run 5.5

type PoolToFloor =
  | { type: "tapped"; creature: string }      // a kind name
  | { type: "stats";
      source: string; version: string; seq: number | null;
      tick: number; paused: boolean;
      kinds: Record<string, { count: number; resting: number; errors: number; benched: boolean }>;
      shown: number; total: number;           // kinds loaded, kinds in the listing
      swap: { mode: "adopt" | "restart"; arrived: string[]; failed: string[] } | null;   // the last swap
      selftest: { version: string; ok: boolean; failed: Array<{ name: string; kind: string | null }> } | null };
```

### 4.6 How the page learns of a new landing

The page cannot poll with `fetch` (`connect-src 'none'`). It learns in two ways, both ending in the same step:

1. **Probe.** The Floor, which reads the event stream, posts `{ type: "probe" }` to a pool frame when something that frame follows may have changed: `landing.landed` for frames on `main`; `green.advanced` for frames on `green`; `op.recorded` and `submit.result` of an attempt for frames on that attempt; and for frames on `plain`, `landing.landed` and again `PLAIN_PROBE_DELAY_MS` later.
2. **Slow self-check.** Every `HEAD_POLL_MS` the host does the same step by itself. This covers a pool opened outside the Floor and a missed message.

The step: `import("./~head.js?n=<counter>")` relative to the page. This is a module import, which `script-src` allows. If `head.version` equals the running version, nothing happens. Otherwise the host swaps (4.7).

- **HO9.** With `follow=0`, and for a source that is a commit id, the host never probes.
- **HO10.** At most one swap every `SWAP_MIN_MS`. A probe that arrives during a swap is remembered as one pending probe.

### 4.7 Hot swap

Input: the running version with its registry, and the new `head`.

1. Import the new `~registry.js`.
2. **Shared files changed** (`registry.shared` differs): **restart**. The host reloads the page with the same query string. The world starts again at tick 0 with the same seed under the new shared rules. No state is carried over, so no value in an old unit survives a change of unit.
3. **Only creature files changed** (`registry.shared` is equal): **adopt**.
   1. `changed` = kinds whose `oid` differs, plus kinds that are new.
   2. For each kind in `changed`, import its module from the new base. A kind whose import fails keeps its old module if it had one, and is reported in `swap.failed`.
   3. Kinds that are unchanged keep the module they have. Kinds that are gone are dropped.
   4. Between two frames: `pool = adoptPool(pool, kinds, changed)`. Unchanged creatures keep their state. Changed and new kinds are made again with age 0, so they show the arrival ring.
4. Post `stats` with `swap` set.
5. After `MAX_ADOPTS` adopts the host restarts once, to release old modules.

- **HO11.** An adopt never mixes two versions of a shared module in one tick: all running modules were loaded from versions with the same `shared` digest, so their shared code is byte-identical, and shared modules hold no state (TP4).
- **HO12.** If step 1 or the import of `main.js` or `pen.js` fails, the running version keeps running and `stats.swap.failed` is `["*"]`.
- **HO13.** A 409 `stale_version` (AS4) ends the swap; the host probes again after `SWAP_MIN_MS`.

### 4.8 Two or three pools side by side

- **AS12.** Each pool is its own frame with its own source: `<iframe sandbox="allow-scripts" src="/pool/<pool>/<source>/?seed=<n>">`. Frames share nothing: each has its own realm, its own seeded `Math.random`, its own module graph and its own world.
- **AS13.** For a comparison the Floor gives every frame the same `seed` and sets their `src` in the same task, so they start from the same world. Differences on screen then come only from differences in code.
- **AS14.** The Floor pauses a frame that is not visible.

| View | Frames | Sources |
| --- | --- | --- |
| The pool | 1 | `main` |
| Held card, before and after (10.2) | 2 | `main`, `a_<attempt>` |
| Hero comparison (section 7) | 2 | `main`, `plain` |
| Race card (11.4) | up to `RACE_SIZE` | one `a_<attempt>` each |

### 4.9 Where the files come from (decided by spike)

The routes above code against this interface. The implementation is not chosen here.

```ts
type Version = string;   // "c-<40 hex>" | "p-<40 hex>" | "a-<attempt id>-<head_seq>-<last op_seq>"

interface PoolSource {
  resolve(pool: string, source: string): Promise<{ version: Version; seq: number | null } | null>;
  read(pool: string, version: Version, path: string): Promise<{ bytes: Uint8Array; oid: string } | null | "stale">;
  list(pool: string, version: Version, dir: string):
    Promise<Array<{ name: string; type: "file" | "dir"; oid: string }> | null | "stale">;
}
```

| Option | For | Description |
| --- | --- | --- |
| A | `c-`, `p-` | Artifacts binding by hash: `log({ ref, limit: 1 })` to resolve a ref, then `readCommit` → `readTree` (one level at a time) → `readBlob`. Trees are cached per version. |
| B | `c-`, `p-` | Artifacts `readFile({ ref: <commit id>, path })`, if the spike shows that a commit id is accepted as `ref`. |
| C | `c-` at head only | Trunk's `files` table (01-core 3.2), with Artifacts for every other commit. |
| D | `a-` | Trunk's attempt view (5.2), through a read-only call that takes the expected `head_seq` and last `op_seq` and answers `stale` when they no longer match. This is the only option for attempt sources. |
| E | tests, local runs | A directory on disk. |

To measure: time per file cold and warm; whether `readFile` accepts a commit id; how soon after a push a read by ref shows the new head.

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

The green line's `Verifier` (11.5) has one implementation per runtime of spike S4. All of them run the same `runSelfTest` from the commit under test.

| S4 option | Harness |
| --- | --- |
| A, Browser Run | Open `/pool/<pool>/<commit>/?selftest=1`. With that parameter the host starts as usual (HO2, PN9, HO1), imports `<base>selftest/run.js`, calls `runSelfTest({ kinds, reseed })` instead of starting the frame loop, and stores `JSON.stringify(verdict)` in `globalThis.__premise_selftest`. The Workflow step waits for that value. |
| B, Dynamic Worker isolate | Read every `.js` file of the commit through `PoolSource`. Load them as the modules of one isolate, plus a generated entry module that imports `selftest/run.js` and each `creatures/<kind>.js` statically, installs the generator of HO2, calls `runSelfTest`, and returns the verdict as JSON. |
| C, container | Check out the commit and run a Node script that does what the entry module of option B does. |
| D, static | The self-test is not run (GR5). |

Mapping to `VerifyResult` (11.5):

| `VerifyResult` field | Value |
| --- | --- |
| `ok` | `verdict.ok` |
| `checks` | `verdict.checks`, preceded by `{ name: "selftest_ran", ok: true }` |
| `log` | JSON of `{ failed, rest_share }`, cut to `GREEN_LOG_MAX_CHARS` |
| `runtime` | `"browser"`, `"isolate"` or `"container"` |

- **ST4 (fail closed).** No verdict within `SELFTEST_TIMEOUT_MS`, a verdict that is not valid JSON of the type in 5.3, or a harness error gives `ok: false` with the single check `{ name: "selftest_ran", ok: false, detail: <reason> }`. A pool whose code never returns is therefore red, and GR3 reverts it.
- **ST5.** The harness adds nothing to the pool's checks and removes none.
- **ST6.** `selftest/**` is a held path. A change that weakens a check needs the owner's tap.

### 5.5 The same self-test in the page

On `{ type: "probe", selftest: true }` the host runs `runSelfTest` once for the version it is running and reports the result in `stats.selftest`. The Floor shows it as a badge under that pool, with the words "self-test, run in this page". This is how the plain-merge pool, which the green line does not verify, shows a verdict next to the real pool. The badge never moves `refs/heads/green`.

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
  "globals": ["Math", "Number", "String", "Boolean", "Array", "Object", "JSON", "Map", "Set",
              "Infinity", "NaN", "undefined", "isFinite", "isNaN", "parseInt", "parseFloat"],
  "limits": { "max_paths": 16, "max_change_bytes": 65536 }
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
- `globals` leaves out `Date`, `console`, `Symbol`, `Promise`, timers and every page and network name. `Math.random` stays usable because the host and the self-test seed it (HO2).
- Every seed module passes CK6 with this list (TP3), so any entity in the pool can be edited later without tripping over a global it already used.

The Swarm uses a second seed, `tidepool-swarm`, whose policy differs in one line: the first rule's paths are `["creatures/*.js", "world/*.js"]`. Scripted shared-rule changes then land without a tap. The SYNTHETIC banner states this ("shared rules land without a tap in this pool").

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

C and H rely on the old meaning: their intents carry numbers in points. J never mentions energy; it is in the script to show who is not disturbed. (`premise-cases.json` uses the shorter intent "a crab that hides when its energy is low" with the same code shape; the vectors `C04`, `C05` and `C10` are this conflict on the vector pool.)

### 7.3 Canned operations

These are the exact operations of the canned version. Real agents write their own code; 7.10 lists what must hold for them.

**S.** `read GUIDE.md`; `read world/energy.js`; then one `replace` on `world/energy.js`:

- `old`: `// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 100;`
- `new`: `// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 1;`

(`\n` is a line break. The comment belongs to the entity: by rule EN6 a leading comment is part of the statement that follows it.)

Result of the `replace` (observed): `targets` and `altered` are `["world/energy.js#ENERGY_MAX"]`. By rule D2 Trunk pins `refs:world/energy.js#ENERGY_MAX` and returns the referrers at head in `relied_on_by`. In the reference implementation there are 14: the import entity and `spawn` of `fish`, `minnow` and `turtle`; `world/energy.js#HUNGRY_BELOW`, `#LIVING_COST`, `#feed`, `#liveOneTick`; `world/food.js#(import ./energy.js)` and `#FOOD_ENERGY`; and the import entity and one check function of `selftest/invariants.js`. Then `submit` with summary "Make energy a fraction from 0 to 1".

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

C reads by entity and H reads whole files on purpose: the two styles reach the same catch through different rules (7.5).

### 7.4 Premises held just before S lands (landing order 1)

| Attempt | Premise | Flags | From |
| --- | --- | --- | --- |
| C | `listing:creatures/` | read | `list` |
| C | `file:GUIDE.md` | read | `read` |
| C | `entity:world/energy.js#ENERGY_MAX` | read | `read` of the entity |
| C | `entity:world/bounds.js#FLOOR_Y`, `#bounce`; `entity:world/movement.js#step` | read | `read` of each entity |
| C | `file:creatures/crab.js` at `absent` | edit | `write` (W4) |
| H | `listing:creatures/`, `file:GUIDE.md` | read | `list`, `read` |
| H | `file:world/energy.js`, `file:world/bounds.js`, `file:world/time.js`, `file:world/movement.js` | read | `read` of each file |
| H | `file:creatures/shrimp.js` at `absent` | edit | `write` |
| J | `listing:creatures/`, `file:GUIDE.md`, `entity:world/bounds.js#SURFACE_Y`, `#FLOOR_Y` | read | `list`, `read` |
| J | `file:creatures/jellyfish.js` at `absent` | edit | `write` |
| S | `file:GUIDE.md`, `file:world/energy.js` | read | `read` |
| S | `entity:world/energy.js#ENERGY_MAX` | edit | `replace` (R4) |
| S | `refs:world/energy.js#ENERGY_MAX` (members: the referrers at head) | derived | D2 at the `replace` |

For both C and H, `world/energy.js#ENERGY_MAX` is in `NewRefs` (01-core 6.3): their new `spawn` and import entities reference it.

### 7.5 Landing order 1: the shared rule lands while the creatures are in flight

| # | Event | Rule | What Trunk does |
| --- | --- | --- | --- |
| 1 | S submits. | CK9, T4 | Tier `held`. A held card opens. Blast radius: `repair: [C, H]`, `confirm: []`, `triage: []`. J is not on it. |
| 2 | The owner taps Land. | T13 | S is `validated`. |
| 3 | The next tick accepts S as landing 1. | 9.4 step 5, HU1 | In the same transaction every in-flight premise changed by the batch is classified. |
| 3a | C: `entity:world/energy.js#ENERGY_MAX`, hash changed, not edited by C, referenced by C. | **E2** | `repair`, reason `referenced_entity_changed`. C: `working` → `going_around`, go-around 1. |
| 3b | H: `file:world/energy.js`, blob id changed, changed entities `{ENERGY_MAX}`, which H references. | **F3** | `repair`, reason `referenced_entity_changed`. H: `working` → `going_around`, go-around 1. |
| 3c | J: holds no premise on anything S wrote. | none | No judgment, no heads-up. J stays `working`. |
| 4 | Trunk writes `ops_first` for C and for H (11.7): the one `write` each holds at this moment. | 11.7 | Used later for the plain-merge pool. |
| 5 | Each agent receives its heads-up in its next tool result, or as a push (HU5). | TA3 | No write or submit is accepted from C or H until the heads-up is in the model's context. |
| 6 | C applies its repair operation and submits with `acknowledge: [1]` and the statement "Energy is now a fraction from 0 to 1, so the crab hides below 0.3." | CK1, CK7, CK8 | `validated`. D1 marks C's four entity premises `derived`. No blind spot: C read each of them. |
| 7 | H applies its repair operation and submits with `acknowledge: [1]` and the statement "Energy is now a fraction from 0 to 1, so a dart costs 0.05." | CK1, CK7, CK8 | `validated`. D1 creates 7 derived entity premises. No blind spot: H read each file. |
| 8 | J submits. | CK7 | `validated`, no go-around. |
| 9 | The next tick accepts C, H and J in one batch as landings 2, 3 and 4. | 9.4 step 3b | Each holds a `listing:creatures/` premise that the others changed; rule **L3** classifies it `holds` (`listing_unused`), so the three are disjoint. |

Observed end state: S landed, 0 go-arounds; C landed, 1; H landed, 1; J landed, 0. No Clef call was made.

What C's agent receives (the item of its `HeadsUp`, 01-core 8.2):

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

H receives the same heads-up with one item for `file:world/energy.js`, rule `F3`, whose `diff` is `{ "kind": "file", ..., "changed_entities": ["world/energy.js#ENERGY_MAX"] }` and whose `uses` are lines 1 and 9 of `creatures/shrimp.js`.

Note on `uses`. The lines that reference `ENERGY_MAX` are the import and `spawn`. The line with the old number (`crab.energy < 30`, `drain(shrimp, 5)`) does not name `ENERGY_MAX` and is not in `uses`. The agent has to connect the two from the diff, the other change's intent text, and rule 3 of the guide. This step is the one spike S5 measures ("30 → 0.3").

Variant 1c: the creature's agent never read the rule. If C's agent learned about energy only from `creatures/fish.js`, it holds no premise on `ENERGY_MAX` while it works, and step 3a does not happen. At C's submit, rule D1 creates the premise and rule **B1** makes it a blind spot: C receives one heads-up of result `confirm` (cause `submit`) that carries the current source of `ENERGY_MAX` (`... = 1;`, with its comment) and C's own lines. C's submit answers `needs_confirm`; C applies the same repair operation and submits again with an acknowledgement. Observed: C lands with 0 go-arounds and the same final file. This is vector `C10` on the real pool.

### 7.6 Landing order 2: the creatures land while the shared-rule change is in flight

S has made its `replace` (so `refs:world/energy.js#ENERGY_MAX` is pinned) and is waiting on its held card. C and H are written against points and submit.

| # | Event | Rule | What Trunk does |
| --- | --- | --- | --- |
| 1 | S submits. | T4 | Held card. Blast radius at this moment: empty, if C and H have not written yet. |
| 2 | C and H submit. Their premises hold: `ENERGY_MAX` is still 100 at head. | CK7, CK8 | Both `validated` (tier `auto`). |
| 3 | The next tick accepts C and H as landings 1 and 2. | 9.4 | Both land. The pool is healthy: head is still in points. |
| 4 | In the same transaction S's `refs:` premise is classified: its member set gained `creatures/crab.js#(import ../world/energy.js)`, `creatures/crab.js#spawn`, `creatures/shrimp.js#(import ../world/energy.js)`, `creatures/shrimp.js#spawn`, and S alters `ENERGY_MAX`. | **QR1** | `repair`, reason `new_reference_to_altered_entity`. S: `held` → `going_around`, go-around 1. The held card closes as `stale` (T8). `ops_first` for S is written: its one `replace`. |
| 5 | S reads `creatures/crab.js` and `creatures/shrimp.js` and applies both repair operations of 7.3 itself, in its own change. | R4, D2 | S now also alters `creatures/crab.js#update` and `creatures/shrimp.js#update`. |
| 6 | S submits with `acknowledge: [1]` and the statement "Two new creatures used point values. Changed the crab's 30 to 0.3 and the shrimp's 5 to 0.05 in the same change." | CK1, CK7 | The repair is resolved. The two `update` entities S altered call `step`, `bounce`, `seconds`, `wander` and `glide`, which S never read: rule **B1** lists these five as blind spots in one heads-up of result `confirm`. Submit answers `needs_confirm`. |
| 7 | S submits again with `acknowledge: [2]` and a statement that none of the five deals with energy. | CK9, T4 | Tier `held` (it touches `world/energy.js`). A new held card opens for the new `submit_id`. |
| 8 | The owner taps Land. The next tick accepts S as landing 3. | T13, 9.4 | Head: `ENERGY_MAX = 1`, `crab.energy < 0.3`, `drain(shrimp, 0.05)`. |

Observed end state: C and H landed with 0 go-arounds; S landed with 1. No Clef call was made.

What S's agent receives in step 4:

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
      "removed": []
    },
    "uses": []
  }],
  "dropped_ops": [],
  "go_around": 1
}
```

The intent texts of the two landed changes ("below 30", "5 energy") are in `cause.changes`. The added sources are the entities that reference `ENERGY_MAX`; the lines with the old numbers are in the `update` functions, so S must read the two files. Rule 8 of the guide tells it to.

Mixed order. If C lands before S and H after, both rules run in one session: QR1 sends S around to fix the crab, and E2 or F3 sends H around to fix itself. The outcomes are the rows above.

Order 2b: S makes its edit after C has landed. Then nothing is in flight against anything, and no heads-up is due. The `replace` result's `relied_on_by` already lists `creatures/crab.js#spawn` and its import next to the seed referrers (observed), so S's agent is shown the crab at the moment it changes the meaning. Whether S then fixes the crab's number is S's own work, shown to the owner in the before and after preview of the held card. Premise guarantees the agent was shown every referrer; it does not prove the sweep was complete. This limit is stated in the README.

### 7.7 Who is not sent back

Observed with the same attempts in flight:

| Landing | C (read the entity) | H (read the whole file) | J | Rule |
| --- | --- | --- | --- | --- |
| A comment in `world/energy.js` is reworded (intent R10) | nothing | judgment `holds`, no heads-up | nothing | E0, F2 |
| `REST_TICKS` changes from 300 to 150 (intent R07) | nothing | triage (`F4`: read, not referenced) | nothing | F4 |
| `ENERGY_MAX` changes meaning | `repair` | `repair` | nothing | E2, F3 |

A change to the hottest shared constant sends back exactly the attempts whose code references it. A cosmetic change to the hottest shared file sends back nobody. An agent that reads a whole shared file widens its premise: an unrelated change to that file goes to triage (7.3 of 01-core) instead of passing silently. Rule 1 of the guide ("read each shared rule you use by name") keeps premises narrow.

### 7.8 The "same changes, merged by plain git" pool

Built by rule 11.7 from the same landings.

| Landing order | Landings replayed, in `seq` order | Operations used |
| --- | --- | --- |
| 1 | S, C, H, J | S: its `replace`. C and H: `ops_first`, that is the `write` each held before its first heads-up (the files of 7.3 with `30` and `5`). J: its landed `write`. |
| 2 | C, H, S | C and H: their landed `write`. S: `ops_first`, that is its one `replace` on `world/energy.js`, without the two creature fixes it added during its go-around. |

Both orders give the same tree: `ENERGY_MAX = 1`, `crab.energy < 30`, `drain(shrimp, 5)`. Every replay succeeds: no text conflict is counted.

What a person sees, side by side, same seed (observed over 3600 ticks; three crabs, three shrimp):

| | The pool (`main`) | "same changes, merged by plain git" (`plain`) |
| --- | --- | --- |
| Crabs | Walk along the sand. Hidden 1.7% of the time. Mean speed 0.98 units per tick. | Never come out of their shells. Hidden 100% of the time, from the first tick. Speed 0. |
| Shrimp | Dart every two seconds. Resting 5.6% of the time. | Dart once, turn grey, roll upside down and sink to the sand. They wake after five seconds, dart once, and collapse again. Resting 82% of the time. At any moment most of the three are grey on the sand. |
| Jellyfish and the seed creatures | Unchanged | Unchanged |
| Self-test badge (5.5) | pass | FAIL: `not_exhausted` (shrimp: resting 82% of the time) |
| `stats.kinds.shrimp.resting` | 0 most of the time | 3 of 3 most of the time |

Why the numbers break: with `ENERGY_MAX = 1`, `crab.energy < 30` is always true, and `drain(shrimp, 5)` removes five full tanks in one call.

The crab is the case no test sees: the self-test passes it in both pools, because a creature that sits still is a healthy creature. Only the record of what the crab's author relied on says it is wrong.

- **TP19.** The Floor labels the right-hand pool "same changes, merged by plain git" and "constructed", in neutral words (rule 13 of the brief). It shows no product name.
- **TP20.** If, in a live run, the real agents wrote code that does not depend on the old scale (7.10), the two pools look the same. The Floor then says "no visible difference in this run". It never substitutes canned code into a live comparison.

### 7.9 Why the ordinary checks accept it

| Check | What it compares | Result in both landing orders |
| --- | --- | --- |
| Text merge (three-way, per file) | Line ranges changed on both sides of one file | S changed lines 1 and 2 of `world/energy.js`. C and H added new files. No file is changed twice. Clean merge, nothing to report. |
| File-level check on writes (claims, leases, "a file I wrote has moved") | The sets of paths written | `{world/energy.js}`, `{creatures/crab.js}`, `{creatures/shrimp.js}`: disjoint. Accepts. |
| File-level check on reads ("a file I read has moved") | The paths each author read | Order 2: S never read `creatures/crab.js`; it did not exist. Accepts. Order 1: flags a creature only if its author happened to read `world/energy.js` as a file; accepts in variant 1c. It also flags every comment-only edit to that file. |
| Import index | Which names each file imports, and whether they resolve | `ENERGY_MAX` and `drain` are still exported from `world/energy.js`. Accepts. |
| Signature index | Name, kind and parameter count of each export | The outline line of `ENERGY_MAX` (7.1) is identical before and after. Accepts. |
| Parse, type of the value | Syntax; a number stays a number | Accepts. |
| The self-test (section 5) | Health of the running pool | Fails for the shrimp, after the merge. Passes the crab. |
| Premise | The hash of the entity each change references, and who references an entity a change alters | Order 1: E2, F3 or B1. Order 2: QR1. Both before the dependent change lands, with the diff, while its author still has its context. |

### 7.10 What must hold for real agents, and what happens when it does not

The canned run is deterministic. A real model writes its own crab. The rule-based catch needs one fact: **the creature's code references `ENERGY_MAX`**. TP16 and rule 3 of the guide make `energy: ENERGY_MAX` the documented way to give a creature energy.

| What the creature's agent wrote | What happens when the meaning changes | Rule-based |
| --- | --- | --- |
| `energy: ENERGY_MAX` in `spawn`, and a number in points (the seeded wording asks for one) | As 7.5 or 7.6. | yes |
| `energy: ENERGY_MAX`, and only relative amounts (`ENERGY_MAX * 0.3`) | E2 or F3 sends it around. The agent acknowledges and changes nothing. Counted as a false abort (14.4). The two pools look the same (TP20). | yes |
| No `energy` in `spawn`, but it compares `creature.energy` with a number | The creature never had energy; the comparison is always false. Nothing depends on the scale. The creature does not do what was asked, in either pool. Not a conflict. | n/a |
| `energy: 100` written as a number, no reference to `ENERGY_MAX` | No rule fires. If the agent read `ENERGY_MAX` or the file: triage (E3 or F4), so Clef decides or, without Clef, a `confirm` with the diff. If it read neither: nothing. After both land, the self-test fails `energy_range` and the green line reverts (GR3). | no; stated limit |

- **TP21.** The seeded intents of the hero (P1a, P1b) carry their numbers in the owner's words, so a model that follows the request writes a number in points.
- **TP22.** Spike S5 reports, per model, the share of energy creatures that reference `ENERGY_MAX`, the share that write an absolute number, and the share that repair it correctly after the heads-up. The live cast is chosen from those numbers.

### 7.11 The conductor's script for rehearsals and for the Replay recording

| # | The conductor does | Then waits for |
| --- | --- | --- |
| 1 | Creates the intents of J, C and H. | `op.recorded` for `creatures/crab.js` and for `creatures/shrimp.js`. |
| 2 | Creates the intent of S. | `card.opened` of kind `held` whose blast radius lists C and H. |
| 3 | Opens the comparison view (4.8): `main` and `plain`, same seed. | Both frames report `stats`. |
| 4 | Taps Land on the card. | `headsup.sent` with result `repair` for C and for H; `landing.landed` for S. |
| 5 | Nothing. | `landing.landed` for C, H and J. |
| 6 | Sends `probe` with `selftest: true` to both frames. | `stats.selftest` from both. |

For landing order 2 the conductor swaps steps: it creates S first, waits for S's `submit.result` of status `held`, creates C and H, waits for their `landing.landed` and for `headsup.sent` (QR1) to S, then waits for the second held card and taps Land. With canned agents the creature scripts hold before `submit` until step 2 has happened (flag `hold_before_submit`, section 10); with real agents either order may occur and both are handled.

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
| 3 | A's `listing:creatures/` premise: the entry names gained `seahorse.js`, and A has current operations on paths directly in `creatures/` that existed before. | **L1** | `repair`, reason `sweep_incomplete`. A: `working` → `going_around`, go-around 1. `ops_first` for A is written: the nine `replace` operations it holds. |
| 4 | A receives the heads-up, reads `creatures/seahorse.js`, repaints it, and submits with `acknowledge: [1]` and the statement "A seahorse arrived during the repaint. Painted it gold too." | CK1, CK8 | `validated`. No blind spot: the entities A altered are constants that reference nothing. |
| 5 | The next tick accepts A as landing 2, with ten operations. | 9.4 | Every creature is gold, the seahorse included. |

L1 fires as soon as A holds one operation on an existing creature file, so the same catch happens when B lands in the middle of A's sweep.

What A's agent receives:

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

Stated gap (observed). If B lands after A's `list` and before A's first edit, rule L1 does not apply (A has no operation yet) and rule L3 classifies the change as `holds` with no heads-up. A then repaints the five files it knows and lands; the seahorse stays pink in the real pool too. Rule X0 covers this window for search premises (8.6) but not for listings. The conductor avoids the window: it creates B's intent only after A's first `op.recorded`. Appendix C asks `01-core.md` for an `info` heads-up in this case.

### 8.4 Landing order 2: the repaint lands while the seahorse is in flight

This order is not a conflict. It is the same as the owner asking for the repaint and, a minute later, asking for a seahorse: the repaint was true of every creature when it landed. Premise does not force B to be gold.

B is still told, because B read `creatures/fish.js` as an example and A changed it (observed):

| B's state when A lands | Rule on `file:creatures/fish.js` | B receives |
| --- | --- | --- |
| Has read, has written nothing | **X0** (`no_patch_yet`) | An `info` heads-up with the diff of `fish.js` and A's intent text. No go-around. |
| Has written `seahorse.js` | **F4**, triage | With Clef: its answer (7.3 of 01-core). Without Clef: one `confirm` turn with the diff. |

A standing rule ("creatures are always gold") is a different intent. It belongs in shared code, for example a palette in `world/`, and would be a held change.

### 8.5 The "same changes, merged by plain git" pool

Landing order 1 replayed by rule 11.7: B's `write`, then A's `ops_first`, the nine repaints of the five seed files. The plain-merge pool shows every seed creature gold, and three pink seahorses.

- **TP23.** `ops_first` is what an attempt held when its first heads-up arrived. It equals "what the attempt would have landed" only if the attempt had finished its work by then. The canned scripts guarantee this by holding before `submit`. For a real agent that was sent around in the middle of its work, the plain-merge pool shows half-finished work, and the Floor marks that landing "interrupted" in the comparison (Appendix C, item 12).

| | The pool (`main`) | "same changes, merged by plain git" (`plain`) |
| --- | --- | --- |
| What a person sees | Every creature is gold. | Every creature is gold except the three seahorses, which are pink. |
| Self-test badge | pass | pass |

Why the ordinary checks accept it: B added a new file and A edited other files (text merge: clean; file-level check: disjoint); every import resolves and no signature changed (import index: accepts); the pool is healthy (self-test: passes, observed for both trees). The only thing that knows A's work was about a set, and that the set grew, is the listing premise.

### 8.6 The same catch through a search

Seeded pair P3 (section 9) is the search form. A's intent is "make every creature that swims out one side and back in the other turn around at the walls instead". A runs `search` for `wrap(` in `creatures/` (one container in the seed: `creatures/fish.js#update`) and replaces `wrap(fish);` with `bounce(fish);` and the import. B adds `creatures/ray.js`, whose `update` calls `wrap(ray)`.

| When B lands | Rule on A's premise `text:creatures/:wrap(` | A receives |
| --- | --- | --- |
| After A altered `creatures/fish.js#update` | **QT1**, `repair`, `sweep_incomplete` | `added: ["creatures/ray.js#update"]` with its source. A changes the ray too. |
| After A's search, before A's first edit | **X0**, `holds` | An `info` heads-up with the same `added`. No go-around. |

Plain-merge pool: the fish turns around at the walls; the ray still leaves on one side and comes back on the other.

---

## 9. Seeded intents

Thirty-three intents in the owner's words. "Reads" and "writes" are what a correct attempt is expected to touch; tests of the agent loop compare against them. In every row the attempt also reads `GUIDE.md`. `bounds#FLOOR_Y` means the entity `world/bounds.js#FLOOR_Y`.

Difficulty for a weak model: **E** = one small file or one line, copy the nearest example; **M** = needs two or more shared rules, or a little state; **H** = several files, or reasoning about a unit.

### 9.1 Additive creatures (tier `auto`, one new file each)

| Id | Intent | Reads | Writes | Difficulty and note |
| --- | --- | --- | --- | --- |
| A01 | "a jellyfish that drifts up and down" | `bounds#SURFACE_Y`, `#FLOOR_Y` | `creatures/jellyfish.js` | E. About 20 lines. No energy. The bystander of section 7. |
| A02 | "a seahorse that bobs up and down" | `bounds#SURFACE_Y`, `#FLOOR_Y`; `creatures/fish.js` as an example | `creatures/seahorse.js` | E. Uses `Math.sin` and `world.tick`. Attempt B of section 8. |
| A03 | "a starfish that sits on the sand and slowly turns" | `bounds#FLOOR_Y` | `creatures/starfish.js` | E. Needs `pen.turn` and one `poly`. |
| A04 | "a sea urchin on the sand that waves its spines" | `bounds#FLOOR_Y`; `creatures/anemone.js` as an example | `creatures/urchin.js` | E. Copy the anemone's loop of lines. |
| A05 | "a manta ray that glides in wide slow circles" | `movement#step`, `bounds#keepInside` | `creatures/manta.js` | M. Must turn `age` into a direction with `Math.cos` and `Math.sin`. |
| A06 | "an octopus that is dark at night and bright in the day" | `time#isNight`, `movement#wander`, `#step`, `bounds#bounce` | `creatures/octopus.js` | E. One `if` in `draw`. |
| A07 | "an anglerfish whose light only shows at night" | `time#isNight`, `movement#step`, `bounds#bounce` | `creatures/anglerfish.js` | M. Two looks; must keep the light inside 60 units. |
| A08 | "a school of eight tiny blue fish that stay together" | `creatures/minnow.js` as an example; `energy#ENERGY_MAX`, `movement#steer`, `#wander`, `#glide`, `#step`, `bounds#bounce` | `creatures/sardine.js` | M. Must export `count = 8` and change the kind name in the leader lookup. |
| A09 | "an eel that goes straight for the nearest food" | `energy#ENERGY_MAX`, `food#nearestFood`, `movement#steer`, `#glide`, `#step`, `bounds#keepInside` | `creatures/eel.js` | M. Must opt in to energy and handle "no food" (`null`). No energy number needed. |
| A10 | "a pufferfish that puffs up when another creature comes close" | `movement#distance`, `#wander`, `#step`, `bounds#bounce` | `creatures/pufferfish.js` | M. Loops over `world.creatures`; must skip itself. |
| A11 | "a lobster that walks along the sand and turns around at the walls" | `creatures/snail.js` as an example; `bounds#FLOOR_Y`, `#bounce`, `movement#step` | `creatures/lobster.js` | E. The snail with another drawing. |
| A12 | "a little cleaner fish that follows the turtle around" | `movement#steer`, `#glide`, `#step`, `bounds#keepInside`; `list creatures/` | `creatures/cleaner.js` | M. Finds a creature whose `kind` is `"turtle"`. The string names a listing entry, so a later change to the listing gives it a `confirm` (rule L2). |

### 9.2 Shared-rule changes (tier `held`)

| Id | Intent | Reads | Writes | Difficulty and note |
| --- | --- | --- | --- | --- |
| R01 | "make energy a fraction from 0 to 1" | `world/energy.js` | `world/energy.js#ENERGY_MAX` (one `replace`) | E to edit. The meaning change of section 7. The agent must look at `relied_on_by`. |
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

| Id | Intent | Reads | Writes | Difficulty and note |
| --- | --- | --- | --- | --- |
| P1a | "a crab that hides in its shell when its energy drops below 30" | `energy#ENERGY_MAX`, `bounds#FLOOR_Y`, `#bounce`, `movement#step` | `creatures/crab.js` | M to write. H to repair: after the heads-up the model must connect `30` to the changed unit. Attempt C of section 7. |
| P1b | "a shrimp that darts every two seconds and spends 5 energy on each dart" | `energy#ENERGY_MAX`, `#drain`, `time#seconds`, `movement#wander`, `#glide`, `#step`, `bounds#bounce` | `creatures/shrimp.js` | M to write. M to repair: the number sits in a call to `drain`. Attempt H of section 7. |
| P2a | "repaint every creature in gold" | `list creatures/`; every creature file | colour constants in every creature file | H. Five reads and nine `replace` calls in the seed. Fits `max_paths` only while the pool has at most 16 kinds. Attempt A of section 8. |
| P3a | "make every creature that swims out one side and back in the other turn around at the walls instead" | `search` for `wrap(` in `creatures/`; each file found; `bounds#bounce` | each `update` that calls `wrap`, and its import | M. One file in the seed. |
| P3b | "a ray that glides across the pool and comes back in on the other side" | `bounds#wrap`, `movement#step` | `creatures/ray.js` | E. |
| P4b | "make the day half as long" | `time#DAY_TICKS` | `world/time.js#DAY_TICKS`: `3600` → `1800` | E to write. After a go-around it must halve the new value, or stop: the two intents contradict. |
| P5b | "a crab that walks sideways and waves one big claw" | `bounds#FLOOR_Y`, `#bounce`, `movement#step` | `creatures/crab.js` | E to write. M after the go-around: it must choose another file name or build on the crab that landed. |
| P6b | "a lily pad that floats on the water line" | `bounds#SURFACE_Y` | `creatures/lily.js` | E. With R04 it is sent around and has nothing to change. |
| P8b | "a sailfish that always swims at top speed" | `movement#MAX_SPEED`, `#step`, `bounds#wrap` | `creatures/sailfish.js` | E. With R03 it is sent around and has nothing to change if it used the constant. |

### 9.4 The pairs

Every rule named in this table was observed in the simulator with the seed of 2.1. "Order 1" is the row's first intent landing while the second is in flight; "order 2" is the reverse.

| Pair | Intents | The key they share | Order 1 | Order 2 | In the plain-merge pool | Self-test sees it |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | R01 with P1a and P1b | `entity:world/energy.js#ENERGY_MAX` | E2 (entity read), F3 (file read) or B1 (not read) to the creature | QR1 to R01 | Crabs never leave their shells; shrimp collapse | shrimp only |
| P2 | P2a with A02 | `listing:creatures/` | no conflict (8.4): X0 or F4 on the example file | L1 to P2a | One kind is not gold | no |
| P3 | P3a with P3b | `text:creatures/:wrap(` | no conflict | QT1 to P3a (X0 before its first edit) | The ray still crosses the walls | no |
| P4 | R02 with P4b | `entity:world/time.js#DAY_TICKS` | E1 with OP1 (its `replace` no longer matches) to P4b | the same to R02 | Text conflict: the second change is skipped and counted | n/a |
| P5 | P1a with P5b | `file:creatures/crab.js` (both pinned at `absent`) | F1 with OP5 to P5b | the same to P1a | By rule 11.7 the later `write` replaces the earlier crab file (OP5 is not applied there). A text merge would report that both sides add the file (Appendix C, item 14). | n/a |
| P6 | R04 with P6b | `entity:world/bounds.js#SURFACE_Y` | E2 to P6b; it acknowledges without an edit | QR1 to R04 | No visible break | no. The designed false-abort probe (14.4). |
| P7 | R06 with P3b | `entity:world/bounds.js#wrap` | E2 to P3b: the function it calls no longer does what it relies on | QR1 to R06 | The ray turns around instead of coming back | no |
| P8 | R03 with P8b | `entity:world/movement.js#MAX_SPEED` | E2 to P8b; nothing to change | QR1 to R03 | No visible break | no. A second false-abort probe. |

P4 and P5 are the cases a text merge does report. P4 is in the list so that the plain-merge pool's "text conflict" counter is not always zero, and so that the choice card (GL3, GL4) has a seeded case. P5 is in the list because two people asking for "a crab" is the most likely accident in a live session.

---

## 10. Scripted agents for the Swarm

A scripted agent is a small state machine that calls the same seven Trunk tools as a real agent (01-core section 4), with `agent_kind: "synthetic"`. It has no model. Everything it shows is under the SYNTHETIC banner.

### 10.1 The Swarm pool

- Seed `tidepool-swarm`: the tree of 2.1, the policy variant of section 6, and four pre-made scripted creatures `creatures/s0000.js` to `s0003.js` (template T-plain below, colours `teal`, `red`, `blue`, `green`, speeds 1, 1.5, 2, 2.5).
- **SW1.** A Swarm run is fully determined by its `SwarmConfig`. Agent *n* (0, 1, 2, ...) draws all its choices from `mulberry32(H32(seed + ":" + n))`, where `H32` is the first 8 hex digits of `H()` read as an integer.

```ts
type SwarmConfig = {
  seed: number;
  agents: number;                 // how many to launch in total
  launch_per_second: number;
  collision_dial: number;         // 0 to 1 (10.4)
  think_ms: [number, number];     // wait between two tool calls of one agent, uniform; default [50, 400]
  rescale_every_s: number;        // 0 = never; default 15 (10.4)
  hold_before_submit?: string[];  // pattern ids that wait for the conductor before `submit` (7.11)
};
```

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

"Truth" is the ground-truth label used by metrics 14.4 and 14.5: the premise keys the change really depends on.

| Pattern | Tool calls, in order | Truth | What it does when a heads-up arrives |
| --- | --- | --- | --- |
| `add-plain` | `list creatures/`; `read GUIDE.md`; `read` entities `bounds#bounce`, `movement#step`, `movement#wander`; `write` T-plain to a fresh name; `submit` | `bounce`, `step`, `wander` | `repair` on one of them: `read` it again, acknowledge "still valid". |
| `add-energy` | `list creatures/`; `read GUIDE.md`; `read` entities `bounds#bounce`, `movement#step`, `energy#ENERGY_MAX`; parse the value *V* of `ENERGY_MAX` from its source; `write` T-energy with threshold `0.3 × V` (the text `30` or `0.3`); `submit` | `ENERGY_MAX`, `bounce`, `step` | `repair` (E2) or `confirm` (B1) on `ENERGY_MAX`: parse the new *V* from `after`; `replace` the old threshold text with `0.3 × V`; acknowledge "rescaled the threshold". |
| `add-relative` | as `add-energy`, with T-relative | `bounce`, `step` (not `ENERGY_MAX`) | `repair` on `ENERGY_MAX`: acknowledge with no edit. This is the designed false abort. |
| `rescale-energy` | `read` entity `energy#ENERGY_MAX`; `replace` `ENERGY_MAX = 100` with `ENERGY_MAX = 1`, or the reverse, whichever applies; `submit` | `ENERGY_MAX`, and every referrer with an absolute threshold | `repair` (QR1): for each added referrer, `read` its file; if it holds the T-energy line with a number, `replace` the number with `0.3 × new V`; acknowledge. `repair` (E1): another rescale landed first; end the attempt with reason `superseded`. |
| `retune` | pick one of `movement#MAX_SPEED` (3, 3.5, 4), `food#FOOD_EVERY` (30, 20, 40), `energy#REST_TICKS` (300, 240, 360), `time#DAY_TICKS` (3600, 2400, 4800); `read` the entity; `replace` its current value with the next in the cycle; `submit` | that entity | `repair` (E1, with OP1): `read` it again; `replace` from the new current value; acknowledge. |
| `edit-creature` | pick one of `s0000` to `s0003`; `read` entity `#SPEED`; `replace` `const SPEED = <a>;` with the next of (1, 1.5, 2, 2.5); `submit` | that entity | as `retune`. |
| `sweep-colour` | `list creatures/`; take the first four kinds in name order; for each: `read` the file, `replace` its first colour constant with the next palette name; `submit` | `listing:creatures/` | `repair` (L1): for each added file, the same edit; acknowledge. |
| `sweep-search` | `search` for `wander(creature, 0.05)` in `creatures/`; for the first three containers: `read`, `replace` with `wander(creature, 0.1)`; `submit` | the query | `repair` (QT1): the same edit in each added container; acknowledge. `info` (X0): the same edit before its own first edit. |
| `same-file` | agents come in pairs; both `write` T-plain to the same fresh name `creatures/d<number>.js`; `submit` | `file:` at `absent` | `repair` (F1, with OP5): `write` to the next free name; acknowledge. |
| `cosmetic` | `read world/energy.js`; `replace` one comment line with a reworded one from a fixed list; `submit` | none | It must never cause a heads-up for an attempt of another pattern (E0, F2). A run in which it does is a failed run. Two `cosmetic` attempts can meet on the same line: the later one's `replace` no longer matches (OP1), and it ends its attempt with reason `superseded`. |
| `reader` | `read` the whole file `world/energy.js`; then `add-plain` | `bounce`, `step`, `wander` | Triage (F4) when `energy.js` changes: `confirm` → acknowledge "does not use energy". Measures the cost of wide reads. |
| `blind` | `read GUIDE.md`; `write` T-plain; `submit` | `bounce`, `step`, `wander` | `confirm` (B1) at submit: acknowledge. Measures the cost of blind spots. |

Deliberate premise breaks: who breaks whom.

| A landing by | breaks a premise of | Premise | Rule | A true dependency |
| --- | --- | --- | --- | --- |
| `rescale-energy` | `add-energy` in flight | `entity:…#ENERGY_MAX` | E2, or B1 at submit | yes |
| `rescale-energy` | `add-relative` in flight | the same | E2 | no: false abort |
| `rescale-energy` | `reader` in flight | `file:world/energy.js` | F4 (triage) | no |
| `add-energy`, `add-relative` | `rescale-energy` in flight | `refs:…#ENERGY_MAX` | QR1 | yes for `add-energy` |
| `retune` of X | `retune` of X in flight | `entity:` X (edited) | E1 + OP1 | yes |
| `edit-creature` of K | `edit-creature` of K in flight | `entity:` K`#SPEED` | E1 + OP1 | yes |
| any `add-*` | `sweep-colour` after its first edit | `listing:creatures/` | L1 | yes |
| any `add-*` | `sweep-colour` before its first edit | the same | L3 (no heads-up) | yes: counted as an escape (8.3) |
| `add-plain` | `sweep-search` | `text:creatures/:wander(creature, 0.05)` | QT1, or X0 before its first edit | yes |
| `same-file` | its partner | `file:` at `absent` | F1 + OP5 | yes |
| `cosmetic` | no attempt of another pattern | | E0, F2 | |

- **SW2 (oracle).** After a run, for every landed file made from T-energy, the threshold number divided by `ENERGY_MAX` at head MUST be 0.3. Each file that fails is one escape. This is checked from the final tree, independent of Trunk's own judgments.
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

A measurement run reports, for each *d* in 0, 0.1, 0.25, 0.5 and 1: landings per second, time to land p50 and p99, go-around rate, false-abort rate from the truth labels, escape count from SW2, and waiting-behind (14.1 to 14.6).

---

## 11. Risks of the demo codebase

| # | Risk | What the design does | What remains |
| --- | --- | --- | --- |
| 1 | A real model writes the crab without a number in points (`ENERGY_MAX * 0.3`). The hero then has nothing to show. | The seeded wording carries the number (TP21). The seed shows no relative threshold in creature code: seed creatures use `isHungry`. | The pools look the same and the Floor says so (TP20). The Replay recording uses the canned cast. |
| 2 | A real model gives a creature energy without referencing `ENERGY_MAX` (`energy: 100`). No rule fires. | Opt-in (TP16), guide rule 3, every example. S5 measures the rate (TP22). The self-test's `energy_range` catches it after landing; the green line reverts. | A stated limit: Premise tracks direct references. |
| 3 | A dependency through another shared rule. `drain(creature, 5)` passes a number in the unit of `ENERGY_MAX` to a function whose own code never changes. The call references `drain`, not `ENERGY_MAX`. | Opt-in (TP16): a creature that has energy references `ENERGY_MAX` in its `spawn`, so its file is caught as a whole. The shrimp of section 7 is this case. | A file that spends or gives energy without having energy itself (a hunter that drains its prey by a fixed amount) references only `drain`. No rule fires for it. Stated limit in the README; Appendix C, item 7. |
| 4 | A change to a hot shared entity sends every in-flight agent back. | Energy is opt-in, so only energy creatures reference `ENERGY_MAX`. Other amounts are derived, so one entity changes. Cosmetic edits change no hash (7.7). The held card shows the blast radius before the tap. | Energy creatures that used only relative amounts are sent back once with nothing to change (pairs P6, P8 measure this). |
| 5 | Agents read whole shared files. Every unrelated change to that file then goes to triage for them. | Shared modules are small and split by topic. Guide rule 1 asks for reads by name. `reader` measures the cost. | Without Clef each such case costs one `confirm` turn. |
| 6 | A weak model cannot finish a sweep over several files (P2a). | Colours are one-line constants (TP18). The seed has five kinds. | Marked H. S5 decides whether it is in the live set. The canned sweep serves Replay. |
| 7 | A sweep touches more than 16 paths and cannot land (`MAX_PATHS`). | Seeded sweeps are run while the pool is small. | A universal intent over a large pool has to be done in shared code. Reported in Appendix C. |
| 8 | A listing gains an entry between an agent's `list` and its first edit, and nobody is told (8.3). | The conductor orders the canned run around it. The search form is covered by X0. | A real gap for listing sweeps until `01-core.md` changes (Appendix C). The Swarm counts it as an escape. |
| 9 | A value in an old unit survives a hot swap (a creature at 64 points in a pool whose full is now 1). | Any change outside `creatures/` restarts the pool from tick 0 (4.7 step 2). | The pool visibly restarts on shared-rule landings. |
| 10 | A creature's code throws, returns broken numbers, or loops forever. | Guard and bench (TP10); `settle`; the Floor's reload to `green` (HO8); ST4 makes the green line red. | An endless loop freezes that frame until the reload. |
| 11 | A creature draws words or covers the pool. | Section 3.4: no text operation exists; 40 shapes inside 60 units; surface caps in the host. | A small picture made of shapes is possible (PN10). |
| 12 | Pool code changes a built-in to interfere with other creatures or the host. | PN9 freezes built-ins before any pool module loads. | None known inside the frame; the frame is the boundary. |
| 13 | The self-test flakes. | No clocks, no timers, seeded random numbers, a fixed number of ticks, two identical runs compared. Reference duration under 0.2 s. | The Browser Run harness itself (S4). |
| 14 | Old module graphs pile up in a long-lived frame. | A restart after `MAX_ADOPTS` adopts and on every shared-rule change (4.7). | None. |
| 15 | The pool looks dead or unreadable on a projector. | TP9; the `visible` check; saturated palette on dark water; rest and arrival are shared rules, so every kind gets them. | Three pools side by side shrink each to a third. |
| 16 | Two intents choose the same kind name. | It is a seeded pair (P5): F1 with OP5, and the second agent goes around. | The second agent may choose a poor new name. |
| 17 | Held shared rules stall a scripted run. | The Swarm seed's policy variant (section 6), stated on the banner. | None. |
| 18 | The break in the plain-merge pool is called staged. | It is built by rule 11.7 from the recorded operations, served by the same app server, labelled "constructed", and never shown with substituted code (TP20). | It is a construction, and the label says so. |
| 19 | A fix to an existing creature function costs an extra `confirm` for every shared rule that function already called (7.6 step 6). | The canned script includes the turn. | Extra model turns for real agents. Reported in Appendix C. |

---

## Appendix A. Acceptance checks

Observed on the reference implementation with seed 7 and 3600 ticks unless stated. Tests assert the bounds, not the observed values.

| # | Tree | Bound that MUST hold | Observed |
| --- | --- | --- | --- |
| A1 | The seed | Verdict `ok`. Every kind's rest share at most 0.10. | `ok`; all 0. Two runs of 3600 ticks in under 0.1 s in Node 22. |
| A2 | The seed, 36,000 ticks | Every kind's rest share at most 0.10. | Highest: minnow 0.060. |
| A3 | Seed + canned crab, shrimp, jellyfish, energy in points (before S lands in order 2) | Verdict `ok`. Shrimp rest share at most 0.15. | `ok`; shrimp 0.056. |
| A4 | The result of section 7 in the real pool (`ENERGY_MAX = 1`, `< 0.3`, `0.05`) | Verdict `ok`. Shrimp rest share at most 0.15. Crab hidden at most 0.10 of ticks. Crab mean speed at least 0.8. | `ok`; 0.056; 0.017; 0.98. |
| A5 | The plain-merge pool of section 7 (`ENERGY_MAX = 1`, `< 30`, `5`) | Verdict not `ok`. `failed` is exactly `[{ not_exhausted, shrimp }]`. Shrimp rest share at least 0.60. Crab hidden on every tick. Crab speed 0. Crab rest share at most 0.25. | not `ok`; exactly that; 0.817; 1.000; 0; 0.000 (0.035 over 14,400 ticks). |
| A6 | Section 8, both pools (all gold; all gold but the seahorse) | Both verdicts `ok`. | both `ok`. |
| A7 | Seed + the three templates of 10.2 | Verdict `ok`. | `ok`. |
| A8 | Every seed module and every canned file | Parses; every import resolves (CK5); every global is in the policy list (CK6). | Globals used: `Array`, `Boolean`, `Infinity`, `JSON`, `Math`, `NaN`, `Number`, `Object`, `parseInt`, `undefined`. No unresolved import. |

Rule outcomes that tests MUST reproduce with the pure core, using the seed of 2.1 and the canned operations:

| # | Scenario | Expected judgments, in order |
| --- | --- | --- |
| A9 | 7.5 | Card for S with blast radius `repair: [C, H]`. At S's landing: C `entity:world/energy.js#ENERGY_MAX` E2 `repair`; H `file:world/energy.js` F3 `repair`; nothing for J. Final: S, C, H, J landed as 1, 2, 3, 4; go-arounds 0, 1, 1, 0. |
| A10 | 7.5 variant 1c | Nothing for C at S's landing. At C's submit: `entity:world/energy.js#ENERGY_MAX` B1 `confirm`; status `needs_confirm`. Then `validated`. |
| A11 | 7.6 | At the landing of C and H: S `refs:world/energy.js#ENERGY_MAX` QR1 `repair` with the four added referrers; S's card closed. S's next submit: B1 `confirm` for `step`, `bounce`, `seconds`, `wander`, `glide`. Next submit: `held`. Final head as in 7.6 step 8. |
| A12 | 7.7 | Comment-only landing: F2 `holds` for H, nothing for C, no heads-up. `REST_TICKS` landing: F4 triage for H, nothing for C. |
| A13 | 8.3 | A `listing:creatures/` L1 `repair`, `added: ["seahorse.js"]`. In the early window: L3 `holds`, no heads-up. |
| A14 | 8.4 | B `file:creatures/fish.js`: X0 with an `info` heads-up when B has no operation; F4 triage when it has. |
| A15 | 8.6 | A `text:creatures/:wrap(` QT1 `repair`, `added: ["creatures/ray.js#update"]`; X0 `info` in the early window. |
| A16 | 9.4, P4 to P8 | P4: E1 `repair` with dropped operation OP1. P5: F1 `repair` with dropped operation OP5; the second candidate is skipped as `not_disjoint` in the tick. P6: E2 `repair`, then `validated` with no new operation. P7: E2 `repair` on `world/bounds.js#wrap`. |

---

## Appendix B. Constants

Pool constants are exported by the pool's files and listed in section 2. Platform constants:

| Constant | Value | Notes |
| --- | --- | --- |
| `HOST_SEED` | 7 | Default seed of a pool page. |
| `HOST_MAX_CATCH_UP` | 5 | Ticks per animation frame at most. |
| `HOST_MAX_REACH` | 200 | Largest clip radius the surface accepts. |
| `HOST_MAX_OPS` | 256 | Shape calls between one `push` and its `pop`. |
| `STATS_EVERY_MS` | 1,000 | |
| `HEAD_POLL_MS` | 5,000 | The slow self-check. |
| `SWAP_MIN_MS` | 500 | |
| `MAX_ADOPTS` | 100 | Adopts before one restart. |
| `PLAIN_PROBE_DELAY_MS` | 1,500 | Second probe to a frame on `plain`. |
| `POOL_STALL_MS` | 5,000 | The Floor's watchdog for a frame. |
| `MAX_KINDS` | 64 | Kinds in one registry. |
| `APP_FILE_RATE_PER_MIN` | 1,200 | Version-pinned file requests per client address. |
| `SELFTEST_TIMEOUT_MS` | 10,000 | Whole harness, including page load. |

Self-test constants (exported by `selftest/`): `SELFTEST_TICKS` 3600, `SELFTEST_SEED` 7, `DRAW_EVERY` 300, `MAX_REST_SHARE` 0.25, `MIN_DRAWN` 16, `MAX_STATE_CHARS` 200,000.

---

## Appendix C. Points where this file needs `01-core.md` to agree

Each item is designed around here. Each needs a decision in `01-core.md`.

| # | Where | What this file does | What is needed |
| --- | --- | --- | --- |
| 1 | SE15: "serves only paths that exist in the requested ref" | Adds three generated modules under names that start with `~` (AS3). The registry cannot come from the listing otherwise. | Allow these three names in SE15. |
| 2 | SE16: the channel schema | Gives `probe` the meaning "look for a new version now", adds the optional field `selftest`, and defines the fields of `stats` (4.5). | Adopt the types of 4.5. |
| 3 | 11.7 and 12.1 | The Floor has no event that says the plain-merge repo moved. This file probes on `landing.landed` and again after a delay. | An event (for example `plain.pushed`) with the plain-merge commit. |
| 4 | 10.2, 11.4: previews "by the app server" | Needs a read-only Trunk call for an attempt view at an expected `(head_seq, last op_seq)`, which records no premise (AS6, 4.9 option D). | Define that call. |
| 5 | Rule L3 | A listing that gains an entry while the attempt has listed and not yet edited gives no heads-up (8.3). A later sweep misses the new entry. | An `info` heads-up when the attempt has no operation yet, as X0 does for searches. |
| 6 | Rule B1 with the definition of `NewRefs` | An attempt that fixes one line of an existing function gets a blind-spot `confirm` for every outside entity that function already referenced (7.6 step 6). | Consider limiting blind spots to references the attempt added. |
| 7 | 6.3: direct references only | A dependency on a meaning through another shared function is not tracked (risk 3): `drain(creature, 5)` references `drain`, whose hash does not change when `ENERGY_MAX` does. The pool makes every energy creature reference `ENERGY_MAX` in `spawn` (TP16), which covers creatures but not every possible file. | State the limit in 01-core 2.4 "Known limits". |
| 8 | 13.2: `PUBLIC_RATE_PER_MIN` 120 | One page load fetches about 25 modules; three pools side by side exceed the limit. This file counts version-pinned files separately (AS8). | Confirm the separate limit. |
| 9 | 01-core Appendix C: `MAX_PATHS` 16 | A sweep over more than 16 creature files cannot land as one change (risk 7). | Confirm, or raise the cap for `auto` paths. |
| 10 | 10.1: the example policy | This pool's policy uses `creatures/*.js` (not `creatures/**`), adds `GUIDE.md`, and leaves `Symbol` out of `globals`. | Replace the example with the file of section 6. |
| 11 | 6.5 and the vector pool | The vector pool's creatures call `drain(fish, 1)` and set `energy: 60` as numbers. In the real pool such numbers would break when the scale changes (TP15 forbids them in the seed). The vectors stay valid as vectors. | Note in 6.5 that the real pool is the one in this file. |
| 12 | 11.7: `ops_first` | An attempt that was sent around in the middle of its work contributes half-finished work to the plain-merge pool (TP23). | Mark such a landing in the plain-merge record (for example when the attempt had not yet submitted), so the Floor can label it. |
| 13 | Rule L2 | An attempt whose code names any kind as a string (`"turtle"`, `"minnow"`) and that listed `creatures/` gets a `confirm` each time any creature lands, even when the name it uses is unaffected (observed for intent A12). | Consider limiting L2 to the gained or lost names. |
| 14 | 11.7: replay "without OP3 and OP5" | Two attempts that create the same file (pair P5): the later `write` silently replaces the earlier file in the plain-merge pool. A text merge would report a conflict. | Count a `write` whose base has moved as a text conflict in the plain-merge pool, or say in 11.7 why not. |
| 15 | Rule L3 at Swarm scale | Every scripted creature agent lists `creatures/`. Each batch that adds a creature records one L3 judgment for every in-flight lister. With 1,000 in flight that is about 1,000 rows per batch. | Confirm the cost in the scale run, or record L3 without a row. |
