// Member sets and the listing and query hashes of 01-core.md 2.5 (with KH3).

import { H } from "../sync/h.ts";
import { blobId } from "../sync/sha1.ts";
import { utf8 } from "../sync/bytes.ts";

/** `H(JSON array of sorted members)`: the hash of a listing, a `text:`/`refs:`/`outline:` query (2.5). */
export function membersHash(members: readonly string[]): string {
  return H(JSON.stringify([...members].sort()));
}

/**
 * The members of a listing premise (2.5): the immediate children of `directory`, a subdirectory's
 * name ending in `/`. `tree` maps pool paths to their contents; a missing or empty directory has `[]`.
 */
export function listingMembers(tree: ReadonlyMap<string, string>, directory: string): string[] {
  const names = new Set<string>();
  for (const path of tree.keys()) {
    const rest = directory === "/" ? path : path.startsWith(directory) ? path.slice(directory.length) : null;
    if (rest === null || rest === "") continue;
    const slash = rest.indexOf("/");
    names.add(slash === -1 ? rest : rest.slice(0, slash + 1));
  }
  return [...names].sort();
}

/** The hash of a `listing:` premise (2.5). A directory that does not exist hashes the empty array. */
export function listingHash(tree: ReadonlyMap<string, string>, directory: string): string {
  return membersHash(listingMembers(tree, directory));
}

/** The hash of a `file:` premise (2.5): the git blob object id of the file's bytes. */
export function fileHash(content: string): string {
  return blobId(utf8(content));
}

/** The count part of a `text:` member (`<container>*<count>`): the decimal digits after the last `*` (KH3). */
export function textMemberCount(member: string): number {
  const star = member.lastIndexOf("*");
  return star === -1 ? 0 : Number(member.slice(star + 1));
}

/** The container part of a `text:` member: everything before the last `*` (KH3). */
export function textMemberContainer(member: string): string {
  const star = member.lastIndexOf("*");
  return star === -1 ? member : member.slice(0, star);
}

export type RefsMember = { kind: "referrer"; key: string } | { kind: "module"; path: string; hash: string };

/**
 * A `refs:` member parsed (KH3): a string that contains `#` is a referrer entity key, any other
 * string is a module entry `<path>@<module hash>` (`@` cannot occur in a path).
 */
export function refsMember(member: string): RefsMember {
  if (member.includes("#")) return { kind: "referrer", key: member };
  const at = member.lastIndexOf("@");
  return { kind: "module", path: member.slice(0, at), hash: member.slice(at + 1) };
}
