// The local ledger of ME4: the arithmetic of SE6 and SE6a with MG2's prices. It stands in for the
// model gate: every reservation is bounded by the request's bytes and `MODEL_MAX_TOKENS`, a call
// with no usage settles the whole reservation, and `--max-usd` starts no run that could pass it.
// It also meters the `per_minute` request rate of the model plan.

import { MODEL_MAX_TOKENS } from "../../../src/protocol/constants.ts";

export type ModelPrice = { input: number; output: number }; // USD per million tokens

/** MG2's starting plan: id, `per_minute` request rate, prices and `MODEL_OPTIONS`. */
export const MODEL_PLAN: Record<
  string,
  { per_minute: number; price: ModelPrice; options: Record<string, unknown>; context: number }
> = {
  "@cf/openai/gpt-oss-120b": {
    per_minute: 240,
    price: { input: 0.35, output: 0.75 },
    options: { reasoning_effort: "low" },
    context: 128_000,
  },
  "@cf/moonshotai/kimi-k2.7-code": {
    per_minute: 16,
    price: { input: 0.95, output: 4.0 },
    options: {},
    context: 262_144,
  },
  "@cf/zai-org/glm-5.3-flash": {
    per_minute: 16,
    price: { input: 0.15, output: 0.5 },
    options: { reasoning_effort: "low" },
    context: 1_048_576,
  },
};

export type Reservation = {
  id: number;
  model: string;
  bound: number; // USD
  request_bytes: number;
  settled: number | null;
};

/**
 * SE6: a reservation's bound is `request_bytes` charged at the input price plus `max_tokens` at
 * the output price, per million. `request_bytes` stands for the input-token bound (TL2's journal
 * records the JSON request's size; a byte is at least a token here by construction).
 */
export function reservationBound(requestBytes: number, maxTokens: number, price: ModelPrice): number {
  return (requestBytes * price.input + maxTokens * price.output) / 1_000_000;
}

/** SE6a: a try that ended without usage settles its reservation in full. */
export function settleAmount(
  bound: number,
  usage: { tokens_in: number; tokens_out: number } | null,
  price: ModelPrice,
): number {
  if (usage === null) return bound;
  return (usage.tokens_in * price.input + usage.tokens_out * price.output) / 1_000_000;
}

export type Ledger = ReturnType<typeof newLedger>;

export function newLedger(opts: { maxUsd: number }) {
  const spent = { usd: 0 };
  const outstanding = new Map<number, Reservation>();
  const calls = new Map<string, number[]>(); // model -> timestamps of requests in the last minute
  let nextId = 1;

  const outstandingUsd = () => [...outstanding.values()].reduce((s, r) => s + r.bound, 0);

  return {
    /**
     * Reserve a call (SE6). Refused when the bound, on top of spend and other open reservations,
     * could pass `--max-usd` (ME4: "starts no run that could pass it").
     */
    reserve(model: string, requestBytes: number, maxTokens = MODEL_MAX_TOKENS): Reservation | null {
      const entry = MODEL_PLAN[model];
      const price = entry?.price ?? { input: 1, output: 1 };
      const bound = reservationBound(requestBytes, maxTokens, price);
      if (spent.usd + outstandingUsd() + bound > opts.maxUsd) return null;
      const r: Reservation = { id: nextId++, model, bound, request_bytes: requestBytes, settled: null };
      outstanding.set(r.id, r);
      return r;
    },
    /** Settle a reservation: the counted spend (SE6a), moved from outstanding to spent. */
    settle(id: number, usage: { tokens_in: number; tokens_out: number } | null): number {
      const r = outstanding.get(id);
      if (r === undefined) return 0;
      const price = MODEL_PLAN[r.model]?.price ?? { input: 1, output: 1 };
      const amount = settleAmount(r.bound, usage, price);
      r.settled = amount;
      outstanding.delete(id);
      spent.usd += amount;
      return amount;
    },
    /** The `per_minute` meter (ME4): requests to `model` in the last 60,000 ms. */
    noteCall(model: string, atMs: number): void {
      const list = calls.get(model) ?? [];
      list.push(atMs);
      calls.set(
        model,
        list.filter((t) => atMs - t < 60_000),
      );
    },
    callsInLastMinute(model: string, atMs: number): number {
      return (calls.get(model) ?? []).filter((t) => atMs - t < 60_000).length;
    },
    /** True while another request in this minute would pass `per_minute`. */
    rateLimited(model: string, atMs: number): boolean {
      const cap = MODEL_PLAN[model]?.per_minute ?? 60;
      return this.callsInLastMinute(model, atMs) >= cap;
    },
    spentUsd(): number {
      return spent.usd;
    },
    outstandingUsd(): number {
      return outstandingUsd();
    },
    /** ME4's guard for a new run: what it could still spend at most before the cap. */
    headroomUsd(): number {
      return opts.maxUsd - spent.usd - outstandingUsd();
    },
    maxUsd(): number {
      return opts.maxUsd;
    },
  };
}
