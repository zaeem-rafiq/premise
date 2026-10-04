// The single-key map of 03-floor 6.6 (keys on while `ViewState.shortcuts`; `nav.shortcuts`
// in About turns them off, AX13). Keys do nothing while a field, a button or a sheet has
// focus, except Escape, which closes the topmost thing. Replay adds its own keys (RY26).

import { useEffect } from "react";

export type KeyAction =
  | "focus-intent" // /
  | "view-floor" // F
  | "view-swarm" // S
  | "view-about" // A
  | "view-compare" // C
  | "needs-you" // N: oldest card that needs the owner
  | "tab-landed" // L
  | "git-drawer" // G
  | "pause-frames" // P
  | "kill" // K
  | "replay-default" // R
  | "theme" // T
  | "type-size" // Z
  | "shortcuts" // ?
  | "escape" // Esc
  // Replay only (6.6):
  | "replay-toggle" // Space
  | "replay-chapter" // 1..9, key has the digit
  | "replay-prev" // ArrowLeft
  | "replay-next" // ArrowRight
  | "replay-slower" // ,
  | "replay-faster" // .
  | "replay-restart"; // 0

export type KeyEvent = { action: KeyAction; digit?: number };

const KEYMAP: Record<string, KeyAction> = {
  "/": "focus-intent",
  f: "view-floor",
  s: "view-swarm",
  a: "view-about",
  c: "view-compare",
  n: "needs-you",
  l: "tab-landed",
  g: "git-drawer",
  p: "pause-frames",
  k: "kill",
  r: "replay-default",
  t: "theme",
  z: "type-size",
  "?": "shortcuts",
};

const REPLAY_KEYMAP: Record<string, KeyAction> = {
  " ": "replay-toggle",
  ArrowLeft: "replay-prev",
  ArrowRight: "replay-next",
  ",": "replay-slower",
  ".": "replay-faster",
  "0": "replay-restart",
};

/** Translate a DOM key event into a KeyEvent, or null when the key is not bound. */
export function mapKey(event: { key: string; replay: boolean }): KeyEvent | null {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (event.replay) {
    if (/^[1-9]$/.test(key)) return { action: "replay-chapter", digit: Number(key) };
    const action = REPLAY_KEYMAP[key];
    if (action !== undefined) return { action };
  }
  const action = KEYMAP[key];
  return action === undefined ? null : { action };
}

/** True while focus is in a field, a button, a link or a sheet - where keys do not bind. */
export function keysHeld(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.closest("input, textarea, select, [contenteditable], .sheet") !== null ||
    target.tagName === "BUTTON" ||
    target.tagName === "A"
  );
}

/**
 * Installs the page keymap. `Escape` always reaches `onKey`; the rest fire only when no
 * control or sheet holds focus and `shortcuts` is on (AX13).
 */
export function useKeys(opts: { replay: boolean; shortcuts: boolean; onKey: (event: KeyEvent) => void }): void {
  const { replay, shortcuts, onKey } = opts;
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onKey({ action: "escape" });
        return;
      }
      if (!shortcuts || event.metaKey || event.ctrlKey || event.altKey) return;
      if (keysHeld(event.target)) return;
      const mapped = mapKey({ key: event.key, replay });
      if (mapped === null) return;
      event.preventDefault();
      onKey(mapped);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [replay, shortcuts, onKey]);
}
