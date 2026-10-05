// The `edit-creature` canned pattern (02-tidepool.md 10.3): draw one of `s0000` to `s0003`,
// `read` its `#SPEED` entity, `replace` `const SPEED = <a>;` with the next of
// (1, 1.5, 2, 2.5), `submit`. Heads-up answers are `retune`'s (the row's "as `retune`"):
// `repair` (E1, with OP1) — `read` the entity again, `replace` from the new current value,
// acknowledge; everything else takes the defaults of SW6, and a held agent waits before its
// first `submit` (SW8, SWR3).

import type { Pattern } from "../pattern.ts";
import { SPEEDS } from "../templates.ts";
import { makeCycleEdit } from "./retune.ts";

/** The `edit-creature` row's four creatures, in table order. */
export const EDIT_CREATURE: Pattern = makeCycleEdit(
  "edit-creature",
  "retune a creature's speed",
  [0, 1, 2, 3].map((k) => ({
    path: `creatures/s000${k}.js`,
    entity: "SPEED",
    values: SPEEDS,
  })),
);
