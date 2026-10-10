// ClefTriage and the shared Clef call (01-core 7.3, TR7, TR9, S6) against a fake `AI` binding
// and a fake gate. Expected request text is 7.3's; codes are the unavailable reasons of 7.3.

import { describe, expect, it } from "vitest";
import { CLEF_INPUT_TOKEN_LIMIT, CLEF_STATE_MAX_CHARS } from "../../../protocol/constants.ts";
import type { TriageInput } from "../../../protocol/ports.ts";
import type { ClefGate } from "./clef-call.ts";
import { ClefTriage } from "./clef-triage.ts";

const INPUT: TriageInput = {
  attempt_id: "a_crab",
  intent: "a crab that hides when its energy is low",
  patch: [{ key: "creatures/crab.js#update", source: "export function update(crab) { ... }" }],
  premises: {
    "entity:world/movement.js#MAX_SPEED": {
      kind: "entity",
      key: "world/movement.js#MAX_SPEED",
      rule: "E3",
      read_then: "export const MAX_SPEED = 2;",
      is_now: "export const MAX_SPEED = 3;",
      changed_by_intent: "let creatures move faster",
      changed: [],
    },
    "file:world/energy.js": {
      kind: "file",
      key: "world/energy.js",
      rule: "F4",
      read_then: "export const ENERGY_MAX = 100;\n",
      is_now: "export const ENERGY_MAX = 1;\n",
      changed_by_intent: "make energy a fraction",
      changed: ["world/energy.js#ENERGY_MAX"],
    },
  },
  truth: null,
};

type Call = { model: string; request: Record<string, unknown> };

function fakes(
  answer: (call: Call) => unknown | Promise<unknown>,
  gateAnswer?: Awaited<ReturnType<ClefGate["reserve"]>>,
) {
  const calls: Call[] = [];
  const reserves: Array<Parameters<ClefGate["reserve"]>[0]> = [];
  const settles: Array<Parameters<ClefGate["settle"]>[0]> = [];
  const ai = {
    async run(model: string, request: Record<string, unknown>) {
      const call = { model, request };
      calls.push(call);
      return answer(call);
    },
  };
  const gate: ClefGate = {
    async reserve(request) {
      reserves.push(request);
      return gateAnswer ?? { ok: true, reservation_id: "r1", expires_at: 0 };
    },
    async settle(request) {
      settles.push(request);
      return { ok: true, charged_usd: 0, found: true };
    },
  };
  let t = 1_000;
  const triage = (opts: { timeoutMs?: number; gate?: ClefGate | null } = {}) =>
    new ClefTriage({
      ai,
      gate: opts.gate === undefined ? gate : opts.gate,
      pool: "pool-a",
      modelId: "@cf/cloudflare/clef",
      model: "clef",
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      now: () => (t += 250),
    });
  return { calls, reserves, settles, triage };
}

const ok = (p1: unknown, p2: unknown, input_tokens = 460) => ({
  model: "clef",
  answers: { p1: { noul: p1 }, p2: { noul: p2 } },
  usage: { input_tokens },
});

