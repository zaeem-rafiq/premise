// `/floor.json`: the static settings the page reads before anything else (03-floor 4.5).
// The values come from `src/config/` — the build writes the same file into `public/` (FJ1).

export const FEATURE_KEYS = ["held", "race", "undo", "green", "clef", "attempt_repos", "mcp", "text_merge", "try"] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** The SHOULD features the build has (FJ1). `green` says which runtime the build has (GR5) or "none". */
export type Features = {
  held: boolean; // 10.2 in full: previews, blast radius, risk lines, `land_now`. false: the minimal form (HD1)
  race: boolean; // 11.4
  undo: boolean; // 11.3: the owner's Undo, the undo-plan and undo routes
  green: "none" | "static" | "full"; // 11.5: no verification | static checks only (GR5) | the isolate self-test
  clef: boolean; // triage (7.3), risk (10.4) and contradiction (GL4) questions
  attempt_repos: boolean; // 11.5a
  mcp: boolean; // 07-mcp: outside agents over MCP
  text_merge: boolean; // 11.7 PM3a: the plain-merge pool merges each change three ways (added 2026-10-10)
  try: boolean; // 09-try: a visitor's "Try it" button and `POST /api/try` (added 2026-10-14)
};

export type PrewrittenIntent = {
  id: string; // the id of 02-tidepool section 9, for example "A01", "P1b", "P9a"
  text: string;
  group: "starter" | null;
  race: boolean;
};

/** The fields of `/floor.json` (03-floor 4.5, FJ1). */
export type FloorJson = {
  default_pool: string; // the main pool at `/`
  swarm_pool: string; // the pool of Swarm view; created with summary_only: true
  features: Features; // 01-core FJ1; this file adds no key
  prewritten: PrewrittenIntent[];
  swarm_defaults: {
    seed: number;
    launch_per_second: number;
    think_ms: [number, number];
    rescale_every_s: number;
  }; // the SwarmConfig fields the page has no control for
  models: Record<string, string>; // model id -> short name
  limits: string[]; // the limits list of 5.12, lines whose condition is false left out
  related: string; // the text of `about.related.body`, so the page and the README show the same words
  /** 2.11 (2026-10-10): the view a live page opens on. Absent: the Floor view. */
  default_view?: "floor" | "overview";
};
