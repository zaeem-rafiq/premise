import type { EffectTable } from "../effects.ts";
import { receivePackPusher } from "../../adapters/pusher/pusher.ts";
import { artifactsTokenSource } from "../../adapters/token-source/token-source.ts";
import { runPush, type PushBatch } from "../push-runner.ts";

/**
 * The git lane's handlers. "push" sends one batch's receive-pack request: its payload is a
 * `PushBatch` ({pool_id, updates, pack}). Applying the result to the outbox — the LP5 ref
 * read and the landing state changes — lands with the outbox work of Slice 3; until then
 * the handler performs the push and the engine's effect completes with it.
 */
export function wire(table: EffectTable): void {
  table.handlers.set("push", async ({ payload, env }) => {
    await runPush(payload as PushBatch, {
      tokenSource: artifactsTokenSource(env.POOLS),
      pusher: receivePackPusher(),
    });
  });
}