describe("ClefTriage (7.3, S6)", () => {
  it("7.3: sends one request with the state, one noul question per premise and the 7.3 criteria", async () => {
    const f = fakes(() => ok(0.96, 0.04));
    await f.triage().judge(INPUT);
    expect(f.calls).toHaveLength(1);
    const [call] = f.calls;
    expect(call?.model).toBe("@cf/cloudflare/clef");
    expect(call?.request.model).toBe("clef");
    expect(call?.request.state).toEqual({
      intent: "a crab that hides when its energy is low",
      patch: [{ key: "creatures/crab.js#update", source: "export function update(crab) { ... }" }],
      premises: {
        p1: {
          kind: "entity",
          key: "world/movement.js#MAX_SPEED",
          read_then: "export const MAX_SPEED = 2;",
          is_now: "export const MAX_SPEED = 3;",
          changed_by_intent: "let creatures move faster",
        },
        p2: {
          kind: "file",
          key: "world/energy.js",
          read_then: "export const ENERGY_MAX = 100;\n",
          is_now: "export const ENERGY_MAX = 1;\n",
          changed_by_intent: "make energy a fraction",
        },
      },
    });
    const questions = call?.request.questions as Record<
      string,
      { type: string; instructions: string; criteria: unknown }
    >;
    expect(Object.keys(questions)).toEqual(["p1", "p2"]);
    expect(questions.p1).toEqual({
      type: "noul",
      instructions:
        "`patch` was written by an agent that had read `premises.p1.read_then`. That code has since changed to " +
        "`premises.p1.is_now`. Does `patch` rely on the old meaning in `read_then`, so that `patch` would behave " +
        "differently than its `intent` wants now that the code is `is_now`?",
      criteria: {
        true: "patch uses a value, unit, range, name, order or behaviour that held under read_then and no longer holds under is_now",
        false: "patch behaves as intended under is_now, or does not depend on this code",
      },
    });
    expect(questions.p2?.instructions).toContain("`premises.p2.read_then`");
  });

  it("S6: answers come back under the engine's premise ids with the model and the latency", async () => {
    const f = fakes(() => ok(0.96, 0.04));
    const answers = await f.triage().judge(INPUT);
    expect(answers).toEqual({
      answers: { "entity:world/movement.js#MAX_SPEED": 0.96, "file:world/energy.js": 0.04 },
      model: "clef",
      ms: 250,
    });
  });

  it("TR9: the request goes through the gate under Clef's own model id, and settles the reported input tokens", async () => {
    const f = fakes(() => ok(0.5, 0.5, 512));
    await f.triage().judge(INPUT);
    expect(f.reserves).toEqual([
      {
        attempt_id: "a_crab",
        pool: "pool-a",
        model: "@cf/cloudflare/clef",
        request_bytes: expect.any(Number),
        max_tokens: 0,
      },
    ]);
    expect(f.reserves[0]!.request_bytes).toBe(new TextEncoder().encode(JSON.stringify(f.calls[0]!.request)).length);
    expect(f.settles).toEqual([{ reservation_id: "r1", usage: { tokens_in: 512, tokens_out: 0 } }]);
  });

  it.each([
    [{ ok: false as const, refused: "spend_cap" as const }, "spend_cap"],
    [{ ok: false as const, refused: "killed" as const }, "killed"],
    [{ ok: false as const, retry_after_ms: 900 }, "rate_limited"],
  ])("TR9: a gate refusal %j is unavailable (%s) and Clef is not called", async (refusal, code) => {
    const f = fakes(() => ok(0.9, 0.9), refusal);
    const answers = await f.triage().judge(INPUT);
    expect(f.calls).toEqual([]);
    expect(answers.error).toBe(code);
    expect(Object.values(answers.answers)).toEqual([null, null]);
  });

  it("TR9: with no gate binding Clef is never called un-gated", async () => {
    const f = fakes(() => ok(0.9, 0.9));
    const answers = await f.triage({ gate: null }).judge(INPUT);
    expect(f.calls).toEqual([]);
    expect(answers.error).toBe("gate_unavailable");
  });

  it("TR7: a state over CLEF_STATE_MAX_CHARS is never sent, and nothing is cut to make it fit", async () => {
    const f = fakes(() => ok(0.1, 0.1));
    const big: TriageInput = {
      ...INPUT,
      patch: [{ key: "big.js#x", source: "x".repeat(CLEF_STATE_MAX_CHARS) }],
    };
    const answers = await f.triage().judge(big);
    expect(f.calls).toEqual([]);
    expect(f.reserves).toEqual([]);
    expect(answers).toMatchObject({ error: "state_too_large" });
    expect(Object.values(answers.answers)).toEqual([null, null]);
  });

  it("TR7: usage.input_tokens at CLEF_INPUT_TOKEN_LIMIT discards the answer as unavailable", async () => {
    const f = fakes(() => ok(0.01, 0.01, CLEF_INPUT_TOKEN_LIMIT));
    const answers = await f.triage().judge(INPUT);
    expect(answers).toMatchObject({ error: "truncated" });
    expect(Object.values(answers.answers)).toEqual([null, null]);
  });

  it("7.3: a time-out is unavailable", async () => {
    const f = fakes(() => new Promise(() => {}));
    const answers = await f.triage({ timeoutMs: 20 }).judge(INPUT);
    expect(answers).toMatchObject({ error: "timeout" });
    expect(Object.values(answers.answers)).toEqual([null, null]);
    // The reservation is settled without usage, so the full bound is charged (SE6a).
    expect(f.settles).toEqual([{ reservation_id: "r1", usage: null }]);
  });

  it("7.3: a malformed answer is unavailable for that premise only", async () => {
    const f = fakes(() => ok(1.4, 0.3));
    const answers = await f.triage().judge(INPUT);
    expect(answers.answers).toEqual({ "entity:world/movement.js#MAX_SPEED": null, "file:world/energy.js": 0.3 });
    expect(answers.error).toBe("malformed");
  });

  it("7.3: a provider error is unavailable", async () => {
    const f = fakes(() => {
      throw Object.assign(new Error("model http 503"), { status: 503 });
    });
    const answers = await f.triage().judge(INPUT);
    expect(answers).toMatchObject({ error: "model_unavailable" });
  });
});
