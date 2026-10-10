// Outside agents over MCP (docs/spec/07-mcp.md) in local workerd: the real Worker, Trunk, Floor,
// gate and Agent objects, a local git remote for landings, and the Swarm for a scripted landing
// that breaks the outside attempt's premise. The test is the MCP client: JSON-RPC over POST, the
// way an outside agent speaks Streamable HTTP. Expected values come from 07-mcp, 05-agent and
// 01-core, never from the route's own output (BP1).

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../support/source.ts";
import { startLandingWorker, type LandingWorker } from "../landing/harness.ts";
import { bearer, createPool, eventsOf, KEY, launch, waitFor } from "../collide/helpers.ts";
import { McpClient, mintToken } from "./client.ts";

const SPEC = readFileSync(join(REPO_ROOT, "docs/spec/07-mcp.md"), "utf8");
const AGENT_SPEC = readFileSync(join(REPO_ROOT, "docs/spec/05-agent.md"), "utf8");

/** The fenced block after `<!-- block: <name> -->` (07-mcp and 05-agent "Blocks"). */
function block(spec: string, name: string): string {
  const marker = `<!-- block: ${name} -->`;
  const after = spec.slice(spec.indexOf(marker) + marker.length);
  const open = after.indexOf("```");
  const start = after.indexOf("\n", open) + 1;
  return after.slice(start, after.indexOf("```", start)).replace(/\n$/, "");
}

const TEXTS = JSON.parse(block(SPEC, "mcp-texts")) as Record<string, string> & {
  status_next: Record<string, string>;
};

/** MC6 written out by hand: `pmcp1_<base64url body>.<hmac hex>` over `premise_mcp_token.v1.<body>`. */
function handToken(pool: string, expiresS: number): string {
  const body = Buffer.from(JSON.stringify({ p: pool, e: expiresS, n: "0".repeat(32) })).toString("base64url");
  const sig = createHmac("sha256", KEY).update(`premise_mcp_token.v1.${body}`).digest("hex");
  return `pmcp1_${body}.${sig}`;
}

const JELLY = [
  'import { SURFACE_Y, FLOOR_Y } from "../world/bounds.js";',
  "",
  "export function spawn() {",
  "  return { vy: -0.4 };",
  "}",
  "",
  "export function update(jellyfish) {",
  "  if (jellyfish.y < SURFACE_Y + 40) jellyfish.vy = 0.4;",
  "  if (jellyfish.y > FLOOR_Y - 60) jellyfish.vy = -0.4;",
  "  jellyfish.y += jellyfish.vy;",
  "}",
  "",
  "export function draw(jellyfish, pen) {",
  '  pen.fill("purple");',
  "  pen.ellipse(0, 0, 16, 10);",
  "}",
  "",
].join("\n");

/** A creature that relies on ENERGY_MAX in points: the rescale to a fraction breaks it (E2). */
const CRAB = [
  'import { ENERGY_MAX } from "../world/energy.js";',
  'import { FLOOR_Y } from "../world/bounds.js";',
  "",
  "export function spawn() {",
  "  return { y: FLOOR_Y - 10, vx: 1, energy: ENERGY_MAX, hiding: false };",
  "}",
  "",
  "export function update(crab) {",
  "  crab.hiding = crab.energy < 30;",
  "  crab.x += crab.hiding ? 0 : crab.vx;",
  "}",
  "",
  "export function draw(crab, pen) {",
  '  pen.fill("orange");',
  "  pen.ellipse(0, 0, 12, 8);",
  "}",
  "",
].join("\n");

const POOLS = ["mcp-flow", "mcp-heads", "mcp-other", "mcp-quiet", "mcp-turn", "mcp-kill"];

