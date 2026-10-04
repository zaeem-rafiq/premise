import type { EffectTable } from "../effects.ts";
import { receivePackPusher } from "../../adapters/pusher/pusher.ts";
import { artifactsTokenSource } from "../../adapters/token-source/token-source.ts";
import { runPush, type PushBatch } from "../push-runner.ts";

/**
 * The git lane's handler. "push" performs one batch's receive-pack request — the raw request
 * the payload describes. The LP5 ref read and the landing state changes live in
 * `src/worker/trunk/push.ts`, which the Durable Object runs after every commit and on the
 * `push` timer; this handler stays for an explicit `push` effect a lane may emit.
 */
export function wire(table: EffectTable): void {
  table.handlers.set("push", async ({ payload, env }) => {
    await runPush(payload as PushBatch, {
      tokenSource: artifactsTokenSource(env.POOLS),
      pusher: receivePackPusher(),
    });
  });
}
