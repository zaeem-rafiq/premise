// test/workerd/agent/real/routes.test.ts — a rota de intent contra o sistema
// inteiro em local workerd (04-build-plan 2.5, itens 1, 3 e 6).
//
// Diferente do agent-do.test.ts (que abre o Agent DO direto com fakes de Trunk
// e Gate), aqui TUDO é real menos o modelo: Trunk DO, engine, git remoto via
// fake-artifacts, Floor, eventos — o único fake é o FakeModel HTTP atrás do
// binding `AI` do worker de teste (fake-ai.mjs), do jeito que um deploy liga
// o modelo de verdade.
//
//   item 1    POST /api/pools/{pool}/intents → real agent → landing.landed,
//             CM1 (autor = model id), attempt.step com tokens/cost reais e o
//             spend do pool batendo com a soma dos custos assentados
//   item 6    prompt/tools byte-iguais a agent-prompt.ts e shape MP1 (na rota)
//   9.8       request_id repetido devolve o mesmo intent_id e abre nada de novo
//   item 3    SPEND_CAP_USD abaixo do bound do 1º call → spend_cap, zero sends
//   FJ1       race:true responde feature_off (a flag segue off na slice)
//   TA9       POST attempts/{id}/stop → cancelled; repetir não muda nada
//   SE10      kill global → a reserva seguinte é recusada e o agente para

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { git } from "../../../git/helpers.ts";
import { TOOL_DEFINITIONS, firstUserMessage, systemPrompt } from "../../../../src/protocol/agent-prompt.ts";
import { MODEL_OPTIONS, MODEL_PLAN, WORKHORSE_MODEL } from "../../../../src/config/model-plan.ts";
import { H } from "../../../../src/core/sync/h.ts";
import { FakeModel, type LandingRealWorker, startRealLandingWorker, waitFor } from "./harness.ts";

const KEY = "owner-key-for-tests-0123456789abcdef";
const POOL = "p-rland";
const SEED = "tidepool";
const INTENT_TEXT = "a jellyfish that drifts up and down";

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Mesma derivação de src/worker/routes/intents.ts (9.8). */
function derivedId(prefix: "i_" | "a_", requestId: string): string {
  let value = BigInt(`0x${H(`intents|${prefix}|${requestId}`)}`);
  let id = "";
  for (let i = 0; i < 26; i += 1) {
    id = B32[Number(value & 0x1fn)] + id;
    value >>= 5n;
  }
  return `${prefix}${id}`;
}

function bearer(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  };
}

/** A criatura que a intent pede — drift vertical mínimo, no esqueleto tPlain
 * que o add-plain já provou passar na política do tidepool (creatures/* auto). */
const JELLYFISH_JS = `import { bounce } from "../world/bounds.js";
import { step, wander } from "../world/movement.js";

const BODY = "cyan";

export function spawn() {
  return { vy: 1 };
}

export function update(creature) {
  wander(creature, 0.05);
  step(creature);
  bounce(creature);
}

export function draw(creature, pen) {
  pen.fill(BODY);
  pen.circle(0, 0, 9);
}
`;

const SCRIPT_LANDING = [
  { tool_calls: [{ name: "list", arguments: { path: "creatures/" } }] },
  { tool_calls: [{ name: "read", arguments: { path: "GUIDE.md" } }] },
  { tool_calls: [{ name: "read", arguments: { path: "creatures/fish.js" } }] },
  { tool_calls: [{ name: "write", arguments: { path: "creatures/jellyfish.js", content: JELLYFISH_JS } }] },
  { tool_calls: [{ name: "submit", arguments: { summary: "a jellyfish that drifts up and down" } }] },
  // TD6: o batch do seed pode empurrar durante a rodada → needs_confirm com
  // heads-up; a segunda submit carrega `statement` (o loop preenche os hns).
  {
    tool_calls: [
      {
        name: "submit",
        arguments: {
          summary: "a jellyfish that drifts up and down",
          statement: "checked the heads-up: nothing of mine relied on the pushed files",
        },
      },
    ],
  },
  {
    tool_calls: [
      {
        name: "submit",
        arguments: {
          summary: "a jellyfish that drifts up and down",
          statement: "re-checked: still nothing relied on the pushed files",
        },
      },
    ],
  },
];

