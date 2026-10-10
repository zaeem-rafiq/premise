// `ViewState` (03-floor 4.2): the local state, never from the stream and never sent anywhere.
// What is on screen is `render(FloorState, ViewState, clock)` (FL1).

import type { FloorJson } from "../../protocol/floor-json.ts";

export type SheetTarget =
  | { kind: "none" }
  | { kind: "card"; card_id: string }
  | { kind: "why"; seq: number }
  | { kind: "who"; kind_: string; key: string }
  | { kind: "undo"; seq: number }
  | { kind: "about" }
  | { kind: "owner" }
  | { kind: "kill" }
  | { kind: "rebuild" }
  | { kind: "shortcuts" };

export type Toast = { id: number; text: string };

export type ViewState = {
  pool: string; // the id of the main pool, from the address (FE7)
  settings: FloorJson; // the content of /floor.json, read once
  view: "floor" | "compare" | "swarm" | "overview";
  mode: "live" | "replay";
  sheet: SheetTarget;
  git_drawer: boolean;
  tab: "working" | "landed" | "stopped";
  expanded: string[]; // attempt ids the owner expanded
  draft: string; // the text in the intent box
  pending: Record<string, string>; // requests in flight, by request_id -> purpose
  owner: boolean;
  connection: "connecting" | "open" | "lost";
  connectionTries: number;
  pool_paused: boolean; // the viewer paused the pool frames (P)
  frames: Record<string, { stats: unknown; at: number; fell_back: boolean }>;
  theme: "dark" | "light";
  size: "stage" | "laptop";
  shortcuts: boolean; // single-key shortcuts on (AX13)
  replay: {
    recording: string | null;
    position: number; // event index
    playing: boolean;
    speed: number;
    progress: number; // load progress 0..1
    error: string | null; // a filled replay.error sentence
  };
  toasts: Toast[];
};

export function initViewState(opts: {
  pool: string;
  settings: FloorJson;
  mode: "live" | "replay";
  theme: "dark" | "light";
  size: "stage" | "laptop";
}): ViewState {
  return {
    pool: opts.pool,
    settings: opts.settings,
    view: "floor",
    mode: opts.mode,
    sheet: { kind: "none" },
    git_drawer: false,
    tab: "working",
    expanded: [],
    draft: "",
    pending: {},
    owner: false,
    connection: "connecting",
    connectionTries: 0,
    pool_paused: false,
    frames: {},
    theme: opts.theme,
    size: opts.size,
    shortcuts: true,
    replay: { recording: null, position: 0, playing: false, speed: 1, progress: 0, error: null },
    toasts: [],
  };
}
