// calibrate:clef end to end, offline: a fake model client answers in place of Workers AI. Expected
// values follow from the labels of the set, the 7.3 mapping and RR7's text, and from what the fake is
// scripted to answer; the token test checks BP7 (a Cloudflare API token never reaches a log or a file).

import { describe, expect, it } from "vitest";
import { triageRequest } from "../../src/worker/adapters/triage/clef-triage.ts";
import type { AiBinding } from "../../src/worker/adapters/model/workers-ai.ts";
import type { FetchLike } from "../measure/early/workers-ai-rest.ts";
import { loadCases } from "./cases.ts";
import { main, type Calibration, type Io } from "./run.ts";

const cases = loadCases();
const byState = new Map(cases.map((c) => [JSON.stringify(triageRequest(c.input).state), c]));
const DEPENDENT = cases.filter((c) => c.label === "dependent").length;
const INDEPENDENT = cases.length - DEPENDENT;

type Script = {
  p: (label: string) => number;
  ms: number;
  maxQuestions?: number;
  tokensPerChar?: number;
  tokenCap?: number;
};

/** A fake Workers AI: answers each case by its label, takes `ms` of virtual time, reports usage. */
function fakeAi(clock: { t: number }, script: Script): AiBinding & { calls: number } {
  const ai = {
    calls: 0,
    async run(_model: string, request: Record<string, unknown>) {
      ai.calls += 1;
      clock.t += script.ms;
      const state = request.state as Record<string, unknown>;
      const questions = Object.keys(request.questions as Record<string, unknown>);
      if (questions.length > (script.maxQuestions ?? 1_000)) throw { status: 400 };
      const chars = JSON.stringify(state).length;
      const tokens = Math.min(Math.round(chars * (script.tokensPerChar ?? 0.25)), script.tokenCap ?? Infinity);
      const known = byState.get(JSON.stringify(state));
      const p = known === undefined ? 0.5 : script.p(known.label);
      return {
        model: "clef",
        answers: Object.fromEntries(questions.map((q) => [q, { noul: p }])),
        usage: { input_tokens: tokens },
      };
    },
  };
  return ai;
}

function io(clock: { t: number }, extra: Partial<Io> = {}) {
  const logs: string[] = [];
  const files = new Map<string, string>();
  const value: Io = {
    log: (line) => logs.push(line),
    writeFile: (path, text) => files.set(path, text),
    mkdir: () => {},
    now: () => clock.t,
    sleep: async () => {},
    date: () => "2026-10-14",
    ...extra,
  };
  return { io: value, logs, files };
}

