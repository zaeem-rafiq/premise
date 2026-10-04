// The operation union of 01-core 5.1 — every change an attempt makes, before it lands.

/**
 * An operation of 5.1: a whole-file `write` (`content: null` deletes the file) or a unique-span
 * `replace` (`targets` are the recorded keys of the span, OP3), in `op_seq` order.
 */
export type Operation =
  | { op_seq: number; op: "write"; path: string; content: string | null; base_oid: string }
  | { op_seq: number; op: "replace"; path: string; old: string; new: string; targets: string[] };
