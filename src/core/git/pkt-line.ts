// pkt-line encoding and decoding (01-core.md 9.5): a 4-character lowercase hex length field covers
// the whole packet, and the all-zero line "0000" is the flush that ends a section.

import { concatBytes, text, utf8 } from "../sync/bytes.ts";

/** The packet "0000" that ends a section. */
export const FLUSH_PKT = utf8("0000");

/** One pkt-line with payload `payload` ("0000" for a flush packet). */
export function pktLine(payload: string | Uint8Array): Uint8Array {
  const body = typeof payload === "string" ? utf8(payload) : payload;
  return concatBytes([utf8((body.byteLength + 4).toString(16).padStart(4, "0")), body]);
}

/** True when `bytes` is exactly the flush packet "0000". */
export function isFlushPkt(line: Uint8Array): boolean {
  return line.byteLength === 4 && line[0] === 0x30 && line[1] === 0x30 && line[2] === 0x30 && line[3] === 0x30;
}

export type PktLine = { readonly kind: "data"; readonly payload: Uint8Array } | { readonly kind: "flush" };

/** The packets of a pkt-line stream. Throws on a truncated or malformed line. */
export function parsePktLines(bytes: Uint8Array): PktLine[] {
  const out: PktLine[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 4);
    if (header.byteLength < 4) throw new Error(`truncated pkt-line header at offset ${offset}`);
    const headerText = text(header);
    if (headerText === "0000") {
      out.push({ kind: "flush" });
      offset += 4;
      continue;
    }
    const length = parseInt(headerText, 16);
    if (Number.isNaN(length) || length < 4) {
      throw new Error(`malformed pkt-line length "${headerText}" at offset ${offset}`);
    }
    const end = offset + length;
    if (end > bytes.byteLength) {
      throw new Error(`pkt-line of ${length} bytes truncated at offset ${offset}`);
    }
    out.push({ kind: "data", payload: bytes.slice(offset + 4, end) });
    offset = end;
  }
  return out;
}
