// The Rebuild confirmation of FR11/LP8: the paused banner's `pool.rebuild` button opens
// this dialog (pool.rebuild.title/body/confirm), and only its confirm posts
// `POST /api/pools/{pool}/rebuild` (4.5). Failures show the 5.9 sentence here and as a
// toast (FR22); a 401 is the ended owner session of FR21.

import { useContext, useRef, useState } from "react";
import { ShellContext } from "../../app/context.ts";
import { errorSentence } from "../../../copy/errors.ts";

export function RebuildDialog({
  pool,
  onClose,
  onToast,
  onExpired,
  offline,
}: {
  pool: string;
  onClose: () => void;
  onToast?: (line: string) => void;
  onExpired?: () => void;
  /** FR10/CO3: connection lost - the owner control is off. */
  offline?: boolean;
}) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const rebuild = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/pools/${encodeURIComponent(pool)}/rebuild`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request_id: crypto.randomUUID() }),
      });
      if (response.status === 401) {
        onExpired?.();
        return;
      }
      if (!response.ok) {
        const line = errorSentence(response.status);
        setError(line);
        onToast?.(line);
      } else {
        onClose();
      }
    } catch {
      const line = errorSentence(null);
      setError(line);
      onToast?.(line);
    } finally {
      setSaving(false);
      inFlight.current = false;
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet rebuild-sheet"
        role="dialog"
        aria-label={t("pool.rebuild.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="sheet-title">{t("pool.rebuild.title")}</h2>
        <p>{t("pool.rebuild.body")}</p>
        {error !== null && <p className="field-error">{error}</p>}
        <div className="sheet-actions">
          <button
            type="button"
            className="danger"
            disabled={saving || offline === true}
            onClick={() => void rebuild()}
            autoFocus
          >
            {t("pool.rebuild.confirm")}
          </button>
          <button type="button" onClick={onClose}>
            {t("kill.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
