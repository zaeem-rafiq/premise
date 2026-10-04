// The Replay machinery of 03-floor section 8: the 8.3 loading checks, the Replay clock
// (RY13 to RY15), seeking by rebuilding state (RY16) and the chapters of 8.5. Pure of the
// DOM and of the network: `loadRecording` takes `fetch`, the player takes its clock and
// scheduler, so the unit tests run it all deterministically. A recording is played through
// the same reducer and the same components as the live stream (8.1, `01-core.md` 12.3).

import { CHAPTER_LEAD_MS, REPLAY_MAX_BYTES, REPLAY_MAX_GAP_MS, REPLAY_SPEEDS } from "../../protocol/constants.ts";
import type { PoolEvent } from "../../protocol/events.ts";
import { REPLAY_FORMAT, type ReplayHeader } from "../../protocol/replay.ts";
import { reduce } from "../../protocol/reducer/reduce.ts";
import { emptyFloorState, type FloorState } from "../../protocol/reducer/state.ts";
import { CHAPTERS, CHAPTER_CONFLICT_COMPARE } from "../../copy/cards.ts";
import type { REPLAY_ERRORS } from "../../copy/replay.ts";
import { RECORDING_TEXTS } from "./recordings.ts";

/** One entry of `/replay/index.json` (8.2). Only `id` is required: `file` may point at the
 * export route of a kept pool (RY7) and the header of the file itself is the truth (RY8). */
export type RecordingEntry = {
  id: string;
  file?: string;
  title?: string;
  duration_ms?: number;
  events?: number;
  bytes?: number;
  synthetic?: boolean;
  recorded_at?: string;
};

export type RecordingIndex = {
  v?: number;
  default?: string | null;
  recordings?: RecordingEntry[];
};

export type Recording = { header: ReplayHeader; events: PoolEvent[] };

/** The check of 8.3 that failed, and the fills of its `replay.error` sentence. */
export type ReplayFailure = {
  check: keyof typeof REPLAY_ERRORS;
  vars: Record<string, string | number>;
};

export type ParsedRecording = { ok: true; recording: Recording } | { ok: false; failure: ReplayFailure };

/** The URL a recording id is fetched from when the index names no `file` (8.2, RY7). */
export function recordingFileUrl(id: string): string {
  return `/replay/${encodeURIComponent(id)}.ndjson`;
}

/** The recordings menu: `GET /replay/index.json` when it answers, otherwise the embedded
 * fixtures (8.2). The menu only decides what the menu shows; the file's header is the truth. */
export async function loadRecordingIndex(
  get: typeof fetch,
): Promise<{ index: RecordingIndex | null; source: "network" | "embedded" }> {
  try {
    const response = await get("/replay/index.json");
    if (response.ok) {
      const index = (await response.json()) as RecordingIndex;
      return { index, source: "network" };
    }
  } catch {
    // No deployment serves the file in this build: the embedded index stands in.
  }
  return { index: embeddedIndex(), source: "embedded" };
}

/** The menu the embedded fixtures make when `/replay/index.json` is not served (RY8: every
 * field here is read off the embedded files' own headers, never typed in). */
function embeddedIndex(): RecordingIndex {
  const recordings = Object.entries(RECORDING_TEXTS).map(([id, text]) => {
    const { header, events } = headerAndEvents(text);
    const times = replayTimes(events);
    const first = times[0] ?? 0;
    return {
      id,
      title: header.label,
      duration_ms: (times[times.length - 1] ?? first) - first,
      events: events.length,
      bytes: byteLength(text),
      synthetic: header.synthetic,
      recorded_at: header.recorded_at,
    };
  });
  return { v: 1, default: recordings[0]?.id ?? null, recordings };
}

/** Header and event lines without the 8.3 validation: used only for the embedded index,
 * where recordings.test.ts has already checked the bytes against the fixtures. */
