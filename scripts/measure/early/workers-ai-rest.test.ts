// The REST adapter of ME1: the documented endpoint and request shape of the platform spike E9,
// TL12's outcome classes, Retry-After on rate limits, and credentials that never appear in any
// error detail.

import { describe, it, expect } from "vitest";
import { callWorkersAI, endpointOf, REST_BASE } from "./workers-ai-rest.ts";
import type { FetchLike } from "./workers-ai-rest.ts";

const ACCOUNT = "acct_secret_123";
const TOKEN = "token_secret_456";

function fakeFetch(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): {
  calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }>;
  fn: FetchLike;
} {
  const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init: { method: init.method, headers: init.headers, body: init.body } });
    return { status, text: async () => body, headers: { get: (n) => headers[n.toLowerCase()] ?? null } };
  };
  return { calls, fn };
}

const call = (fn: FetchLike) =>
  callWorkersAI({
    accountId: ACCOUNT,
    token: TOKEN,
    model: "@cf/openai/gpt-oss-120b",
    body: { messages: [] },
    fetchImpl: fn,
    timeoutMs: 5000,
  });

describe("the request shape (E9, ME1)", () => {
  it("posts JSON to /client/v4/accounts/{account}/ai/run/{model} with the bearer token", async () => {
    const { calls, fn } = fakeFetch(200, '{"result": {"choices": []}}');
    await call(fn);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(`${REST_BASE}/${encodeURIComponent(ACCOUNT)}/ai/run/@cf/openai/gpt-oss-120b`);
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body)).toEqual({ messages: [] });
  });

  it("endpointOf keeps the model id verbatim (slash stays, E9's @cf/... form)", () => {
    expect(endpointOf("acct", "@cf/openai/gpt-oss-120b")).toBe(`${REST_BASE}/acct/ai/run/@cf/openai/gpt-oss-120b`);
  });

  it("a 200 unwraps `result` for TL3 to parse", async () => {
    const { fn } = fakeFetch(200, '{"success": true, "result": {"choices": [{"message": {"content": ""}}]}}');
    const out = await call(fn);
    expect(out).toEqual({ kind: "answer", result: { choices: [{ message: { content: "" } }] } });
  });

  it("a 200 with unreadable JSON still answers with result null (TL3 decides)", async () => {
    const { fn } = fakeFetch(200, "not json");
    const out = await call(fn);
    expect(out).toEqual({ kind: "answer", result: null });
  });
});

describe("TL12 outcome classes", () => {
  it("HTTP 429 and code 3040 are rate_limited, honoring Retry-After", async () => {
    const { fn } = fakeFetch(429, "rate limited", { "retry-after": "7" });
    expect(await call(fn)).toEqual({ kind: "rate_limited", retry_after_ms: 7000 });
    const body = JSON.stringify({ errors: [{ code: 3040, message: "rate limit" }] });
    const { fn: fn2 } = fakeFetch(400, body);
    expect(await call(fn2)).toEqual({ kind: "rate_limited", retry_after_ms: 1000 });
  });

  it("5xx and codes 3007/3008 are unavailable (retryable)", async () => {
    const { fn } = fakeFetch(503, "upstream");
    expect((await call(fn)).kind).toBe("unavailable");
    const { fn: f2 } = fakeFetch(200, JSON.stringify({ errors: [{ code: 3008 }] }));
    // error code on a 200 body still classifies unavailable
    expect((await call(f2)).kind).toBe("unavailable");
  });

  it("other 4xx are rejected — repeating cannot help", async () => {
    const { fn } = fakeFetch(404, '{"errors":[{"code":1000}]}');
    const out = await call(fn);
    expect(out.kind).toBe("rejected");
    expect((out as { status: number }).status).toBe(404);
  });

  it("a thrown fetch is network; credentials never appear in details", async () => {
    const fn: FetchLike = async () => {
      throw new Error(`connect failed for ${ACCOUNT} with ${TOKEN}`);
    };
    const out = await call(fn);
    expect(out.kind).toBe("network");
    const detail = (out as { detail: string }).detail;
    expect(detail).not.toContain(ACCOUNT);
    expect(detail).not.toContain(TOKEN);
  });

  it("error details are redacted even when the server echoes the token", async () => {
    const { fn } = fakeFetch(400, `bad request: token ${TOKEN} for ${ACCOUNT} is invalid`);
    const out = await call(fn);
    const detail = (out as { detail: string }).detail;
    expect(detail).not.toContain(TOKEN);
    expect(detail).not.toContain(ACCOUNT);
  });
});
