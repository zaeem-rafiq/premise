// The kill switch of 3.18 and `01-core.md` SE10 to SE12: a dialog with `kill.title`,
// `kill.body`, the checkbox `kill.landings`, the buttons `kill.confirm` and `kill.cancel`.
// Two taps, no typing (CO47). The page shows what the request changed only from events
// (CO48): the dialog reports the request's failure; `limits.killed` is the only truth.

import { useContext, useState } from "react";
import { ShellContext } from "../../app/context.ts";
import { killPath } from "../../stream/urls.ts";
import { errorSentence } from "../../../copy/errors.ts";

export function KillDialog({ onClose }: { onClose: () => void }) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  const [landings, setLandings] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kill = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(killPath(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(landings ? { killed: true, landings: false } : { killed: true }),
      });
      if (!response.ok) setError(errorSentence(response.status));
      else onClose();
    } catch {
      setError(errorSentence(null));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet kill-sheet" role="dialog" aria-label={t("kill.title")} onClick={(e) => e.stopPropagation()}>
        <h2 className="sheet-title">{t("kill.title")}</h2>
        <p>{t("kill.body")}</p>
        <label className="field field-check">
          <input type="checkbox" checked={landings} onChange={(event) => setLandings(event.target.checked)} />
          <span>{t("kill.landings")}</span>
        </label>
        {error !== null && <p className="field-error">{error}</p>}
        <div className="sheet-actions">
          <button type="button" className="danger" disabled={saving} onClick={() => void kill()} autoFocus>
            {saving ? t("kill.stopping") : t("kill.confirm")}
          </button>
          <button type="button" onClick={onClose}>
            {t("kill.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** `kill.allow` (banner 3, the header button when killed): POST { killed: false }, which
 * also resumes a pool the owner paused (SE12). */
export async function allowAgents(): Promise<boolean> {
  try {
    const response = await fetch(killPath(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ killed: false }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
