// Slice 15 acceptance item 3 (04-build-plan 2.16), in local workerd with a fake `AI` binding that
// answers with given probabilities. A real attempt reads all of `creatures/fish.js` and writes a
// file that uses none of it; a synthetic change alters `fish.js#BODY` and lands. The reader's
// `file` premise is row F4 (triage), so Clef is asked. Expected values are 01-core 7.3's:
// TR1, TR2, JE1, TR4, TR7, TR8. The switch is on only for this bundle (`features.clef`,
// `CLEF_TRIAGE = on`); the shipped build keeps both off.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLEF_STATE_MAX_CHARS } from "../../../src/protocol/constants.ts";
import { startLandingWorker, type LandingWorker } from "../landing/harness.ts";
import { createPool, eventsOf, KEY, openAttempt, sync, tick, tool, waitFor } from "../collide/helpers.ts";

type ModelCall = {
  model: string;
  request: { model?: string; state?: { patch?: Array<{ key: string; source: string }> }; questions?: object };
  /** The reader's judgment and heads-ups as stored when the request arrived (TR2). */
  stored: { judgments: Array<Record<string, unknown>>; heads: number };
};

/** The fake Workers AI: each `/run` asks the test's `answer` for the probability of `p1`. */
class FakeClef {
  calls: ModelCall[] = [];
  answer: (call: ModelCall) => Promise<number> = async () => 0.9;
  observe: (pool: string) => Promise<ModelCall["stored"]> = async () => ({ judgments: [], heads: 0 });
  pool = "";
  url = "";
  #server: Server | null = null;

  async listen(): Promise<void> {
    this.#server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk));
      req.on("end", () => {
        void (async () => {
          const parsed = JSON.parse(body) as { model: string; request: ModelCall["request"] };
          const call: ModelCall = { ...parsed, stored: await this.observe(this.pool) };
          this.calls.push(call);
          const p = await this.answer(call);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ model: "clef", answers: { p1: { noul: p } }, usage: { input_tokens: 460 } }));
        })().catch(() => {
          res.writeHead(500);
          res.end();
        });
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.#server?.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }
}

const POOLS = ["clef-tr1", "clef-tr4", "clef-tr7", "clef-tr8"];
const READER_FILE = "creatures/clefcrab.js";

