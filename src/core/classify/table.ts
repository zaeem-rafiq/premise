// src/core/classify/classify.ts — the pure classification of 7.1/7.2: the decision table
// (rowFor) and classification over a (before, after) file-map pair (classify).
//
// Pure and synchronous: no clock, no randomness, no I/O. The engine in src/core/trunk calls
// rowFor for one changed premise and classify for a whole (before, after) pair; QR4 needs the
// frozen premises of the landings being applied (`landers`).

import type { Attempt, ClassifyItem, FileMap, Pool, Premise, Sets } from "../trunk/sets.ts";
import {
  curOps,
  entityAt,
  entityKeysOf,
  isModule,
  keyHash,
  literalNames,
  pathOf,
  replayOps,
  setsOf,
  sourceOf,
  created,
  sweeping,
} from "../trunk/sets.ts";
import { languageOfPath, TIDEPOOL_LANGUAGES } from "../keys/paths.ts";

export type Row = [string, "holds" | "info" | "confirm" | "repair" | "triage" | "delete", string];

/** The decision-table row of section 7.2 for one changed premise. */
export function rowFor(
  pool: Pool | null,
  a: Attempt,
  p: Premise,
  it: ClassifyItem,
  s: Sets,
  before: FileMap,
  after: FileMap,
): Row {
  const hasOps = curOps(a).length > 0;
  let row: Row;
  if (p.kind === "entity") {
    if (p.edit || s.Edited.has(p.key)) row = ["E1", "repair", "edited_entity_changed"];
    else if (s.NewRefs.has(p.key)) row = ["E2", "repair", "referenced_entity_changed"];
    else if (s.ModuleRefs.has(p.key)) row = ["E2m", "confirm", "module_reference_changed"];
    else if (p.read || a.premises.get(`file|${pathOf(p.key)}`)?.read === true)
      row = ["E3", "triage", "read_not_referenced"];
    else row = ["E4", "delete", "reference_gone"];
  } else if (p.kind === "file") {
    const P = p.key;
    const mb = isModule(P, s.languages) ? entityKeysOf(before, P, s.languages) : null;
    const ma = isModule(P, s.languages) ? entityKeysOf(after, P, s.languages) : null;
    const writes = curOps(a).some((o) => o.path === P && (o.op === "write" || mb === null));
    // LG10: the extra `file` premise of LG4 (`derived`, on a Python or Go module) is classified as
    // if its path were in ModuleRefs: F3m for an entity change, F5 when the file turns opaque or is
    // removed, F2 for a comment or whitespace change; never F7.
    const language = languageOfPath(P, s.languages);
    const byName = p.derived && (language === "python" || language === "go");
    if (p.edit && writes) row = ["F1", "repair", "write_base_changed"];
    else if (mb !== null && ma !== null) {
      const D = it.changed ?? [];
      if (D.length === 0) row = ["F2", "holds", "cosmetic"];
      else if (D.some((k) => s.NewRefs.has(k) || s.Edited.has(k)) || s.NewRefs.has(P)) {
        row = ["F3", "repair", s.NewRefs.has(P) ? "referenced_file_changed" : "referenced_entity_changed"];
      } else if (D.some((k) => s.ModuleRefs.has(k)) || s.ModuleRefs.has(P) || byName)
        row = ["F3m", "confirm", "module_reference_changed"];
      else if (p.read) row = ["F4", "triage", "read_not_referenced"];
      else row = ["F7", "delete", "reference_gone"];
    } else {
      const all = [...s.NewRefs, ...s.ModuleRefs];
      const referenced = byName || all.includes(P) || all.some((k) => k.startsWith(`${P}#`));
      if (referenced) row = ["F5", "repair", "referenced_file_changed"];
      else if (p.read) row = ["F6", "triage", "read_not_referenced"];
      else row = ["F7", "delete", "reference_gone"];
    }
  } else if (p.kind === "listing") {
    const made = created(a, before);
    const prefix = p.key === "/" ? "" : p.key;
    const shown = Array.isArray(p.shown) ? p.shown : [];
    const unshown = (it.members ?? []).filter((n) => !shown.includes(n) && !made.has(prefix + n));
    const lit = literalNames(a, s);
    const named = [...(it.added ?? []), ...(it.removed ?? [])].some(
      (n) => !made.has(prefix + n) && (lit.has(n) || lit.has(n.replace(/\.[^.]*$/, ""))),
    );
    if (unshown.length > 0 && sweeping(a, p.key, before)) {
      row = ["L1", "repair", "sweep_incomplete"];
      it.added = unshown;
    } else if (named) row = ["L2", "confirm", "listing_named"];
    else row = ["L3", "holds", "listing_unused"];
  } else if (p.key.startsWith("text:")) {
    const pinned = (it.oldMembers ?? []).map((m) => m.slice(0, m.lastIndexOf("*")));
    const swept = pinned.filter((c) =>
      c.includes("#") ? s.Altered.includes(c) : curOps(a).some((o) => o.path === c),
    ).length;
    if ((it.added ?? []).length > 0 && pinned.length > 0 && swept >= Math.min(2, pinned.length)) {
      row = ["QT1", "repair", "sweep_incomplete"];
    } else if ((it.added ?? []).length > 0) row = ["QT2", "triage", "search_gained_match"];
    else row = ["QT3", "holds", "match_lost"];
  } else if (p.key.startsWith("refs:")) {
    if (!s.Altered.includes(p.key.slice(5))) row = ["QR3", "delete", "n/a"];
    else if ((it.added ?? []).length > 0) row = ["QR1", "repair", "new_reference_to_altered_entity"];
    else if ((it.context ?? []).length > 0) row = ["QR1m", "confirm", "referrer_module_changed"];
    else row = ["QR2", "holds", "match_lost"];
  } else if (p.key.startsWith("outline:")) {
    const path = p.key.slice(8);
    const oldM = it.oldMembers ?? [];
    const newM = it.members ?? [];
    const changedNames = [...oldM.filter((l) => !newM.includes(l)), ...newM.filter((l) => !oldM.includes(l))].map(
      (l) => `${path}#${l.split("|")[0] ?? ""}`,
    );
    if (changedNames.some((k) => s.NewRefs.has(k) || s.Edited.has(k)))
      row = ["QO1", "repair", "outlined_entity_changed"];
    else row = ["QO2", "holds", "outline_unused"];
  } else {
    // V5: a changed premise that matches no row fails closed: confirm, Z1, unclassified.
    row = ["Z1", "confirm", "unclassified"];
  }
  if (row[1] === "triage" && !hasOps) row = ["X0", "info", "no_patch_yet"];
  return row;
}

