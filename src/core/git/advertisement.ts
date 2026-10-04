// The ref advertisement of 01-core.md 9.5: the first bytes of a smart-protocol info/refs answer,
// parsed into refs, capabilities and the HEAD line (LP6). Pkt-lines carry either
// "<oid> <name>\n" or "# service=<name>".

import { text } from "../sync/bytes.ts";
import { parsePktLines } from "./pkt-line.ts";

export type RefAdvertisement = {
  /** The symref target of HEAD when the advertisement announces it (`symref=HEAD:<target>`). */
  readonly head: string | null;
  /** The capability strings of the zero-id first ref line (or an empty list). */
  readonly capabilities: string[];
  /** Advertised refs by name (for example "refs/heads/main"); the first line's zero-id placeholder and peeled "^" entries are excluded. */
  readonly refs: Map<string, string>;
};

/**
 * The pkt-lines of an info/refs response for `git-receive-pack`. Accepts the raw body (with the
 * "# service=" line when the response includes one) and parses everything up to the flush packet.
 */
export function parseRefAdvertisement(bytes: Uint8Array): RefAdvertisement {
  let head: string | null = null;
  let capabilities: string[] = [];
  const refs = new Map<string, string>();
  let firstRef = true;
  for (const line of parsePktLines(bytes)) {
    if (line.kind === "flush") {
      // The "# service=" preamble of an info/refs response ends in a flush of its own; the
      // advertisement follows it. A flush after the first ref line ends the advertisement.
      if (firstRef) continue;
      break;
    }
    let s = text(line.payload);
    if (s.endsWith("\n")) s = s.slice(0, -1);
    if (s.startsWith("# service=")) continue;
    if (firstRef) {
      const nul = s.indexOf("\0");
      if (nul !== -1) {
        capabilities = s
          .slice(nul + 1)
          .split(" ")
          .filter((c) => c.length > 0);
        s = s.slice(0, nul);
      }
      firstRef = false;
    }
    const space = s.indexOf(" ");
    if (space === -1) continue;
    const oid = s.slice(0, space);
    const name = s.slice(space + 1);
    if (name === "HEAD") head = oid;
    else if (!name.endsWith("^{}") && oid !== "0".repeat(40)) refs.set(name, oid);
  }
  // The real form of a HEAD announcement: the symref capability (protocol v0, upload-pack).
  for (const capability of capabilities) {
    if (capability.startsWith("symref=HEAD:")) head = capability.slice(12);
  }
  return { head, capabilities, refs };
}
