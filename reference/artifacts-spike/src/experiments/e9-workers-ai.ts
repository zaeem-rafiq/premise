/** e9-workers-ai: a small tool-calling loop on Workers AI models: latency, turns and correctness. */
import {
  errText,
  intParam,
  summarize,
} from "../recorder";
import {
  type Experiment,
} from "./common";

const E9_DEFAULT_MODELS = ["@cf/openai/gpt-oss-120b", "@cf/zai-org/glm-5.3-flash"];
/** Most models one request may name. Each model costs up to max_turns (at most 20) Workers AI calls. */
export const E9_MAX_MODELS = 6;
const E9_MAX_MODEL_ID_LENGTH = 200;

const E9_FILES: Record<string, string> = {
  "config.ts": "export const TIMEOUT_MS = 5000;\nexport const RETRIES = 3;\n",
  "client.ts":
    'import { RETRIES } from "./config";\n\nexport function connect(host: string, timeoutMs: number): string {\n  return `${host}:${timeoutMs}:${RETRIES}`;\n}\n\nexport function open(host: string): string {\n  return connect(host, 5000);\n}\n',
};

const E9_EXPECTED: Record<string, string> = {
  "config.ts": E9_FILES["config.ts"]!.replace("TIMEOUT_MS = 5000", "TIMEOUT_MS = 8000"),
  "client.ts": E9_FILES["client.ts"]!.replace("connect(host, 5000)", "connect(host, 8000)"),
};

const E9_SYSTEM = "You are a careful coding agent. You can only see and change files through the provided tools.";

const E9_TASK = [
  "The project has two files: config.ts and client.ts.",
  "1. In config.ts, change the value of the constant TIMEOUT_MS from 5000 to 8000.",
  "2. In client.ts, the function open() calls connect(host, 5000). Update that one call site so that it passes 8000.",
  "Change nothing else. Read a file with read_file before you edit it, and edit with replace_in_file.",
  "When both edits are done, reply with the single word DONE and make no more tool calls.",
].join("\n");

// OpenAI Chat Completions tool format. Both default models take ChatCompletionsInput
// in the generated Workers types (workerd 1.20261001.1).
const E9_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Return the full text of one file.",
      parameters: { type: "object", properties: { path: { type: "string", description: "File name, for example config.ts" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "replace_in_file",
      description: "Replace one exact occurrence of old_string with new_string in a file. Fails when old_string is missing or occurs more than once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File name" },
          old_string: { type: "string", description: "Exact text to replace" },
          new_string: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
];

function runE9Tool(files: Record<string, string>, name: string, argsText: string): string {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = typeof argsText === "string" ? JSON.parse(argsText || "{}") : argsText;
    if (parsed === null || typeof parsed !== "object") return "ERROR: tool arguments must be a JSON object";
    args = parsed as Record<string, unknown>;
  } catch {
    return "ERROR: tool arguments were not valid JSON";
  }
  const path = typeof args.path === "string" ? args.path.replace(/^\.?\//, "") : "";
  const current = files[path];
  if (current === undefined) return `ERROR: no such file "${String(args.path)}". Files: ${Object.keys(files).join(", ")}`;
  if (name === "read_file") return current;
  if (name === "replace_in_file") {
    const oldString = args.old_string;
    const newString = args.new_string;
    if (typeof oldString !== "string" || typeof newString !== "string" || oldString.length === 0) return "ERROR: old_string and new_string must be strings, and old_string must not be empty";
    const count = current.split(oldString).length - 1;
    if (count === 0) return "ERROR: old_string was not found in the file";
    if (count > 1) return `ERROR: old_string occurs ${count} times; give a longer, unique string`;
    files[path] = current.replace(oldString, () => newString);
    return `OK: replaced 1 occurrence in ${path}`;
  }
  return `ERROR: unknown tool "${name}"`;
}

interface ParsedAiOutput {
  shape: string;
  content: string | null;
  toolCalls: { id: string; name: string; argsText: string }[];
  finishReason: string | null;
  usage: unknown;
}

function parseAiOutput(out: unknown, turn: number): ParsedAiOutput {
  const stringify = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value ?? {}));
  if (typeof out === "string") return { shape: "string", content: out, toolCalls: [], finishReason: null, usage: null };
  if (out === null || typeof out !== "object") return { shape: `unexpected ${typeof out}`, content: null, toolCalls: [], finishReason: null, usage: null };
  const obj = out as Record<string, unknown>;
  const usage = obj.usage ?? null;
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const choice = obj.choices[0] as Record<string, unknown>;
    const message = (choice.message ?? {}) as Record<string, unknown>;
    const calls = Array.isArray(message.tool_calls) ? (message.tool_calls as Record<string, unknown>[]) : [];
    return {
      shape: "chat.completions (choices[0].message)",
      content: typeof message.content === "string" ? message.content : null,
      toolCalls: calls.map((c, i) => {
        const fn = (c.function ?? {}) as Record<string, unknown>;
        return { id: typeof c.id === "string" ? c.id : `call_${turn}_${i}`, name: String(fn.name ?? c.name ?? ""), argsText: stringify(fn.arguments ?? c.arguments) };
      }),
      finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
      usage,
    };
  }
  if ("response" in obj || Array.isArray(obj.tool_calls)) {
    const calls = Array.isArray(obj.tool_calls) ? (obj.tool_calls as Record<string, unknown>[]) : [];
    return {
      shape: "legacy ({response, tool_calls})",
      content: typeof obj.response === "string" ? obj.response : null,
      toolCalls: calls.map((c, i) => {
        const fn = (c.function ?? {}) as Record<string, unknown>;
        return { id: typeof c.id === "string" ? c.id : `call_${turn}_${i}`, name: String(c.name ?? fn.name ?? ""), argsText: stringify(c.arguments ?? fn.arguments) };
      }),
      finishReason: null,
      usage,
    };
  }
  return { shape: `unrecognised (keys: ${Object.keys(obj).join(", ")})`, content: null, toolCalls: [], finishReason: null, usage };
}

