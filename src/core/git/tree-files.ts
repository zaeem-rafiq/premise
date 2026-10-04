// A whole tree from a flat map of paths to contents (01-core.md 9.5): the previous tree with the
// changed paths applied is the tree of the full resulting file map. Returns the root tree plus
// every blob and tree object it needs, for the pack.

import { makeBlob, makeTree, type GitObject, type TreeEntry } from "./objects.ts";

/** A file mode git can record: regular file, executable, or symbolic link (content is the target). */
export type FileMode = "100644" | "100755" | "120000";

export type FileSpec = {
  readonly content: string | Uint8Array;
  readonly mode: FileMode;
};

export type FileMapValue = string | Uint8Array | FileSpec;

function isFileSpec(value: FileMapValue): value is FileSpec {
  return typeof value === "object" && !(value instanceof Uint8Array);
}

/**
 * The objects for a nested file map such as `{ "a/b.txt": "...", "run.sh": { content, mode: "100755" } }`.
 * A plain string or byte value is a regular file (mode 100644). `objects` holds every blob and
 * tree the root tree needs; `root` is the root tree object itself.
 */
export function makeTreeFromFiles(files: Record<string, FileMapValue>): {
  root: GitObject;
  objects: GitObject[];
} {
  interface Dir {
    readonly files: Map<string, { blob: GitObject; mode: FileMode }>;
    readonly dirs: Map<string, Dir>;
  }
  const rootDir: Dir = { files: new Map(), dirs: new Map() };
  const objects: GitObject[] = [];
  for (const [path, value] of Object.entries(files)) {
    const segments = path.split("/");
    const fileName = segments.pop();
    if (fileName === undefined || fileName.length === 0 || segments.some((s) => s.length === 0)) {
      throw new Error(`invalid path: ${JSON.stringify(path)}`);
    }
    const spec = isFileSpec(value) ? value : { content: value, mode: "100644" as const };
    let dir = rootDir;
    for (const segment of segments) {
      let next = dir.dirs.get(segment);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(segment, next);
      }
      dir = next;
    }
    const blob = makeBlob(spec.content);
    objects.push(blob);
    dir.files.set(fileName, { blob, mode: spec.mode });
  }
  const build = (dir: Dir): GitObject => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of dir.files) entries.push({ mode: file.mode, name, oid: file.blob.oid });
    for (const [name, sub] of dir.dirs) entries.push({ mode: "40000", name, oid: build(sub).oid });
    const tree = makeTree(entries);
    objects.push(tree);
    return tree;
  };
  const root = build(rootDir);
  return { root, objects };
}
