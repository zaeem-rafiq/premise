// The trees the green line's isolate tests run (02-tidepool Appendix A): the seed (A1) and the
// plain-merge pool of the hero (A5), built the way test/tidepool/scenarios/hero.test.ts builds them.

import { SwarmSim, tidepoolAutoFiles, tidepoolFiles } from "../../integration/collide/harness.ts";
import { conduct } from "../../tidepool/scenarios/conduct.ts";

/** A1: the seed `tidepool`. */
export function seedTree(seed: "tidepool" | "tidepool-auto" = "tidepool"): Map<string, string> {
  return new Map(Object.entries(seed === "tidepool" ? tidepoolFiles() : tidepoolAutoFiles()));
}

/** A5: the hero's order-1 result with the old-scale values the plain merge keeps (7.8): the crab's
 * `30` and the shrimp's `5` under `ENERGY_MAX = 1`. */
export function a5Tree(seed: "tidepool" | "tidepool-auto" = "tidepool"): Map<string, string> {
  const s = new SwarmSim(seed === "tidepool" ? tidepoolFiles() : tidepoolAutoFiles(), {
    seed: 7,
    synthetic: true,
    features_held: seed === "tidepool",
  });
  const { conductor } = conduct(s, 1, seed);
  if (!conductor.done) throw new Error("the hero conductor did not finish");
  const files = new Map(s.files());
  const crab = files.get("creatures/crab.js")!;
  const shrimp = files.get("creatures/shrimp.js")!;
  if (!crab.includes("crab.energy < 0.3") || !shrimp.includes("drain(shrimp, 0.05)")) {
    throw new Error("the hero tree no longer has the values A5 rewrites");
  }
  files.set("creatures/crab.js", crab.replace("crab.energy < 0.3", "crab.energy < 30"));
  files.set("creatures/shrimp.js", shrimp.replace("drain(shrimp, 0.05)", "drain(shrimp, 5)"));
  return files;
}
