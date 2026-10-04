// Source resolution for the app server (02-tidepool 4.1, SE19). Moving sources resolve from the
// pool's Floor Durable Object state (FS2); commit sources resolve to themselves. Pure — this module
// does the shape checks and nothing else.
/**
 * The fields of the pool Floor's read (FS2) the app server consumes. The wire shape is `FloorRead`
 * of src/protocol/internal.ts (gap 1's one-definition rule); `PoolFloorRead` stays as this
 * adapter's name for it so the Node test program keeps working.
 */
export type PoolFloorRead = import("../../../protocol/internal.ts").FloorRead;

/** What `resolve` answers: the immutable version token and the `seq` the page reports in stats. */
export type Resolved = { version: string; seq: number | null };

const COMMIT_SEGMENT = /^[0-9a-f]{40}$/;
const PLAIN_COMMIT_SEGMENT = /^p-[0-9a-f]{40}$/;
export const VERSION_TOKEN = /^[cp]-[0-9a-f]{40}$/;

/** A commit source segment (4.1): `<40 hex>` of the pool repo or `p-<40 hex>` of the plain-merge repo. */
export function isCommitSource(source: string): boolean {
  return COMMIT_SEGMENT.test(source) || PLAIN_COMMIT_SEGMENT.test(source);
}

export function isVersionToken(version: string): boolean {
  return VERSION_TOKEN.test(version);
}

/** The commit id a version token names (S7a: every read names a commit id). */
export function commitOf(version: string): string {
  return version.slice(2);
}

/** Which of a pool's two repositories a version lives in (SE22). */
export function repoOf(version: string): "main" | "plain" | null {
  if (version.startsWith("c-")) return "main";
  if (version.startsWith("p-")) return "plain";
  return null;
}

/**
 * Resolve one source segment of 4.1. `null` means the source does not resolve — for `main`, `green`
 * and `plain` that is the state of a pool that does not exist (its Floor object holds only the empty
 * state, whose `landed_commit` is null).
 *
 * `seq` per route (4.4): `main` reports the landed commit's seq, `green` the green seq, `plain` the
 * `through_seq` of the last `plain.updated`, `<40 hex>` the seq of the landing with that commit while
 * the state still holds it (`FLOOR_KEEP_LANDINGS`), `p-<40 hex>` always null.
 */
export function resolveSource(read: PoolFloorRead, source: string): Resolved | null {
  if (COMMIT_SEGMENT.test(source)) {
    return { version: `c-${source}`, seq: read.landings_by_commit[source] ?? null };
  }
  if (PLAIN_COMMIT_SEGMENT.test(source)) {
    return { version: source, seq: null };
  }
  const seed = read.pool.landed_commit; // the seed commit rides `landed_commit` (SE19, AS17)
  switch (source) {
    case "main":
      // AS2: only landing.landed moves this; never an accepted-but-unpushed landing (LP10).
      return seed === null ? null : { version: `c-${seed}`, seq: read.pool.landed_seq };
    case "green":
      // SE19: while no green commit exists, `green` resolves to the seed commit.
      return read.green.commit !== null
        ? { version: `c-${read.green.commit}`, seq: read.green.seq }
        : seed === null
          ? null
          : { version: `c-${seed}`, seq: read.pool.landed_seq };
    case "plain":
      // AS17: before the first plain.updated, `plain` resolves to the seed commit of the pool repo.
      return read.plain !== null
        ? { version: `p-${read.plain.commit}`, seq: read.plain.through_seq }
        : seed === null
          ? null
          : { version: `c-${seed}`, seq: read.pool.landed_seq };
    default:
      return null;
  }
}