export const e9: Experiment = async (deps, body, rec) => {
  const validList = Array.isArray(body.models) && body.models.length > 0 && body.models.every((m) => typeof m === "string" && m.length > 0 && m.length <= E9_MAX_MODEL_ID_LENGTH);
  const requested = validList ? [...new Set(body.models as string[])] : E9_DEFAULT_MODELS;
  const models = requested.slice(0, E9_MAX_MODELS);
  if (body.models !== undefined && !validList) rec.note(`"models" must be a non-empty list of model ids (strings of at most ${E9_MAX_MODEL_ID_LENGTH} characters); using the default models`);
  if (requested.length > models.length) rec.note(`"models" named ${requested.length} distinct models; only the first ${E9_MAX_MODELS} are run`);
  const maxTurns = intParam(body.max_turns, 8, 1, 20);
  const maxTokens = intParam(body.max_tokens, 2048, 64, 16_384);
  const reasoningEffort = body.reasoning_effort === null ? null : typeof body.reasoning_effort === "string" ? body.reasoning_effort : "low";
  rec.note(`request shape: env.AI.run(model, { messages, tools: [{type:"function", function:{name, description, parameters}}], max_tokens: ${maxTokens}${reasoningEffort ? `, reasoning_effort: "${reasoningEffort}"` : ""} }); max ${maxTurns} turns`);

  const results: Record<string, unknown>[] = [];
  const verdict: Record<string, unknown> = {};
  let allCorrect = true;
  for (const model of models) {
    const files = { ...E9_FILES };
    const messages: Record<string, unknown>[] = [
      { role: "system", content: E9_SYSTEM },
      { role: "user", content: E9_TASK },
    ];
    const calls: Record<string, unknown>[] = [];
    const latencies: number[] = [];
    let error: string | undefined;
    let finalText: string | null = null;
    let finished = false;
    let toolErrors = 0;
    const started = Date.now();
    for (let turn = 1; turn <= maxTurns && !finished; turn++) {
      rec.checkpoint();
      const input: Record<string, unknown> = { messages, tools: E9_TOOLS, max_tokens: maxTokens };
      if (reasoningEffort) input.reasoning_effort = reasoningEffort;
      const callStarted = Date.now();
      let out: unknown;
      try {
        out = await deps.ai.run(model, input);
      } catch (e) {
        rec.checkpoint();
        error = `AI.run threw on turn ${turn}: ${errText(e)}`;
        calls.push({ turn, ms: Date.now() - callStarted, error });
        break;
      }
      const ms = Date.now() - callStarted;
      latencies.push(ms);
      const parsed = parseAiOutput(out, turn);
      calls.push({ turn, ms, shape: parsed.shape, finish_reason: parsed.finishReason, tool_calls: parsed.toolCalls.map((c) => c.name), usage: parsed.usage });
      if (parsed.toolCalls.length === 0) {
        finalText = parsed.content;
        finished = true;
        if (parsed.shape.startsWith("unrecognised") || parsed.shape.startsWith("unexpected")) error = `could not interpret the model output: ${parsed.shape}`;
        break;
      }
      messages.push({
        role: "assistant",
        // Workers AI rejects a null content on an assistant tool-call message (AiError 5006).
        content: parsed.content ?? "",
        tool_calls: parsed.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.argsText } })),
      });
      for (const call of parsed.toolCalls) {
        const result = runE9Tool(files, call.name, call.argsText);
        if (result.startsWith("ERROR")) toolErrors++;
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
    const totalMs = Date.now() - started;
    const filesMatch = Object.fromEntries(Object.keys(E9_EXPECTED).map((name) => [name, files[name] === E9_EXPECTED[name]]));
    const correct = Object.values(filesMatch).every(Boolean);
    if (!correct || error) allCorrect = false;
    rec.timings[`${model} call_ms`] = latencies;
    results.push({ model, correct, files_match: filesMatch, turns: calls.length, finished_without_hitting_turn_limit: finished, tool_errors: toolErrors, total_ms: totalMs, call_ms: summarize(latencies), calls, final_text: finalText?.slice(0, 200) ?? null, final_files: correct ? undefined : files, error });
    verdict[model] = { correct, turns: calls.length, total_ms: totalMs, call_ms_p50: summarize(latencies)?.p50 ?? null, error: error ?? null };
    rec.note(`${model}: ${correct ? "final files are correct" : "final files are NOT correct"}; ${calls.length} model calls in ${totalMs} ms; per-call ms ${JSON.stringify(summarize(latencies))}; tool errors ${toolErrors}${error ? `; ${error}` : ""}`);
  }
  rec.data.models = results;
  Object.assign(rec.verdict, verdict);
  return allCorrect;
};
