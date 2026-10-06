// UN1-UN3: synchronous causal closure and replay over Trunk's stored landing history.
import type { FileMap, Pool } from "../trunk/sets.ts";
import { replayOps } from "../trunk/sets.ts";

export type UndoComputation = {
  reverted: number[];
  files: FileMap;
  depKeys: Map<number, Set<string>>;
  kept: number[];
};

/**
 * UN3's plan for reverting `u` against `running`: R grows by dependency (premises pinned on what
 * a reverted landing wrote) and by replay failure; kept readers stay.
 */
export function planUndo(pool: Pool, u: number, running: FileMap, initial: readonly number[] = [u]): UndoComputation {
  const live = pool.landings.filter((l) => l.undone_by === null && l.kind === "change");
  // GR3 supplies a fixed range for a revert; an owner's undo starts with its one target.
  const R = new Set<number>([u, ...initial]);
  const depKeys = new Map<number, Set<string>>();
  for (;;) {
    let grew = false;
    for (const L of live) {
      for (const xs of R) {
        if (xs >= L.seq) continue;
        const X = pool.landings.find((l) => l.seq === xs);
        if (X === undefined) continue;
        for (const p of L.premises) {
          if (
            p.seq >= xs &&
            (p.kind === "entity" || p.kind === "file") &&
            (p.edit || p.derived) &&
            X.writes.some((w) => w.kind === p.kind && w.key === p.key)
          ) {
            let d = depKeys.get(L.seq);
            if (d === undefined) {
              d = new Set();
              depKeys.set(L.seq, d);
            }
            d.add(`${p.kind}|${p.key}`);
            if (!R.has(L.seq)) {
              R.add(L.seq);
              grew = true;
            }
          }
        }
      }
    }
    // Replay each un-reverted landing's ops on the reverted paths (UN3).
    const files = new Map(running);
    const P = new Set<string>();
    for (const s of R) for (const p of pool.landings.find((l) => l.seq === s)?.files.keys() ?? []) P.add(p);
    let failedLanding: number | null = null;
    for (const p of P) {
      const first = live.filter((l) => R.has(l.seq) && l.files.has(p)).sort((a, b) => a.seq - b.seq)[0];
      if (first === undefined) continue;
      let firstSeq = first.seq;
      // An earlier change can still be present in this historical baseline even though a later
      // undo removed it. Start before that change too, so omitting undone operations does not
      // resurrect its bytes. Undos already reflected in the baseline need no earlier replay.
      for (;;) {
        const startSeq = firstSeq;
        const earlier = pool.landings
          .filter(
            (l) =>
              l.kind === "change" &&
              l.seq < startSeq &&
              l.undone_by !== null &&
              l.undone_by >= startSeq &&
              l.files.has(p),
          )
          .sort((a, b) => a.seq - b.seq)[0];
        if (earlier === undefined) break;
        firstSeq = earlier.seq;
      }
      const tree = new Map<string, string>();
      const beforeP = pool.fileMapAt(firstSeq - 1).get(p);
      if (beforeP !== undefined) tree.set(p, beforeP);
      for (const L of live) {
        if (R.has(L.seq) || L.seq < firstSeq) continue;
        const ops = L.ops.filter((o) => o.path === p);
        if (ops.length === 0) continue;
        const r = replayOps(ops, tree, { noOP5: true }, pool.languages);
        if (r.failed.length > 0) {
          failedLanding = L.seq;
          break;
        }
        const got = r.files.get(p);
        if (got === undefined) tree.delete(p);
        else tree.set(p, got);
      }
      if (failedLanding !== null) break;
      const got = tree.get(p);
      if (got === undefined) files.delete(p);
      else files.set(p, got);
    }
    if (failedLanding !== null) {
      R.add(failedLanding);
      continue;
    }
    if (!grew) {
      const kept: number[] = [];
      for (const L of live) {
        if (R.has(L.seq)) continue;
        for (const xs of R) {
          if (xs >= L.seq) continue;
          const X = pool.landings.find((l) => l.seq === xs);
          if (X === undefined) continue;
          if (
            L.premises.some(
              (p) =>
                p.seq >= xs &&
                p.read &&
                !p.edit &&
                !p.derived &&
                X.writes.some((w) => w.kind === p.kind && w.key === p.key),
            )
          ) {
            if (!kept.includes(L.seq)) kept.push(L.seq);
          }
        }
      }
      return { reverted: [...R].sort((a, b) => a - b), files, depKeys, kept };
    }
  }
}
