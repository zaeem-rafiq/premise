// IR2a: an imported pool's repository gets `refs/heads/main` at the imported head. The import
// fills the repository with the remote's branch under its own name (`master`, `trunk`, `dev/x`),
// while every writer and reader of a pool repository — the landing push, the rebuild, the app
// server, the green line — works on `main` (01-core 3.2). Without it the first landing's push
// finds no `main` at the commit Trunk expects and the pool pauses as diverged (found on `test`,
// 2026-10-10, with hukkin/tomli on `master`). One ref command with an empty pack; idempotent, so a
// retried create repeats it safely. Nothing is pushed for the seed commit itself (IR2: no batch 0).

import { PUSH_TIMEOUT_MS } from "../../protocol/constants.ts";
import type { Pusher, TokenSource } from "../../protocol/ports.ts";
import { buildPack } from "../../core/git/pack.ts";
import { ZERO_OID } from "../../core/git/objects.ts";
import { artifactsTokenSource } from "../adapters/token-source/token-source.ts";
import { receivePackPusher } from "../adapters/pusher/pusher.ts";
import { runPush } from "../trunk/push-runner.ts";
import type { Env } from "../env.ts";
import { poolRepoName } from "../repos.ts";

const MAIN_REF = "refs/heads/main";

/** `headOf` answers the repository's head commit: the first row of the binding's `log`, as the import job reads it. */
export type MainRefDeps = {
  tokenSource: TokenSource;
  pusher: Pusher;
  headOf: (pool: string) => Promise<string | null>;
};

export function mainRefDeps(env: Env): MainRefDeps {
  return {
    tokenSource: artifactsTokenSource(env.POOLS),
    pusher: receivePackPusher(),
    headOf: async (pool) => {
      const repo = await (env.POOLS as Artifacts).get(poolRepoName(pool));
      try {
        return (await repo.log({ limit: 1 }))[0]?.hash ?? null;
      } finally {
        repo[Symbol.dispose]();
      }
    },
  };
}

/** Points `main` at the imported head in the pool's repository, unless `main` is already there.
 * The head is the named branch's commit, or the commit `HEAD` names: the binding reported a
 * default branch of `main` for a repository whose only branch is `master` (hukkin/tomli on `test`). */
export async function ensureMainRef(deps: MainRefDeps, pool: string, branch: string): Promise<void> {
  const branchRef = `refs/heads/${branch}`;
  const target = await deps.tokenSource.writeTarget(pool);
  const refs = await deps.pusher.readRefs({
    remote: target.remote,
    token: target.token,
    refs: [MAIN_REF, branchRef],
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });
  const main = refs[MAIN_REF] ?? null;
  if (main !== null && branch === "main") return;
  const head = refs[branchRef] ?? (await deps.headOf(pool));
  if (head === null) throw new Error(`the imported branch ${branch} is not in the repository`);
  if (main === head) return;
  const outcome = await runPush(
    { pool_id: pool, updates: [{ ref: MAIN_REF, old: main ?? ZERO_OID, new: head }], pack: buildPack([]) },
    deps,
  );
  if (!outcome.result.ok) throw new Error(`main was not created (${outcome.result.kind})`);
}
