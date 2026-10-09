// Toasts (3.19): one sentence each, bottom left, for TOAST_MS; at most three. Every toast
// also goes to the polite live region of the announcer (AX8).

import { useEffect } from "react";
import { TOAST_MS } from "../../../protocol/constants.ts";
import type { Toast } from "../../state/view-state.ts";

import "./toasts.css";

export function Toasts({ toasts, onDrop }: { toasts: Toast[]; onDrop: (id: number) => void }) {
  const shown = toasts.slice(-3);
  if (shown.length === 0) return null;
  return (
    <div className="toasts">
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
