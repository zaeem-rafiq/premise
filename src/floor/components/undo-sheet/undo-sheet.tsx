// The undo sheet of 03-floor 3.12: the plan-first revert of 01-core 11.3. Opens from the Why
// card's `undo.open` (which the Why card only offers on a live `change` landing, for an owner,
// while `features.undo` is on — the sheet is no extra door, AC28). On open it asks
// `GET /api/pools/{pool}/undo-plan?seq={seq}` (4.5) and reads `undo.planning`; the plan answers
// `undo.title`, `undo.also`, `undo.kept`, `undo.in_flight` and the buttons `undo.confirm` /
// `undo.cancel` (5.10). "Undo it" POSTs `/undo` with `expect_reverted` equal to the `reverted`
// list on screen (CO34a, UN5) and a fresh `request_id`; a refusal shows `undo.refused` and keeps
// the sheet, `plan_changed` swaps in the response's plan under `undo.plan_changed` and enables the
// button again with nothing queued (FR31). Once Trunk accepts, the sheet reads `undo.landing`
// while `undo.planned` has no landed undo landing yet, then `undo.done` — the same sentences the
// Landed tab's undo row carries (CO34), so a close loses nothing.

import "./undo-sheet.css";

import { useContext, useEffect, useRef, useState } from "react";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import type { UndoPlan, UndoPlanResponse, UndoResponse } from "../../../protocol/undo.ts";
import { landingLabel } from "../../../copy/format.ts";
import { errorSentence, UNDO_REFUSAL_REASONS, undoRefusalReason } from "../../../copy/errors.ts";
import { text } from "../../../copy/strings.ts";
import { ShellContext } from "../../app/context.ts";
import { whyOffered } from "../../state/derive.ts";
import { whyCard } from "../../../protocol/reducer/why.ts";
import { postJson, requestId } from "../rail/request.ts";
import { getJson } from "./request.ts";
import { undoPlanModel } from "./model.ts";

export type UndoSheetProps = {
  floor: FloorState;
  /** The `landing.seq` the Why card's Undo button named — the plan's `target_seq`. */
  seq: number;
  onClose: () => void;
};

/** What the sheet is showing (3.12's state table): `planning` until the route answers, `plan` for
 * a plan on screen (`changed` marks the FR31 swap), `queued` after a `ok: true` confirm, `refused`
 * for every refusal and request error. */
type Phase =
  | { kind: "planning" }
  | { kind: "plan"; plan: UndoPlan; changed: boolean }
  | { kind: "queued"; plan: UndoPlan }
  | { kind: "refused"; sentence: string };

/** The `{reason}` sentence of `undo.refused`: the `UndoRefusal` sentences of 5.9; a reason the
 * protocol does not name falls back to the plain request-error sentence for the status. */
function refusalSentence(reason: unknown, status: number | null, code?: string): string {
  const name = String(reason);
  return UNDO_REFUSAL_REASONS[name] !== undefined
    ? text("undo.refused", { reason: undoRefusalReason(name) })
    : errorSentence(status, code);
}

/**
 * The undo sheet. Renders its states locally — `undo.refused` arrives only in the request's own
 * response (the stream's `undo.refused` mutates no reducer state, by design), and `undo.planned`
 * lands in `floor.undo` keyed by the `request_id` the confirm carried.
 */
