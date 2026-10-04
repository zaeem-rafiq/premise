// src/core/trunk/premises.ts — premise pinning and the synchronization of 01-core.md 6.4/6.5:
// the implied edit premises (R4, R4a, W4), the derived premises (D1, D1b, D2) and their cleanup
// (R5, D4). `pin` is the only place a premise row is created or re-pinned at head.
//
// Pure and synchronous: every function takes the working Pool and mutates the attempt's premise
// map; registry persists the rows at the end of the call.

import type { PremiseKind, PremiseRef } from "../../protocol/premise.ts";
import { ABSENT } from "../../protocol/premise.ts";
import type { Attempt, FileMap, Pool, Premise } from "./sets.ts";
import { curOps, entityAt, keyHash, pathOf, setsOf } from "./sets.ts";

export const pid = (kind: string, key: string): string => `${kind}|${key}`;

/**
 * Pin `kind`/`key` for `a` at `files`/`seq` (head by default), setting the named flags.
 * `repin` refreshes hash, seq and members (a repeated read pins again at head, 4.4).
 * A `read` flag also records `shown`: the hash the tool showed (entity/file) or the member
 * names it listed (listing), per 3.2.
 */
export function pin(
  pool: Pool,
  a: Attempt,
  kind: PremiseKind,
  key: string,
  flags: { read?: boolean; edit?: boolean; derived?: boolean; repin?: boolean },
  files: FileMap = pool.files,
  seq: number = pool.headSeq(),
): Premise {
  const id = pid(kind, key);
  const h = keyHash(files, kind, key);
  let p = a.premises.get(id);
  if (p === undefined) {
    p = {
      kind,
      key,
      hash: h.hash,
      seq,
      members: h.members,
      shown: null,
      read: false,
      edit: false,
      derived: false,
      status: "holds",
    };
    a.premises.set(id, p);
  } else if (flags.repin === true) {
    p.hash = h.hash;
    p.seq = seq;
    p.members = h.members;
  }
  if (flags.read === true) {
    p.read = true;
    p.shown = kind === "listing" ? [...(h.members ?? [])] : h.hash;
  }
  if (flags.edit === true) p.edit = true;
  if (flags.derived === true) p.derived = true;
  pool.dirtyAttempts.add(a.id);
  return p;
}

/** The `PremiseRef` wire shape (4.1, TA7). */
export function ref(p: Premise): PremiseRef {
  return { kind: p.kind, key: p.key, hash: p.hash, seq: p.seq, read: p.read, edit: p.edit, derived: p.derived };
}

/**
 * R4/R4a/W4 + D1/D1b/D2 after every change of the operations (4.7 W5, 4.8 R5, CK7). Returns the
 * premises the call created or whose flags changed (TA7). A premise that loses all flags is
 * deleted (R5) and any pending triage on it is closed (V7a) — here it drops out of the pending
 * list, and the judgment is resolved `holds` with reason `premise_gone`.
 */
export function syncPremises(pool: Pool, a: Attempt): Premise[] {
  const head = pool.files;
  const s = setsOf(a, head);
  const changed = new Set<Premise>();
  const flag = (kind: PremiseKind, key: string, f: "edit" | "derived"): Premise => {
    const had = a.premises.get(pid(kind, key));
    const p = pin(pool, a, kind, key, {});
    if (had === undefined || !p[f]) {
      p[f] = true;
      changed.add(p);
    }
    return p;
  };

  // edit flags: file for write paths, entity for replace targets that exist at head, absence
  // premises for entities the attempt adds to a module that exists at head (R4a).
  const wantEdit = new Set<string>();
  for (const o of curOps(a)) {
    if (o.op === "write") wantEdit.add(pid("file", o.path));
    else {
      for (const t of o.targets ?? []) {
        if (t.includes("#")) {
          if (entityAt(head, t) !== null) wantEdit.add(pid("entity", t));
        } else if (head.has(t)) wantEdit.add(pid("file", t));
      }
    }
  }
  for (const k of s.Added) {
    if (head.has(pathOf(k))) wantEdit.add(pid("entity", k));
  }

  // derived flags: D1/D1b for NewRefs ∪ ModuleRefs, D2 refs: queries for Altered.
  const wantDerived = new Set<string>();
  for (const K of [...s.NewRefs, ...s.ModuleRefs]) {
    if (K.includes("#")) {
      if (entityAt(head, K) !== null || s.Negatives.has(K)) wantDerived.add(pid("entity", K));
    } else if (head.has(K)) wantDerived.add(pid("file", K));
  }
  for (const K of s.Altered) wantDerived.add(pid("query", `refs:${K}`));

  for (const id of wantEdit) {
    const i = id.indexOf("|");
    flag(id.slice(0, i) as PremiseKind, id.slice(i + 1), "edit");
  }
  for (const id of wantDerived) {
    const i = id.indexOf("|");
    flag(id.slice(0, i) as PremiseKind, id.slice(i + 1), "derived");
  }

  for (const [id, p] of [...a.premises]) {
    // A non-refs: query premise (text:, outline:) is the agent's own read and is never swept.
    if (p.kind === "query" && !p.key.startsWith("refs:")) continue;
    if (p.kind === "listing") continue;
    if (p.edit && !wantEdit.has(id)) p.edit = false;
    if (p.derived && !wantDerived.has(id)) p.derived = false;
    if (!p.read && !p.edit && !p.derived) {
      a.premises.delete(id);
      changed.delete(p);
      pool.event("premise.removed", { attempt_id: a.id, kind: p.kind, key: p.key, rule: "flags_cleared" });
      pool.dropPendingItem(a, p);
    }
  }
  return [...changed];
}

/** The read-covered test of section 7: a `read` flag, or a `read` file premise on the entity's module. */
export function readCovered(a: Attempt, p: Premise): boolean {
  return p.read || (p.kind === "entity" && a.premises.get(pid("file", pathOf(p.key)))?.read === true);
}

/** `refs:` members at head right now — the `relied_on_by` map of write/replace results (D2). */
export function reliedOnBy(pool: Pool, a: Attempt, altered: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const k of altered) {
    const p = a.premises.get(pid("query", `refs:${k}`));
    out[k] = (p?.members ?? keyHash(pool.files, "query", `refs:${k}`).members ?? []).filter((m) => m.includes("#"));
  }
  return out;
}

export { ABSENT };
