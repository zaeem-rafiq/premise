// The chosen NotesReader (01-core.md S1c): the notes commit id comes from Trunk's own state
// or the ref advertisement — the binding does not resolve `refs/notes/premise` by name —
// and the notes tree and note blobs are then read through the binding by object id (X4).

import type { NotesReader } from "../../../protocol/ports.ts";

/**
 * The slice of a repository handle this adapter uses — a handle from `Artifacts.get` at
 * runtime, a fake in tests. The caller owns the handle and disposes it.
 */
export type ArtifactsNotesRepo = {
  readCommit(hash: string): Promise<{ treeHash: string } | null>;
  readTree(hash: string): Promise<{ name: string; type: string; hash: string }[] | null>;
  readBlob(hash: string): Promise<Blob | null>;
};

const FANOUT_DIR = /^[0-9a-f]{2}$/;
const FANOUT_FILE = /^[0-9a-f]{38}$/;

/**
 * A reader over the notes commit `notesCommit` — the oid of the notes head commit, not a
 * ref name (S1c). When `notesCommit` is null the pool has no notes ref yet and every read
 * is empty.
 */
export function artifactsNotesReader(repo: ArtifactsNotesRepo, notesCommit: string | null): NotesReader {
  return {
    async readNote(commit) {
      if (notesCommit === null) return null;
      const head = await repo.readCommit(notesCommit);
      if (head === null) return null;
      const root = await repo.readTree(head.treeHash);
      const dir = root?.find((entry) => entry.name === commit.slice(0, 2) && entry.type === "tree");
      if (dir === undefined) return null;
      const fanout = await repo.readTree(dir.hash);
      const note = fanout?.find((entry) => entry.name === commit.slice(2));
      if (note === undefined) return null;
      const blob = await repo.readBlob(note.hash);
      return blob === null ? null : blob.text();
    },

    async *listNotes() {
      if (notesCommit === null) return;
      const head = await repo.readCommit(notesCommit);
      if (head === null) return;
      const root = await repo.readTree(head.treeHash);
      if (root === null) return;
      const dirs = root
        .filter((entry) => entry.type === "tree" && FANOUT_DIR.test(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const dir of dirs) {
        const fanout = await repo.readTree(dir.hash);
        if (fanout === null) continue;
        const files = fanout
          .filter((entry) => FANOUT_FILE.test(entry.name))
          .sort((a, b) => a.name.localeCompare(b.name));
        for (const file of files) {
          yield { commit: `${dir.name}${file.name}`, blob: file.hash };
        }
      }
    },
  };
}
