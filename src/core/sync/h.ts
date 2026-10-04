// `H(s)` as docs/spec/01-core.md section 2 defines it: the first 32 lowercase hex characters of
// SHA-256 over the UTF-8 bytes of `s`. Synchronous through node:crypto (SY1).

import { createHash } from "node:crypto";
import { utf8 } from "./bytes.ts";

export function H(s: string): string {
  return createHash("sha256").update(utf8(s)).digest("hex").slice(0, 32);
}
