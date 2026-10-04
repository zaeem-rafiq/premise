/**
 * Worker entry point and the Durable Object that runs the experiments.
 * Routing and auth live in router.ts; the experiments live in experiments/.
 */
import { DurableObject } from "cloudflare:workers";
import { EXPERIMENT_IDS, ExperimentRunner, type AiLike, type Deps, type WarmState } from "./experiments";
import { redactText, type ExperimentResult } from "./recorder";
import { failureResult, handleRequest } from "./router";

/** One instance (named "spike") does all the git work. SQLite-backed, see wrangler.jsonc. */
export class SpikeDO extends DurableObject<Env> {
  /** In-memory state: lost when the instance is evicted or the Worker is redeployed. */
  private readonly warm: WarmState = {};
  private readonly instanceStartedAt = Date.now();
  private runs = 0;
  /** One experiment at a time: a second request while one is running gets a "busy" result. */
  private readonly runner = new ExperimentRunner();

  async run(id: string, body: Record<string, unknown>, meta: Record<string, unknown>): Promise<ExperimentResult> {
    this.runs++;
    const storage = this.ctx.storage;
    const deps: Deps = {
      artifacts: this.env.ARTIFACTS,
      ai: this.env.AI as unknown as AiLike,
      store: {
        get: <T>(key: string) => storage.get<T>(key),
        put: (key: string, value: unknown) => storage.put(key, value),
        delete: (key: string) => storage.delete(key),
      },
      warm: this.warm,
      meta: {
        ...meta,
        ran_in: "Durable Object SpikeDO",
        do_instance_age_ms: Date.now() - this.instanceStartedAt,
        do_runs_on_this_instance: this.runs,
        clock_note: "Workers advance Date.now() only at I/O, so CPU-only spans read as 0 ms; timings cover network round trips.",
      },
    };
    try {
      return await this.runner.run(id, deps, body);
    } catch (e) {
      // The runner already catches; this is the last guard so the caller always gets a result.
      return failureResult(id, redactText(String(e)), "the experiment runner itself threw");
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, {
      spikeKey: (env as { SPIKE_KEY?: unknown }).SPIKE_KEY,
      experimentIds: EXPERIMENT_IDS,
      meta: { worker_colo: (request.cf as { colo?: string } | undefined)?.colo ?? null },
      run: async (id, body, meta) => {
        const stub = env.SPIKE_DO.get(env.SPIKE_DO.idFromName("spike"));
        return await stub.run(id, body, meta);
      },
    });
  },
} satisfies ExportedHandler<Env>;
