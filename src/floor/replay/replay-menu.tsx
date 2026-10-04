// The Replay menu (3.16, 8.2): the list of recordings of `/replay/index.json`, or
// `replay.none` when it is empty. Choosing one navigates to `/replay/{id}` (RY18). The
// `replay.save` row (owner, live) downloads the pool's export (4.5).

import { useContext } from "react";
import { ShellContext } from "../app/context.ts";
import { duration } from "../../copy/format.ts";
import type { RecordingIndex } from "./player.ts";

export function ReplayMenu({
  index,
  owner,
  pool,
  onPick,
  onClose,
}: {
  index: RecordingIndex | null;
  owner: boolean;
  pool: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  const recordings = index?.recordings ?? [];
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet replay-menu"
        role="dialog"
        aria-label={t("replay.menu.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="sheet-title">{t("replay.menu.title")}</h2>
        {recordings.length === 0 ? (
          <p>{t("replay.none")}</p>
        ) : (
          <ul className="replay-list">
            {recordings.map((entry) => (
              <li key={entry.id}>
                <button type="button" className="replay-item" onClick={() => onPick(entry.id)}>
                  {t("replay.menu.item", {
                    title: entry.title ?? entry.id,
                    duration: duration(entry.duration_ms ?? 0),
                    date: (entry.recorded_at ?? "").slice(0, 10),
                  })}
                </button>
              </li>
            ))}
          </ul>
        )}
        {owner && (
          <a className="replay-save" href={`/api/pools/${encodeURIComponent(pool)}/replay.ndjson`} download>
            {t("replay.save")}
          </a>
        )}
        <div className="sheet-actions">
          <button type="button" onClick={onClose}>
            {t("owner.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
