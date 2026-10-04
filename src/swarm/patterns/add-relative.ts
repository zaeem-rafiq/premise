// The `add-relative` canned pattern (02-tidepool.md 10.3): `add-energy` with template T-relative,
// so `ENERGY_MAX` is not in its truth list and an `E2` repair on it is acknowledged with no edit —
// the designed false abort (the `changed: false` of HU12). Everything else is `add-energy`.

import type { Pattern } from "../pattern.ts";
import { makeEnergyAdd } from "./add-energy.ts";

export const ADD_RELATIVE: Pattern = makeEnergyAdd({
  id: "add-relative",
  intent: "add a creature",
  truth: ["entity:world/bounds.js#bounce", "entity:world/movement.js#step"],
  relative: true,
  rescaleOnE2: false,
});
