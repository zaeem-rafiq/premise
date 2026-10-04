// The Artifacts adapter of S7 (02-tidepool 4.9, option B): `readFile` by commit id for bytes,
// `readCommit` + `readTree` for listings. Every read names a commit id (S7a) — the binding is never
// asked to resolve a ref, and Trunk is never reached (AS16, SE19).

import type { PoolSource, Version } from "../../../protocol/ports.ts";
import { blobId } from "../../../core/sync/sha1.ts";
import { poolRepoName } from "../../repos.ts";
import { commitOf, repoOf, resolveSource, type PoolFloorRead } from "./resolve.ts";

/** How the adapter reads the pool's Floor state (FS2). Throws propagate to the caller as 503s. */
export type FloorStateReader = (pool: string) => Promise<PoolFloorRead>;

/** The binding surface the adapter uses (the `Artifacts` type of worker-configuration.d.ts). */
export type ArtifactsLike = {
  get(name: string): Promise<{
    readFile(args: { ref: string; path: string }): Promise<Blob | null>;
    readCommit(hash: string): Promise<{ treeHash: string } | null>;
    readTree(hash: string): Promise<Array<{ name: string; type: string; hash: string }> | null>;
  }>;
};

/**
 * The Artifacts repository name that holds `version` of `pool`.
 *
 * The spec gives no naming scheme: SE22 constrains which repositories are served, and `pool.state`'s
 * `remote`/`plain_remote` carry their addresses — but the Floor's read does not expose those fields yet,
 * so the names are the pool's own by convention: `<pool>` and `<pool>-plain`. When the Floor read
 * grows the remote fields this function should follow them ("the app server follows it", SE19).
 */
export function repoName(pool: string, version: Version): string {
  return poolRepoName(pool, repoOf(version) === "plain" ? "plain" : "main");
}

function isMissingRepo(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "NOT_FOUND";
}

/** The PoolSource over the `POOLS` Artifacts binding (4.9, option B). One instance per request. */
export function artifactsPoolSource(deps: { pools: ArtifactsLike; floorState: FloorStateReader }): PoolSource {
  let read: Promise<PoolFloorRead> | null = null;
  const state = (pool: string) => {
    read ??= deps.floorState(pool);
    return read;
  };

  const repoFor = async (pool: string, version: Version) => {
    try {
      return await deps.pools.get(repoName(pool, version));
    } catch (error) {
      if (isMissingRepo(error)) return null; // a pool that was never provisioned: unknown, so 404
      throw error;
    }
  };

  return {
    async resolve(pool, source) {
      return resolveSource(await state(pool), source);
    },
    async read(pool, version, path) {
      const repo = await repoFor(pool, version);
      if (repo === null) return null;
      const blob = await repo.readFile({ ref: commitOf(version), path });
      if (blob === null) return null;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return { bytes, oid: blobId(bytes) };
    },
    async list(pool, version, dir) {
      const repo = await repoFor(pool, version);
      if (repo === null) return null;
      const commit = await repo.readCommit(commitOf(version));
      if (commit === null) return null;
      let tree = commit.treeHash;
      for (const segment of dir.split("/").filter(Boolean)) {
        const entries = await repo.readTree(tree);
        const next = entries?.find((entry) => entry.name === segment && entry.type === "tree");
        if (next === undefined) return null;
        tree = next.hash;
      }
      const entries = await repo.readTree(tree);
      if (entries === null) return null;
      return entries.map((entry) => ({
        name: entry.name,
        type: entry.type === "tree" ? ("dir" as const) : ("file" as const),
        oid: entry.hash,
      }));
    },
  };
}
