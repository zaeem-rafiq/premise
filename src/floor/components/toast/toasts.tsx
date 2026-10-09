// Toasts (3.19): one sentence each, bottom left, for TOAST_MS; at most three. Every toast
// also goes to the polite live region of the announcer (AX8).

import { useEffect } from "react";
import { TOAST_MS } from "../../../protocol/constants.ts";
import type { Toast } from "../../state/view-state.ts";

import "./toasts.css";

/**
 * `hidden` keeps the toasts mounted, so each still leaves after TOAST_MS, but off screen: Compare view
 * has no free corner, and every toast is also in the live region and on its attempt card (AX14).
 */
export function Toasts({
  toasts,
  onDrop,
  hidden = false,
}: {
  toasts: Toast[];
  onDrop: (id: number) => void;
  hidden?: boolean;
}) {
  const shown = toasts.slice(-3);
  if (shown.length === 0) return null;
  return (
    <div className="toasts" hidden={hidden}>
      {shown.map((toast) => (
        <ToastLine key={toast.id} toast={toast} onDrop={onDrop} />
      ))}
    </div>
  );
}

function ToastLine({ toast, onDrop }: { toast: Toast; onDrop: (id: number) => void }) {
  useEffect(() => {
    const handle = window.setTimeout(() => onDrop(toast.id), TOAST_MS);
    return () => window.clearTimeout(handle);
  }, [toast.id, onDrop]);
  return (
    <div className="toast" role="status">
      {toast.text}
    </div>
  );
}
