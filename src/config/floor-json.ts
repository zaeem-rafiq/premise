// PLACEHOLDER (Slice 0a, the toolchain scaffold).
//
// `GET /floor.json` carries the static settings of the Floor (03-floor 4.5). Its real shape belongs in
// `src/protocol/floor-json.ts` and its values in this directory (plan 1.1). Until then the file says so.

import { NOT_BUILT } from "../protocol/placeholder.ts";

/** The content of `public/floor.json`, written by `scripts/build/floor-json.ts`. */
export function floorJson(): { status: typeof NOT_BUILT } {
  return { status: NOT_BUILT };
}
