// The chosen TokenSource (01-core.md S2 option A): every call to `writeTarget` mints a fresh
// write-scoped token on the pool's Artifacts repository through the binding (S2b), so the
// call after a 401 or 403 always yields a new token (LP5a). The plaintext token travels
// inside Trunk only — it is returned, never logged (13.1).

import type { TokenSource } from "../../../protocol/ports.ts";
import { poolRepoName } from "../../repos.ts";

/**
 * The slice of the namespace binding this adapter uses — `env.POOLS` at runtime, a fake in
 * tests. Declared structurally because the generated `Artifacts` interface lives in the
 * platform types and tests must be able to stand in for it.
 */
export type ArtifactsLike = {
  get(name: string): Promise<ArtifactsRepoLike>;
};

/** The slice of a repository handle this adapter uses. */
export type ArtifactsRepoLike = {
  createToken(scope: "write" | "read", ttl?: number): Promise<{ plaintext: string; expiresAt: string }>;
  info(): Promise<{ remote: string }>;
};

/** The write token's lifetime in seconds: the value the E2 measurement minted with. */
export const WRITE_TOKEN_TTL_SECONDS = 3_600;

export type TokenSourceOptions = {
  /** Maps a pool id to its repository name; default: the pool id itself. */
  repoForPool?: (pool_id: string) => string;
  /** The minted token's time-to-live in seconds; default `WRITE_TOKEN_TTL_SECONDS`. */
  tokenTtlSeconds?: number;
};

/** `Symbol.dispose` by its registered key, so the lookup works under every tsconfig lib. */
const DISPOSE = Symbol.for("Symbol.dispose");

/** Disposes a repository handle without failing the caller when it cannot be. */
function disposeQuietly(repo: ArtifactsRepoLike): void {
  const dispose = (repo as unknown as Record<symbol, unknown>)[DISPOSE];
  if (typeof dispose === "function") (dispose as () => void).call(repo);
}

export function artifactsTokenSource(binding: ArtifactsLike, options?: TokenSourceOptions): TokenSource {
  const repoForPool = options?.repoForPool ?? ((pool_id: string) => pool_id);
  const ttl = options?.tokenTtlSeconds ?? WRITE_TOKEN_TTL_SECONDS;
  return {
    async writeTarget(pool_id) {
      const repo = repoForPool(pool_id);
      const handle = await binding.get(repo);
      try {
        const info = await handle.info();
        // The scope is always explicit: a write token for Trunk's pushes, never a default
        // the service could reinterpret later (S2b).
        const token = await handle.createToken("write", ttl);
        const expiresAt = Date.parse(token.expiresAt);
        return {
          remote: info.remote,
          repo,
          token: token.plaintext,
          expires_at: Number.isNaN(expiresAt) ? null : expiresAt,
        };
      } finally {
        disposeQuietly(handle);
      }
    },
  };
}
