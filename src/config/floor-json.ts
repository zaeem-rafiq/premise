// `/floor.json`: the static settings built with the deployment (FJ1, 03-floor 4.5). The build script
// `scripts/build/floor-json.ts` writes the same object into `public/floor.json`, so the page and the
// engine cannot disagree.

import type { FloorJson } from "../protocol/floor-json.ts";
import { HOST_SEED } from "../protocol/constants.ts";
import { FEATURES } from "./features.ts";
import { DEFAULT_POOL, SWARM_POOL } from "./pools.ts";
import { PREWRITTEN } from "./prewritten.ts";
import { MODEL_SHORT_NAMES } from "./model-plan.ts";
import { limitsList } from "./limits.ts";

/** The text of `about.related.body` (03-floor 5.4): the page and the README show the same words. */
export const RELATED_BODY =
  'STORM (arXiv 2605.20563), CoAgent (arXiv 2606.15376) and the entry "dibs" also check what agents ' +
  "relied on. Premise observes reads at entity, listing and search level, checks them live, and " +
  "stores the record in git notes.";

/** `swarm_defaults`: the `SwarmConfig` fields the page has no control for (03-floor 4.5).
 * `launch_per_second` takes the start value the Swarm view's own rehearsal used (02-tidepool VE6). */
export const SWARM_DEFAULTS: FloorJson["swarm_defaults"] = {
  seed: HOST_SEED,
  launch_per_second: 50,
  think_ms: [50, 400],
  rescale_every_s: 15,
};

export function floorJson(): FloorJson {
  return {
    default_pool: DEFAULT_POOL,
    swarm_pool: SWARM_POOL,
    features: FEATURES,
    prewritten: [...PREWRITTEN],
    swarm_defaults: SWARM_DEFAULTS,
    models: MODEL_SHORT_NAMES,
    limits: limitsList(FEATURES),
    related: RELATED_BODY,
    default_view: "overview",
  };
}
