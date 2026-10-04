// Undo: the owner's plan-first revert. Source: 01-core 11.3 (UN4, UN5).

export type UndoRefusal = "not_a_change" | "already_undone" | "too_old" | "too_many" | "plan_changed";

export type UndoPlan = {
  target_seq: number;
  reverted: number[]; // R, ascending seq
  reopened: string[]; // attempt ids (T19, T19s)
  kept_readers: number[]; // seqs of landings that only read what R wrote
  repairs: string[]; // in-flight attempt ids that would receive `repair`
};

export type UndoPlanResponse = { ok: true; plan: UndoPlan } | { ok: false; reason: UndoRefusal };

export type UndoResponse = { ok: true; request_id: string } | { ok: false; reason: UndoRefusal; plan?: UndoPlan }; // `plan` is the new plan when reason is "plan_changed"
