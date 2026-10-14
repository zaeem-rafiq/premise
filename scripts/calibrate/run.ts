// `calibrate:clef` (04-build-plan 2.16 item 2; 01-core S6, S6b, TR7; RR7): ask every case of the
// labelled set through `ClefTriage`, the adapter production uses, once per model (`clef` and the
// fallback `clef-flash`); probe how many questions one request accepts (`CLEF_MAX_QUESTIONS`) and
// the input size at which the service truncates (`CLEF_INPUT_TOKEN_LIMIT`); then write the
// confusion table, the thresholds, the latency and RR7's verdict under docs/measurements/calibration/.
// The model client is injected: the CLI passes Workers AI over REST, the tests a fake.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLEF_INPUT_TOKEN_LIMIT,
  CLEF_MAX_QUESTIONS,
  CLEF_TIMEOUT_MS,
  CLEF_TRIAGE_MODEL_ID,
  T_CONFIRM,
  T_REPAIR,
} from "../../src/protocol/constants.ts";
import type { TriageInput } from "../../src/protocol/ports.ts";
import { redact } from "../../src/protocol/redact.ts";
import { callModel, type AiBinding } from "../../src/worker/adapters/model/workers-ai.ts";
import { ClefTriage, triageRequest } from "../../src/worker/adapters/triage/clef-triage.ts";
import type { FetchLike } from "../measure/early/workers-ai-rest.ts";
import { CASES_FILE, ROOT, loadCases, type CalibrationCase, type Label } from "./cases.ts";
import { credentialsFromEnv, LedgerGate, restBinding } from "./client.ts";
import {
  confusion,
  decide,
  OUTCOMES,
  percentile,
  rr7,
  type Answer,
  type Confusion,
  type Decision,
  type Rr7,
  type Thresholds,
} from "./score.ts";

export const MODELS = [
  { name: "clef", id: "@cf/cloudflare/clef" },
  { name: "clef-flash", id: "@cf/cloudflare/clef-flash" },
] as const;
export type ModelName = (typeof MODELS)[number]["name"];

/** Long enough to measure a slow answer; RR7 compares the latency with `CLEF_TIMEOUT_MS` itself. */
export const CALL_TIMEOUT_MS = 30_000;
/** The question counts tried in one request: up from the current constant, or down when it fails. */
export const QUESTION_PROBES_UP = [CLEF_MAX_QUESTIONS, CLEF_MAX_QUESTIONS * 2];
export const QUESTION_PROBES_DOWN = [32, 16, 8];
/** Filler sizes of the truncation probe, in characters of the serialized state. */
export const TOKEN_PROBE_CHARS = [16_000, 64_000, 128_000, 256_000];
/** A probe whose tokens per character fall below this share of the smallest probe's was cut. */
export const TRUNCATION_RATIO = 0.75;
const RATE_LIMIT_RETRIES = 3;
const STARTING: Thresholds = { T_REPAIR, T_CONFIRM };

export type CaseAnswer = Answer & { row: string; zone: string; tokens_in: number | null };

export type ModelRun = {
  model: ModelName;
  model_id: string;
  answers: CaseAnswer[];
  latency_ms: { p50: number | null; p95: number | null; max: number | null; over_timeout: number };
  unavailable: Record<string, number>;
  response_shape: { top: string[]; answer: string[] } | null;
  confusion_starting: Confusion;
  confusion_proposed: Confusion | null;
  rr7: Rr7;
};

export type QuestionProbe = { questions: number; answered: number; ok: boolean; ms: number; error: string | null };
export type TokenProbe = {
  state_chars: number;
  input_tokens: number | null;
  ok: boolean;
  truncated: boolean;
  ms: number;
  error: string | null;
};
export type Probes = { questions: QuestionProbe[]; tokens: TokenProbe[] };

