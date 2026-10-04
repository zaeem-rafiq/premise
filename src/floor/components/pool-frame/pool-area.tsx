// The pool area of the Floor view (docs/spec/03-floor.md 2.1, the "pool area" of the wireframes):
// what is on `main` — the pool frame and, with the tiles slice, the file tiles. Slice 1 registers
// this region for the shell through app/wiring/pool-area.ts.

import { PoolFrame } from "./pool-frame.tsx";
import type { PoolFrameProps } from "./pool-frame.tsx";

export type PoolAreaProps = PoolFrameProps;

export function PoolArea(props: PoolAreaProps) {
  return <PoolFrame {...props} />;
}
