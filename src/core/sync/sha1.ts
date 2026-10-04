// SHA-1 and git object ids (SY1): an object's id is SHA-1 over "<type> <size>\0" + content.
// The `file` premise hash of 01-core.md 2.5 is the git blob id computed here.

import { createHash } from "node:crypto";
import { concatBytes, utf8 } from "./bytes.ts";

/** The 20 bytes of SHA-1 over `data`. */
export function sha1(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha1").update(data).digest());
}

/** The lowercase hex spelling of SHA-1 over `data`. */
export function sha1Hex(data: Uint8Array): string {
  return createHash("sha1").update(data).digest("hex");
}

/** The git object id of `<type> <size>\0` followed by `content`, as 40 lowercase hex characters. */
export function gitObjectId(type: "blob" | "tree" | "commit" | "tag", content: Uint8Array): string {
  return sha1Hex(concatBytes([utf8(`${type} ${content.byteLength}\0`), content]));
}

/** The git blob object id of a byte string (01-core.md 2.5). */
export function blobId(content: Uint8Array): string {
  return gitObjectId("blob", content);
}
