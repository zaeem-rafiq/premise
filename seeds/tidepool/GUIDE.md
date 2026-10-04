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
