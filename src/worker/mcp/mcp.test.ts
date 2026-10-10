// docs/spec/07-mcp.md, the pure parts: the constants of Appendix A, the three blocks of section 5,
// the tool list of MC13, the token and session formats of MC6 to MC11, and the limits lines the
// switch moves (03-floor 5.12). Expected values are read from the spec files or written by hand
// from the rule text — never taken from the code under test (BP1).

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../test/support/source.ts";
import { FEATURES } from "../../config/features.ts";
import { limitsList } from "../../config/limits.ts";
import { aboutHowBoxes } from "../../copy/strings.ts";
import * as constants from "./constants.ts";
import { clientName, mintSession, mintToken, sessionIds, verifySession, verifyToken } from "./credentials.ts";
import { MCP_INSTRUCTIONS, MCP_TEXTS, MCP_TOOL_LIST, MCP_TOOLS, startNext, statusNext } from "./texts.ts";

const SPEC = readFileSync(`${REPO_ROOT}/docs/spec/07-mcp.md`, "utf8");
const AGENT = readFileSync(`${REPO_ROOT}/docs/spec/05-agent.md`, "utf8");
const KEY = "owner-key-for-unit-tests";

function block(spec: string, name: string): string {
  const marker = `<!-- block: ${name} -->`;
  const at = spec.indexOf(marker);
  if (at < 0) throw new Error(`marker ${marker} not found`);
  const after = spec.slice(at + marker.length);
  const open = after.indexOf("```");
  const start = after.indexOf("\n", open) + 1;
  return after.slice(start, after.indexOf("```", start)).replace(/\n$/, "");
}

/** `pmcp1_<body>.<sig>` as MC6 describes it, built here by hand. */
function handToken(body: object, key = KEY): string {
  const text = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `pmcp1_${text}.${createHmac("sha256", key).update(`premise_mcp_token.v1.${text}`).digest("hex")}`;
}

