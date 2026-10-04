// The Replay bar of 03-floor 2.7 and 3.16: play/pause, restart, the position, a track with
// chapter marks, the chapter keys, the speed and close; `replay.ended` and its two buttons
// after the last event (RY19); `replay.skipped` for 3 s after a gap jump (RY14).

import { useContext } from "react";
import { ShellContext } from "../app/context.ts";
import { clock as clockText } from "../../copy/format.ts";
import { REPLAY_SPEEDS } from "../../protocol/constants.ts";
import type { ReplayPlayer } from "./player.ts";

export function ReplayBar({ player, onClose }: { player: ReplayPlayer; onClose: () => void }) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  const snap = player.snapshot();
  const chapterAt = player.chapters.findIndex((c) => c.start > snap.position) - 1;
  const currentChapter = chapterAt >= 0 ? player.chapters[chapterAt] : player.chapters[player.chapters.length - 1];
  return (
    <div className="replay-bar" role="region" aria-label={t("replay.menu.title")}>
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
      <span className="replay-position">
        {t("replay.position", { clock: [clockText(snap.position), clockText(snap.duration)] })}
      </span>
      <div className="replay-track-wrap">
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
          {player.chapters.map((chapter) => (
            <button
              key={chapter.key}
              type="button"
              className="replay-mark"
              style={{ left: `${snap.duration === 0 ? 0 : (chapter.start / snap.duration) * 100}%` }}
              title={chapter.name}
              onClick={() => player.seekChapter(chapter.key)}
            >
              {chapter.key}
            </button>
          ))}
        </div>
      </div>
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
      {snap.ended ? (
        <span className="replay-ended">
          {t("replay.ended")}{" "}
          <button type="button" className="replay-button" onClick={() => player.restart()}>
            {t("replay.again")}
          </button>{" "}
          <button type="button" className="replay-button" onClick={onClose}>
            {t("replay.to_live")}
          </button>
        </span>
      ) : null}
      <button type="button" className="replay-close" onClick={onClose}>
        {t("replay.close")}
      </button>
    </div>
  );
}
