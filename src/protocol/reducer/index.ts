// The shared reducer (EV5): `FloorState`, the `reduce` function and the metrics computation of EM5.
// The Floor page, the Floor Durable Object and Replay all reduce the same stream with these.

export type {
  AttemptView,
  CardView,
  FileView,
  FloorState,
  HeadsUpView,
  LandingDigest,
  LandingEntry,
  LandingView,
  MetricsEvent,
  PremiseView,
} from "./state.ts";
export { emptyFloorState, premiseId } from "./state.ts";
export { HANDLED_TYPES, reduce } from "./reduce.ts";
export { computeMetrics } from "./metrics.ts";
export type { MetricsBody } from "./metrics.ts";