export type Deps = {
  ai: AiBinding;
  gate: LedgerGate;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inputTokensOf(result: unknown): number | null {
  if (!isRecord(result) || !isRecord(result.usage)) return null;
  const n = result.usage.input_tokens ?? result.usage.prompt_tokens;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Wraps the client to keep, per call, the reported input tokens and the first answer's shape. */
function recorder(ai: AiBinding) {
  let lastTokens: number | null = null;
  let shape: ModelRun["response_shape"] = null;
  const binding: AiBinding = {
    async run(model, request) {
      lastTokens = null;
      const result = await ai.run(model, request);
      lastTokens = inputTokensOf(result);
      if (shape === null && isRecord(result) && isRecord(result.answers)) {
        const first = Object.values(result.answers)[0];
        shape = { top: Object.keys(result).sort(), answer: isRecord(first) ? Object.keys(first).sort() : [] };
      }
      return result;
    },
  };
  return { binding, tokens: () => lastTokens, shape: () => shape };
}

/** Every case through `ClefTriage`, one request per case, in order (no concurrency: clean latency). */
export async function judgeCases(
  deps: Deps,
  model: (typeof MODELS)[number],
  cases: readonly CalibrationCase[],
): Promise<ModelRun> {
  const rec = recorder(deps.ai);
  const triage = new ClefTriage({
    ai: rec.binding,
    gate: deps.gate,
    pool: "calibrate-clef",
    modelId: model.id,
    model: model.name,
    timeoutMs: CALL_TIMEOUT_MS,
    now: deps.now,
  });
  const answers: CaseAnswer[] = [];
  for (const c of cases) {
    let result = await triage.judge(c.input);
    for (let retry = 1; retry <= RATE_LIMIT_RETRIES && result.error === "rate_limited"; retry += 1) {
      await deps.sleep(2_000 * retry);
      result = await triage.judge(c.input);
    }
    const p = result.answers[c.qid] ?? null;
    const answer: CaseAnswer = {
      id: c.id,
      label: c.label,
      row: c.row,
      zone: c.zone,
      p,
      ms: result.ms,
      tokens_in: rec.tokens(),
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
    answers.push(answer);
    deps.log(
      `${model.name} ${c.id} (${c.label}): ${p === null ? `unavailable (${result.error ?? "?"})` : `p=${p}`} ${result.ms} ms`,
    );
  }
  const ms = answers.map((a) => a.ms);
  const unavailable: Record<string, number> = {};
  for (const a of answers)
    if (a.p === null) unavailable[a.error ?? "unknown"] = (unavailable[a.error ?? "unknown"] ?? 0) + 1;
  const verdict = rr7(answers, STARTING, CLEF_TIMEOUT_MS);
  return {
    model: model.name,
    model_id: model.id,
    answers,
    latency_ms: {
      p50: percentile(ms, 0.5),
      p95: percentile(ms, 0.95),
      max: ms.length === 0 ? null : Math.max(...ms),
      over_timeout: ms.filter((m) => m > CLEF_TIMEOUT_MS).length,
    },
    unavailable,
    response_shape: rec.shape(),
    confusion_starting: confusion(answers, STARTING),
    confusion_proposed: verdict.thresholds === null ? null : confusion(answers, verdict.thresholds),
    rr7: verdict,
  };
}

/** One raw request through the gate and the model adapter, outside `ClefTriage`'s question limit. */
async function rawCall(deps: Deps, model: (typeof MODELS)[number], input: TriageInput) {
  const { state, questions } = triageRequest(input);
  const body = { model: model.name, state, questions };
  const reserved = await deps.gate.reserve({ model: model.id });
  if (!reserved.ok)
    return { outcome: null, ms: 0, tokens: null, chars: JSON.stringify(state).length, error: "spend_cap" };
  const started = deps.now();
  const outcome = await callModel(deps.ai, model.id, body, CALL_TIMEOUT_MS);
  const ms = Math.max(0, deps.now() - started);
  const tokens = outcome.kind === "answer" ? inputTokensOf(outcome.result) : null;
  await deps.gate.settle({
    reservation_id: reserved.reservation_id,
    usage: tokens === null ? null : { tokens_in: tokens, tokens_out: 0 },
  });
  return {
    outcome,
    ms,
    tokens,
    chars: JSON.stringify(state).length,
    error: outcome.kind === "answer" ? null : outcome.kind,
  };
}

/** `base` with its one premise asked `n` times (ids `p1` to `pn` in the request). */
function withQuestions(base: CalibrationCase, n: number): TriageInput {
  const premise = base.input.premises[base.qid]!;
  const premises: TriageInput["premises"] = {};
  for (let i = 1; i <= n; i += 1) premises[`${base.qid}#${i}`] = premise;
  return { ...base.input, premises };
}

/** `base` with a filler entity in its patch, so the serialized state is about `chars` long. */
function withFiller(base: CalibrationCase, chars: number): TriageInput {
  const lines: string[] = [];
  let size = JSON.stringify(triageRequest(base.input).state).length;
  for (let i = 0; size < chars; i += 1) {
    const line = `export const FILLER_${i} = ${(i * 7919) % 10007}; // filler for the truncation probe\n`;
    lines.push(line);
    size += line.length + 1;
  }
  return { ...base.input, patch: [...base.input.patch, { key: "probe/filler.js#FILLER", source: lines.join("") }] };
}

export async function probe(deps: Deps, model: (typeof MODELS)[number], base: CalibrationCase): Promise<Probes> {
  const questions: QuestionProbe[] = [];
  const ask = async (n: number): Promise<boolean> => {
    const r = await rawCall(deps, model, withQuestions(base, n));
    const answers = r.outcome?.kind === "answer" && isRecord(r.outcome.result) ? r.outcome.result.answers : null;
    let answered = 0;
    for (let i = 1; i <= n; i += 1) {
      const a = isRecord(answers) ? answers[`p${i}`] : undefined;
      const p = isRecord(a) ? a.noul : undefined;
      if (typeof p === "number" && p >= 0 && p <= 1) answered += 1;
    }
    const ok = answered === n;
    questions.push({ questions: n, answered, ok, ms: r.ms, error: r.error ?? (ok ? null : "malformed") });
    deps.log(`${model.name} probe: ${n} questions in one request: ${answered} answered`);
    return ok;
  };
  if (await ask(QUESTION_PROBES_UP[0]!)) {
    for (const n of QUESTION_PROBES_UP.slice(1)) if (!(await ask(n))) break;
  } else {
    for (const n of QUESTION_PROBES_DOWN) if (await ask(n)) break;
  }

  const tokens: TokenProbe[] = [];
  let firstRatio: number | null = null;
  for (const chars of TOKEN_PROBE_CHARS) {
    const r = await rawCall(deps, model, withFiller(base, chars));
    const ratio = r.tokens === null ? null : r.tokens / r.chars;
    if (firstRatio === null && ratio !== null) firstRatio = ratio;
    const truncated = ratio !== null && firstRatio !== null && ratio < firstRatio * TRUNCATION_RATIO;
    tokens.push({
      state_chars: r.chars,
      input_tokens: r.tokens,
      ok: r.error === null,
      truncated,
      ms: r.ms,
      error: r.error,
    });
    deps.log(
      `${model.name} probe: state of ${r.chars} characters: ${r.tokens ?? "no"} input tokens${truncated ? " (truncated)" : ""}${r.error === null ? "" : ` (${r.error})`}`,
    );
    if (r.error !== null) break;
  }
  return { questions, tokens };
}

export type Proposed = {
  CLEF_TRIAGE: "on" | "off";
  features_clef: boolean;
  CLEF_TRIAGE_MODEL_ID: string;
  CLEF_TRIAGE_MODEL: string;
  T_REPAIR: number;
  T_CONFIRM: number;
  CLEF_MAX_QUESTIONS: number;
  CLEF_INPUT_TOKEN_LIMIT: number;
  CLEF_RISK: "off";
  CLEF_CONTRADICTION: "off";
  notes: string[];
};

/** The values to propose for wrangler.jsonc and src/protocol/constants.ts (the lead sets them, BP8). */
export function propose(
  decision: Decision,
  runs: Partial<Record<ModelName, ModelRun>>,
  probes: Partial<Record<ModelName, Probes>>,
): Proposed {
  const notes: string[] = [];
  const chosen: ModelName = decision.model ?? "clef";
  const run = runs[chosen];
  const thresholds = decision.model !== null && run?.rr7.thresholds ? run.rr7.thresholds : STARTING;
  if (decision.model === null) notes.push("RR7 keeps Clef off: thresholds stay at their starting values (S6b).");
  const probe = probes[chosen];
  let maxQuestions = CLEF_MAX_QUESTIONS;
  if (probe === undefined) notes.push("CLEF_MAX_QUESTIONS: not probed; keep.");
  else {
    const ok = probe.questions.filter((q) => q.ok).map((q) => q.questions);
    const largest = ok.length === 0 ? null : Math.max(...ok);
    if (largest === null) notes.push("CLEF_MAX_QUESTIONS: no probe was fully answered; keep, and look at the errors.");
    else if (largest >= CLEF_MAX_QUESTIONS)
      notes.push(`CLEF_MAX_QUESTIONS: ${largest} questions were answered in one request; keep ${CLEF_MAX_QUESTIONS}.`);
    else {
      maxQuestions = largest;
      notes.push(
        `CLEF_MAX_QUESTIONS: ${CLEF_MAX_QUESTIONS} failed and ${largest} was answered; lower it to ${largest}.`,
      );
    }
  }
  let tokenLimit = CLEF_INPUT_TOKEN_LIMIT;
  if (probe === undefined) notes.push("CLEF_INPUT_TOKEN_LIMIT: not probed; keep.");
  else {
    const cut = probe.tokens.filter((t) => t.truncated && t.input_tokens !== null).map((t) => t.input_tokens as number);
    const seen = probe.tokens.filter((t) => t.input_tokens !== null).map((t) => t.input_tokens as number);
    if (cut.length > 0) {
      tokenLimit = Math.min(...cut);
      notes.push(
        `CLEF_INPUT_TOKEN_LIMIT: the service reported at most ${tokenLimit} input tokens for a larger state; set it to ${tokenLimit} (TR7 discards at or above it).`,
      );
    } else {
      notes.push(
        `CLEF_INPUT_TOKEN_LIMIT: no truncation seen up to ${seen.length === 0 ? "no" : Math.max(...seen)} input tokens; keep ${CLEF_INPUT_TOKEN_LIMIT}.`,
      );
    }
  }
  notes.push(
    "CLEF_RISK and CLEF_CONTRADICTION stay off: this set calibrates triage only, not T_INTENT_MIN, T_UNRELATED_MAX, T_SHARED_MAX or T_CONTRADICT.",
  );
  const flash = MODELS.find((m) => m.name === chosen)!;
  return {
    CLEF_TRIAGE: decision.decision === "off" ? "off" : "on",
    features_clef: decision.decision !== "off",
    CLEF_TRIAGE_MODEL_ID: decision.decision === "fallback" ? flash.id : CLEF_TRIAGE_MODEL_ID,
    CLEF_TRIAGE_MODEL: decision.decision === "fallback" ? flash.name : "clef",
    T_REPAIR: thresholds.T_REPAIR,
    T_CONFIRM: thresholds.T_CONFIRM,
    CLEF_MAX_QUESTIONS: maxQuestions,
    CLEF_INPUT_TOKEN_LIMIT: tokenLimit,
    CLEF_RISK: "off",
    CLEF_CONTRADICTION: "off",
    notes,
  };
}

export type Calibration = {
  v: 1;
  recorded_at: string;
  cases: {
    total: number;
    dependent: number;
    independent: number;
    by_row: Record<string, number>;
    by_source: Record<string, number>;
    rule_zone: number;
  };
  starting: Thresholds & { CLEF_TIMEOUT_MS: number; CLEF_MAX_QUESTIONS: number; CLEF_INPUT_TOKEN_LIMIT: number };
  models: Partial<Record<ModelName, ModelRun>>;
  probes: Partial<Record<ModelName, Probes>>;
  verdict: Decision;
  proposed: Proposed;
  spend: { calls: number; input_tokens: number; usd: number };
  errors: string[];
};

export async function calibrate(
  deps: Deps,
  cases: readonly CalibrationCase[],
  opts: { models: readonly ModelName[]; probes: boolean; recordedAt: string; errors: string[] },
): Promise<Calibration> {
  const runs: Partial<Record<ModelName, ModelRun>> = {};
  const probes: Partial<Record<ModelName, Probes>> = {};
  const base = cases.find((c) => c.source.kind === "vector") ?? cases[0]!;
  for (const name of opts.models) {
    const model = MODELS.find((m) => m.name === name)!;
    runs[name] = await judgeCases(deps, model, cases);
    if (opts.probes) probes[name] = await probe(deps, model, base);
  }
  const verdict = decide(runs.clef?.rr7 ?? null, runs["clef-flash"]?.rr7 ?? null);
  const count = (key: (c: CalibrationCase) => string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const c of cases) out[key(c)] = (out[key(c)] ?? 0) + 1;
    return out;
  };
  const labelled = (label: Label) => cases.filter((c) => c.label === label).length;
  return {
    v: 1,
    recorded_at: opts.recordedAt,
    cases: {
      total: cases.length,
      dependent: labelled("dependent"),
      independent: labelled("independent"),
      by_row: count((c) => c.row),
      by_source: count((c) => c.source.kind),
      rule_zone: cases.filter((c) => c.zone === "rule").length,
    },
    starting: { ...STARTING, CLEF_TIMEOUT_MS, CLEF_MAX_QUESTIONS, CLEF_INPUT_TOKEN_LIMIT },
    models: runs,
    probes,
    verdict,
    proposed: propose(verdict, runs, probes),
    spend: { calls: deps.gate.calls, input_tokens: deps.gate.tokensIn, usd: Number(deps.gate.spentUsd.toFixed(6)) },
    errors: opts.errors.slice(0, 20),
  };
}

function table(head: string[], rows: Array<Array<string | number>>): string {
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

function confusionTable(c: Confusion): string {
  return table(
    ["truth \\ result", ...OUTCOMES],
    (["dependent", "independent"] as const).map((label) => [label, ...OUTCOMES.map((o) => c[label][o])]),
  );
}

export function renderMarkdown(cal: Calibration): string {
  const out: string[] = [];
  out.push(`# Clef calibration, ${cal.recorded_at.slice(0, 10)}`, "");
  out.push(
    "Written by `npm run calibrate:clef` (04-build-plan 2.16 item 2; 01-core S6, S6b; RR7). Every case of",
    "`scripts/calibrate/clef-cases.json` was asked through `ClefTriage`, the adapter production uses, one request",
    "per case, over the Workers AI REST API from the machine that ran the script. Latency is the time of that call",
    "and so includes the network path to the API, which a Worker's `AI` binding does not have.",
    "",
  );
  out.push(
    `## Verdict: ${cal.verdict.decision}${cal.verdict.model === null ? "" : ` (${cal.verdict.model})`}`,
    "",
    cal.verdict.why,
    "",
  );
  out.push("## The set", "");
  out.push(
    `${cal.cases.total} cases: ${cal.cases.dependent} truly dependent, ${cal.cases.independent} independent. Rows: ` +
      Object.entries(cal.cases.by_row)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ") +
      ". Sources: " +
      Object.entries(cal.cases.by_source)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ") +
      `. ${cal.cases.rule_zone} cases are ones a rule row decides in the engine before Clef; they are kept as probes.`,
    "",
  );
  for (const run of Object.values(cal.models)) {
    if (run === undefined) continue;
    out.push(`## ${run.model} (\`${run.model_id}\`)`, "");
    out.push(
      `Latency: p50 ${run.latency_ms.p50 ?? "-"} ms, p95 ${run.latency_ms.p95 ?? "-"} ms, max ${run.latency_ms.max ?? "-"} ms; ` +
        `${run.latency_ms.over_timeout} calls over CLEF_TIMEOUT_MS (${cal.starting.CLEF_TIMEOUT_MS} ms).`,
      "",
    );
    const unavailable = Object.entries(run.unavailable);
    out.push(
      `Unavailable answers: ${unavailable.length === 0 ? "none" : unavailable.map(([k, v]) => `${k} ${v}`).join(", ")}.`,
      "",
    );
    out.push(
      `Response shape: ${run.response_shape === null ? "no answer was read" : `top-level keys ${run.response_shape.top.join(", ")}; answer keys ${run.response_shape.answer.join(", ")}`}.`,
      "",
    );
    out.push(
      `At the starting thresholds (T_REPAIR ${cal.starting.T_REPAIR}, T_CONFIRM ${cal.starting.T_CONFIRM}):`,
      "",
      confusionTable(run.confusion_starting),
      "",
    );
    if (run.rr7.thresholds !== null && run.confusion_proposed !== null) {
      out.push(
        `At the best thresholds for RR7 (T_REPAIR ${run.rr7.thresholds.T_REPAIR}, T_CONFIRM ${run.rr7.thresholds.T_CONFIRM}):`,
        "",
        confusionTable(run.confusion_proposed),
        "",
      );
    }
    out.push(
      `RR7: ${run.rr7.pass ? "passes" : "fails"}. Dependent cases judged holds: ${run.rr7.dependent_holds.length}. ` +
        `Independent cases judged holds: ${run.rr7.independent_holds} of ${run.rr7.independent_total}. p95 ${run.rr7.p95_ms ?? "-"} ms.` +
        (run.rr7.reasons.length === 0 ? "" : ` ${run.rr7.reasons.join("; ")}.`),
      "",
    );
    out.push(
      table(
        ["case", "row", "truth", "p", "ms"],
        run.answers.map((a) => [a.id, a.row, a.label, a.p === null ? `null (${a.error ?? "?"})` : a.p, a.ms]),
      ),
      "",
    );
  }
  for (const [name, p] of Object.entries(cal.probes)) {
    if (p === undefined) continue;
    out.push(`## Probes, ${name}`, "");
    out.push(
      table(
        ["questions in one request", "answered", "ms", "error"],
        p.questions.map((q) => [q.questions, q.answered, q.ms, q.error ?? ""]),
      ),
      "",
    );
    out.push(
      table(
        ["state characters", "input tokens", "truncated", "ms", "error"],
        p.tokens.map((t) => [t.state_chars, t.input_tokens ?? "-", t.truncated ? "yes" : "no", t.ms, t.error ?? ""]),
      ),
      "",
    );
  }
  out.push("## Proposed values", "");
  const p = cal.proposed;
  out.push(
    table(
      ["name", "now", "proposed"],
      [
        ["`features.clef`", "false", String(p.features_clef)],
        ["`CLEF_TRIAGE` (wrangler.jsonc)", "off", p.CLEF_TRIAGE],
        ["`CLEF_RISK`, `CLEF_CONTRADICTION`", "off", "off"],
        ["`CLEF_TRIAGE_MODEL_ID`", CLEF_TRIAGE_MODEL_ID, p.CLEF_TRIAGE_MODEL_ID],
        ["`T_REPAIR`", cal.starting.T_REPAIR, p.T_REPAIR],
        ["`T_CONFIRM`", cal.starting.T_CONFIRM, p.T_CONFIRM],
        ["`CLEF_MAX_QUESTIONS`", cal.starting.CLEF_MAX_QUESTIONS, p.CLEF_MAX_QUESTIONS],
        ["`CLEF_INPUT_TOKEN_LIMIT`", cal.starting.CLEF_INPUT_TOKEN_LIMIT, p.CLEF_INPUT_TOKEN_LIMIT],
      ],
    ),
    "",
    ...p.notes.map((n) => `- ${n}`),
    "",
  );
  out.push(
    `Spend: ${cal.spend.calls} model calls, ${cal.spend.input_tokens} input tokens, $${cal.spend.usd} at the model plan's prices.`,
    "",
  );
  if (cal.errors.length > 0) out.push("## Errors (redacted)", "", ...cal.errors.map((e) => `- ${e}`), "");
  return out.join("\n");
}

export type Io = {
  /** A model client to use instead of Workers AI over REST (tests). */
  ai?: AiBinding;
  /** The `fetch` under the REST client (tests). */
  fetchImpl?: FetchLike;
  log: (line: string) => void;
  writeFile: (path: string, text: string) => void;
  mkdir: (path: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The local date, YYYY-MM-DD, that names the output files. */
  date: () => string;
  casesFile?: string;
};

export function defaultIo(): Io {
  return {
    log: (line) => console.log(line),
    writeFile: (path, text) => writeFileSync(path, text),
    mkdir: (path) => mkdirSync(path, { recursive: true }),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    date: () => {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    },
  };
}

type Args = { models: ModelName[]; maxUsd: number; out: string; probes: boolean };

export function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = {
    models: MODELS.map((m) => m.name),
    maxUsd: 1,
    out: join(ROOT, "docs", "measurements", "calibration"),
    probes: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--no-probes") args.probes = false;
    else if (flag === "--models" && value !== undefined) {
      const names = value.split(",");
      const bad = names.filter((n) => !MODELS.some((m) => m.name === n));
      if (bad.length > 0)
        return `unknown model ${bad.join(", ")}; the models are ${MODELS.map((m) => m.name).join(", ")}`;
      args.models = names as ModelName[];
      i += 1;
    } else if (flag === "--max-usd" && value !== undefined) {
      args.maxUsd = Number(value);
      if (!(args.maxUsd > 0)) return "--max-usd must be a positive number";
      i += 1;
    } else if (flag === "--out" && value !== undefined) {
      args.out = value;
      i += 1;
    } else
      return `unknown argument ${flag}; usage: calibrate:clef [--models clef,clef-flash] [--max-usd 1] [--out dir] [--no-probes]`;
  }
  return args;
}

/** The command. Exit codes: 0 written, 1 failed, 2 bad arguments or missing credentials. */
export async function main(argv: readonly string[], env: Record<string, string | undefined>, io: Io): Promise<number> {
  const creds = credentialsFromEnv(env);
  const secrets = creds === null ? [] : [creds.token, creds.accountId];
  const log = (line: string) => io.log(redact(line, secrets));
  const args = parseArgs(argv);
  if (typeof args === "string") {
    log(args);
    return 2;
  }
  const errors: string[] = [];
  let ai = io.ai;
  if (ai === undefined) {
    if (creds === null) {
      log("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required: calibrate:clef calls Workers AI over REST.");
      return 2;
    }
    ai = restBinding(creds, {
      timeoutMs: CALL_TIMEOUT_MS,
      ...(io.fetchImpl !== undefined ? { fetchImpl: io.fetchImpl } : {}),
      onError: (detail) => errors.push(redact(detail, secrets)),
    });
  }
  const cases = loadCases(io.casesFile ?? CASES_FILE);
  log(`calibrate:clef: ${cases.length} cases, models ${args.models.join(", ")}, at most $${args.maxUsd}`);
  const gate = new LedgerGate(args.maxUsd);
  const cal = await calibrate({ ai, gate, now: io.now, sleep: io.sleep, log }, cases, {
    models: args.models,
    probes: args.probes,
    recordedAt: new Date(io.now()).toISOString(),
    errors,
  });
  const base = join(args.out, `${io.date()}-clef`);
  io.mkdir(args.out);
  io.writeFile(`${base}.json`, redact(JSON.stringify(cal, null, 2), secrets) + "\n");
  io.writeFile(`${base}.md`, redact(renderMarkdown(cal), secrets));
  log(
    `verdict: ${cal.verdict.decision}${cal.verdict.model === null ? "" : ` (${cal.verdict.model})`}: ${cal.verdict.why}`,
  );
  log(`spend: ${cal.spend.calls} calls, $${cal.spend.usd}; wrote ${base}.json and ${base}.md`);
  return 0;
}
