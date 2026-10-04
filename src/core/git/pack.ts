// The pack writer of 01-core.md 9.5: the thin pack of one push (all reachable objects are sent),
// built as header + deflated entries + trailer. Validated in test/git by `git index-pack` and
// `git fsck --strict`, and by a real `git http-backend` accepting it in a receive-pack request.

import { deflate } from "../sync/deflate.ts";
import { sha1 } from "../sync/sha1.ts";
import { concatBytes } from "../sync/bytes.ts";
import type { GitObject } from "./objects.ts";

const PACK_TYPES: Record<GitObject["type"], number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** The byte length of a pack entry's variable-length size field: 4 bits in the first byte, 7 in each after. */
function sizeLength(size: number): number {
  size >>>= 4;
  let n = 1;
  while (size !== 0) {
    size >>>= 7;
    n += 1;
  }
  return n;
}

/**
 * The "PACK" file holding `objects`, deflated in order, for `git index-pack` and for the body of a
 * receive-pack request. Duplicate object ids are an error. Sizes must fit 32 bits.
 */
export function buildPack(objects: readonly GitObject[]): Uint8Array {
  const seen = new Set<string>();
  const parts: Uint8Array[] = [];
  for (const object of objects) {
    if (seen.has(object.oid)) throw new Error(`duplicate object in pack: ${object.oid}`);
    seen.add(object.oid);
  }
  const header = new Uint8Array(12);
  header.set([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2]); // "PACK", version 2
  const view = new DataView(header.buffer);
  view.setUint32(8, objects.length, false);
  parts.push(header);
  for (const object of objects) {
    let size = object.content.byteLength;
    if (size > 0xffffffff) throw new Error(`object too large for a pack: ${size} bytes`);
    const entry = new Uint8Array(sizeLength(size));
    let i = 0;
    let byte = (size & 0x0f) | (PACK_TYPES[object.type] << 4);
    size >>>= 4;
    while (size !== 0) {
      entry[i] = byte | 0x80;
      byte = size & 0x7f;
      size >>>= 7;
      i += 1;
    }
    entry[i] = byte;
    parts.push(entry, deflate(object.content));
  }
  return concatBytes([...parts, sha1(concatBytes(parts))]);
}
