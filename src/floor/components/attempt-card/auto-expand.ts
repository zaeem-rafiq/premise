import type { FloorState } from "../../../protocol/reducer/state.ts";
import { AUTO_EXPAND_MAX } from "../../../protocol/constants.ts";

/** CO11: retain the two newest panels across the rail, regardless of their attempt. */
export function autoExpandedPanels(state: FloorState): { attemptId: string; hn: number }[] {
  return Object.values(state.attempts)
    .flatMap((attempt) =>
      Object.values(attempt.heads_ups)
        .filter((panel) => panel.result === "repair" || panel.result === "confirm")
        .map((panel) => ({ attemptId: attempt.id, hn: panel.hn, ts: panel.ts })),
    )
    .sort((a, b) => a.ts - b.ts)
    .slice(-AUTO_EXPAND_MAX)
    .map(({ attemptId, hn }) => ({ attemptId, hn }));
}