function headerAndEvents(text: string): { header: ReplayHeader; events: PoolEvent[] } {
  const lines = text.split("\n").filter((line) => line !== "");
  const header = JSON.parse(lines[0] ?? "{}") as ReplayHeader;
  const events = lines.slice(1).map((line) => JSON.parse(line) as PoolEvent);
  return { header, events };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Loads one recording's text. Order: the index's `file` when the index names the id (RY7),
 * then the embedded fixtures, then `/replay/{id}.ndjson` (8.2). Returns null when no source
 * answers — the caller reports the `download` check of 8.3. Makes only the requests of RY1.
 */
export async function loadRecordingText(id: string, get: typeof fetch): Promise<string | null> {
  const { index } = await loadRecordingIndex(get);
  const file = index?.recordings?.find((entry) => entry.id === id)?.file;
  if (file !== undefined) {
    try {
      const response = await get(file);
      if (response.ok) return await response.text();
    } catch {
      // fall through to the embedded copy and the canonical path
    }
  }
  const embedded = RECORDING_TEXTS[id];
  if (embedded !== undefined) return embedded;
  try {
    const response = await get(recordingFileUrl(id));
    if (response.ok) return await response.text();
  } catch {
    // fall through
  }
  return null;
}

/** The checks of 8.3, in the table's order. `download` is reported by the caller (8.3 names
 * the file's arrival, not a parse step). Event lines are only checked for the fields the
 * table names; an event type the reducer does not know is not an error (RY11). */
export function parseRecording(text: string): ParsedRecording {
  if (byteLength(text) > REPLAY_MAX_BYTES) return { ok: false, failure: { check: "too_large", vars: {} } };

  const lines = text.split("\n").filter((line) => line !== "");
  let header: ReplayHeader;
  try {
    header = JSON.parse(lines[0] ?? "") as ReplayHeader;
  } catch {
    return { ok: false, failure: { check: "not_a_recording", vars: {} } };
  }
  if (header.premise_replay !== REPLAY_FORMAT) {
    return { ok: false, failure: { check: "not_a_recording", vars: {} } };
  }

  const eventLines = lines.slice(1);
  if (eventLines.length !== header.events) {
    return {
      ok: false,
      failure: { check: "incomplete", vars: { a: eventLines.length, b: header.events } },
    };
  }

  const events: PoolEvent[] = [];
  for (const [i, line] of eventLines.entries()) {
    let event: PoolEvent;
    try {
      event = JSON.parse(line) as PoolEvent;
    } catch {
      return { ok: false, failure: { check: "damaged_line", vars: { line: i + 2 } } };
    }
    if (
      typeof event.n !== "number" ||
      typeof event.t !== "number" ||
      typeof event.ts !== "number" ||
      typeof event.type !== "string"
    ) {
      return { ok: false, failure: { check: "damaged_line", vars: { line: i + 2 } } };
    }
    events.push(event);
  }

  for (const [i, event] of events.entries()) {
    if (event.n !== i + 1) return { ok: false, failure: { check: "damaged_gap", vars: { n: i + 1 } } };
  }
  for (const [i, event] of events.entries()) {
    const before = events[i - 1];
    if (before !== undefined && event.t < before.t) {
      return { ok: false, failure: { check: "damaged_time", vars: { n: event.n } } };
    }
  }

  return { ok: true, recording: { header, events } };
}

/** RY13: the replay time of event k is the largest `ts` among events 1 to k. `ts` may fall
 * inside the stream (EV4); `t` is never used for spacing. */
export function replayTimes(events: readonly PoolEvent[]): number[] {
  const times = new Array<number>(events.length);
  let max = -Infinity;
  for (const [i, event] of events.entries()) {
    if (event.ts > max) max = event.ts;
    times[i] = max;
  }
  return times;
}

/** One chapter of 8.5: its key is its number in order of position (6.6). */
export type ReplayChapter = {
  key: number; // 1-based, in order of position
  name: string;
  caption: string;
  startIndex: number; // the recorded-time position start, as an event index the clock lands on
  start: number; // replay-time position (ms since the clock's zero)
};

/** 8.5: for each row of the copy table, the index of its first matching event, or -1. */
function chapterStartIndex(events: readonly PoolEvent[], row: number): number {
  for (const [i, event] of events.entries()) {
    switch (row) {
      case 0: // Requests: the first `intent.created`
        if (event.type === "intent.created") return i;
        break;
      case 1: // Held change: the first `card.opened` of kind `held`
        if (event.type === "card.opened" && event.card.kind === "held") return i;
        break;
      case 2: // Conflict: the first `headsup.sent` of result `repair`
        if (event.type === "headsup.sent" && event.result === "repair") return i;
        break;
      case 3: // Second catch: `repair` naming a key of rule QT1 or L1
        if (
          event.type === "headsup.sent" &&
          event.result === "repair" &&
          event.keys.some((key) => key.rule === "QT1" || key.rule === "L1")
        )
          return i;
        break;
      case 4: // Choice: the first `card.opened` of kind `choice`
        if (event.type === "card.opened" && event.card.kind === "choice") return i;
        break;
      case 5: // Undo: the first `undo.planned` of cause `undo`
        if (event.type === "undo.planned" && event.cause === "undo") return i;
        break;
      case 6: // Race: the first `card.opened` of kind `race`
        if (event.type === "card.opened" && event.card.kind === "race") return i;
        break;
      case 7: // Green line: `green.verified` with ok false and confirmed true
        if (event.type === "green.verified" && !event.ok && event.confirmed) return i;
        break;
      case 8: // Swarm: `swarm.state` with running true
        if (event.type === "swarm.state" && event.running) return i;
        break;
    }
  }
  return -1;
}

/**
 * `chapters(events)` (8.5). A chapter starts `CHAPTER_LEAD_MS` of recorded time before its
 * first matching event (clamped to the recording's start), exists only if an event matches,
 * and two chapters starting at the same event keep only the one earlier in the table. The
 * Conflict caption gains `CHAPTER_CONFLICT_COMPARE` when the recording has a plain-merge pool.
 */
export function chapters(events: readonly PoolEvent[]): ReplayChapter[] {
  const times = replayTimes(events);
  const zero = times[0] ?? 0;
  const hasPlain = events.some(
    (event) =>
      event.type === "plain.updated" ||
      (event.type === "pool.state" && event.plain_remote !== null && event.plain_remote !== undefined),
  );

  const found: Array<{ row: number; index: number; start: number }> = [];
  for (let row = 0; row < CHAPTERS.length; row += 1) {
    const index = chapterStartIndex(events, row);
    if (index < 0) continue;
    const start = Math.max(0, (times[index] ?? zero) - CHAPTER_LEAD_MS - zero);
    // Two chapters starting at the same event keep only the one earlier in the table (8.5).
    if (!found.some((other) => other.index === index)) found.push({ row, index, start });
  }
  found.sort((a, b) => a.start - b.start || a.row - b.row);

  return found.map((entry, n) => {
    const caption = CHAPTERS[entry.row]!;
    return {
      key: n + 1,
      name: caption.name,
      caption: entry.row === 2 && hasPlain ? `${caption.caption} ${CHAPTER_CONFLICT_COMPARE}` : caption.caption,
      startIndex: entry.index,
      start: entry.start,
    };
  });
}

/** What the page shows for a player tick (RY13 to RY19). */
export type PlayerSnapshot = {
  floor: FloorState; // the reduced state at `applied` events
  applied: number; // how many events are applied
  total: number; // the recording's event count
  clock: number; // the Replay clock: a replay time (ms since epoch)
  position: number; // clock minus the replay time of event 1 (ms)
  duration: number; // replay time of the last event minus the first (ms)
  playing: boolean;
  speed: number; // one of REPLAY_SPEEDS
  ended: boolean; // the last event is applied (RY19)
  chapter: number; // the current chapter's key, or 0 before the first
  skipped: boolean; // a gap jump happened within the last SKIP_NOTICE_MS
};

/** The wall time the `replay.skipped` note stays on the bar (RY14: "for 3 s"). */
export const SKIP_NOTICE_MS = 3_000;
/** The finest real-time wait between player ticks: the position text and the clock update. */
const TICK_MS = 100;

export type PlayerTimers = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

/**
 * The Replay player. Applies events to `FloorState` as the Replay clock crosses each
 * event's replay time; the clock advances by real time times the speed (RY13). Rebuilds on
 * seek (RY16). Jumps recorded gaps longer than REPLAY_MAX_GAP_MS (RY14).
 */
export class ReplayPlayer {
  private readonly events: readonly PoolEvent[];
  private readonly times: readonly number[];
  readonly chapters: readonly ReplayChapter[];
  readonly zero: number; // replay time of event 1: the clock's start (RY13)
  readonly duration: number; // replay time of the last event minus the first

  private floor: FloorState = emptyFloorState();
  private applied = 0;
  private clockTs: number;
  private lastNow: number;
  private timer: unknown = null;
  private skippedUntil = 0;
  private listeners = new Set<() => void>();
  playing: boolean;
  speed = 1;

  constructor(recording: Recording, timers: PlayerTimers, opts: { playing?: boolean; speed?: number } = {}) {
    this.events = recording.events;
    this.times = replayTimes(recording.events);
    this.chapters = chapters(recording.events);
    this.zero = this.times[0] ?? 0;
    this.duration = (this.times[this.times.length - 1] ?? this.zero) - this.zero;
    this.clockTs = this.zero;
    this.lastNow = timers.now();
    this.timers = timers;
    this.playing = opts.playing ?? true;
    this.speed = opts.speed ?? REPLAY_SPEEDS[1] ?? 1;
    this.applyDue();
    this.arm();
  }

  private readonly timers: PlayerTimers;

  // ---- subscription ----

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  close(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  // ---- the clock ----

  /** Advance the clock by elapsed real time times the speed, capped at the end (RY13). */
  private tick(): void {
    const now = this.timers.now();
    if (this.playing && !this.ended()) {
      let clock = this.clockTs + (now - this.lastNow) * this.speed;
      const end = this.zero + this.duration;
      // RY14: a recorded gap longer than REPLAY_MAX_GAP_MS is jumped, at every speed.
      const next = this.times[this.applied];
      if (next !== undefined && next - clock > REPLAY_MAX_GAP_MS) {
        clock = next - REPLAY_MAX_GAP_MS;
        this.skippedUntil = now + SKIP_NOTICE_MS;
      }
      this.clockTs = Math.min(clock, end);
      this.applyDue();
    }
    this.lastNow = now;
    this.arm();
    this.notify();
  }

  private ended(): boolean {
    return this.applied >= this.events.length;
  }

  private applyDue(): void {
    while (this.applied < this.events.length && this.clockTs >= (this.times[this.applied] ?? Infinity)) {
      reduce(this.floor, this.events[this.applied]!);
      this.applied += 1;
    }
  }

  private arm(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    if (!this.playing || this.ended()) return;
    const next = this.times[this.applied];
    const wait = next === undefined ? TICK_MS : Math.min(TICK_MS, Math.max(0, (next - this.clockTs) / this.speed));
    this.timer = this.timers.setTimeout(() => this.tick(), wait);
  }

  // ---- controls (3.16, 6.6) ----

  play(): void {
    if (this.ended()) return;
    this.playing = true;
    this.lastNow = this.timers.now();
    this.arm();
    this.notify();
  }

  pause(): void {
    this.tickClockToNow();
    this.playing = false;
    this.arm();
    this.notify();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  /** 0 restarts (6.6): back to the first event's replay time, applied from a fresh state. */
  restart(): void {
    this.seekToIndex(0);
  }

  setSpeed(speed: number): void {
    if (!REPLAY_SPEEDS.includes(speed)) return;
    this.tickClockToNow();
    this.speed = speed;
    this.arm();
    this.notify();
  }

  /** `,` and `.` step through REPLAY_SPEEDS (6.6). */
  stepSpeed(direction: -1 | 1): void {
    const at = REPLAY_SPEEDS.indexOf(this.speed);
    const next = REPLAY_SPEEDS[at + direction];
    if (next !== undefined) this.setSpeed(next);
  }

  /** Seek to a recorded-time position (ms since `zero`), the drag of the track (RY16). */
  seek(position: number): void {
    const target = this.zero + Math.max(0, Math.min(position, this.duration));
    let index = 0;
    while (index < this.events.length && (this.times[index] ?? Infinity) <= target) index += 1;
    this.rebuild(index, target);
  }

  /** Jump to a chapter: the clock lands on the chapter's start (8.5, keys 1-9, arrows). */
  seekChapter(key: number): void {
    const chapter = this.chapters.find((entry) => entry.key === key);
    if (chapter === undefined) return;
    this.seek(chapter.start);
  }

  /** `←`/`→`: previous and next chapter (6.6). */
  moveChapter(direction: -1 | 1): void {
    const position = this.clockTs - this.zero;
    const current = this.chapterAt(position);
    const next = this.chapters[current + direction];
    if (next !== undefined) this.seek(next.start);
  }

  private chapterAt(position: number): number {
    let index = -1;
    for (const [i, chapter] of this.chapters.entries()) {
      if (chapter.start <= position) index = i;
      else break;
    }
    return index;
  }

  /** RY16: rebuild `FloorState` for the first `index` events, then play or stay paused.
   * During the rebuild no animation runs and no log line is spoken. */
  private rebuild(index: number, clockTs: number): void {
    const floor = emptyFloorState();
    for (let i = 0; i < index; i += 1) reduce(floor, this.events[i]!);
    this.floor = floor;
    this.applied = index;
    this.clockTs = clockTs;
    this.lastNow = this.timers.now();
    this.applyDue();
    this.arm();
    this.notify();
  }

  private seekToIndex(index: number): void {
    const target = index <= 0 ? this.zero : (this.times[index - 1] ?? this.zero);
    this.rebuild(index, target);
  }

  private tickClockToNow(): void {
    const now = this.timers.now();
    if (this.playing && !this.ended()) {
      this.clockTs = Math.min(this.clockTs + (now - this.lastNow) * this.speed, this.zero + this.duration);
      this.applyDue();
    }
    this.lastNow = now;
  }

  snapshot(): PlayerSnapshot {
    // The clock reads live between ticks: real time times the speed, capped at the end.
    let clock = this.clockTs;
    if (this.playing && !this.ended()) {
      clock = Math.min(clock + (this.timers.now() - this.lastNow) * this.speed, this.zero + this.duration);
    }
    const position = clock - this.zero;
    const chapterIndex = this.chapterAt(position);
    return {
      floor: this.floor,
      applied: this.applied,
      total: this.events.length,
      clock,
      position,
      duration: this.duration,
      playing: this.playing,
      speed: this.speed,
      ended: this.ended(),
      chapter: chapterIndex < 0 ? 0 : this.chapters[chapterIndex]!.key,
      skipped: this.timers.now() < this.skippedUntil,
    };
  }
}
