// The generated `~` modules of 02-tidepool 4.4: `~head.js`, `~boot.js`, `~registry.js`. None of them
// is stored in a pool repo; each is produced per request (and cached on the version routes, SE20).

import type { PoolSource, Version } from "../../protocol/ports.ts";
import type { PoolFloorRead, Resolved } from "../adapters/pool-source/resolve.ts";
import { H } from "../../core/sync/h.ts";
import { MAX_KINDS } from "../../protocol/constants.ts";

/** `~head.js`: the `landed` export tells the live frame which version its source points to now. */
export function headModule(pool: string, source: string, resolved: Resolved): string {
  const landed = {
    pool,
    source,
    version: resolved.version,
    base: `/pool/${pool}/v/${resolved.version}/`,
    seq: resolved.seq,
  };
  return `export const landed = ${JSON.stringify(landed, null, 2)};\n`;
}

/**
 * `~boot.js`: loads the host bundle and hands it the page's `landed` plus the frame's own
 * `import()` — a computed dynamic import may not live in checked `src/` files (the repository's
 * import allow-list refuses one), so generated code carries it.
 */
export function bootModule(hostBuild: string): string {
  return (
    `import { startHost } from "/pool/~host.${hostBuild}.js";\n` +
    `import { landed } from "./~head.js";\n` +
    `startHost(landed, (specifier) => import(specifier));\n`
  );
}

const KIND_NAME = /^[a-z][a-z0-9-]{0,30}$/;
const RESERVED = "constructor";

type RegistryKind = { kind: string; path: string; oid: string };
type Skipped = { name: string; reason: "not_a_kind" | "reserved_name" };

async function walkFiles(
  pools: PoolSource,
  pool: string,
  version: Version,
  dir: string,
  into: Array<{ path: string; oid: string }>,
): Promise<void> {
  const entries = await pools.list(pool, version, dir);
  if (entries === null) return;
  for (const entry of entries) {
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.type === "dir") {
      await walkFiles(pools, pool, version, path, into);
    } else {
      into.push({ path, oid: entry.oid });
    }
  }
}

/**
 * `~registry.js` (4.4, AS9–AS11). `null` when the version's listing cannot be read at all — the
 * caller maps that to 404 (empty `creatures/` is a registry with no kinds, not an error).
 */
export async function registryModule(
  pools: PoolSource,
  pool: string,
  version: Version,
  paths: PoolFloorRead["paths"],
): Promise<string | null> {
  const creatures = await pools.list(pool, version, "creatures");
  if (creatures === null) return null;

  // AS9: direct children of creatures/ only; a valid kind name plus `.js` makes a kind.
  const kinds: RegistryKind[] = [];
  const skipped: Skipped[] = [];
  for (const entry of creatures) {
    const base = entry.name.endsWith(".js") ? entry.name.slice(0, -3) : null;
    if (entry.type === "file" && base === "constructor") {
      skipped.push({ name: entry.name, reason: "reserved_name" });
    } else if (entry.type === "file" && base !== null && KIND_NAME.test(base)) {
      kinds.push({ kind: base, path: `creatures/${entry.name}`, oid: entry.oid });
    } else {
      skipped.push({ name: entry.name, reason: "not_a_kind" });
    }
  }
  kinds.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  skipped.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // AS11: over MAX_KINDS the newest-landed paths stay; unknown seqs and ties fall to name order.
  const total = kinds.length;
  const shown =
    kinds.length <= MAX_KINDS
      ? kinds
      : kinds
          .slice()
          .sort((a, b) => {
            const seqA = paths[a.path];
            const seqB = paths[b.path];
            if (seqA !== undefined && seqB !== undefined && seqA !== seqB) return seqB - seqA;
            if (seqA !== undefined && seqB === undefined) return -1;
            if (seqA === undefined && seqB !== undefined) return 1;
            return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
          })
          .slice(0, MAX_KINDS)
          .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

  // AS10: `shared` = H() of sorted `<path> <blob id>` lines over every file not directly in
  // creatures/ — including `.premise/` and anything nested below creatures/, which is not "directly
  // in creatures/" by the rule's own words.
  const files: Array<{ path: string; oid: string }> = [];
  await walkFiles(pools, pool, version, "", files);
  const lines = files
    .filter((file) => !/^creatures\/[^/]+$/.test(file.path))
    .map((file) => `${file.path} ${file.oid}`)
    .sort();
  const registry = {
    version,
    shared: H(lines.join("\n")),
    kinds: shown,
    total,
    skipped,
  };
  return `export const registry = ${JSON.stringify(registry, null, 2)};\n`;
}
