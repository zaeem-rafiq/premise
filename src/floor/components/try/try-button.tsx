// The visitor's "Try it" button (09-try TY11): `POST /api/try`, then the page opens the try pool
// the Worker answers. While the request is open the button is disabled and `try.starting` shows
// under it; a 429 shows the Worker's sentence and keeps the button disabled for the rest of the
// page's life; any other failure shows `try.failed` and the button can be tapped again.

import "./try-button.css";

import { useEffect, useState } from "react";
import { text } from "../../../copy/strings.ts";
import type { TryResponse } from "../../../protocol/routes.ts";

type TryState = { kind: "idle" } | { kind: "starting" } | { kind: "limited"; message: string } | { kind: "failed" };

/** TY11: a refusal for the rate limit lasts as long as the page, in every place the button shows. */
let limitedForPage: string | null = null;

function isTryResponse(value: unknown): value is TryResponse {
  if (typeof value !== "object" || value === null) return false;
  const { pool, path } = value as Record<string, unknown>;
  return typeof pool === "string" && typeof path === "string" && path === `/p/${pool}`;
}

async function startTry(): Promise<{ ok: true; path: string } | { ok: false; limited: string | null }> {
  let response: Response;
  try {
    response = await fetch("/api/try", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch {
    return { ok: false, limited: null };
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.ok && isTryResponse(body)) return { ok: true, path: body.path };
  if (response.status === 429) {
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    return { ok: false, limited: typeof message === "string" && message !== "" ? message : text("try.failed") };
  }
  return { ok: false, limited: null };
}

export function TryButton(props: { onOpen: (path: string) => void; primary?: boolean }) {
  const [state, setState] = useState<TryState>(
    limitedForPage === null ? { kind: "idle" } : { kind: "limited", message: limitedForPage },
  );
  // A sibling button (the Overview's or the start card's) may have been refused meanwhile.
  useEffect(() => {
    if (limitedForPage !== null && state.kind === "idle") setState({ kind: "limited", message: limitedForPage });
  }, [state.kind]);

  const onClick = () => {
    if (state.kind === "starting" || state.kind === "limited") return;
    setState({ kind: "starting" });
    void startTry().then((result) => {
      if (result.ok) {
        setState({ kind: "idle" });
        props.onOpen(result.path);
      } else if (result.limited !== null) {
        limitedForPage = result.limited;
        setState({ kind: "limited", message: result.limited });
      } else {
        setState({ kind: "failed" });
      }
    });
  };

  const note =
    state.kind === "starting"
      ? text("try.starting")
      : state.kind === "limited"
        ? state.message
        : state.kind === "failed"
          ? text("try.failed")
          : null;
  return (
    <span className="try">
      <button
        type="button"
        className={props.primary === true ? "primary try__button" : "try__button"}
        disabled={state.kind === "starting" || state.kind === "limited"}
        aria-busy={state.kind === "starting"}
        onClick={onClick}
      >
        {text("try.button")}
      </button>
      <span className="try__note" role="status" aria-live="polite">
        {note}
      </span>
    </span>
  );
}