describe("outside agents over MCP (07-mcp), in local workerd", () => {
  let worker: LandingWorker;
  const output: string[] = [];
  const restore: Array<() => void> = [];

  beforeAll(async () => {
    // MC8: every line the Worker and its objects log reaches this process's stdout or stderr.
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        output.push(String(chunk));
        return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write;
      restore.push(() => {
        stream.write = write;
      });
    }
    worker = await startLandingWorker({ ownerKey: KEY, repos: POOLS, swarm: true, features: { mcp: true } });
    for (const pool of POOLS) await createPool(worker, pool);
  }, 300_000);

  afterAll(async () => {
    for (const undo of restore) undo();
    await worker?.dispose();
  });

  it("MC5, MC6, MC7: a minted token reaches its own pool only; no token, a wrong pool, an expired one and the owner key answer 401", async () => {
    const token = await mintToken(worker, "mcp-flow");
    expect(token).toMatch(/^pmcp1_[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    const body = JSON.parse(Buffer.from(token.slice(6).split(".")[0]!, "base64url").toString()) as Record<
      string,
      unknown
    >;
    expect(body.p).toBe("mcp-flow");
    // MCP_TOKEN_TTL_S is four hours (Appendix A).
    expect(Number(body.e) * 1000 - Date.now()).toBeGreaterThan(14_400_000 - 60_000);

    const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };
    const ok = await new McpClient(worker, "mcp-flow", token).post(initialize);
    expect(ok.status).toBe(200);
    for (const [label, pool, credential] of [
      ["no token", "mcp-flow", ""],
      ["a wrong pool", "mcp-other", token],
      ["an expired token", "mcp-flow", handToken("mcp-flow", Math.floor(Date.now() / 1000) - 1)],
      ["the owner key", "mcp-flow", KEY],
      ["a forged signature", "mcp-flow", `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`],
    ] as const) {
      const res = await worker.fetch(`/mcp/${pool}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(credential === "" ? {} : { authorization: `Bearer ${credential}` }),
        },
        body: JSON.stringify(initialize),
      });
      expect(res.status, label).toBe(401);
      expect(res.headers.get("www-authenticate"), label).toBe("Bearer");
      expect(((await res.json()) as { error: { code: number } }).error.code, label).toBe(-32001);
    }
    // A token signed by hand for an unexpired time is accepted: the format is MC6's.
    const hand = await new McpClient(
      worker,
      "mcp-flow",
      handToken("mcp-flow", Math.floor(Date.now() / 1000) + 60),
    ).post(initialize);
    expect(hand.status).toBe(200);
    // MC5: the token route is the owner's, and it knows only pools that exist.
    const anon = await worker.fetch("/api/pools/mcp-flow/mcp-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(anon.status).toBe(401);
    expect((await worker.fetch("/api/pools/no-such-pool/mcp-tokens", bearer({}))).status).toBe(404);
    expect((await worker.fetch("/api/pools/Bad_Name/mcp-tokens", bearer({}))).status).toBe(400);
  });

  it("MC1, MC2, MC3, MC9, MC10, MC13: initialize and tools/list answer as the specification says", async () => {
    const client = new McpClient(worker, "mcp-flow", await mintToken(worker, "mcp-flow"));
    const init = await client.initialize("Claude Code / test", "2025-11-25");
    const result = init.body?.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2025-11-25");
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(result.serverInfo).toEqual({ name: "premise", version: "07-mcp/1" });
    expect(result.instructions).toBe(block(SPEC, "mcp-instructions"));
    expect(client.session).toMatch(/^ms1_[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    // MC9: the client name keeps A-Z a-z 0-9 . _ - and replaces the rest by "-".
    const session = JSON.parse(Buffer.from(client.session!.slice(4).split(".")[0]!, "base64url").toString()) as {
      c: string;
    };
    expect(session.c).toBe("Claude-Code---test");
    // MC3: an unknown revision is answered with 2025-06-18.
    const other = new McpClient(worker, "mcp-flow", await mintToken(worker, "mcp-flow"));
    expect(((await other.initialize("x", "1999-01-01")).body?.result as Record<string, unknown>).protocolVersion).toBe(
      "2025-06-18",
    );

    // MC13: two Premise tools, then the seven of 05-agent 3.1, unchanged.
    const list = await client.rpc("tools/list");
    const tools = (list.body?.result as { tools: Array<Record<string, unknown>> }).tools;
    const seven = (
      JSON.parse(block(AGENT_SPEC, "tool-definitions")) as Array<{
        function: { name: string; description: string; parameters: unknown };
      }>
    ).map(({ function: f }) => ({ name: f.name, description: f.description, inputSchema: f.parameters }));
    expect(tools).toEqual([...(JSON.parse(block(SPEC, "mcp-tools")) as unknown[]), ...seven]);
    expect(tools.map((t) => t.name)).toEqual([
      "premise_start",
      "premise_status",
      "outline",
      "read",
      "list",
      "search",
      "write",
      "replace",
      "submit",
    ]);

    // MC2 and MC10.
    expect((await client.rpc("ping")).body?.result).toEqual({});
    expect((await client.post("{not json")).status).toBe(400);
    expect(((await client.post("{not json")).body?.error as { code: number }).code).toBe(-32700);
    expect(
      ((await client.post([{ jsonrpc: "2.0", id: 9, method: "ping" }])).body?.error as { code: number }).code,
    ).toBe(-32600);
    expect((await client.post({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} })).status).toBe(202);
    expect(((await client.rpc("resources/list")).body?.error as { code: number }).code).toBe(-32601);
    const unknownTool = await client.rpc("tools/call", { name: "sync", arguments: {} });
    expect((unknownTool.body?.error as { code: number }).code).toBe(-32602);
    const forged = await client.post(
      { jsonrpc: "2.0", id: 51, method: "ping" },
      { "mcp-session-id": `${client.session!.slice(0, -1)}${client.session!.endsWith("0") ? "1" : "0"}` },
    );
    expect(forged.status).toBe(404);
    // A session belongs to the token it was made with (MC10).
    const stranger = new McpClient(worker, "mcp-flow", await mintToken(worker, "mcp-flow"));
    stranger.session = client.session;
    expect((await stranger.rpc("ping")).status).toBe(404);
    const bare = new McpClient(worker, "mcp-flow", await mintToken(worker, "mcp-flow"));
    expect((await bare.rpc("ping")).status).toBe(400);
    // MC1: no event stream, no session to delete.
    for (const method of ["GET", "DELETE"]) {
      const res = await worker.fetch("/mcp/mcp-flow", { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe("POST");
    }
  });

  it("MC11, MC12, MC14, MC15, MC16, MC19, MC20, MC25: a scripted client opens an attempt, reads by entity, writes, submits and lands", async () => {
    const pool = "mcp-flow";
    const client = new McpClient(worker, pool, await mintToken(worker, pool));
    await client.initialize("scripted-client");

    // MC15: the seven tools before premise_start answer not_started.
    const early = await client.call("read", { path: "GUIDE.md" });
    expect(early.isError).toBe(true);
    expect(early.message).toEqual({ error: { code: "not_started", message: TEXTS.not_started } });

    const bad = await client.call("premise_start", { request: "" });
    expect(bad.isError).toBe(true);
    expect((bad.message.error as { code: string }).code).toBe("bad_request");

    const start = await client.call("premise_start", { request: "a jellyfish that drifts up and down" });
    expect(start.isError).toBe(false);
    const started = start.message.result as Record<string, unknown>;
    expect(started).toMatchObject({
      state: "opened",
      guide: "GUIDE.md",
      next: TEXTS.start_next.replaceAll("{GUIDE_PATH}", "GUIDE.md"),
    });
    const attempt = started.attempt_id as string;
    expect(attempt).toMatch(/^a_[0-9A-HJKMNP-TV-Z]{26}$/);

    // MC11: a second premise_start of the session reaches the same attempt and opens nothing.
    const again = await client.call("premise_start", { request: "something else" });
    expect((again.message.result as Record<string, unknown>).attempt_id).toBe(attempt);
    expect((again.message.result as Record<string, unknown>).next).toBe(TEXTS.already);

    // MC12: the attempt is real, its model is mcp/<client name>, the owner asked.
    const opened = (await eventsOf(worker, pool, "attempt.opened")).filter((e) => e.attempt_id === attempt);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ agent: "real", model: "mcp/scripted-client", race: false });
    expect((await eventsOf(worker, pool, "intent.created")).some((e) => e.requester === "owner")).toBe(true);

    // MC20: the attempt holds a slot of the gate while it works.
    const slots = async (): Promise<Record<string, unknown>> =>
      (
        (await (await worker.object("GATE", "premise").fetch("/internal/state")).json()) as {
          state: { slots: Record<string, unknown> };
        }
      ).state.slots;
    expect(Object.keys(await slots())).toContain(attempt);

    // TD5 through MC15: a write before the guide is refused guide_first, with 05-agent's sentence.
    const early_write = await client.call("write", { path: "creatures/mcp-jelly.js", content: JELLY });
    expect(early_write.isError).toBe(true);
    expect((early_write.message.error as { code: string }).code).toBe("guide_first");

    const guide = await client.call("read", { path: "GUIDE.md" });
    expect(guide.isError).toBe(false);
    expect((guide.message.result as { content: string }).content).toContain("# Tide pool guide");

    // A read by entity records an entity premise (TA6, TA7).
    const surface = await client.call("read", { path: "world/bounds.js", entity: "SURFACE_Y" });
    expect((surface.message.result as { key: string }).key).toBe("world/bounds.js#SURFACE_Y");
    await client.call("read", { path: "./world/bounds.js#FLOOR_Y" }); // TD3: N1 and N3 apply
    await waitFor(async () => {
      const keys = (await eventsOf(worker, pool, "premise.recorded"))
        .filter((e) => e.attempt_id === attempt)
        .map(
          (e) =>
            `${String((e.premise as { kind?: string } | undefined)?.kind ?? e.kind)}:${String((e.premise as { key?: string } | undefined)?.key ?? e.key)}`,
        );
      return keys.includes("entity:world/bounds.js#SURFACE_Y") && keys.includes("entity:world/bounds.js#FLOOR_Y");
    }, 30_000);

    const write = await client.call("write", { path: "creatures/mcp-jelly.js", content: JELLY });
    expect(write.isError, JSON.stringify(write.message)).toBe(false);
    expect((write.message.result as { created: boolean }).created).toBe(true);

    const submit = await client.call("submit", { summary: "Add a jellyfish that drifts up and down" });
    expect(submit.isError, JSON.stringify(submit.message)).toBe(false);
    const status = (submit.message.result as { status: string }).status;
    expect(["validated", "submitted", "accepted", "landed"]).toContain(status);

    // MC19 and MC25: premise_status with wait until the change landed.
    let last: Record<string, unknown> = {};
    await waitFor(async () => {
      last = (await client.call("premise_status", { wait: true })).message.result as Record<string, unknown>;
      return last.state === "landed";
    }, 90_000);
    expect(last.next).toBe(TEXTS.status_next.landed);
    const landed = (await eventsOf(worker, pool, "landing.landed")).filter((e) => JSON.stringify(e).includes(attempt));
    expect(landed.length).toBeGreaterThanOrEqual(1);
    // MC20: a landed attempt holds no slot.
    await waitFor(async () => !Object.keys(await slots()).includes(attempt), 30_000);

    // Every tool call the Agent sent to Trunk is an attempt.step on the stream (TL14).
    const steps = (await eventsOf(worker, pool, "attempt.step")).filter((e) => e.attempt_id === attempt);
    expect(steps.map((e) => e.tool)).toEqual(["read", "read", "read", "write", "submit"]);

    // MC23: after the end, a call answers attempt_closed with 05-agent's sentence.
    const late = await client.call("read", { path: "GUIDE.md" });
    expect(late.isError).toBe(true);
    expect((late.message.error as { code: string }).code).toBe("attempt_closed");
  }, 240_000);
});
