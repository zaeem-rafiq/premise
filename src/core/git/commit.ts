// The two commits of 01-core.md 3.5 and 9.5: the landing commit (CM1 to CM5) and the notes commit
// of a batch. The worked example of 3.5 has object id 6bd48525d87d048e928a6dce65cd7e033fcbd839;
// test/git checks these bytes against real git.

import { makeCommit, type GitObject } from "./objects.ts";

/** The committer of every landing, and author and committer of every notes commit. */
const TRUNK_IDENT = { name: "Premise Trunk", email: "trunk@premise.invalid" };

// CM2: control characters are U+0000 to U+001F and U+007F.
const CONTROL = /[\u0000-\u001f\u007f]/g;

function stripControls(text: string): string {
  return text.replace(CONTROL, "");
}

/** The first `count` Unicode code points of `text`; a surrogate pair is never split (CM3). */
function firstCodePoints(text: string, count: number): string {
  return Array.from(text).slice(0, count).join("");
}

export type LandingCommitInput = {
  /** The commit's tree id. */
  readonly tree: string;
  /** The previous landing's commit id (9.5: the batch is a chain). */
  readonly parent: string;
  /** CM1: the model id for a real agent, "SYNTHETIC swarm" for a synthetic agent, "Premise Trunk" for undo and revert landings. */
  readonly authorName: string;
  /**
   * The landing attempt's id: the author's email is `<attempt id>@agents.premise.invalid`.
   * `null` for undo and revert landings, whose author is `Premise Trunk <trunk@premise.invalid>` (3.5).
   */
  readonly attemptId: string | null;
  /** Unix seconds of acceptance; author and committer times. */
  readonly acceptedAt: number;
  /** The submit summary. CM3: one line of at most 72 code points, or the intent text when empty. */
  readonly summary: string;
  /** The intent's text, written after `Intent: `. CM2 applies. */
  readonly intentText: string;
  readonly changeId: string;
  readonly intentId: string;
  /** CM4: for undo and revert landings, the reverted landings' commit ids in ascending seq. */
  readonly undoes?: readonly string[];
};

/**
 * The landing commit of 01-core.md 3.5. Its object's bytes are exactly the lines the section shows,
 * each ended by one LF, with CM2's sanitizing, CM3's summary, CM4's trailers and CM5's last LF.
 */
export function landingCommit(input: LandingCommitInput): GitObject {
  // CM2 removes < and > in the author name; in the summary and the intent text only control
  // characters are removed, so a "<" there survives into the message.
  const authorName = stripControls(input.authorName).replace(/[<>]/g, "");
  const intentText = stripControls(input.intentText.replace(/\r\n|\r|\n/g, " "));
  const summary = firstCodePoints(stripControls(input.summary), 72) || firstCodePoints(intentText, 72);
  const authorEmail = input.attemptId === null ? TRUNK_IDENT.email : `${input.attemptId}@agents.premise.invalid`;
  const trailers = [`Change-Id: ${input.changeId}`, `Intent-Id: ${input.intentId}`];
  for (const undone of input.undoes ?? []) trailers.push(`Undoes: ${undone}`);
  return makeCommit({
    tree: input.tree,
    parents: [input.parent],
    author: { name: authorName, email: authorEmail, timestamp: input.acceptedAt },
    committer: { ...TRUNK_IDENT, timestamp: input.acceptedAt },
    message: `${summary}\n\nIntent: ${intentText}\n\n${trailers.join("\n")}`,
  });
}

export type NotesCommitInput = {
  /** The notes tree id (the fan-out tree of `notes-tree.ts`). */
  readonly tree: string;
  /** The previous notes commit id, or null for the first batch. */
  readonly parent: string | null;
  readonly batchId: number;
  /** `seq` of the batch's first and last landing. */
  readonly firstSeq: number;
  readonly lastSeq: number;
  /** Unix seconds; author and committer times. */
  readonly at: number;
};

/**
 * The notes commit of a batch (9.5): author and committer `Premise Trunk`, message
 * `Premise notes for batch <batch_id> (seq <first>..<last>)` followed by one newline.
 */
export function notesCommit(input: NotesCommitInput): GitObject {
  return makeCommit({
    tree: input.tree,
    parents: input.parent === null ? [] : [input.parent],
    author: { ...TRUNK_IDENT, timestamp: input.at },
    committer: { ...TRUNK_IDENT, timestamp: input.at },
    message: `Premise notes for batch ${input.batchId} (seq ${input.firstSeq}..${input.lastSeq})`,
  });
}
