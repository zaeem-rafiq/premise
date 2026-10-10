// S3: the ATTEMPTS namespace is the only capability this adapter receives. Option A
// avoids a cross-namespace fork, which the current binding cannot express (SE22).

import { utf8 } from "../../../core/sync/bytes.ts";
import { sha1Hex } from "../../../core/sync/sha1.ts";
import { FORK_BACKOFF_BASE_MS } from "../../../protocol/constants.ts";
import type { AttemptRepoProvisioner } from "../../../protocol/ports.ts";

export type AttemptRepoOption = "A" | "B";
/** The one production selection. A pool handle cannot fork into ATTEMPTS (SE22). */
export const ATTEMPT_REPO_OPTION: AttemptRepoOption = "A";

/** Only the binding methods used here. Creation's implicit token is deliberately absent. */
export type AttemptRepository = {
  info(): Promise<{ name: string; remote: string }>;
  createToken(scope: "write" | "read", ttl: number): Promise<{ plaintext: string; expiresAt: string }>;
  readCommit(hash: string): Promise<{ treeHash: string; message: string } | null>;
  fork(name: string, opts: { readOnly: boolean; defaultBranchOnly: boolean }): Promise<{ name: string }>;
};

export type AttemptNamespace = {
  create(name: string, opts: { readOnly: boolean; setDefaultBranch: string }): Promise<{ name: string }>;
  get(name: string): Promise<AttemptRepository>;
};

export type AttemptRepoOptions = {
  /** Test/measurement selection. Production uses ATTEMPT_REPO_OPTION. */
  option?: AttemptRepoOption;
  /** B is safe only for a source already in ATTEMPTS, never a POOLS handle. */
  forkSourceRepo?: string;
};

/** Stable across retries, bounded, and safe for Artifacts names even for unusual ids. */
export function attemptRepoName(attemptId: string): string {
  return `attempt-${sha1Hex(utf8(attemptId))}`;
}

/** A binding remote must not contain credentials or carry tokens to a non-HTTPS URL. */
export function safeAttemptRemote(remote: string): boolean {
  try {
    const url = new URL(remote);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      !/[\s\u0000-\u001f\u007f]/.test(remote)
    );
  } catch {
    return false;
  }
}

/** Release a native capability. Disposal must not hide a successful operation. */
export function disposeAttemptRepository(repo: AttemptRepository): void {
  const symbol = (Symbol as unknown as { dispose?: symbol }).dispose ?? Symbol.for("Symbol.dispose");
  const dispose = (repo as unknown as Record<symbol, unknown>)[symbol];
  if (typeof dispose !== "function") return;
  try {
    (dispose as () => void).call(repo);
  } catch {
    // No service exception text may reach an event, a transcript, or a checkpoint (AG7).
  }
}

function alreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ALREADY_EXISTS";
}

/**
 * One provisioning try. The singleton gate owns the deployment-wide bound and alarm
 * retries (S3a); this adapter never sleeps or times out a still-running create/fork.
 */
export function artifactsAttemptRepoProvisioner(
  attempts: AttemptNamespace,
  options: AttemptRepoOptions = {},
): AttemptRepoProvisioner {
  const option = options.option ?? ATTEMPT_REPO_OPTION;
  const failed = (error: string) => ({ error, retry_after_ms: FORK_BACKOFF_BASE_MS });
  return {
    async provision(attemptId) {
      if (attemptId.length === 0) return failed("attempt_repo_invalid_id");
      const name = attemptRepoName(attemptId);
      try {
        try {
          if (option === "A") {
            // Never retain, return, or read the token included with create().
            await attempts.create(name, { readOnly: false, setDefaultBranch: "attempt" });
          } else {
            if (!options.forkSourceRepo) return failed("attempt_repo_fork_namespace");
            // A handle from ATTEMPTS guarantees fork stays in that namespace. Current
            // pool repositories live in POOLS, so this is deliberately not wired there.
            const source = await attempts.get(options.forkSourceRepo);
            try {
              await source.fork(name, { readOnly: false, defaultBranchOnly: false });
            } finally {
              disposeAttemptRepository(source);
            }
          }
        } catch (error) {
          // A create may have succeeded before its reply was lost. Only ALREADY_EXISTS
          // permits the recovery read; all other errors remain failed provisioning tries.
          if (!alreadyExists(error)) return failed("attempt_repo_provision_failed");
        }
        const handle = await attempts.get(name);
        try {
          const info = await handle.info();
          if (info.name !== name || !safeAttemptRemote(info.remote)) return failed("attempt_repo_invalid_target");
          return { repo: name };
        } finally {
          disposeAttemptRepository(handle);
        }
      } catch {
        return failed("attempt_repo_provision_failed");
      }
    },
  };
}
