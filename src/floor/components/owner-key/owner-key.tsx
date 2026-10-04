// The owner-key entry of 3.17: the dialog holds one password field (owner.key_label,
// autocomplete="current-password" so a password manager can fill it), the buttons
// owner.unlock and owner.cancel, and owner.lock when unlocked. CO45: the key is typed or
// pasted only; it is sent only in the body of POST /api/session on its own origin, never
// stored, shown or logged. CO46: in Replay the dialog cannot open - the header shows
// owner.replay instead.

import { useContext, useEffect, useRef, useState } from "react";
import { ShellContext } from "../../app/context.ts";
import { sessionPath } from "../../stream/urls.ts";
import { errorSentence } from "../../../copy/errors.ts";

export type OwnerState = "visitor" | "checking" | "owner" | "wrong" | "not_configured" | "wait" | "saving";

export function OwnerDialog({
  onDone,
  onClose,
  unlocked,
  onToast,
}: {
  onDone: (owner: boolean) => void;
  onClose: () => void;
  /** Whether the session is the owner's: `owner.lock` shows only then (3.17). */
  unlocked?: boolean;
  /** FR22: a failed request is reported next to the control and as a toast. */
  onToast?: (line: string) => void;
}) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  const [key, setKey] = useState("");
  const [state, setState] = useState<OwnerState>("visitor");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const unlock = async () => {
    if (key === "") return;
    setState("checking");
    try {
      const response = await fetch(sessionPath(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      });
      if (response.ok) {
        onDone(true);
        return;
      }
      if (response.status === 401 || response.status === 403) setState("wrong");
      else if (response.status === 503) setState("not_configured");
      else if (response.status === 429) setState("wait");
      else setState("wrong");
      setKey("");
    } catch {
      setState("wrong");
      setKey("");
    }
  };

  const lock = async () => {
    setState("saving");
    let failed = false;
    try {
      const response = await fetch(sessionPath(), { method: "DELETE" });
      failed = !response.ok;
    } catch {
      failed = true;
    }
    // FR22: a lock the server did not take is reported; the session stays the owner's.
    if (failed) {
      onToast?.(errorSentence(null));
      setState("visitor");
      return;
    }
    onDone(false);
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet owner-sheet"
        role="dialog"
        aria-label={t("owner.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="sheet-title">{t("owner.title")}</h2>
        <p>{t("owner.body")}</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void unlock();
          }}
        >
          <label className="field">
            <span>{t("owner.key_label")}</span>
            <input
              ref={ref}
              type="password"
              autoComplete="current-password"
              value={key}
              disabled={state === "checking" || state === "not_configured"}
              onChange={(event) => setKey(event.target.value)}
            />
          </label>
          {state === "checking" && <p>{t("owner.checking")}</p>}
          {state === "wrong" && <p className="field-error">{t("owner.wrong")}</p>}
          {state === "not_configured" && <p className="field-error">{t("owner.not_configured")}</p>}
          {state === "wait" && <p className="field-error">{t("owner.wait")}</p>}
          <div className="sheet-actions">
            <button
              type="submit"
              className="primary"
              disabled={key === "" || state === "checking" || state === "not_configured"}
            >
              {t("owner.unlock")}
            </button>
            <button type="button" onClick={onClose}>
              {t("owner.cancel")}
            </button>
            {unlocked === true && (
              <button type="button" disabled={state === "saving"} onClick={() => void lock()}>
                {t("owner.lock")}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
