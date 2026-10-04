// The Compare view's read of FloorState (docs/spec/03-floor.md 3.6, CO25; docs/spec/01-core.md
// PM3, PM4, PM7; docs/spec/02-tidepool.md TP20): which landed changes get a "what differs"
// line, whether the two pools hold the same files, how far behind the plain-merge pool runs,
// and the approximated count of text conflicts. Pure — no DOM, no clock; the component renders
// exactly what these return (the list is computed from the stream only, CO25).

import type { FloorState, LandingEntry, LandingView } from "../../../protocol/reducer/index.ts";
import type { CopyVars } from "../../../copy/fill.ts";
import { changeName, keyShort } from "../../../copy/names.ts";
import type { LabelKind } from "../../../copy/names.ts";
import { landingLabel } from "../../../copy/format.ts";

/** One line of the CO25 list: the copy id and its fills. `seq` keys the <li>. */
export type DiffLine = { seq: number; id: string; vars: CopyVars };

/** The name a landing carries in the diff list — the same resolution the rail's landed rows
 * use (attempt's race/model plus the requester's words), falling back to the intent text and
 * then the landing's own name. For a landing the premises are the ones frozen at acceptance
 * (`landing.premises`), not the attempt's live set. */
function landingName(landing: LandingEntry, state: FloorState): string {
  const attempt = landing.attempt_id === null ? undefined : state.attempts[landing.attempt_id];
  const intentText = (landing.intent_id === null ? undefined : state.intents[landing.intent_id])?.text ?? "";
  const premises =
    landing.digest === true
      ? // A digest keeps only the premise keys — `edit` is unknown, so the created-file
        // naming of `changeName` (PremiseRef.hash) cannot apply here.
        landing.premise_keys.map((p) => ({ kind: p.kind, key: p.key, edit: false }))
      : landing.premises.map((p) => ({ kind: p.kind, key: p.key, edit: p.edit }));
  if (attempt !== undefined || intentText !== "") {
    return changeName({ intentText, race: attempt?.race, model: attempt?.model, premises });
  }
  return landingLabel(landing.seq);
}

/** The `{keyShort}` of a diff line: the first premise key the deciding heads-up named — for a
 * repair, the key that changed under the attempt; for a confirm, the key it confirmed. A
 * heads-up with no keys falls back to the change's own first premise. */
function lineKey(landing: LandingView): { kind: LabelKind; key: string } | null {
  const headsUp = landing.go_arounds[0] ?? landing.confirms[0];
  const key = headsUp?.keys[0] ?? landing.premises[0];
  return key === undefined ? null : { kind: key.kind, key: key.key };
}

/**
 * CO25 line 2 (PM4, PM6): the "what differs" list, oldest landing first. One line per landed
 * change of kind `change` that had at least one heads-up of result `repair` or `confirm`
 * before it landed — the heads-ups the LandingView holds are exactly those resolved before
 * `landing.accepted` — plus every landing `plain.interrupted` names, which gets
 * `plain.interrupted` instead of a went-around/confirmed line (its agent was sent back in the
 * middle of its work, so the plain-merge pool holds unfinished work for it).
 *
 * A landing held only as a digest carries no heads-up lists, so it can appear in the list only
 * through `interrupted` — where its name still resolves from the intent.
 */
export function diffLines(state: FloorState): DiffLine[] {
  const interrupted = new Set(state.plain?.interrupted ?? []);
  const seqs = Object.keys(state.landings)
    .map((s) => Number(s))
    .filter((seq) => Number.isFinite(seq))
    .sort((a, b) => a - b);
  const lines: DiffLine[] = [];
  for (const seq of seqs) {
    const landing = state.landings[seq];
    if (landing === undefined) continue;
    const landed = landing.digest === true ? landing.commit !== null : landing.landed !== null;
    if (!landed || landing.kind !== "change") continue;
    const isInterrupted = interrupted.has(seq);
    const name = landingName(landing, state);
    if (isInterrupted) {
      lines.push({ seq, id: "plain.interrupted", vars: { changeName: name } });
      continue;
    }
    if (landing.digest === true) continue; // no heads-up lists survive the digest (FS1)
    const repairs = landing.go_arounds.length;
    if (repairs === 0 && landing.confirms.length === 0) continue;
    if (repairs > 1) {
      lines.push({ seq, id: "plain.diff_line.many", vars: { changeName: name, n: repairs } });
      continue;
    }
    const key = lineKey(landing);
    const keyShortVar = key === null ? "" : keyShort(key.kind, key.key);
    lines.push({
      seq,
      id: repairs === 1 ? "plain.diff_line" : "plain.diff_line.confirm",
      vars: { changeName: name, keyShort: keyShortVar },
    });
  }
  return lines;
}

/**
 * PM7 / TP20 / AC24: the one fact on which the page may say "no visible difference in this
 * run" — `plain.tree` equals `landed.tree` of the landing `plain.through_seq`. False while
 * `plain` is null, while that landing is absent, and once it is held only as a digest (CO25:
 * "when that landing is no longer held in full, the line is not shown"). Never guessed from
 * what the frames draw.
 */
export function plainSameAsLanded(state: FloorState): boolean {
  const plain = state.plain;
  if (plain === null) return false;
  const landing = state.landings[plain.through_seq];
  if (landing === undefined || landing.digest === true || landing.landed === null) return false;
  return landing.landed.tree === plain.tree;
}

/** CO25 line 4 / PM3: the approximated count of text conflicts — `plain.skipped`. Null while
 * no `plain.updated` has arrived (the count is unknown, not zero). */
export function conflictCount(state: FloorState): number | null {
  return state.plain === null ? null : state.plain.skipped.length;
}

/** 3.6 held row: how many landings `main` has that the plain-merge replay has not reached —
 * `pool.landed_seq - plain.through_seq`, 0 when the plain pool has caught up or does not
 * exist yet. */
export function plainBehind(state: FloorState): number {
  const plain = state.plain;
  if (plain === null) return 0;
  return Math.max(0, state.pool.landed_seq - plain.through_seq);
}
