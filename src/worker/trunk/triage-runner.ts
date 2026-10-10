// The asynchronous Clef path of 01-core 7.3 in the Trunk object (TR2, TR6, TR10): after a commit,
// `triage_dispatch` names the questions to send; each request goes through the `Triage` port
// (`ClefTriage` over the `AI` binding and the model gate); every answer returns through the
// `triage` entry with the `asked_op_seq` it was sent with, so an answer for an older patch is
// recorded `stale` (TR4). Nothing on the landing path waits for this.

import { FEATURES } from "../../config/features.ts";
import { CLEF_TRIAGE_MODEL, CLEF_TRIAGE_MODEL_ID } from "../../protocol/constants.ts";
import type { Sql, Triage, TriageAnswers } from "../../protocol/ports.ts";
import type { TriageRequest } from "../../core/trunk/triage.ts";
import { GateCalls, gateDurableObjectTransport } from "../agent/gate-client.ts";
import { ClefTriage } from "../adapters/triage/clef-triage.ts";
import type { Env } from "../env.ts";

/** S6a/TR10: a real attempt's triage is Clef only with `features.clef` and `CLEF_TRIAGE = on`. */
export function clefTriageOn(env: Pick<Env, "CLEF_TRIAGE">, features: { clef: boolean } = FEATURES): boolean {
  return features.clef && env.CLEF_TRIAGE === "on";
}

/** The deployment's `ClefTriage`: Workers AI behind the model gate (TR9). */
export function clefTriageOf(env: Env, pool: string): Triage {
  const gate = env.GATE === undefined ? null : new GateCalls(gateDurableObjectTransport(env.GATE));
  return new ClefTriage({ ai: env.AI, gate, pool, modelId: CLEF_TRIAGE_MODEL_ID, model: CLEF_TRIAGE_MODEL });
}

/** Whether the question store holds a row in `state` — a plain read, so the engine is opened only
 * when there is work (a pool created before TR10, or no pool at all, has nothing). */
export function hasAsks(sql: Sql, state: "unsent" | "sent"): boolean {
  try {
    return (
      sql
        .exec(`SELECT 1 FROM triage_asks WHERE dispatched_at IS ${state === "unsent" ? "" : "NOT "}NULL LIMIT 1`)
        .toArray().length > 0
    );
  } catch {
    return false;
  }
}

export type TriageRunnerDeps = {
  /** Calls an engine entry; rejects when the entry failed. */
  apply: (name: string, input: unknown) => Promise<unknown>;
  triage: Triage;
};

/** One dispatch: send every unsent question, apply every answer. Resolves the number of requests. */
export async function runTriage(deps: TriageRunnerDeps): Promise<number> {
  const out = (await deps.apply("triage_dispatch", {})) as { requests?: TriageRequest[] } | undefined;
  const requests = out?.requests ?? [];
  await Promise.all(
    requests.map(async (request) => {
      let answers: TriageAnswers & { ms: number; error?: string };
      try {
        answers = await deps.triage.judge(request.input);
      } catch {
        answers = { answers: {}, model: CLEF_TRIAGE_MODEL, ms: 0, error: "model_unavailable" };
      }
      for (const [id, asked] of Object.entries(request.asked)) {
        const p = answers.answers[id] ?? null;
        await deps.apply("triage", {
          attempt: request.attempt_id,
          kind: asked.kind,
          key: asked.key,
          p,
          asked_at_op: asked.asked_op_seq,
          model: answers.model,
          ms: answers.ms,
          // An error code belongs to the answers it made unavailable (7.5).
          ...(p === null ? { error: answers.error ?? "malformed" } : {}),
        });
      }
    }),
  );
  return requests.length;
}
