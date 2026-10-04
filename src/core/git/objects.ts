// Git object construction (01-core.md 3.5, 9.5). Every builder returns the object's bytes and the
// id real git computes for them; test/git compares each against `git hash-object`, `git mktree`,
// `git commit-tree` and objects read back after `git index-pack`.

import { compareBytes, concatBytes, hexToBytes, utf8 } from "../sync/bytes.ts";
import { gitObjectId } from "../sync/sha1.ts";

/** The object id a command writes for "create" and the server reports for "delete". */
export const ZERO_OID = "0".repeat(40);

const OID_RE = /^[0-9a-f]{40}$/;

/** True for a 40-character lowercase hex string. */
export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

export type GitObjectType = "commit" | "tree" | "blob" | "tag";

export type GitObject = {
  readonly type: GitObjectType;
  /** The object body, without the "<type> <size>\0" header. */
  readonly content: Uint8Array;
  /** The object's id: SHA-1 over header and body, as lowercase hex. */
  readonly oid: string;
};

export function makeObject(type: GitObjectType, content: Uint8Array): GitObject {
  return { type, content, oid: gitObjectId(type, content) };
}

export function makeBlob(content: string | Uint8Array): GitObject {
  return makeObject("blob", typeof content === "string" ? utf8(content) : content);
}

/** The modes git records in a tree entry. "40000" is a directory, "160000" a submodule. */
export type TreeMode = "100644" | "100755" | "120000" | "160000" | "40000";

export type TreeEntry = {
  readonly mode: TreeMode;
  /** One path segment: no "/", no NUL, never ".", ".." or ".git". */
  readonly name: string;
  readonly oid: string;
};

/**
 * The bytes of a tree object. Entries are sorted the way git sorts them: by raw name bytes,
 * with directories compared as if their name ended in "/" (a file `foo.bar` then sorts before
 * the directory `foo`).
 */
export function makeTree(entries: readonly TreeEntry[]): GitObject {
  const seen = new Set<string>();
  const keyed = entries.map((entry) => {
    if (entry.name.length === 0 || entry.name.includes("/") || entry.name.includes("\0")) {
      throw new Error(`invalid tree entry name: ${JSON.stringify(entry.name)}`);
    }
    if (entry.name === "." || entry.name === ".." || entry.name === ".git") {
      throw new Error(`forbidden tree entry name: ${entry.name}`);
    }
    if (!isOid(entry.oid)) throw new Error(`invalid oid for tree entry ${entry.name}: ${entry.oid}`);
    if (seen.has(entry.name)) throw new Error(`duplicate tree entry name: ${entry.name}`);
    seen.add(entry.name);
    return { entry, key: utf8(entry.mode === "40000" ? `${entry.name}/` : entry.name) };
  });
  keyed.sort((a, b) => compareBytes(a.key, b.key));
  const parts: Uint8Array[] = [];
  for (const { entry } of keyed) {
    parts.push(utf8(`${entry.mode} ${entry.name}\0`), hexToBytes(entry.oid));
  }
  return makeObject("tree", concatBytes(parts));
}

export type Ident = {
  readonly name: string;
  readonly email: string;
  /** Unix seconds. */
  readonly timestamp: number;
  /** Timezone as git prints it, for example "+0000". Default "+0000". */
  readonly tz?: string;
};

function formatIdent(ident: Ident): string {
  if (/[<>\n]/.test(ident.name) || /[<>\n]/.test(ident.email)) {
    throw new Error(`invalid ident ${JSON.stringify(ident.name)} <${JSON.stringify(ident.email)}>`);
  }
  return `${ident.name} <${ident.email}> ${Math.floor(ident.timestamp)} ${ident.tz ?? "+0000"}`;
}

export type CommitInput = {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: Ident;
  /** Defaults to the author. */
  readonly committer?: Ident;
  /** Ends with exactly one LF in the object; a trailing LF is added when missing. */
  readonly message: string;
};

export function makeCommit(input: CommitInput): GitObject {
  if (!isOid(input.tree)) throw new Error(`invalid tree oid: ${input.tree}`);
  for (const parent of input.parents) {
    if (!isOid(parent)) throw new Error(`invalid parent oid: ${parent}`);
  }
  const message = input.message.endsWith("\n") ? input.message : `${input.message}\n`;
  const lines = [
    `tree ${input.tree}`,
    ...input.parents.map((parent) => `parent ${parent}`),
    `author ${formatIdent(input.author)}`,
    `committer ${formatIdent(input.committer ?? input.author)}`,
    "",
    message,
  ];
  return makeObject("commit", utf8(lines.join("\n")));
}
