// SE7, the cap's source: the gate guards the owner's budget, so it takes its cap from the
// deployment on every load and fails closed without one.
//
// Money math (01-core SE6, the price table of model-plan.ts; BP1): the workhorse is $0.35/$0.75
// per million tokens, so bound(10_000, 1_000) = (3500 + 750) / 1e6 = 0.00425.
//   no SPEND_CAP_USD        -> cap 0    -> 0 + 0 + 0.00425 > 0     -> spend_cap
//   cap 40, then cap 0.001  -> the same reservation is granted, then refused: 0.00425 > 0.001

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gateCall, startGateWorker, type GateWorker } from "./harness.ts";

const WORKHORSE = "@cf/openai/gpt-oss-120b";
const RESERVE = { pool: "g-src", model: WORKHORSE, request_bytes: 10_000, max_tokens: 1_000 };

describe("SE7: the cap comes from the deployment, on every load", () => {
  let worker: GateWorker | null = null;
  afterEach(async () => {
    await worker?.dispose();
    worker = null;
  });

  it("SE7: with no SPEND_CAP_USD every reservation is refused spend_cap (the gate fails closed)", async () => {
    worker = await startGateWorker({});
    await gateCall(worker.gate(), "register-pool", { pool: "g-src", request_id: "req-src-1" });
    const reserve = await gateCall(worker.gate(), "reserve", { ...RESERVE, attempt_id: "a-src-1" });
    expect(await reserve.json()).toEqual({ ok: false, refused: "spend_cap" });
  });

  it("SE7: a cap lowered by a new deployment binds the stored state at once", async () => {
    const storageDir = mkdtempSync(join(tmpdir(), "gate-cap-"));
    worker = await startGateWorker({ spendCapUsd: "40", storageDir });
    await gateCall(worker.gate(), "register-pool", { pool: "g-src", request_id: "req-src-2" });
    const granted = (await (
      await gateCall(worker.gate(), "reserve", { ...RESERVE, attempt_id: "a-src-2" })
    ).json()) as { ok: boolean };
    expect(granted.ok).toBe(true);
    await worker.dispose();

    worker = await startGateWorker({ spendCapUsd: "0.001", storageDir });
    const refused = await gateCall(worker.gate(), "reserve", { ...RESERVE, attempt_id: "a-src-3" });
    expect(await refused.json()).toEqual({ ok: false, refused: "spend_cap" });
  });
});
