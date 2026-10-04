// The Swarm: the configuration the launcher takes and the request the route accepts.
// Source: 02-tidepool 10.1 (SwarmConfig), 01-core SWR1 (SwarmRequest).

/** The configuration of one Swarm run (02-tidepool 10.1). */
export type SwarmConfig = {
  seed: number;
  agents: number;
  launch_per_second: number;
  collision_dial: number;
  think_ms: [number, number];
  rescale_every_s: number;
  hold_before_submit?: string[];
};

/** `POST /api/swarm` (SWR1). A request that starts agents carries all of `SwarmConfig`. */
export type SwarmRequest = Partial<SwarmConfig> & {
  pool: string; // the pool the scripted agents work in; it must exist
  running: boolean; // false: stop launching in this pool; agents in flight finish
  patterns?: string[]; // launch exactly these pattern ids (02-tidepool 10.3), one scripted agent each, in this order
  release?: string[]; // pattern ids named in `hold_before_submit` whose agents may now call `submit`
  request_id: string;
};