export type Classification = {
  items: ClassifyItem[];
  failed: Array<{ op_seq: number; path: string; rule: string }>;
};

/**
 * Classify the attempt's changed premises against (`before` -> `after`) by section 7. `landers`
 * is the frozen premise set of landings being applied (row QR4). `rep` is the replay of the
 * attempt's ops on `after`, which double-checks the ops still apply there.
 */
export function classify(
  pool: Pool | null,
  a: Attempt,
  before: FileMap,
  after: FileMap,
  setsOverride: Sets | null,
  landers: Array<{ premises: Premise[]; attempt_id?: string }> = [],
): Classification {
  const L = setsOverride?.languages ?? pool?.languages ?? TIDEPOOL_LANGUAGES;
  let computedSets = setsOverride;
  // Most right-of-way and batch comparisons change no premise. Reference analysis
  // of the attempt view is needed only when a rule can actually decide something.
  // The sets remain local to this synchronous call and always use the pre-change tree (V6).
  const getSets = (): Sets => (computedSets ??= setsOf(a, before, L));
  const items: ClassifyItem[] = [];
  for (const p of a.premises.values()) {
    const cur = keyHash(after, p.kind, p.key, L);
    if (cur.hash === p.hash) continue;
    const it: ClassifyItem = {
      p,
      kind: p.kind,
      key: p.key,
      old_hash: p.hash,
      new_hash: cur.hash,
      members: cur.members,
      oldMembers: p.members,
      before,
      after,
    };
    if (p.kind === "entity") {
      it.after_src = entityAt(after, p.key, L) !== null ? sourceOf(after, p.key, L) : null;
    } else if (p.kind === "file") {
      const P = p.key;
      const mb = isModule(P, L) ? entityKeysOf(before, P, L) : null;
      const ma = isModule(P, L) ? entityKeysOf(after, P, L) : null;
      it.changed = [];
      if (mb !== null && ma !== null) {
        for (const k of new Set([...mb, ...ma])) {
          const b = entityAt(before, k, L);
          const c = entityAt(after, k, L);
          if (b === null || c === null || b.hash !== c.hash) it.changed.push(k);
        }
      }
    } else if (p.kind === "listing") {
      const oldM = p.members ?? [];
      const newM = cur.members ?? [];
      it.added = newM.filter((n) => !oldM.includes(n));
      it.removed = oldM.filter((n) => !newM.includes(n));
    } else if (p.key.startsWith("text:")) {
      const cont = (m: string): string => m.slice(0, m.lastIndexOf("*"));
      const cnt = (m: string): number => Number(m.slice(m.lastIndexOf("*") + 1));
      const oldC = new Map((p.members ?? []).map((m) => [cont(m), cnt(m)]));
      const newC = new Map((cur.members ?? []).map((m) => [cont(m), cnt(m)]));
      it.added = [...newC]
        .filter(([c, n]) => n > (oldC.get(c) ?? 0))
        .map(([c]) => c)
        .sort();
      it.removed = [...oldC]
        .filter(([c, n]) => n > (newC.get(c) ?? 0))
        .map(([c]) => c)
        .sort();
    } else if (p.key.startsWith("refs:")) {
      const isRef = (m: string): boolean => m.includes("#");
      const newM = cur.members ?? [];
      const oldM = p.members ?? [];
      it.added = newM.filter((m) => isRef(m) && !oldM.includes(m));
      it.removed = oldM.filter((m) => isRef(m) && !newM.includes(m));
      // context: entities added or altered in the modules that hold a referrer now (QR1m).
      it.context = [];
      const mods = new Set(newM.filter(isRef).map(pathOf));
      for (const m of mods) {
        for (const k of entityKeysOf(after, m, L) ?? []) {
          const b = before.has(m) ? entityAt(before, k, L) : null;
          const c = entityAt(after, k, L);
          if ((b === null || (c !== null && b.hash !== c.hash)) && !it.added.includes(k)) it.context.push(k);
        }
      }
      it.context.sort();
    }
    const row = rowFor(pool, a, p, it, getSets(), before, after);
    it.rule = row[0];
    it.result = row[1];
    it.reason = row[2];
    items.push(it);
  }
  // HU2a: a file item is folded when entity items of the same classification carry every relevant
  // changed entity.
  for (const it of items) {
    const s = getSets();
    if (
      it.kind === "file" &&
      (it.rule === "F3" || it.rule === "F3m") &&
      !s.NewRefs.has(it.key) &&
      !s.ModuleRefs.has(it.key)
    ) {
      const rel = (it.changed ?? []).filter((k) => s.NewRefs.has(k) || s.Edited.has(k) || s.ModuleRefs.has(k));
      if (
        rel.length > 0 &&
        rel.every((k) =>
          items.some((x) => x.kind === "entity" && x.key === k && (x.result === "repair" || x.result === "confirm")),
        )
      ) {
        it.folded = true;
      }
    }
  }
  // QR4: a landing that only read K, while this attempt alters K.
  // Its hash can be unchanged, so this scan is independent of the changed items.
  // Match frozen readers first to avoid computing the attempt's sets when QR4
  // cannot apply. Keep the first matching lander, as required for its decider.
  const readers = new Map<string, (typeof landers)[number]>();
  if (landers.length > 0) {
    for (const p of a.premises.values()) {
      if (p.kind !== "query" || !p.key.startsWith("refs:")) continue;
      const K = p.key.slice(5);
      const reader = landers.find((l) =>
        l.premises.some(
          (q) =>
            q.read &&
            !q.edit &&
            !q.derived &&
            ((q.kind === "entity" && q.key === K) ||
              (q.kind === "file" &&
                q.key === pathOf(K) &&
                !l.premises.some((r) => r.kind === "entity" && r.key === K && (r.edit || r.derived)))),
        ),
      );
      if (reader !== undefined) readers.set(K, reader);
    }
  }
  // OP7: an operation can fail even when every premise hash still holds.
  const rep = replayOps(curOps(a), after, {}, L);
  for (const K of readers.size === 0 ? [] : getSets().Altered) {
    if (entityAt(before, K, L) === null || rep.failed.some((f) => f.path === pathOf(K))) continue;
    const reader = readers.get(K);
    if (reader === undefined) continue;
    const p = a.premises.get(`query|refs:${K}`);
    if (p === undefined) continue;
    let it = items.find((x) => x.p === p);
    if (it !== undefined && (it.result === "repair" || it.result === "confirm")) continue;
    if (it === undefined) {
      it = {
        p,
        kind: p.kind,
        key: p.key,
        old_hash: p.hash,
        new_hash: p.hash,
        members: p.members,
        oldMembers: p.members,
        added: [],
        removed: [],
        context: [],
        before,
        after,
      };
      items.push(it);
    }
    it.rule = "QR4";
    it.result = "triage";
    it.reason = "reader_landed";
    // TR8: the reader decides the triage of QR4 (its truth list, its frozen premise on K).
    if (reader.attempt_id !== undefined) it.decider = reader.attempt_id;
  }
  return { items, failed: rep.failed };
}
