// A directory on disk (02-tidepool 4.9, option E): the PoolSource tests and local runs use.
// Layout: `<root>/<pool>/<version>/<path>`, where `<version>` is the full token (`c-<40 hex>` or
// `p-<40 hex>`). It is never wired into the deployment: `wiring.ts` imports the Artifacts adapter
// only, so this file stays out of the Worker bundle.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { PoolSource, Version } from "../../../protocol/ports.ts";
import { blobId } from "../../../core/sync/sha1.ts";
import { resolveSource } from "./resolve.ts";
import type { FloorStateReader } from "./artifacts.ts";

export function directoryPoolSource(deps: { root: string; floorState?: FloorStateReader }): PoolSource {
  const dir = (pool: string, version: Version) => join(deps.root, pool, version);
  return {
    async resolve(pool, source) {
      if (deps.floorState === undefined) return null;
      return resolveSource(await deps.floorState(pool), source);
    },
    async read(pool, version, path) {
      try {
        const bytes = new Uint8Array(await fs.readFile(join(dir(pool, version), path)));
        return { bytes, oid: blobId(bytes) };
      } catch {
        return null;
      }
    },
    async list(pool, version, directory) {
      try {
        const entries = await fs.readdir(join(dir(pool, version), directory), { withFileTypes: true });
        const out = [];
        for (const entry of entries) {
          if (entry.isDirectory()) {
            out.push({ name: entry.name, type: "dir" as const, oid: "" });
          } else if (entry.isFile()) {
            const bytes = new Uint8Array(await fs.readFile(join(dir(pool, version), directory, entry.name)));
            out.push({ name: entry.name, type: "file" as const, oid: blobId(bytes) });
          }
        }
        return out;
      } catch {
        return null;
      }
    },
  };
}
