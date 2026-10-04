// Time is counted in ticks. The pool runs TICKS_PER_SECOND ticks each second.
export const TICKS_PER_SECOND = 60;

// One day and one night together last this many ticks.
export const DAY_TICKS = 3600;

// How far through the day the pool is: 0 at sunrise, 0.5 at sunset, almost 1 just before the next sunrise.
export function dayPhase(world) {
  return (world.tick % DAY_TICKS) / DAY_TICKS;
}

// True from sunset to sunrise.
export function isNight(world) {
  return dayPhase(world) >= 0.5;
}

// How many ticks there are in `s` seconds.
export function seconds(s) {
  return Math.round(s * TICKS_PER_SECOND);
}
