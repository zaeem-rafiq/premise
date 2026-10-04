// Byte helpers for the pure core: the only encodings the git formats need.
// Everything here is synchronous and deterministic (SY1, SY2).

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The UTF-8 bytes of a string. */
export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** The string held in UTF-8 bytes. */
export function text(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** One byte string out of a list of byte strings, in order. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** The bytes a lowercase or uppercase hex string spells. Throws on odd length or non-hex text. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`invalid hex string of ${hex.length} characters`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** The lowercase hex spelling of a byte string. */
export function bytesToHex(bytes: Uint8Array): string {
  const digits: string[] = [];
  for (const byte of bytes) digits.push(byte.toString(16).padStart(2, "0"));
  return digits.join("");
}

/** The order git uses for tree entry names: unsigned byte order, shorter is smaller. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < n; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (x !== y) return x - y;
  }
  return a.byteLength - b.byteLength;
}
