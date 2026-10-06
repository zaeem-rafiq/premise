// A whole tree from a flat map of paths to contents (01-core.md 9.5): the previous tree with the
// changed paths applied is the tree of the full resulting file map. Returns the root tree plus
// every blob and tree object it needs, for the pack.
//
// IR5 (06-repos): an entry may also be given by object id and mode alone — a symbolic link, a
// submodule (`160000`), or a blob the remote already has. No object is emitted for it; the tree
// writes the pointer unchanged. With `overlay`, a directory the change does not touch (`fresh`
// names the directories it does) reuses its stored tree object id, so a landing's pack holds
// only the objects the remote does not have yet.

import { makeBlob, makeTree, type GitObject, type TreeEntry, type TreeMode } from "./objects.ts";

/** A file mode git can record: regular file, executable, or symbolic link (content is the target). */
export type FileMode = "100644" | "100755" | "120000";

export type FileSpec = {
  readonly content: string | Uint8Array;
  readonly mode: FileMode;
};

/** A leaf entry's mode when it is referenced by object id: any leaf mode, including the
 * submodule's `160000` (whose object id is a commit, not a blob — never emitted into a pack). */
export type EntryMode = "100644" | "100755" | "120000" | "160000";

/** An entry carried by object id and mode alone (IR5): no object is made or emitted for it. */
export type EntryRef = {
  readonly oid: string;
  readonly mode: EntryMode;
};

export type FileMapValue = string | Uint8Array | FileSpec | EntryRef;

function isFileSpec(value: FileMapValue): value is FileSpec {
  return typeof value === "object" && !(value instanceof Uint8Array) && "content" in value;
}

function isEntryRef(value: FileMapValue): value is EntryRef {
  return typeof value === "object" && !(value instanceof Uint8Array) && "oid" in value;
}

/** The directory-overlap the caller knows: `stored` maps a directory's repo path (`""` is the
 * root, `a/b` a nested one — the `trees` table's `dir` shape) to the tree object id it had at
 * the parent commit; `fresh` names every directory the change touches. A directory outside
 * `fresh` with a stored id is written back as that id — its subtree is emitted nowhere. */
export type TreeOverlay = {
  readonly stored: ReadonlyMap<string, string>;
  readonly fresh: ReadonlySet<string>;
};

/**
 * The objects for a nested file map such as `{ "a/b.txt": "...", "run.sh": { content, mode: "100755" } }`.
 * A plain string or byte value is a regular file (mode 100644). `objects` holds every blob and
 * tree the root tree needs, each object id once — paths with identical content share one blob,
 * identical directories share one tree, and a pack carries an object id at most once (9.5).
 * `root` is the root tree object itself. `dirs` records the tree object id each built directory
 * got (repo path as in `TreeOverlay.stored`), so the caller can keep `stored` current across
 * landings.
 */
export function makeTreeFromFiles(
  files: Record<string, FileMapValue>,
  overlay?: TreeOverlay,
): {
  root: GitObject;
  objects: GitObject[];
  dirs: Map<string, string>;
} {
  interface Dir {
    readonly files: Map<string, { oid: string; mode: TreeMode }>;
    readonly dirs: Map<string, Dir>;
  }
  const rootDir: Dir = { files: new Map(), dirs: new Map() };
  const objects: GitObject[] = [];
  const emitted = new Set<string>();
  // Two paths can name the same content and two directories the same subtree: the pack holds
  // each object once, so an oid already emitted is not emitted again.
  const emit = (object: GitObject): void => {
    if (emitted.has(object.oid)) return;
    emitted.add(object.oid);
    objects.push(object);
  };
  for (const [path, value] of Object.entries(files)) {
    const segments = path.split("/");
    const fileName = segments.pop();
    if (fileName === undefined || fileName.length === 0 || segments.some((s) => s.length === 0)) {
      throw new Error(`invalid path: ${JSON.stringify(path)}`);
    }
    let dir = rootDir;
    for (const segment of segments) {
      let next = dir.dirs.get(segment);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(segment, next);
      }
      dir = next;
    }
    if (isEntryRef(value)) {
      dir.files.set(fileName, { oid: value.oid, mode: value.mode });
      continue;
    }
    const spec = isFileSpec(value) ? value : { content: value, mode: "100644" as const };
    const blob = makeBlob(spec.content);
    emit(blob);
    dir.files.set(fileName, { oid: blob.oid, mode: spec.mode });
  }
  const dirs = new Map<string, string>();
  const build = (dir: Dir, dirPath: string): { oid: string; tree: GitObject | null } => {
    // A non-root directory the change does not touch keeps its stored tree object: the new
    // trees above it reference it by id, and nothing of its subtree goes into the pack.
    if (dirPath !== "" && overlay !== undefined && !overlay.fresh.has(dirPath)) {
      const kept = overlay.stored.get(dirPath);
      if (kept !== undefined) return { oid: kept, tree: null };
    }
    const entries: TreeEntry[] = [];
    for (const [name, file] of dir.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, sub] of dir.dirs) {
      const subPath = dirPath === "" ? name : `${dirPath}/${name}`;
      entries.push({ mode: "40000", name, oid: build(sub, subPath).oid });
    }
    const tree = makeTree(entries);
    emit(tree);
    dirs.set(dirPath, tree.oid);
    return { oid: tree.oid, tree };
  };
  // The root is always built: every change names it in `fresh`, and its object must exist.
  const root = build(rootDir, "").tree;
  if (root === null) throw new Error("unreachable: the root tree is always built");
  return { root, objects, dirs };
}
