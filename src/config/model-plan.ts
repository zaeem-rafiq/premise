// The model plan (S5, 05-agent MG2): which models, their options and their rates. Data, not code —
// a model that misses the marks of the build plan is replaced here (MP2).

import type { ModelPlan } from "../protocol/ports.ts";
import { MAX_REAL_AGENTS, RACE_SIZE } from "../protocol/constants.ts";

export const WORKHORSE_MODEL = "@cf/openai/gpt-oss-120b";
export const RACE_MODELS = [
  "@cf/openai/gpt-oss-120b",
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/zai-org/glm-5.3-flash",
] as const;

/** The starting plan of MG2 (05-agent): workhorse, the `RACE_SIZE` race models, starting per-minute
 * rates, `max_real_agents` and input/output prices per million tokens. */
export const MODEL_PLAN: ModelPlan = {
  workhorse: WORKHORSE_MODEL,
  race: [...RACE_MODELS],
  per_minute: {
    "@cf/openai/gpt-oss-120b": 240,
    "@cf/moonshotai/kimi-k2.7-code": 16,
    "@cf/zai-org/glm-5.3-flash": 16,
  },
  max_real_agents: MAX_REAL_AGENTS,
  prices_usd_per_mtok: {
    "@cf/openai/gpt-oss-120b": { in: 0.35, out: 0.75 },
    "@cf/moonshotai/kimi-k2.7-code": { in: 0.95, out: 4.0 },
    "@cf/zai-org/glm-5.3-flash": { in: 0.15, out: 0.5 },
    // 01-core TR10 (Price): Clef's requests are priced by input tokens only (TR9 reserves them).
    "@cf/cloudflare/clef": { in: 0.24, out: 0 },
    "@cf/cloudflare/clef-flash": { in: 0.038, out: 0 },
  },
};

/** `MODEL_OPTIONS` (05-agent Appendix A): the last column of MG2, per model. */
export const MODEL_OPTIONS: Record<string, { reasoning_effort?: string }> = {
  "@cf/openai/gpt-oss-120b": { reasoning_effort: "low" },
  "@cf/moonshotai/kimi-k2.7-code": {},
  "@cf/zai-org/glm-5.3-flash": { reasoning_effort: "low" },
};

/** The short names the Floor shows for a model id (the `models` map of `/floor.json`): the model
 * name without its `@cf/<org>/` prefix, as in "crab (glm-5.3-flash)". */
export const MODEL_SHORT_NAMES: Record<string, string> = Object.fromEntries(
  [...RACE_MODELS].map((id) => [id, id.split("/").pop() as string]),
);

if (MODEL_PLAN.race.length !== RACE_SIZE) throw new Error("RACE_MODELS must hold RACE_SIZE models");
