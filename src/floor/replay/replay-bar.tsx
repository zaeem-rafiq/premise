// The Replay bar of 03-floor 2.7 and 3.16: play/pause, restart, the position, a track with
// chapter marks, the chapter keys, the speed and close; `replay.ended` and its two buttons
// after the last event (RY19); `replay.skipped` for 3 s after a gap jump (RY14).
//
// RY19 (the bar at its end): the ended controls take the place of the play/restart cluster
// and the chapter caption - Pause does nothing once the last event is applied, `replay.again`
// is restart, and `replay.to_live` is close. The position and the track keep their places:
// the track keeps at least half the bar's width, and on a narrower laptop it wraps to a row
// of its own rather than squeeze. The chapter marks are thinned to the ones that fit without
// overlapping - a dropped mark's chapter still answers its key of 6.6.

import { useContext, useEffect, useRef, useState } from "react";
import { ShellContext } from "../app/context.ts";
import { clock as clockText } from "../../copy/format.ts";
import { REPLAY_SPEEDS } from "../../protocol/constants.ts";
import type { ReplayChapter, ReplayPlayer } from "./player.ts";

/** The least space two chapter-mark centres may stand without their buttons touching:
 * a mark is centred on its position and about 22 px wide. */
const MARK_MIN_GAP_PX = 26;

export function ReplayBar({ player, onClose }: { player: ReplayPlayer; onClose: () => void }) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  const snap = player.snapshot();
  const chapterAt = player.chapters.findIndex((c) => c.start > snap.position) - 1;
  const currentChapter = chapterAt >= 0 ? player.chapters[chapterAt] : player.chapters[player.chapters.length - 1];

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
          <button
            key={chapter.key}
            type="button"
            className="replay-mark"
            style={{
              left: `clamp(11px, ${snap.duration === 0 ? 0 : (chapter.start / snap.duration) * 100}%, calc(100% - 11px))`,
            }}
            title={chapter.name}
            onClick={() => player.seekChapter(chapter.key)}
          >
            {chapter.key}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="replay-bar" role="region" aria-label={t("replay.menu.title")} data-ended={snap.ended || undefined}>
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
          <span className="replay-caption">{currentChapter?.caption ?? ""}</span>
          {snap.skipped && <span className="replay-skipped">{t("replay.skipped", { duration: "…" })}</span>}
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
  );
}
