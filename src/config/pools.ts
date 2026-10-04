// The deployment's own pools (PL1). `seed` of `POST /api/pools` names one of `SEEDS`, the seed trees
// built into the deployment (`seeds/` and `scripts/seeds/`).

/** The main pool at `/`: the `default_pool` of `/floor.json`. */
export const DEFAULT_POOL = "tidepool";

/** The pool of Swarm view: the `swarm_pool` of `/floor.json`, created with `summary_only: true` (PL1). */
export const SWARM_POOL = "tidepool-swarm";

/** The seed names `POST /api/pools` accepts (PL1): `tidepool` (with its held-path policy),
 * `tidepool-auto` (the same tree under which shared-rule files are `auto`), `tidepool-swarm`. */
export const SEEDS = ["tidepool", "tidepool-auto", "tidepool-swarm"] as const;

export type SeedName = (typeof SEEDS)[number];
