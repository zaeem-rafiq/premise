// RC3: read settled Agent spend outside the submit transaction and landing path.
import { TOOL_TIMEOUT_MS } from "../../protocol/constants.ts";
import type { AgentSpendRequest, AgentSpendResponse, RaceCostDone, RaceCostJob } from "../../protocol/internal.ts";
import type { Env } from "../env.ts";
import { recordTrunkError } from "./after-commit.ts";
import { metaGet, sqlOf, timerPut } from "./sql.ts";

const running = new WeakSet<DurableObjectState>();

export async function runRaceCostJob(
  env: Env,
  ctx: DurableObjectState,
  apply: (input: RaceCostDone) => Promise<void>,
): Promise<void> {
  if (running.has(ctx)) return;
  running.add(ctx);
  const sql = sqlOf(ctx);
  const pending = () => sql.exec("SELECT v FROM meta WHERE substr(k, 1, 10) = 'race_cost:'").toArray();
  try {
    const pool = metaGet(sql, "pool_id");
    if (pool === null) return;
    for (const row of pending()) {
      const job = JSON.parse(String(row.v)) as RaceCostJob;
      const request: AgentSpendRequest = { pool, attempt_id: job.attempt_id };
      let cost_usd: number | null = null;
      try {
        const response = await env.AGENT.get(env.AGENT.idFromName(job.attempt_id)).fetch(
          "https://agent.internal/internal/spend",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
          },
        );
        const answer = (await response.json()) as AgentSpendResponse;
        if (
          !response.ok ||
          answer?.ok !== true ||
          answer.attempt_id !== job.attempt_id ||
          typeof answer.cost_usd !== "number" ||
          !Number.isFinite(answer.cost_usd) ||
          answer.cost_usd < 0
        ) {
          throw new Error("spend_unavailable");
        }
        cost_usd = answer.cost_usd;
      } catch {
        recordTrunkError(ctx, "race_cost", "spend_unavailable");
      }
      // The second transaction consumes failures as well as successes. There is no retry
      // for a failed read; a fresh submit queues a fresh observation of cumulative spend.
      await apply({ ...job, cost_usd });
    }
  } finally {
    running.delete(ctx);
    // A submit can arrive during the read and its timer can already have fired. Preserve
    // that new work, while an apply failure uses the alarm's existing backed-off retry.
    if (pending().length > 0) sql.transaction(() => timerPut(sql, "race_cost", "", Date.now()));
  }
}