export function UndoSheet({ floor, seq, onClose }: UndoSheetProps) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  const [phase, setPhase] = useState<Phase>({ kind: "planning" });
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(false);
  // The request_id the accepted confirm carried: `floor.undo[confirmedId]` is this undo's row.
  const [confirmedId, setConfirmedId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Esc closes the sheet and queues nothing; focus lands in the dialog on open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The plan request (4.5): owner-only (AC28) — a visitor or Replay reader sees the route's own
  // refusal sentence, and no request leaves the page. Fetched once per target.
  useEffect(() => {
    if (shell.visitor) {
      setPhase({ kind: "refused", sentence: errorSentence(401) });
      return;
    }
    let live = true;
    void getJson(`/api/pools/${encodeURIComponent(floor.pool.id)}/undo-plan?seq=${seq}`).then((result) => {
      if (!live) return;
      const body = result.body as UndoPlanResponse | null;
      if (body !== null && typeof body === "object" && "ok" in body) {
        if (body.ok === true) {
          setPhase({ kind: "plan", plan: body.plan, changed: false });
        } else {
          setPhase({ kind: "refused", sentence: refusalSentence(body.reason, result.status, result.code) });
        }
      } else {
        setPhase({ kind: "refused", sentence: errorSentence(result.status, result.code) });
      }
    });
    return () => {
      live = false;
    };
  }, [floor.pool.id, seq, shell.visitor]);

  // The undo's own row once the stream's `undo.planned` lands: `undo.landing` until its landing
  // lands, then `undo.done` (3.12's last two rows, shown in the sheet too — see the header note).
  const planned = confirmedId !== null ? floor.undo[confirmedId] : undefined;
  const undoLanding = planned?.landing_seq != null ? floor.landings[planned.landing_seq] : undefined;
  const undoLanded = undoLanding !== undefined && whyOffered(undoLanding);

  const confirm = (plan: UndoPlan): void => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    const rid = requestId();
    void postJson(`/api/pools/${encodeURIComponent(floor.pool.id)}/undo`, {
      seq: plan.target_seq,
      expect_reverted: plan.reverted, // CO34a: the `reverted` list on screen, verbatim.
      request_id: rid,
    }).then((result) => {
      inFlightRef.current = false;
      setBusy(false);
      const body = result.body as UndoResponse | null;
      if (body !== null && typeof body === "object" && "ok" in body) {
        if (body.ok === true) {
          setConfirmedId(body.request_id ?? rid);
          setPhase({ kind: "queued", plan });
          return;
        }
        if (body.reason === "plan_changed" && body.plan !== undefined) {
          // FR31: the new plan under `undo.plan_changed`, confirm enabled again, nothing queued.
          setPhase({ kind: "plan", plan: body.plan, changed: true });
          return;
        }
        setPhase({ kind: "refused", sentence: refusalSentence(body.reason, result.status, result.code) });
        return;
      }
      setPhase({ kind: "refused", sentence: errorSentence(result.status, result.code) });
    });
  };

  const model = phase.kind === "plan" || phase.kind === "queued" ? undoPlanModel(floor, phase.plan, shell.model) : null;
  // While planning and after a refusal the header still names the target, so the title comes from
  // the same `whyCard` the model uses.
  const title =
    model?.title ??
    t("undo.title", { landing: landingLabel(seq), "intent text": whyCard(floor, seq).intentText ?? "" });

  return (
    <div
      className="sheet-backdrop undo-backdrop"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="sheet undo-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="undo-head">
          <h2 className="sheet-title" dir="auto">
            {title}
          </h2>
          <button type="button" className="undo-close" onClick={onClose}>
            {t("card.close")}
          </button>
        </header>

        {phase.kind === "planning" && (
          <p className="undo-note" role="status">
            {t("undo.planning")}
          </p>
        )}

        {phase.kind === "refused" && (
          <p className="undo-refused" role="alert">
            {phase.sentence}
          </p>
        )}

        {phase.kind === "plan" && model !== null && (
          <>
            {phase.changed && (
              <p className="undo-notice" role="status">
                {t("undo.plan_changed")}
              </p>
            )}
            <p dir="auto">{model.also}</p>
            {model.kept !== null && <p dir="auto">{model.kept}</p>}
            {model.inFlight !== null && <p dir="auto">{model.inFlight}</p>}
            <div className="sheet-actions">
              <button type="button" disabled={busy} onClick={onClose}>
                {t("undo.cancel")}
              </button>
              <button type="button" className="primary" disabled={busy} onClick={() => confirm(phase.plan)}>
                {t("undo.confirm")}
              </button>
            </div>
          </>
        )}

        {phase.kind === "queued" && (
          <p className="undo-note" role="status">
            {undoLanded && planned !== undefined && planned.landing_seq !== null
              ? t("undo.done", {
                  landing: [landingLabel(seq), landingLabel(planned.landing_seq)],
                  n: planned.reverted.length,
                })
              : t("undo.landing", { landing: landingLabel(seq) })}
          </p>
        )}
      </div>
    </div>
  );
}