describe("Slice 15 item 3: Clef triage in local workerd with a fake AI binding (7.3)", () => {
  let worker: LandingWorker;
  const clef = new FakeClef();

  async function rows(pool: string, query: string): Promise<Array<Record<string, unknown>>> {
    return [...(await worker.sql("TRUNK", pool, query))] as Array<Record<string, unknown>>;
  }
  const readerJudgments = (pool: string) =>
    rows(
      pool,
      "SELECT rule, class, result, reason, asked_op_seq, clef_model, clef_p, clef_error FROM judgments " +
        "WHERE attempt_id = 'reader' AND kind = 'file' AND key = 'creatures/fish.js' ORDER BY judgment_id",
    );

  /** The reader (real, or synthetic for TR8) reads all of fish.js and writes `content`; the
   * changer alters `fish.js#BODY`, submits, and the tick lands it. */
  async function collide(pool: string, opts: { reader: "real" | "synthetic"; files?: Record<string, string> }) {
    await createPool(worker, pool, { seed: "tidepool" });
    const open = await worker.trunk(pool).fetch("/internal/open-attempt", {
      method: "POST",
      body: JSON.stringify({
        attempt_id: "reader",
        intent: "add a crab that hides",
        agent_kind: opts.reader,
        truth: [],
        requester: "owner",
      }),
    });
    expect(open.status, await open.clone().text()).toBe(200);
    await tool(worker, pool, "reader", { tool: "read", args: { path: "creatures/fish.js" } }, 1);
    let n = 2;
    for (const [path, content] of Object.entries(opts.files ?? { [READER_FILE]: "export const hides = true;\n" })) {
      await tool(worker, pool, "reader", { tool: "write", args: { path, content } }, n++);
    }
    await openAttempt(worker, pool, "changer", { intent: "make the fish red" });
    await tool(worker, pool, "changer", { tool: "read", args: { path: "creatures/fish.js", entity: "BODY" } }, 1);
    await tool(
      worker,
      pool,
      "changer",
      {
        tool: "replace",
        args: { path: "creatures/fish.js", old: 'const BODY = "orange";', new: 'const BODY = "red";' },
      },
      2,
    );
    const submitted = await tool(
      worker,
      pool,
      "changer",
      { tool: "submit", args: { summary: "Make the fish red" } },
      3,
    );
    expect(submitted.result).toMatchObject({ status: "validated" });
    clef.pool = pool;
    await tick(worker, pool);
  }

  beforeAll(async () => {
    await clef.listen();
    clef.observe = async (pool) => ({
      judgments: await readerJudgments(pool),
      heads: Number((await rows(pool, "SELECT COUNT(*) AS n FROM heads_ups WHERE attempt_id = 'reader'"))[0]?.n ?? 0),
    });
    worker = await startLandingWorker({
      ownerKey: KEY,
      repos: POOLS,
      agentStub: true,
      inspect: true,
      modelUrl: clef.url,
      features: { clef: true },
      vars: { CLEF_TRIAGE: "on" },
    });
  }, 120_000);

  afterAll(async () => {
    await worker?.dispose();
    await clef.close();
  });

  it("TR1, TR2, JE1: the pending item is committed before the request leaves; the answer's judgment carries clef.p", async () => {
    clef.calls = [];
    clef.answer = async () => 0.9;
    await collide("clef-tr1", { reader: "real" });
    // TR1: in the accept transaction — the judgment pending, the `info` heads-up with a pending item.
    const heads = await sync(worker, "clef-tr1", "reader", 0);
    expect(heads[0]).toMatchObject({ result: "info" });
    expect((heads[0]?.items as Array<Record<string, unknown>>)[0]).toMatchObject({
      premise: { kind: "file", key: "creatures/fish.js" },
      rule: "F4",
      result: "pending",
    });
    await waitFor(async () => (await readerJudgments("clef-tr1"))[0]?.result !== null, 20_000);
    // TR2: one request, and when it arrived the pending judgment and the heads-up were stored.
    expect(clef.calls).toHaveLength(1);
    expect(clef.calls[0]?.model).toBe("@cf/cloudflare/clef");
    expect(clef.calls[0]?.request.model).toBe("clef");
    expect(clef.calls[0]?.stored.judgments).toMatchObject([{ rule: "F4", class: "triage", result: null }]);
    expect(clef.calls[0]?.stored.heads).toBe(1);
    // 7.3 mapping: p = 0.9 >= T_REPAIR gives `repair`, `triage_depends`.
    expect(await readerJudgments("clef-tr1")).toMatchObject([
      { rule: "F4", class: "triage", result: "repair", reason: "triage_depends", clef_model: "clef", clef_p: 0.9 },
    ]);
    // JE1: a first `premise.judged` with result null, a second that carries clef.p.
    await waitFor(
      async () =>
        (await eventsOf(worker, "clef-tr1", "premise.judged")).filter((e) => e.attempt_id === "reader").length >= 2,
      20_000,
    );
    const judged = (await eventsOf(worker, "clef-tr1", "premise.judged")).filter(
      (e) => e.attempt_id === "reader" && e.key === "creatures/fish.js",
    );
    expect(judged.map((e) => e.result)).toEqual([null, "repair"]);
    expect(judged[1]).toMatchObject({ class: "triage", reason: "triage_depends", clef: { model: "clef", p: 0.9 } });
  }, 120_000);

  it("TR4: an answer that arrives after a new operation is recorded `stale`, and the question is asked again", async () => {
    clef.calls = [];
    let release: (p: number) => void = () => {};
    const first = new Promise<number>((resolve) => (release = resolve));
    clef.answer = async (call) => (clef.calls.indexOf(call) === 0 ? first : 0.05);
    await collide("clef-tr4", { reader: "real" });
    await waitFor(() => clef.calls.length === 1, 20_000);
    const asked = Number((await readerJudgments("clef-tr4"))[0]?.asked_op_seq);
    // A new operation while the answer is out: the question stays triage and is asked again (V7).
    await tool(
      worker,
      "clef-tr4",
      "reader",
      { tool: "write", args: { path: READER_FILE, content: "export const hides = false;\n" } },
      10,
      1,
    );
    release(0.95);
    await waitFor(() => clef.calls.length === 2, 20_000);
    await waitFor(async () => (await readerJudgments("clef-tr4"))[0]?.result !== null, 20_000);
    const [j] = await readerJudgments("clef-tr4");
    expect(Number(j?.asked_op_seq)).toBeGreaterThan(asked);
    // The late answer (0.95) did not decide; the answer for the current patch (0.05) did.
    expect(j).toMatchObject({ result: "holds", reason: "reaffirmed", clef_p: 0.05, clef_error: "stale" });
    expect(clef.calls[1]?.request.state?.patch).toContainEqual({
      key: "creatures/clefcrab.js#hides",
      source: "export const hides = false;\n",
    });
  }, 120_000);

  it("TR7: a state over CLEF_STATE_MAX_CHARS is never sent; the outcome is the fail-closed confirm", async () => {
    clef.calls = [];
    const big = (name: string) => `export const ${name} = "${"x".repeat(Math.ceil(CLEF_STATE_MAX_CHARS / 3))}";\n`;
    await collide("clef-tr7", {
      reader: "real",
      files: { "creatures/big1.js": big("A"), "creatures/big2.js": big("B"), "creatures/big3.js": big("C") },
    });
    await waitFor(async () => (await readerJudgments("clef-tr7"))[0]?.result !== null, 20_000);
    expect(clef.calls).toEqual([]);
    expect(await readerJudgments("clef-tr7")).toMatchObject([
      { rule: "F4", result: "confirm", reason: "triage_unavailable", clef_error: "state_too_large" },
    ]);
  }, 120_000);

  it("TR8: a synthetic attempt in the same position causes no request", async () => {
    clef.calls = [];
    await collide("clef-tr8", { reader: "synthetic" });
    // ScriptedTriage answers inside the transaction (TR5): an empty truth list gives p = 0, `holds`.
    expect(await readerJudgments("clef-tr8")).toMatchObject([
      { rule: "F4", class: "triage", result: "holds", reason: "reaffirmed", clef_model: "scripted", clef_p: 0 },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(clef.calls).toEqual([]);
    expect(await rows("clef-tr8", "SELECT * FROM triage_asks")).toEqual([]);
  }, 120_000);
});
