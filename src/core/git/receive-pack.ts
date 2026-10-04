// The receive-pack protocol of 01-core.md 9.5: one request is the pkt-lines of the command section
// (first line with capabilities after NUL, following lines without), a flush packet, then the pack.
// The reply is a report: a command-result line per ref ("ok <ref>" / "ng <ref> <reason>") between
// "unpack ok" and the final flush.

import { concatBytes, text } from "../sync/bytes.ts";
import { FLUSH_PKT, parsePktLines, pktLine } from "./pkt-line.ts";

const OID_RE = /^[0-9a-f]{40}$/;

export type RefCommand = {
  readonly ref: string;
  /** The id the server must currently hold; ZERO_OID creates the ref. */
  readonly oldOid: string;
  /** The id the ref must point to after the push; ZERO_OID deletes the ref. */
  readonly newOid: string;
};

/** The capabilities a receive-pack request advertises (9.5: `report-status`). */
export const RECEIVE_PACK_CAPABILITIES = ["report-status"] as const;

/**
 * The body of a receive-pack request: pkt-lines `<old> <new> <ref>` for each command, the first
 * followed by NUL and the capability list, then a flush packet, then `pack` unchanged.
 */
export function buildReceivePackRequest(
  commands: readonly RefCommand[],
  capabilities: readonly string[],
  pack: Uint8Array,
): Uint8Array {
  if (commands.length === 0) throw new Error("a receive-pack request needs at least one command");
  const lines: Uint8Array[] = [];
  for (const [i, command] of commands.entries()) {
    if (!OID_RE.test(command.oldOid) || !OID_RE.test(command.newOid)) {
      throw new Error(`invalid oid in command for ${command.ref}`);
    }
    const caps = i === 0 && capabilities.length > 0 ? `\0${capabilities.join(" ")}` : "";
    lines.push(pktLine(`${command.oldOid} ${command.newOid} ${command.ref}${caps}\n`));
  }
  return concatBytes([...lines, FLUSH_PKT, pack]);
}

export type RefResult =
  { readonly ref: string; readonly ok: true } | { readonly ref: string; readonly ok: false; readonly error: string };

export type ReceivePackReport = {
  /** True when the server reported "unpack ok" (or no unpack error). */
  readonly unpackOk: boolean;
  /** The server's reason when the pack itself failed, or null. */
  readonly unpackError: string | null;
  /** One result per command, in the order the server reported them. */
  readonly results: RefResult[];
};

/** The report a server sends for a receive-pack request (9.5). */
export function parseReceivePackReport(bytes: Uint8Array): ReceivePackReport {
  let unpackOk = true;
  let unpackError: string | null = null;
  const results: RefResult[] = [];
  for (const line of parsePktLines(bytes)) {
    if (line.kind === "flush") break;
    const s = text(line.payload).replace(/\n$/, "");
    if (s === "unpack ok") unpackOk = true;
    else if (s.startsWith("unpack ")) {
      unpackOk = false;
      unpackError = s.slice(7);
    } else if (s.startsWith("ok ")) results.push({ ref: s.slice(3), ok: true });
    else if (s.startsWith("ng ")) {
      const space = s.indexOf(" ", 3);
      if (space === -1) results.push({ ref: s.slice(3), ok: false, error: "" });
      else results.push({ ref: s.slice(3, space), ok: false, error: s.slice(space + 1) });
    }
  }
  return { unpackOk, unpackError, results };
}
