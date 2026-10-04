// The Replay file format: NDJSON, one header line then one `PoolEvent` per line in ascending `n`.
// Source: 01-core 12.3.

import type { PoolEvent } from "./events.ts";

/** `premise_replay` of the header (the format version). */
export const REPLAY_FORMAT = 2;

/** Line 1 of a Replay file (01-core 12.3). */
export type ReplayHeader = {
  premise_replay: typeof REPLAY_FORMAT;
  pool: string;
  recorded_at: string; // ISO time
  events: number; // the number of event lines that follow
  synthetic: boolean; // the SYNTHETIC label
  build: string; // the git commit of the build
  label: string;
};

/** A parsed Replay line: the header, or one event. The exporter (RP1) tests every line
 * against the patterns of `redact()` before it exports. */
export type ReplayLine = ReplayHeader | PoolEvent;