let model: FakeModel;
let worker: LandingRealWorker;

async function intentReq(pool: string, requestId: string, extra: Record<string, unknown> = {}) {
  const res = await worker.fetch(
    `/api/pools/${pool}/intents`,
    bearer({
      text: INTENT_TEXT,
      race: false,
      prewritten: false,
      request_id: requestId,
      ...extra,
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function attemptState(pool: string, attemptId: string): Promise<Record<string, unknown> | undefined> {
  const events = await worker.events(pool);
  const last = [...events]
    .reverse()
    .find((e) => e.attempt_id === attemptId && (e.type === "attempt.state" || e.type === "attempt.opened"));
  return last;
}

describe("a rota de intents contra o sistema inteiro (04-build-plan 2.5)", () => {
  beforeAll(async () => {
    model = new FakeModel();
    await model.listen();
    worker = await startRealLandingWorker({
      ownerKey: KEY,
      modelUrl: model.url,
      repos: [POOL, "p-rcap"],
    });
    const res = await worker.fetch(
      "/api/pools",
      bearer({ pool: POOL, seed: SEED, summary_only: false, request_id: "r-pool" }),
    );
    expect(res.status).toBe(200);
  }, 90_000);

  afterAll(async () => {
    await worker?.dispose();
    await model?.close();
  });

  it("item 1 + CM1: a intent tipada desce a rota, sobe o agente real e termina em landing.landed", async () => {
    model.script = [...SCRIPT_LANDING];
    model.requests = [];

    const res = await intentReq(POOL, "r-land-1");
    expect(res.status).toBe(200);
    const intent_id = String(res.body.intent_id);
    expect(intent_id).toBe(derivedId("i_", "r-land-1"));
    const attempt_id = derivedId("a_", "r-land-1");

    await waitFor(async () => (await worker.eventTypes(POOL)).includes("landing.landed"), 120_000);

    // CM1: o commit da criatura tem autor = o id do modelo.
    const events = await worker.events(POOL);
    const landed = events.find((e) => e.type === "landing.landed") as
      { commit: string; note_json?: string } | undefined;
    expect(landed).toBeDefined();
    const author = git(worker.repoDir(POOL), ["log", "-1", "--format=%an", landed!.commit]);
    expect(author).toBe(WORKHORSE_MODEL);

    // attempt.step do modelo: tokens e custo reais vindos do uso do fake.
    const price = MODEL_PLAN.prices_usd_per_mtok[WORKHORSE_MODEL]!;
    const modelSteps = events.filter(
      (e) => e.type === "attempt.step" && e.attempt_id === attempt_id && e.tool === null,
    );
    expect(modelSteps.length).toBeGreaterThanOrEqual(5);
    for (const e of modelSteps) {
      expect(e.tokens_in).toBe(1000);
      expect(e.tokens_out).toBe(60);
      expect(e.cost_usd).toBeCloseTo((1000 * price.in + 60 * price.out) / 1_000_000, 10);
    }
    const spent = modelSteps.reduce((acc, e) => acc + Number(e.cost_usd), 0);
    // A soma dos custos assentados é o que o gate registrou de spend.
    const gateRes = await worker.gate().fetch("/internal/state");
    const gate = (await gateRes.json()) as { state?: { spent_usd: number } };
    expect(gate.state!.spent_usd).toBeCloseTo(spent, 6);

    // EV2a: todo attempt.step do run veio da fonte do Agent, uma vez só, em ordem.
    const steps = events.filter((e) => e.type === "attempt.step" && e.attempt_id === attempt_id);
    expect(steps.every((e) => e.src === "agent")).toBe(true);
    expect(new Set(steps.map((e) => e.step)).size).toBe(steps.length);
    const stepNumbers = steps.map((e) => Number(e.step));
    expect([...stepNumbers].sort((a, b) => a - b)).toEqual(stepNumbers);

    // TA10: a nota congela os totais que o Agent enviou — contados à mão do uso
    // declarado do fake (1000/60 por resposta × o número de chamadas que o run fez).
    // `landing.landed` leva `note_json` no corpo (12.1); `attempt_id` não é campo
    // dele — a tentativa é a única do pool de teste.
    const note = JSON.parse(landed!.note_json ?? "{}") as {
      attempt: { steps: number; model_calls: number; tokens_in: number; tokens_out: number };
    };
    const calls = model.requests.length;
    expect(note.attempt.model_calls).toBe(calls);
    expect(note.attempt.tokens_in).toBe(1000 * calls);
    expect(note.attempt.tokens_out).toBe(60 * calls);
    expect(note.attempt.steps).toBe(steps.filter((e) => e.tool !== null).length);

    // O arquivo chegou ao repositório real via Trunk→landing.
    let fileType = "";
    try {
      fileType = git(worker.repoDir(POOL), ["cat-file", "-t", `${landed!.commit}:creatures/jellyfish.js`]);
    } catch {
      fileType = "";
    }
    expect(fileType).toBe("blob");
  }, 180_000);

  it("item 6: a rota envia o mesmo prompt/ferramentas do agent-prompt e o shape MP1", async () => {
    for (const r of model.requests) {
      expect(Object.keys(r.request).sort()).toEqual(["max_tokens", "messages", "reasoning_effort", "tools"].sort());
      expect(r.request.max_tokens).toBe(4096);
      expect(r.request.reasoning_effort).toBe(MODEL_OPTIONS[WORKHORSE_MODEL]?.reasoning_effort);
      expect(r.request.tools).toEqual(JSON.parse(TOOL_DEFINITIONS));
      const messages = r.request.messages as Array<{ role: string; content: string }>;
      expect(messages[0]).toEqual({ role: "system", content: systemPrompt() });
    }
    const first = model.requests[0]!.request.messages as Array<{ role: string; content: string }>;
    expect(first[1]).toEqual({ role: "user", content: firstUserMessage(INTENT_TEXT) });
  });

  it("9.8: request_id repetido devolve o primeiro intent_id e abre nada de novo", async () => {
    const before = (await worker.events(POOL)).filter((e) => e.type === "attempt.opened").length;
    const again = await intentReq(POOL, "r-land-1");
    expect(again.status).toBe(200);
    expect(again.body.intent_id).toBe(derivedId("i_", "r-land-1"));
    const after = (await worker.events(POOL)).filter((e) => e.type === "attempt.opened").length;
    expect(after).toBe(before);
  });

  it("validação da rota: 401 sem chave, bad_json, invalid_args e FJ1 feature_off", async () => {
    const unauth = await worker.fetch(`/api/pools/${POOL}/intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x", race: false, prewritten: false, request_id: "r-u" }),
    });
    expect(unauth.status).toBe(401);

    const bad = await worker.fetch(`/api/pools/${POOL}/intents`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: "{isto não é json",
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("bad_json");

    const missing = await worker.fetch(`/api/pools/${POOL}/intents`, bearer({ text: "x" }));
    expect(missing.status).toBe(400);

    const race = await intentReq(POOL, "r-race", { race: true });
    expect(race.status).toBe(404);
    expect((race.body.error as { code: string }).code).toBe("feature_off");
  });

  it("TA9: a rota de stop cancela a tentativa e repetir não muda nada", async () => {
    model.script = [
      { tool_calls: [{ name: "read", arguments: { path: "GUIDE.md" } }] },
      { tool_calls: [{ name: "read", arguments: { path: "GUIDE.md" } }] },
      { tool_calls: [{ name: "read", arguments: { path: "GUIDE.md" } }] },
    ];
    const res = await intentReq(POOL, "r-stop-1");
    expect(res.status).toBe(200);
    const attempt_id = derivedId("a_", "r-stop-1");

    const base = model.requests.length;
    await waitFor(async () => model.requests.length >= base + 2, 60_000); // loop em andamento
    const stop = await worker.fetch(`/api/pools/${POOL}/attempts/${attempt_id}/stop`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(stop.status).toBe(200);

    await waitFor(async () => {
      const st = await attemptState(POOL, attempt_id);
      return st?.type === "attempt.state" && st.to === "stopped";
    }, 60_000);
    const st = await attemptState(POOL, attempt_id);
    expect(st?.reason).toBe("cancelled");

    // TA9: repetir a rota no mesmo attempt não produz evento novo.
    const stateEventsBefore = (await worker.events(POOL)).filter(
      (e) => e.type === "attempt.state" && e.attempt_id === attempt_id,
    ).length;
    const again = await worker.fetch(`/api/pools/${POOL}/attempts/${attempt_id}/stop`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(again.status).toBe(200);
    await new Promise((r) => setTimeout(r, 3_000));
    const stateEventsAfter = (await worker.events(POOL)).filter(
      (e) => e.type === "attempt.state" && e.attempt_id === attempt_id,
    ).length;
    expect(stateEventsAfter).toBe(stateEventsBefore);
  }, 180_000);

  it("SE10: POST /api/kill → a reserva seguinte é recusada e o agente para `killed`", async () => {
    // Último teste do deployment: o kill é permanente por instância do gate.
    model.script = [
      { tool_calls: [{ name: "read", arguments: { path: "GUIDE.md" } }] },
      { tool_calls: [{ name: "read", arguments: { path: "GUIDE.md" } }] },
      { tool_calls: [{ name: "read", arguments: { path: "GUIDE.md" } }] },
    ];
    const res = await intentReq(POOL, "r-kill-1");
    expect(res.status).toBe(200);
    const attempt_id = derivedId("a_", "r-kill-1");
    const base = model.requests.length;

    // Primeiro call em voo; o kill chega antes da reserva seguinte.
    await waitFor(async () => model.requests.length >= base + 1, 60_000);
    const kill = await worker.fetch("/api/kill", bearer({ killed: true, landings: false }));
    expect(kill.status).toBe(200);
    const atKill = model.requests.length;

    await waitFor(async () => {
      const st = await attemptState(POOL, attempt_id);
      return st?.type === "attempt.state" && st.to === "stopped";
    }, 90_000);
    const st = await attemptState(POOL, attempt_id);
    expect(st?.reason).toBe("killed");
    // O gate recusou toda reserva após o kill: no máximo um send já em voo pousa.
    expect(model.requests.length).toBeLessThanOrEqual(atKill + 1);
  }, 180_000);
});

describe("item 3: SPEND_CAP_USD abaixo do bound do primeiro call", () => {
  let capWorker: LandingRealWorker;
  let capModel: FakeModel;
  const CAP_POOL = "p-rcap";

  beforeAll(async () => {
    capModel = new FakeModel();
    await capModel.listen();
    capWorker = await startRealLandingWorker({
      ownerKey: KEY,
      modelUrl: capModel.url,
      spendCapUsd: "0.001",
      repos: [CAP_POOL],
    });
    const res = await capWorker.fetch(
      "/api/pools",
      bearer({ pool: CAP_POOL, seed: SEED, summary_only: false, request_id: "r-pool-cap" }),
    );
    expect(res.status).toBe(200);
  }, 90_000);

  afterAll(async () => {
    await capWorker?.dispose();
    await capModel?.close();
  });

  it("SE6/refusal: o bound do primeiro call excede o cap → spend_cap sem nenhum send", async () => {
    capModel.script = [...SCRIPT_LANDING];
    capModel.requests = [];
    const res = await capWorker.fetch(
      `/api/pools/${CAP_POOL}/intents`,
      bearer({
        text: INTENT_TEXT,
        race: false,
        prewritten: false,
        request_id: "r-cap-1",
      }),
    );
    expect(res.status).toBe(200);
    const attempt_id = derivedId("a_", "r-cap-1");

    await waitFor(async () => {
      const st = await (async () => {
        const evs = await capWorker.events(CAP_POOL);
        return [...evs].reverse().find((e) => e.attempt_id === attempt_id && e.type === "attempt.state");
      })();
      return st?.to === "stopped";
    }, 90_000);

    const events = await capWorker.events(CAP_POOL);
    const stopped = [...events].reverse().find((e) => e.attempt_id === attempt_id && e.type === "attempt.state");
    expect(stopped?.reason).toBe("spend_cap");
    // O gate recusou a reserva ANTES do provider: o fake viu zero requests.
    expect(capModel.requests.length).toBe(0);
  }, 120_000);
});
