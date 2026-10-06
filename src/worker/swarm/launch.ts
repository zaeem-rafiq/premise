// One scripted agent's launch (SWR1/SWR2, 9.2 T1): the attempt opens in the pool's Trunk first
// (`attempt.opened` precedes everything the agent does; the first synthetic sets EM1a's
// `pool.state.synthetic`), then the Agent Durable Object named by the attempt id gets `/open`,
// and a held pattern is recorded with the pool so a release reaching any isolate finds it
// (SWR3). The Swarm route and the run Workflow share this — the attempt and intent ids are
// derived from the request id, so a repeated request launches nothing (SWR4, 9.8).

import type { Env } from "../env.ts";
import { H } from "../../core/sync/h.ts";
import type {
  AgentOpenRequest,
  AgentOpenResponse,
  TrunkOpenAttemptRequest,
  TrunkOpenAttemptResponse,
} from "../../protocol/internal.ts";

/** The requester recorded on a synthetic attempt's intent (CM1's author `SYNTHETIC swarm`). */
const REQUESTER = "swarm";

const AGENT_OPEN_URL = "https://agent/open";
const AGENT_RELEASE_URL = "https://agent/release";
const TRUNK_OPEN_ATTEMPT_URL = "https://trunk/internal/open-attempt";
const TRUNK_SWARM_HOLD_URL = "https://trunk/internal/swarm-hold";
const TRUNK_SWARM_HELD_URL = "https://trunk/internal/swarm-held";

/** ULID's Crockford base32 alphabet, in order. */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A deterministic `a_<ULID>` (or `i_`, `c_`) for one agent of one request: the 128 bits of
 * `H("swarm|<prefix>|<request_id>|<n>")` base32-encoded.
 */
export function launchId(prefix: "a_" | "i_" | "c_", requestId: string, n: number): string {
  let value = BigInt(`0x${H(`swarm|${prefix}|${requestId}|${n}`)}`);
  let id = "";
  for (let i = 0; i < 26; i += 1) {
    id = B32[Number(value & 0x1fn)] + id;
    value >>= 5n;
  }
  return `${prefix}${id}`;
}

export type LaunchInput = {
  pool: string;
  attemptId: string;
  intentId: string;
  pattern: { id: string; intent: string; truth: readonly string[] };
  seed: number;
  agentN: number;
  hold: boolean;
  thinkMs: [number, number];
};

export type LaunchResult =
  | { ok: true; attempt_id: string; already: boolean }
  | { ok: false; code: "trunk_open_failed" | "agent_open_failed" | "trunk_hold_failed"; detail?: unknown };

/** Opens the attempt and the scripted agent; records a held pattern with the pool. */
export async function launchAgent(env: Env, input: LaunchInput): Promise<LaunchResult> {
  const openAttempt: TrunkOpenAttemptRequest = {
    attempt_id: input.attemptId,
    intent_id: input.intentId,
    intent: input.pattern.intent,
    agent_kind: "synthetic",
    truth: [...input.pattern.truth],
    requester: REQUESTER,
  };
  let trunkAnswer: TrunkOpenAttemptResponse;
  try {
    const response = await env.TRUNK.get(env.TRUNK.idFromName(input.pool)).fetch(TRUNK_OPEN_ATTEMPT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(openAttempt),
    });
    trunkAnswer = (await response.json()) as TrunkOpenAttemptResponse;
  } catch {
    return { ok: false, code: "trunk_open_failed" };
  }
  if (!trunkAnswer.ok) return { ok: false, code: "trunk_open_failed", detail: trunkAnswer.error };

  const open: AgentOpenRequest = {
    pool: input.pool,
    attempt_id: input.attemptId,
    intent_id: input.intentId,
    change_id: trunkAnswer.change_id,
    intent_text: input.pattern.intent,
    requester: REQUESTER,
    driver: "scripted",
    pattern: input.pattern.id,
    seed: input.seed,
    agent_n: input.agentN,
    truth: [...input.pattern.truth],
    hold: input.hold,
    think_ms: input.thinkMs,
  };
  let answer: AgentOpenResponse;
  try {
    const response = await env.AGENT.get(env.AGENT.idFromName(input.attemptId)).fetch(AGENT_OPEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(open),
    });
    answer = (await response.json()) as AgentOpenResponse;
  } catch {
    return { ok: false, code: "agent_open_failed" };
  }
  if (!answer.ok) return { ok: false, code: "agent_open_failed", detail: answer.error };

  if (input.hold) {
    try {
      const recorded = await env.TRUNK.get(env.TRUNK.idFromName(input.pool)).fetch(TRUNK_SWARM_HOLD_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pattern: input.pattern.id, attempt_id: input.attemptId }),
      });
      if (!recorded.ok) return { ok: false, code: "trunk_hold_failed" };
    } catch {
      return { ok: false, code: "trunk_hold_failed" };
    }
  }
  return { ok: true, attempt_id: input.attemptId, already: answer.already === true };
}

/** SWR3: the attempts the pool holds for `pattern` — the release target list. */
export async function heldAttempts(env: Env, pool: string, pattern: string): Promise<string[]> {
  const held = await env.TRUNK.get(env.TRUNK.idFromName(pool)).fetch(
    `${TRUNK_SWARM_HELD_URL}?pattern=${encodeURIComponent(pattern)}`,
  );
  return ((await held.json()) as { attempts?: string[] }).attempts ?? [];
}

/** SWR3: `POST /release` lets a held agent call `submit`. */
export async function releaseAgent(env: Env, pool: string, pattern: string, attemptId: string): Promise<void> {
  await env.AGENT.get(env.AGENT.idFromName(attemptId)).fetch(AGENT_RELEASE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ attempt_id: attemptId, pool, pattern }),
  });
}
