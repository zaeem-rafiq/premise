// Heads-ups: what Trunk tells an attempt when a landing, a submit, an undo or a revert touches what
// the attempt depends on. Source: 01-core 8.2 (payload), 8.1 (causes).

import type { PremiseKind } from "./premise.ts";

/** The results a heads-up carries (01-core 8.1). `info` never asks for a model turn. */
export type HeadsUpResult = "info" | "confirm" | "repair";

/** What changed something for the attempt (01-core 8.2). */
export type HeadsUpCauseType = "landing" | "submit" | "undo" | "revert";

export type HeadsUp = {
  hn: number; // per attempt: 1, 2, 3, ...
  attempt_id: string;
  result: HeadsUpResult;
  wake: boolean; // HE2: true for confirm and repair sent to an attempt that is not stopped
  cause: {
    type: HeadsUpCauseType;
    seqs: number[]; // landings that changed something for this attempt
    changes: Array<{ seq: number; change_id: string; intent_text: string | null }>;
  };
  items: HeadsUpItem[];
  dropped_ops: Array<{ op_seq: number; path: string; rule: "OP1" | "OP2" | "OP3" | "OP4" | "OP5" }>;
  go_around: number | null; // the go-around this heads-up started or joined
  head_seq: number; // head after the trigger
  created_at: number;
};

export type HeadsUpItem = {
  premise: { kind: PremiseKind | "check"; key: string };
  rule: string; // decision table row
  result: "holds" | "pending" | "confirm" | "repair"; // "holds" and "pending" appear only as info-level items
  reason: string;
  old_hash: string;
  new_hash: string;
  cause_seq: number | null; // first landing in the batch that changed this key
  diff: Diff;
  uses: Array<{ path: string; entity: string; line: number; text: string }>; // the attempt's own lines that reference the key
  truncated?: true; // HU10: texts were left out
};

export type Diff =
  | { kind: "entity"; before: string | null; after: string | null; before_unavailable?: true }
  | { kind: "file"; before_oid: string; after_oid: string; unified: string; changed_entities: string[] }
  | { kind: "listing"; added: string[]; removed: string[] }
  | {
      kind: "query";
      added: Array<{ key: string; source: string | null }>;
      removed: string[];
      context: Array<{ key: string; source: string }>;
    }
  | { kind: "check"; check: string; code: string }; // rule CKL; a fixed code, never free text