describe("07-mcp Appendix A and section 5", () => {
  it("MC6, MC9, MC15, MC19, MC21: the constants are the values of Appendix A", () => {
    const table = /## Appendix A\. Constants\n([\s\S]*?)\n\n/.exec(SPEC)?.[1] ?? "";
    const rows = table
      .split("\n")
      .filter((line) => /^\| `/.test(line))
      .map((line) => line.split("|").map((cell) => cell.trim()));
    const spec = Object.fromEntries(rows.map((r) => [r[1]!.replaceAll("`", ""), Number(r[2]!.replaceAll(",", ""))]));
    expect(Object.keys(spec).length).toBe(6);
    expect({ ...constants }).toEqual(spec);
  });

  it("MC9: the instructions are the block mcp-instructions", () => {
    expect(MCP_INSTRUCTIONS).toBe(block(SPEC, "mcp-instructions"));
  });

  it("MC14, MC16, MC19: the Premise tools and the texts are the blocks mcp-tools and mcp-texts", () => {
    expect(MCP_TOOLS).toBe(block(SPEC, "mcp-tools"));
    expect(MCP_TEXTS).toBe(block(SPEC, "mcp-texts"));
  });

  it("MC13: the tool list is the two Premise tools, then the seven of 05-agent 3.1 with schemas unchanged", () => {
    const seven = (
      JSON.parse(block(AGENT, "tool-definitions")) as Array<{
        function: { name: string; description: string; parameters: unknown };
      }>
    ).map(({ function: f }) => ({ name: f.name, description: f.description, inputSchema: f.parameters }));
    expect(MCP_TOOL_LIST).toEqual([...(JSON.parse(block(SPEC, "mcp-tools")) as unknown[]), ...seven]);
  });

  it("MC14, MC25: next names the guide, and a state's next follows MC25's four groups", () => {
    const texts = JSON.parse(block(SPEC, "mcp-texts")) as {
      start_next: string;
      start_next_no_guide: string;
      status_next: Record<string, string>;
    };
    expect(startNext("GUIDE.md")).toBe(
      "Read GUIDE.md first: call read with path GUIDE.md. Then make the change and call submit.",
    );
    expect(startNext(null)).toBe(texts.start_next_no_guide);
    for (const state of ["opened", "working", "going_around", "needs_confirm"]) {
      expect(statusNext(state), state).toBe(texts.status_next.working);
    }
    for (const state of ["submitted", "validated", "held", "accepted"]) {
      expect(statusNext(state), state).toBe(texts.status_next.handed_in);
    }
    expect(statusNext("landed")).toBe(texts.status_next.landed);
    expect(statusNext("stopped")).toBe(texts.status_next.stopped);
  });
});

describe("07-mcp tokens and sessions", () => {
  const now = 1_791_000_000_000;

  it("MC6: a minted token has MC6's form and signature, and expires MCP_TOKEN_TTL_S later", () => {
    const { token, expires_at } = mintToken(KEY, "tidepool", now);
    const match = /^pmcp1_([A-Za-z0-9_-]+)\.([0-9a-f]{64})$/.exec(token);
    expect(match).not.toBeNull();
    const body = JSON.parse(Buffer.from(match![1]!, "base64url").toString()) as { p: string; e: number; n: string };
    expect(body.p).toBe("tidepool");
    expect(body.e).toBe(Math.floor(now / 1000) + 14_400);
    expect(body.n).toMatch(/^[0-9a-f]{32}$/);
    expect(expires_at).toBe(body.e * 1000);
    expect(match![2]).toBe(createHmac("sha256", KEY).update(`premise_mcp_token.v1.${match![1]}`).digest("hex"));
  });

  it("MC7: a token is refused for another pool, after its expiry, with another key, or not as Bearer", () => {
    const e = Math.floor(now / 1000) + 60;
    const token = handToken({ p: "tidepool", e, n: "ab".repeat(16) });
    expect(verifyToken(KEY, `Bearer ${token}`, "tidepool", now)).toEqual({
      pool: "tidepool",
      expires_s: e,
      nonce: "ab".repeat(16),
    });
    expect(verifyToken(KEY, `Bearer ${token}`, "other", now)).toBeNull();
    expect(verifyToken(KEY, `Bearer ${token}`, "tidepool", e * 1000)).toBeNull();
    expect(verifyToken("another-key", `Bearer ${token}`, "tidepool", now)).toBeNull();
    expect(verifyToken(undefined, `Bearer ${token}`, "tidepool", now)).toBeNull();
    expect(verifyToken(KEY, token, "tidepool", now)).toBeNull();
    expect(verifyToken(KEY, null, "tidepool", now)).toBeNull();
    expect(verifyToken(KEY, `Bearer ${KEY}`, "tidepool", now)).toBeNull();
    expect(verifyToken(KEY, `Bearer ${handToken({ p: "tidepool", e, n: "x" }, "wrong")}`, "tidepool", now)).toBeNull();
  });

  it("MC9: the client name keeps A-Z a-z 0-9 . _ - and is at most MCP_CLIENT_NAME_CHARS long", () => {
    expect(clientName("claude-code")).toBe("claude-code");
    expect(clientName("Codex CLI/1.2")).toBe("Codex-CLI-1.2");
    expect(clientName("x".repeat(50))).toBe("x".repeat(40));
    expect(clientName("")).toBe("mcp-client");
    expect(clientName(undefined)).toBe("mcp-client");
  });

  it("MC10: a session verifies only with its own pool and token, and its signature", () => {
    const token = { pool: "tidepool", expires_s: Math.floor(now / 1000) + 60, nonce: "cd".repeat(16) };
    const session = mintSession(KEY, token, "claude-code");
    const match = /^ms1_([A-Za-z0-9_-]+)\.([0-9a-f]{64})$/.exec(session);
    expect(match).not.toBeNull();
    expect(match![2]).toBe(createHmac("sha256", KEY).update(`premise_mcp_session.v1.${match![1]}`).digest("hex"));
    expect(verifySession(KEY, session, token)).toEqual({
      id: session,
      pool: "tidepool",
      token_nonce: token.nonce,
      client: "claude-code",
    });
    expect(verifySession(KEY, session, { ...token, pool: "other" })).toBeNull();
    expect(verifySession(KEY, session, { ...token, nonce: "ef".repeat(16) })).toBeNull();
    expect(verifySession("another-key", session, token)).toBeNull();
    expect(verifySession(KEY, `${session}0`, token)).toBeNull();
  });

  it("MC11: a session's attempt and intent ids are fixed by its id and written as the intents route writes ids", () => {
    const ids = sessionIds("ms1_example.0");
    expect(ids).toEqual(sessionIds("ms1_example.0"));
    expect(ids.attempt_id).toMatch(/^a_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ids.intent_id).toMatch(/^i_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(sessionIds("ms1_other.0").attempt_id).not.toBe(ids.attempt_id);
  });
});

describe("07-mcp on the page's lists (03-floor 5.12)", () => {
  it("MC24: About's box 3 names outside agents only while features.mcp is true", () => {
    const base = { green: "none" as const, clef: false, attempt_repos: false };
    expect(aboutHowBoxes({ ...base, mcp: false })[2]).toBe(
      "Agent (one Durable Object per attempt): the model's tool loop and its whole conversation",
    );
    expect(aboutHowBoxes({ ...base, mcp: true })[2]).toBe(
      "Agent (one Durable Object per attempt): the model's tool loop and its whole conversation, or the calls of an outside agent over MCP",
    );
  });

  it("MC4: the limits list names outside agents as switched off while the switch is off, and states their blind spot while it is on", () => {
    const off = limitsList({ ...FEATURES, mcp: false });
    // Line 9 as 5.12 now gives it: text merge, too, left it for line 15 when it was built (PM3a).
    expect(off).toContain("Not built: Python and Go modules, audience input.");
    expect(off.find((line) => line.startsWith("Switched off in this build:"))).toContain("outside agents over MCP");
    expect(off.some((line) => line.startsWith("An outside agent over MCP"))).toBe(false);
    const on = limitsList({ ...FEATURES, mcp: true });
    expect(on.join("\n")).not.toContain("Switched off in this build: outside agents over MCP");
    expect(on.some((line) => /Switched off in this build:.*outside agents over MCP/.test(line))).toBe(false);
    expect(on[on.length - 1]).toBe(
      "An outside agent over MCP counts as a real agent. Premise sees only its calls of the seven tools: not what it read elsewhere, and not what its own model cost.",
    );
  });
});
