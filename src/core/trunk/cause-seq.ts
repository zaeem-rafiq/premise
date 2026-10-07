import type { PremiseKind } from "../../protocol/premise.ts";
import type { LanguageSet } from "../keys/paths.ts";
import { keyHash, type FileMap, type Landing } from "./sets.ts";

export type CauseSeq = (kind: PremiseKind, key: string) => number | null;

/**
 * 8.2 / EV4: the first prefix whose key differs from the tree before the batch.
 * `batch` is appended in seq order by tick. One resolver serves every judgment,
 * including holds committed before a candidate is appended (9.4 step 3d).
 *
 * Index write sets once. Only judged query/listing keys scan prefixes, at most once
 * per key/prefix. Landing.after retains the map identities that keyHash's module
 * analysis cache shares across keys. Listings use hashes because older write sets
 * (and the current recorder) do not include directory rows.
 */
export function batchCauseSeq(pre: FileMap, batch: readonly Landing[], languages: LanguageSet): CauseSeq {
  const firstWrite = new Map<string, number>();
  let indexed = 0;
  const derived = new Map<string, { hash: string; checked: number; seq: number | null }>();
  return (kind, key) => {
    const id = `${kind}|${key}`;
    if (kind === "entity" || kind === "file") {
      for (; indexed < batch.length; indexed++) {
        const landing = batch[indexed]!;
        for (const write of landing.writes) {
          const written = `${write.kind}|${write.key}`;
          if (!firstWrite.has(written)) firstWrite.set(written, landing.seq);
        }
      }
      return firstWrite.get(id) ?? null;
    }
    let entry = derived.get(id);
    if (entry === undefined) {
      entry = { hash: keyHash(pre, kind, key, languages).hash, checked: 0, seq: null };
      derived.set(id, entry);
    }
    while (entry.seq === null && entry.checked < batch.length) {
      const landing = batch[entry.checked++]!;
      if (keyHash(landing.after, kind, key, languages).hash !== entry.hash) entry.seq = landing.seq;
    }
    // QR4 can judge a reader landing even when no prefix changes the query hash.
    // In that case no landing changed this key, so the item's cause_seq is null.
    return entry.seq;
  };
}
