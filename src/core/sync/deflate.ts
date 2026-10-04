// zlib deflate and inflate, synchronous through node:zlib (SY1). The pack writer uses deflate;
// inflate exists for readers and for tests.

import { deflateSync, inflateSync } from "node:zlib";

export function deflate(data: Uint8Array): Uint8Array {
  return new Uint8Array(deflateSync(data));
}

export function inflate(data: Uint8Array): Uint8Array {
  return new Uint8Array(inflateSync(data));
}
