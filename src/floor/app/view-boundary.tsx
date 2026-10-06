// FR33 (03-floor 7): a throw while a view body or an open sheet draws must not take the
// page down with it. One boundary per view body and per open sheet: the throwing part is
// replaced in place by the `view.failed` sentence, the error goes to the browser console,
// and the header, the strip, the banners and the other views keep working. React has no
// hook form for an error boundary - this is a class component.
//
// `app.tsx` keys each boundary by the view or the sheet's subject, so switching view (or
// opening a different sheet) mounts a fresh boundary: a failure stays with the part that
// threw and never follows the view switched to.

import { Component, type ContextType, type ReactNode } from "react";
import { ShellContext } from "./context.ts";
import { text } from "../../copy/strings.ts";

export class ViewBoundary extends Component<{ children?: ReactNode; sheet?: boolean }, { failed: boolean }> {
  static override contextType = ShellContext;
  declare context: ContextType<typeof ShellContext>;

  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    // FR33: the error goes to the browser console.
    console.error(error);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const sentence = this.context?.t("view.failed") ?? text("view.failed");
    const line = (
      <p className="view-failed" role="alert">
        {sentence}
      </p>
    );
    // A failed sheet's sentence keeps the sheet shell - it stands where the sheet stood
    // (LY4), and Escape still closes it through the sheet kind the app still holds.
    if (this.props.sheet === true) {
      return (
        <div className="sheet-backdrop">
          <div className="sheet" role="dialog" aria-label={sentence}>
            {line}
          </div>
        </div>
      );
    }
    return line;
  }
}
