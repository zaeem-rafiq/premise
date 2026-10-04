// The postMessage channel between the Floor page and a pool frame (SE16). The Floor checks
// `event.source` is its iframe, validates the shape, and treats every string as text.

export type FloorToPool =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "probe"; selftest?: boolean } // live frames: look for a new version now; with selftest, also run the in-page self-test
  | { type: "advance"; version: string } // commit frames only (Replay, card previews): load this version token (PV5) without a page reload
  | { type: "highlight"; kinds: string[] }; // any frame: outline the creatures of these kinds (Who relies); [] clears

export type PoolToFloor =
  | { type: "tapped"; creature: string; path: string } // the kind name and its file path
  | {
      type: "stats";
      source: string;
      version: string;
      seq: number | null;
      tick: number;
      paused: boolean;
      kinds: Record<string, { count: number; resting: number; errors: number; benched: boolean }>;
      shown: number;
      total: number;
      swap: { mode: "adopt" | "restart"; arrived: string[]; failed: string[] } | null;
      selftest: { version: string; ok: boolean; failed: Array<{ name: string; kind: string | null }> } | null;
    };
