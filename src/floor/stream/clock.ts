// The stream clock of FL9: every "x seconds ago", every timer and every duration uses the
// stream clock and the event field `ts`, never `t`. In live mode the stream clock is the
// browser clock plus an offset: the largest value seen on this connection of (`ts` of an
// event minus the browser clock when that event arrived), so an event that arrives late
// never moves the clock. In Replay the clock is the Replay clock (RY13): the player owns it.

export type StreamClock = { time(): number };

/** The live-mode stream clock. `note(ts)` is called as each event arrives. */
export class LiveClock implements StreamClock {
  private offset: number | null = null;
  private readonly now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }
  note(ts: number): void {
    const offset = ts - this.now();
    if (this.offset === null || offset > this.offset) this.offset = offset;
  }
  time(): number {
    return this.now() + (this.offset ?? 0);
  }
}
