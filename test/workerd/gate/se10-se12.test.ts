// SE10 to SE12 — the kill switch — and plan 2.5 item 2 (the gate's part), in local workerd:
//
//   - `POST /api/kill` is an owner route: without the Bearer key it answers 401 (SE2);
//   - `{"killed":true}` sets the gate: every reserve is refused `killed` (SE10), `GET /killed`
//     answers true, and the registered pool's stream shows `limits` with `killed: true`;
//   - the state is durable: a second Worker on the same object storage — the object's restart —
//     still answers killed (SE12's `killed` survives in `gate_meta.state`);
//   - `{"killed":false}` clears it (SE11): reserves are granted again.
//
// `landings` is left out of the kill bodies: the pause_pool/resume_pool effects it triggers are
// Trunk's side of SE11/SE12, which no Trunk entry answers today — see src/worker/gate/effects.ts.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gateCall, startGateWorker, type GateWorker } from "./harness.ts";

const KEY = "gate-test-owner-key-32-bytes-of-random!";
const WORKHORSE = "@cf/openai/gpt-oss-120b";

function kill(body: unknown, key?: string) {
  return (worker: GateWorker) =>
    worker.fetch("/api/kill", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
      },
      body: JSON.stringify(body),
    });
}

describe("SE10-SE12: the owner kill switch, durable across an object restart", () => {
  const storageDir = mkdtempSync(join(tmpdir(), "gate-se12-"));
  let worker: GateWorker | null = null;
  const after = async () => {
    await worker?.dispose();
    worker = null;
  };

  afterAll(after);

  it("SE2: /api/kill without the owner key answers 401", async () => {
    worker = await startGateWorker({ ownerKey: KEY, spendCapUsd: "40", storageDir });
    const response = await kill({ killed: true })(worker);
    expect(response.status).toBe(401);
    // And the key never reached the gate: it is not killed.
    expect(await (await worker.gate().fetch("/killed")).json()).toEqual({ killed: false });
  });

  it("SE10/SE12: kill is set, durable across the restart, and cleared by killed:false", async () => {
    worker ??= await startGateWorker({ ownerKey: KEY, spendCapUsd: "40", storageDir });
    await gateCall(worker.gate(), "register-pool", { pool: "g-kill", request_id: "req-kill" });

    const killed = await kill({ killed: true }, KEY)(worker);
    expect(killed.status).toBe(200);
    expect(await killed.json()).toEqual({ ok: true, killed: true });
    expect(await (await worker.gate().fetch("/killed")).json()).toEqual({ killed: true });

    // SE10: every reserve is refused `killed` — the cap is not even consulted.
    const reserve = await gateCall(worker.gate(), "reserve", {
      attempt_id: "a-kill-1",
      pool: "g-kill",
      model: WORKHORSE,
      request_bytes: 100,
      max_tokens: 10,
    });
    expect(await reserve.json()).toEqual({ ok: false, refused: "killed" });

    // The kill broadcast reached the pool's stream at once (SE9's `killed` change).
    const events = (await worker.events("g-kill")) as Array<Record<string, unknown>>;
    const last = [...events].reverse().find((event) => event.type === "limits") as { killed: boolean } | undefined;
    expect(last?.killed).toBe(true);

    // SE12: the state is durable. A new Worker on the same object storage — the object's
    // restart — reads the same gate state, not a fresh one.
    await after();
    worker = await startGateWorker({ ownerKey: KEY, spendCapUsd: "40", storageDir });
    expect(await (await worker.gate().fetch("/killed")).json()).toEqual({ killed: true });
    const reserveAfter = await gateCall(worker.gate(), "reserve", {
      attempt_id: "a-kill-2",
      pool: "g-kill",
      model: WORKHORSE,
      request_bytes: 100,
      max_tokens: 10,
    });
    expect(await reserveAfter.json()).toEqual({ ok: false, refused: "killed" });

    // SE11's clear: `killed:false` unsets it and reserves are granted again.
    const cleared = await kill({ killed: false }, KEY)(worker);
    expect(await cleared.json()).toEqual({ ok: true, killed: false });
    expect(await (await worker.gate().fetch("/killed")).json()).toEqual({ killed: false });
    const free = await gateCall(worker.gate(), "reserve", {
      attempt_id: "a-kill-2",
      pool: "g-kill",
      model: WORKHORSE,
      request_bytes: 100,
      max_tokens: 10,
    });
    expect(await free.json()).toMatchObject({ ok: true });
  });
});
