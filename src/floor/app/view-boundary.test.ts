// FR33 (03-floor 7): the ViewBoundary renders its children, and once a child has thrown
// it renders the `view.failed` sentence in that place. `renderToString` does not run error
// boundaries (a throw still propagates), so the failed path is exercised on an instance:
// `getDerivedStateFromError` marks the boundary failed and `componentDidCatch` writes the
// error to the console. The browser spec `test/e2e/shell/view-failed.spec.ts` covers the
// real catch in the page.

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ViewBoundary } from "./view-boundary.tsx";

const FAILED =
  "This part of the page stopped because of an error. The rest of the page still works. Reload the page to try again.";

describe("ViewBoundary (FR33)", () => {
  it("renders its children while nothing has thrown", () => {
    const html = renderToString(createElement(ViewBoundary, {}, createElement("p", {}, "the view")));
    expect(html).toContain("the view");
    expect(html).not.toContain("view-failed");
  });

  it("getDerivedStateFromError marks the boundary failed", () => {
    expect(ViewBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });

  it("a failed boundary renders view.failed where the view stood", () => {
    const boundary = new ViewBoundary({ children: createElement("p", {}, "gone") });
    boundary.state = { failed: true };
    const html = renderToString(boundary.render());
    expect(html).toContain(FAILED);
    expect(html).toContain("view-failed");
    expect(html).not.toContain("gone");
  });

  it("a failed sheet keeps the sheet shell around the sentence", () => {
    const boundary = new ViewBoundary({ sheet: true, children: createElement("p", {}, "gone") });
    boundary.state = { failed: true };
    const html = renderToString(boundary.render());
    expect(html).toContain(FAILED);
    expect(html).toContain("sheet-backdrop");
    expect(html).toContain('role="dialog"');
  });

  it("componentDidCatch writes the error to the console", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("a render threw");
    new ViewBoundary({}).componentDidCatch(error);
    expect(spy).toHaveBeenCalledWith(error);
    spy.mockRestore();
  });
});
