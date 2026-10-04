// The note blob of 01-core.md 3.5. NT1 (canonical bytes): the JSON value serialized with object
// keys sorted at every level (ascending by UTF-16 code unit), no insignificant whitespace,
// ECMAScript JSON.stringify rules for strings and numbers, UTF-8, followed by exactly one LF.
// NT2 (size): a note over the limit is shrunk in a fixed order until it fits, and the note's
// `truncated` field records what was done.

import { concatBytes, utf8 } from "../sync/bytes.ts";
import { blobId } from "../sync/sha1.ts";

/**
 * The canonical serialization of a JSON value: `JSON.stringify` over a copy whose object keys are
 * sorted at every level (ascending by UTF-16 code unit, `Array.prototype.sort`'s order).
 * Two implementations therefore produce the same note blob id for the same record (NT1).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** The note blob's content bytes of NT1: canonical JSON, UTF-8, followed by exactly one LF. */
export function noteBytes(note: unknown): Uint8Array {
  return concatBytes([utf8(canonicalJson(note)), utf8("\n")]);
}

/** The `truncated` field of 3.5: what NT2 did to make the note fit. */
export type NoteTruncated = {
  /** Number of `judgments` entries dropped (result "holds"). */
  judgments: number;
  /** True when at least one `statement` was cut to 120 code points. */
  statements: boolean;
  /** True when at least one `replace` operation had `old`/`new` replaced by `old_oid`/`new_oid`. */
  replace_texts: boolean;
};

export type ShrinkResult<T> = { ok: true; note: T } | { ok: false; reason: "note_too_large" };

const STATEMENT_CODE_POINTS = 120;

function firstCodePoints(text: string, count: number): string {
  return Array.from(text).slice(0, count).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cutStatements(note: Record<string, unknown>): boolean {
  let cut = false;
  for (const key of ["go_arounds", "confirms"] as const) {
    const entries = note[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const statement = entry["statement"];
      if (typeof statement === "string" && Array.from(statement).length > STATEMENT_CODE_POINTS) {
        entry["statement"] = firstCodePoints(statement, STATEMENT_CODE_POINTS);
        cut = true;
      }
    }
  }
  return cut;
}

function replaceTextsToOids(note: Record<string, unknown>): boolean {
  let replaced = false;
  const ops = note["ops"];
  if (!Array.isArray(ops)) return false;
  for (const entry of ops) {
    if (!isRecord(entry) || entry["op"] !== "replace") continue;
    const oldText = entry["old"];
    const newText = entry["new"];
    if (typeof oldText !== "string" || typeof newText !== "string") continue;
    delete entry["old"];
    delete entry["new"];
    entry["old_oid"] = blobId(utf8(oldText));
    entry["new_oid"] = blobId(utf8(newText));
    replaced = true;
  }
  return replaced;
}

/**
 * NT2: shrink `note` until `noteBytes` fits `maxBytes`, in this order, stopping as soon as it fits:
 * drop `judgments` whose result is `holds`; cut every `statement` (in `go_arounds` and `confirms`)
 * to 120 code points; replace the `old` and `new` of `replace` operations by their git blob ids
 * (`old_oid`, `new_oid`). What was done is recorded in the note's `truncated` field.
 * `maxBytes` is an argument: the caller passes NOTE_MAX_BYTES (262,144; 01-core.md Appendix C).
 * Returns `{ ok: false }` when the note still does not fit (step 3c fails with `note_too_large`).
 * The input is not modified.
 */
export function shrinkNote<T extends Record<string, unknown>>(note: T, maxBytes: number): ShrinkResult<T> {
  if (noteBytes(note).byteLength <= maxBytes) return { ok: true, note };
  const shrunk = structuredClone(note) as Record<string, unknown>;
  const truncated: NoteTruncated = { judgments: 0, statements: false, replace_texts: false };
  // The field is part of the final note, so it counts toward the limit in every check below.
  shrunk["truncated"] = truncated;
  const fits = (): boolean => noteBytes(shrunk).byteLength <= maxBytes;

  const judgments = shrunk["judgments"];
  if (Array.isArray(judgments)) {
    const kept = judgments.filter((j) => !(isRecord(j) && j["result"] === "holds"));
    truncated.judgments = judgments.length - kept.length;
    shrunk["judgments"] = kept;
  }
  if (fits()) return { ok: true, note: shrunk as T };
  truncated.statements = cutStatements(shrunk);
  if (fits()) return { ok: true, note: shrunk as T };
  truncated.replace_texts = replaceTextsToOids(shrunk);
  if (fits()) return { ok: true, note: shrunk as T };
  return { ok: false, reason: "note_too_large" };
}
