// The notes tree of 01-core.md 3.5: it maps each landing commit id to one note blob with fan-out
// `<first 2 hex>/<remaining 38 hex>`. The caller passes the full set of (commit, note blob) pairs —
// the previous notes tree plus the batch's new notes — and gets the new tree objects.

import { makeTree, type GitObject, type TreeEntry } from "./objects.ts";

const OID_RE = /^[0-9a-f]{40}$/;

export type NoteMapping = {
  /** The landing commit id the note records. */
  readonly commit: string;
  /** The note blob's id (NT1 bytes). */
  readonly blob: string;
};

/**
 * The tree objects for one notes level: `root` is the root tree, `objects` holds it and every
 * fan-out directory tree. Duplicate commit ids are an error.
 */
export function notesTree(notes: readonly NoteMapping[]): { root: GitObject; objects: GitObject[] } {
  const dirs = new Map<string, TreeEntry[]>();
  for (const note of notes) {
    if (!OID_RE.test(note.commit)) throw new Error(`invalid commit id in notes tree: ${note.commit}`);
    if (!OID_RE.test(note.blob)) throw new Error(`invalid note blob id for ${note.commit}: ${note.blob}`);
    const dir = note.commit.slice(0, 2);
    const name = note.commit.slice(2);
    const entries = dirs.get(dir);
    if (entries === undefined) dirs.set(dir, [{ mode: "100644", name, oid: note.blob }]);
    else {
      if (entries.some((e) => e.name === name)) throw new Error(`duplicate note for commit ${note.commit}`);
      entries.push({ mode: "100644", name, oid: note.blob });
    }
  }
  const objects: GitObject[] = [];
  const rootEntries: TreeEntry[] = [];
  for (const [dir, entries] of dirs) {
    const tree = makeTree(entries);
    objects.push(tree);
    rootEntries.push({ mode: "40000", name: dir, oid: tree.oid });
  }
  const root = makeTree(rootEntries);
  objects.push(root);
  return { root, objects };
}
