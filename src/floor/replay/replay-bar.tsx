// The Replay bar of 03-floor 2.1, 2.7 and 3.16: one region in two rows (the lead's decision of
// 2026-10-09). The transport row holds play/pause, restart, the position, the track with its
// chapter marks, the speed and close. After the last event `replay.ended` and its two buttons
// take the place of play/restart, speed and close (RY19): `replay.again` is restart and
// `replay.to_live` is close. The chapter row holds a named button per chapter (D42; each also
// answers its key of 6.6) and, beside them, the caption of the current chapter (8.5), with
// `replay.skipped` for 3 s after a gap jump (RY14). The track takes the width its row leaves;
// its chapter marks are thinned to the ones that fit without overlapping.

import { useContext, useEffect, useRef, useState } from "react";
import { ShellContext } from "../app/context.ts";
import { clock as clockText } from "../../copy/format.ts";
import { REPLAY_SPEEDS } from "../../protocol/constants.ts";
import type { ReplayChapter, ReplayPlayer } from "./player.ts";
import "./replay-bar.css";

/** Minimum spacing for the chapter marks drawn on the track. The named chapter buttons are in the row below. */
const MARK_MIN_GAP_PX = 26;

export function ReplayBar({ player, onClose }: { player: ReplayPlayer; onClose: () => void }) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  const snap = player.snapshot();
  const currentChapter = player.chapters.find((chapter) => chapter.key === snap.chapter);

  // The track's pixel width decides how many chapter marks stand without overlapping:
  // each sits at its recorded-time position, and two closer than MARK_MIN_GAP_PX would
  // cover each other. The earliest of a cluster stays (the list is in order of position).
  const trackRef = useRef<HTMLDivElement>(null);
  const [trackWidth, setTrackWidth] = useState(0);
  useEffect(() => {
    const el = trackRef.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setTrackWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const marks: ReplayChapter[] = [];
  let lastMarkX = -Infinity;
  for (const chapter of player.chapters) {
    const raw = snap.duration === 0 ? 0 : (chapter.start / snap.duration) * trackWidth;
    const x = Math.max(
      MARK_MIN_GAP_PX / 2,
      Math.min(raw, Math.max(MARK_MIN_GAP_PX / 2, trackWidth - MARK_MIN_GAP_PX / 2)),
    );
    if (x - lastMarkX < MARK_MIN_GAP_PX) continue;
    marks.push(chapter);
    lastMarkX = x;
  }

  const position = (
    <span className="replay-position">
      {t("replay.position", { clock: [clockText(snap.position), clockText(snap.duration)] })}
    </span>
  );
  const track = (
    <div className="replay-track-wrap" ref={trackRef}>
      <input
        type="range"
        className="replay-track"
        min={0}
        max={snap.duration}
        value={snap.position}
        onChange={(event) => player.seek(Number(event.target.value))}
        aria-label={t("replay.position", { clock: [clockText(snap.position), clockText(snap.duration)] })}
      />
      <div className="replay-marks" aria-hidden="true">
        {marks.map((chapter) => (
          <span
            key={chapter.key}
            className="replay-mark"
            style={{
              left: `clamp(11px, ${snap.duration === 0 ? 0 : (chapter.start / snap.duration) * 100}%, calc(100% - 11px))`,
            }}
            title={chapter.name}
          />
        ))}
      </div>
    </div>
  );

  return (
    <div className="replay-bar" role="region" aria-label={t("replay.menu.title")} data-ended={snap.ended || undefined}>
      <div className="replay-transport">
        {snap.ended ? (
          <>
            <span className="replay-ended">
              {t("replay.ended")}{" "}
              <button type="button" className="replay-button" onClick={() => player.restart()}>
                {t("replay.again")}
              </button>{" "}
              <button type="button" className="replay-button" onClick={onClose}>
                {t("replay.to_live")}
              </button>
            </span>
            {position}
            {track}
          </>
        ) : (
          <>
            <div className="replay-buttons">
              <button
                type="button"
                className="replay-button"
                onClick={() => player.toggle()}
                aria-label={snap.playing ? t("replay.pause") : t("replay.play")}
              >
                {snap.playing ? t("replay.pause") : t("replay.play")}
              </button>
              <button type="button" className="replay-button" onClick={() => player.restart()}>
                {t("replay.restart")}
              </button>
            </div>
            {position}
            {track}
            <button
              type="button"
              className="replay-speed"
              onClick={() => player.stepSpeed(1)}
              title={t("replay.speed", { x: snap.speed })}
            >
              {t("replay.speed", { x: snap.speed })}
            </button>
            <button type="button" className="replay-close" onClick={onClose}>
              {t("replay.close")}
            </button>
          </>
        )}
      </div>
      <div className="replay-chapters">
        {player.chapters.map((chapter) => (
          <button
            key={chapter.key}
            type="button"
            title={chapter.name}
            aria-current={chapter.key === snap.chapter ? "step" : undefined}
            onClick={() => player.seekChapter(chapter.key)}
          >
            {chapter.name}
          </button>
        ))}
        <span className="replay-caption">{currentChapter?.caption ?? ""}</span>
        {snap.skipped && <span className="replay-skipped">{t("replay.skipped", { duration: "…" })}</span>}
      </div>
    </div>
  );
}
