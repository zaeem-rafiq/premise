// The "show the git" drawer's display values (03-floor 3.10, 01-core CM1 to CM5): the commit
// message as git stores it and the plain-git commands. Everything is stream or note data; the
// drawer never holds or shows a repository token (SE5c).

import type { Note } from "../../../protocol/note.ts";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import type { WhyCard } from "../../../protocol/reducer/why.ts";

export const NOTE_REF = "refs/notes/premise";

/** `git fetch` + `git log --notes` — the two commands of 01-core 3.5. */
export function noteCommands(remote: string | null): { fetch: string; log: string; clone: string | null } {
  return {
    fetch: `git fetch origin ${NOTE_REF}:${NOTE_REF}`,
    log: "git log --notes=premise",
    // The address as `pool.remote` carries it — with no credentials (3.10).
    clone: remote !== null ? `git clone ${remote}` : null,
  };
}

/**
 * The commit message as git stores it (CM3 to CM5): the summary line, the
 * `Intent:` line, then the `Change-Id` / `Intent-Id` trailers, with `Undoes:`
 * lines (one per reverted landing, ascending seq) for an undo or revert.
 */
export function commitMessage(state: FloorState, card: WhyCard): string {
  const summary = card.note?.summary ?? card.intentText ?? "";
  const lines = [
    summary,
    "",
    `Intent: ${card.intentText ?? ""}`,
    "",
    `Change-Id: ${card.changeId ?? ""}`,
    `Intent-Id: ${card.intentId ?? ""}`,
  ];
  if (card.undo !== null) {
    for (const seq of [...card.undo.tookBack].sort((a, b) => a - b)) {
      const entry = state.landings[seq];
      const commit = entry === undefined ? null : entry.digest === true ? entry.commit : (entry.landed?.commit ?? null);
      lines.push(`Undoes: ${commit ?? ""}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The note as indented JSON (CO33: re-indented only, never rewritten or shortened). */
export function noteJson(note: Note | null): string | null {
  if (note === null) return null;
  try {
    return JSON.stringify(note, null, 2);
  } catch {
    return null;
  }
}
