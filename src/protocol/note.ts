// The git note one landing writes (01-core 3.5): the record of what the attempt depended on.

import type { PremiseKind, PremiseRef } from "./premise.ts";
import type { RiskAnswers } from "./cards.ts";

export type Note = {
  v: 1;
  hash_version: "ast1";
  seq: number;
  kind: "change" | "undo" | "revert";
  change_id: string;
  revision: number;
  intent: { id: string; text: string; requester: string; created_at: string } | null;
  attempt: {
    id: string;
    agent: "real" | "synthetic";
    model: string | null;
    repo: string | null;
    opened_seq: number;
    steps: number;
    model_calls: number;
    tokens_in: number;
    tokens_out: number;
  } | null;
  summary: string;
  premises: PremiseRef[];
  writes: Array<{ kind: "entity" | "file" | "listing"; key: string; old: string; new: string }>;
  ops: Array<
    | { op: "write"; path: string; blob: string } // content is this blob in the commit's tree
    | { op: "write"; path: string; content: string } // content not equal to the final blob
    | { op: "write"; path: string; delete: true }
    | { op: "replace"; path: string; old: string; new: string; targets: string[] }
    | { op: "replace"; path: string; old_oid: string; new_oid: string; targets: string[] } // NT2 only
  >;
  go_arounds: Array<{
    n: number;
    hn: number;
    cause: "landing" | "submit" | "undo" | "revert";
    cause_seqs: number[];
    keys: Array<{ kind: PremiseKind; key: string; rule: string }>;
    statement: string | null;
    at: string;
  }>;
  confirms: Array<{
    hn: number;
    keys: Array<{ kind: PremiseKind; key: string; rule: string }>;
    statement: string;
    at: string;
  }>;
  judgments: Array<{
    kind: PremiseKind;
    key: string;
    old: string;
    new: string;
    cause_seq: number | null;
    rule: string;
    class: "rule" | "triage";
    result: "holds" | "confirm" | "repair";
    reason: string;
    clef?: { model: string; p: number | null; error?: string; t_repair: number; t_confirm: number };
  }>;
  checks: Array<{ name: string; ok: true; detail?: string }>;
  policy: {
    tier: "auto" | "held";
    approved_by: string | null;
    approved_at: string | null;
    option: "land" | "land_now" | "choose" | null;
    risk: RiskAnswers | null;
  };
  pull_backs: number;
  truncated?: { judgments: number; statements: boolean; replace_texts: boolean }; // NT2
  batch: { id: number; index: number; size: number };
  timing: { opened_at: string; submitted_at: string; accepted_at: string };
  undo?: { requested_by: string; undoes: number[]; reopened: string[]; kept_readers: number[] };
};
