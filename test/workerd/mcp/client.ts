// A scripted MCP client for the workerd tests of docs/spec/07-mcp.md: JSON-RPC 2.0 over POST to
// `/mcp/{pool}`, the way Claude Code or Codex speak Streamable HTTP, with the token as
// `Authorization: Bearer` and the session id it was given on `initialize`.

import { expect } from "vitest";
import type { LandingWorker } from "../landing/harness.ts";
import { KEY } from "../collide/helpers.ts";

export type RpcAnswer = { status: number; headers: Headers; body: Record<string, unknown> | null };

/** A tool result's parts (MC16): its text items, the JSON of the first, and `isError`. */
export type ToolAnswer = { isError: boolean; texts: string[]; message: Record<string, unknown> };

/** `POST /api/pools/{pool}/mcp-tokens` with the owner key (MC5). */
export async function mintToken(worker: LandingWorker, pool: string): Promise<string> {
  const res = await worker.fetch(`/api/pools/${pool}/mcp-tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: "{}",
  });
  expect(res.status, `mint for ${pool}: ${await res.clone().text()}`).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

export class McpClient {
  readonly #worker: LandingWorker;
  readonly #pool: string;
  readonly #token: string;
  #next = 1;
  session: string | null = null;

  constructor(worker: LandingWorker, pool: string, token: string) {
    this.#worker = worker;
    this.#pool = pool;
    this.#token = token;
  }

  /** One JSON-RPC message, as is. */
  async post(body: unknown, headers: Record<string, string> = {}): Promise<RpcAnswer> {
    const res = await this.#worker.fetch(`/mcp/${this.#pool}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${this.#token}`,
        ...(this.session === null ? {} : { "mcp-session-id": this.session }),
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      body: text === "" ? null : (JSON.parse(text) as Record<string, unknown>),
    };
  }

  /** A request with the next id. */
  rpc(method: string, params: Record<string, unknown> = {}): Promise<RpcAnswer> {
    return this.post({ jsonrpc: "2.0", id: this.#next++, method, params });
  }

  /** `initialize`, then the `initialized` notification, as a client does. */
  async initialize(name = "test-client", protocolVersion = "2025-06-18"): Promise<RpcAnswer> {
    const answer = await this.rpc("initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name, version: "1.0.0" },
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    this.session = answer.headers.get("mcp-session-id");
    expect(this.session).not.toBeNull();
    const note = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
    return answer;
  }

  /** `tools/call` of `name`: the result's parts (MC16). */
  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
    const answer = await this.rpc("tools/call", { name, arguments: args });
    expect(answer.status, `${name}: ${JSON.stringify(answer.body)}`).toBe(200);
    const result = answer.body?.result as { content: Array<{ type: string; text: string }>; isError: boolean };
    expect(result, `${name}: ${JSON.stringify(answer.body)}`).toBeDefined();
    const texts = result.content.map((item) => item.text);
    const last = texts[texts.length - 1] ?? "{}";
    return { isError: result.isError, texts, message: JSON.parse(last) as Record<string, unknown> };
  }
}