describe("calibrate:clef offline with a fake model client", () => {
  it("2.16: writes <date>-clef.json and .md with the confusion table, thresholds, latency and RR7's verdict", async () => {
    const clock = { t: 1_000_000 };
    const ai = fakeAi(clock, {
      p: (label) => (label === "dependent" ? 0.92 : 0.06),
      ms: 350,
      maxQuestions: 64,
      tokenCap: 20_000,
    });
    const run = io(clock, { ai });
    const code = await main(["--out", "/out"], {}, run.io);
    expect(code).toBe(0);
    expect([...run.files.keys()].sort()).toEqual(["/out/2026-10-14-clef.json", "/out/2026-10-14-clef.md"]);
    const cal = JSON.parse(run.files.get("/out/2026-10-14-clef.json")!) as Calibration;

    expect(cal.cases).toMatchObject({ total: cases.length, dependent: DEPENDENT, independent: INDEPENDENT });
    for (const name of ["clef", "clef-flash"] as const) {
      const m = cal.models[name]!;
      expect(m.answers).toHaveLength(cases.length);
      // 7.3 at the starting thresholds (0.70, 0.20): 0.92 is repair, 0.06 is holds.
      expect(m.confusion_starting).toEqual({
        dependent: { repair: DEPENDENT, confirm: 0, holds: 0, unavailable: 0 },
        independent: { repair: 0, confirm: 0, holds: INDEPENDENT, unavailable: 0 },
      });
      expect(m.latency_ms).toEqual({ p50: 350, p95: 350, max: 350, over_timeout: 0 });
      expect(m.rr7.pass).toBe(true);
      expect(m.response_shape).toEqual({ top: ["answers", "model", "usage"], answer: ["noul"] });
    }
    expect(cal.verdict).toMatchObject({ decision: "on", model: "clef" });
    expect(cal.proposed).toMatchObject({
      CLEF_TRIAGE: "on",
      features_clef: true,
      CLEF_TRIAGE_MODEL_ID: "@cf/cloudflare/clef",
    });

    // S6: 64 questions answered in one request, 128 refused: CLEF_MAX_QUESTIONS stays 64.
    expect(cal.probes.clef!.questions.map((q) => [q.questions, q.ok])).toEqual([
      [64, true],
      [128, false],
    ]);
    expect(cal.proposed.CLEF_MAX_QUESTIONS).toBe(64);
    // TR7: the fake reports at most 20,000 input tokens however large the state: that is the truncation point.
    expect(cal.probes.clef!.tokens.some((t) => t.truncated)).toBe(true);
    expect(cal.proposed.CLEF_INPUT_TOKEN_LIMIT).toBe(20_000);

    const md = run.files.get("/out/2026-10-14-clef.md")!;
    expect(md).toContain("## Verdict: on (clef)");
    expect(md).toContain("| truth \\ result | repair | confirm | holds | unavailable |");
    expect(md).toContain("`CLEF_INPUT_TOKEN_LIMIT` | 60000 | 20000");
  });

  it("RR7: a truly dependent case judged holds keeps Clef off, and the thresholds stay at their starting values", async () => {
    const clock = { t: 0 };
    // Every case answered 0.05: no threshold separates the classes, so nothing may hold.
    const ai = fakeAi(clock, { p: () => 0.05, ms: 200 });
    const run = io(clock, { ai });
    expect(await main(["--out", "/o", "--no-probes"], {}, run.io)).toBe(0);
    const cal = JSON.parse(run.files.get("/o/2026-10-14-clef.json")!) as Calibration;
    expect(cal.models.clef!.confusion_starting.dependent.holds).toBe(DEPENDENT);
    expect(cal.models.clef!.rr7.independent_holds).toBe(0);
    expect(cal.verdict.decision).toBe("off");
    expect(cal.proposed).toMatchObject({ CLEF_TRIAGE: "off", features_clef: false, T_REPAIR: 0.7, T_CONFIRM: 0.2 });
  });

  it("RR7 and S6: clef too slow at p95, clef-flash fast and accurate: the fallback is clef-flash", async () => {
    const clock = { t: 0 };
    let model = "";
    const base = fakeAi(clock, { p: (label) => (label === "dependent" ? 0.9 : 0.05), ms: 0 });
    const ai: AiBinding = {
      async run(m, request) {
        model = m;
        clock.t += m === "@cf/cloudflare/clef" ? 2_500 : 300;
        return base.run(m, request);
      },
    };
    const run = io(clock, { ai });
    expect(await main(["--out", "/o", "--no-probes"], {}, run.io)).toBe(0);
    expect(model).toBe("@cf/cloudflare/clef-flash");
    const cal = JSON.parse(run.files.get("/o/2026-10-14-clef.json")!) as Calibration;
    expect(cal.models.clef!.latency_ms.p95).toBe(2_500);
    expect(cal.models.clef!.rr7).toMatchObject({ accuracy_ok: true, latency_ok: false });
    expect(cal.verdict).toMatchObject({ decision: "fallback", model: "clef-flash" });
    expect(cal.proposed).toMatchObject({
      CLEF_TRIAGE_MODEL_ID: "@cf/cloudflare/clef-flash",
      CLEF_TRIAGE_MODEL: "clef-flash",
    });
  });

  it("--max-usd: once the budget is spent every further question is unavailable (spend_cap)", async () => {
    const clock = { t: 0 };
    const ai = fakeAi(clock, { p: () => 0.5, ms: 100, tokensPerChar: 10 });
    const run = io(clock, { ai });
    expect(await main(["--out", "/o", "--no-probes", "--models", "clef", "--max-usd", "0.001"], {}, run.io)).toBe(0);
    const cal = JSON.parse(run.files.get("/o/2026-10-14-clef.json")!) as Calibration;
    expect(ai.calls).toBe(1);
    expect(cal.models.clef!.unavailable).toEqual({ spend_cap: cases.length - 1 });
  });

  it("refuses to run without CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, and on unknown arguments", async () => {
    const run = io({ t: 0 });
    expect(await main([], {}, run.io)).toBe(2);
    expect(run.logs.join("\n")).toContain("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
    expect(await main(["--models", "gpt"], {}, run.io)).toBe(2);
    expect(run.files.size).toBe(0);
  });

  it("BP7: the API token reaches only the Authorization header, never a log line or a written file", async () => {
    const token = "cfTOKEN_sentinel_6c0ffee6c0ffee6c0ffee";
    const account = "acct0sentinel9f8e7d6c5b4a3";
    const clock = { t: 0 };
    const answer = fakeAi(clock, { p: (label) => (label === "dependent" ? 0.9 : 0.05), ms: 100 });
    const seen: string[] = [];
    let calls = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      calls += 1;
      seen.push(init.headers.authorization ?? "");
      expect(url).toContain(account);
      if (calls === 1) {
        // A provider error that echoes the credentials back must still be redacted.
        return {
          status: 500,
          text: async () => `{"errors":[{"code":7000,"message":"bad token ${token} for ${account}"}]}`,
        };
      }
      const result = await answer.run(url.split("/ai/run/")[1]!, JSON.parse(init.body) as Record<string, unknown>);
      return { status: 200, text: async () => JSON.stringify({ success: true, result }) };
    };
    const run = io(clock, { fetchImpl });
    const env = { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token };
    expect(await main(["--out", "/o", "--models", "clef", "--no-probes"], env, run.io)).toBe(0);

    // The default client was used, and it sent the token where it belongs.
    expect(seen.length).toBe(cases.length);
    expect(seen.every((h) => h === `Bearer ${token}`)).toBe(true);
    const everything = [...run.logs, ...run.files.values()].join("\n");
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(account);
    const cal = JSON.parse(run.files.get("/o/2026-10-14-clef.json")!) as Calibration;
    expect(cal.errors).toHaveLength(1);
    expect(cal.errors[0]).toContain("[redacted]");
    expect(cal.models.clef!.unavailable).toEqual({ model_unavailable: 1 });
  });
});
