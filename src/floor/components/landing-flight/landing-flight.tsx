// The landing moment of 03-floor 6.4: when `landing.landed` arrives (FL3), the change's card
// shrinks to a chip and travels to the pool frame (720 ms), and the frame's water rings once.
// It reads only `FloorState` for what landed; the positions it reads from the page are where the
// attempt's card and the pool frame are drawn now. With reduced motion nothing travels (6.4).

import "./landing-flight.css";

import { useEffect, useRef } from "react";
import type { FloorState } from "../../../protocol/reducer/state.ts";

/** 6.4: the chip's travel. */
const FLIGHT_MS = 720;
/** A replay seek or a reconnect can deliver many landings at once: then nothing flies. */
const FLIGHT_MAX_AT_ONCE = 2;

export type LandingFlightProps = {
  floor: FloorState;
  reducedMotion: boolean;
};

/** The seqs whose landing has its `landing.landed`. */
function landedSeqs(floor: FloorState): number[] {
  return floor.landed_order.filter((seq) => {
    const entry = floor.landings[seq];
    if (entry === undefined) return false;
    return entry.digest === true ? entry.landed_ts !== null : entry.landed !== null;
  });
}

export function LandingFlight({ floor, reducedMotion }: LandingFlightProps) {
  const seen = useRef<Set<number> | null>(null);
  const opened = useRef(0);
  // The reducer may update the state object in place, so the effect keys on the landed seqs
  // themselves, not on the object.
  const now = landedSeqs(floor);
  const key = now.join(",");

  useEffect(() => {
    // What arrives with the page's first events has already landed: a page that opens does not
    // replay it. Until the stream has delivered anything (`n` 0), every landing counts as old.
    if (seen.current === null || opened.current === 0) {
      seen.current = new Set(now);
      opened.current = floor.n;
      return;
    }
    const fresh = now.filter((seq) => !seen.current!.has(seq));
    for (const seq of fresh) seen.current.add(seq);
    if (fresh.length === 0 || fresh.length > FLIGHT_MAX_AT_ONCE || reducedMotion) return;
    for (const seq of fresh) {
      const entry = floor.landings[seq];
      const attemptId = entry !== undefined && entry.digest !== true ? entry.attempt_id : null;
      fly(attemptId);
    }
    // `floor` is read for the newest entries only; `key` says when they change.
  }, [key, reducedMotion, floor.n === 0]);

  return null;
}

/** The chip leaves the attempt's card (rail or Overview), travels to the frame and rings it. */
function fly(attemptId: string | null): void {
  if (typeof document === "undefined") return;
  const frame = document.querySelector<HTMLElement>(".floor-body .pf-body");
  if (frame === null) return;
  const to = frame.getBoundingClientRect();
  if (to.width === 0 || to.height === 0) return;
  const source =
    attemptId === null ? null : document.querySelector<HTMLElement>(`[data-attempt-id="${CSS.escape(attemptId)}"]`);
  const from = source?.getBoundingClientRect() ?? null;

  if (from !== null && from.width > 0 && typeof document.body.animate === "function") {
    const chip = document.createElement("div");
    chip.className = "landing-chip";
    chip.setAttribute("aria-hidden", "true");
    chip.style.left = `${from.left}px`;
    chip.style.top = `${from.top}px`;
    chip.style.width = `${from.width}px`;
    chip.style.height = `${from.height}px`;
    document.body.appendChild(chip);
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const animation = chip.animate(
      [
        { transform: "translate(0, 0) scale(1)", opacity: 0.95 },
        { transform: `translate(${dx * 0.35}px, ${dy * 0.35}px) scale(0.35)`, opacity: 1, offset: 0.35 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.08)`, opacity: 0 },
      ],
      { duration: FLIGHT_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
    );
    animation.onfinish = () => {
      chip.remove();
      ring(frame);
    };
    animation.oncancel = () => chip.remove();
    return;
  }
  ring(frame);
}

/** One ring on the frame's water, from the centre, gone within 720 ms. */
function ring(frame: HTMLElement): void {
  if (typeof frame.animate !== "function") return;
  const wave = document.createElement("div");
  wave.className = "landing-ring";
  wave.setAttribute("aria-hidden", "true");
  frame.appendChild(wave);
  const animation = wave.animate(
    [
      { transform: "translate(-50%, -50%) scale(0.05)", opacity: 0.9 },
      { transform: "translate(-50%, -50%) scale(1)", opacity: 0 },
    ],
    { duration: FLIGHT_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
  );
  animation.onfinish = () => wave.remove();
  animation.oncancel = () => wave.remove();
}
