// The production delivery function over real workerd SQLite with a controlled Agent
// transport. The appended probe changes no production logic or file on disk.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { AgentOpenRequest } from "../../../src/protocol/internal.ts";
import { WORKHORSE_MODEL } from "../../../src/config/model-plan.ts";
import { REPO_ROOT } from "../../support/source.ts";

const BUNDLE = join(REPO_ROOT, "dist/worker/index.js");
const ORIGIN = "http://startup-fault.test";
const REQUEST: AgentOpenRequest = {
  attempt_id: "fresh",
  intent_id: "intent",
  change_id: "change",
  pool: "startup-fault",
  intent_text: "add a crab",
  requester: "owner",
  agent_kind: "real",
  driver: "model",
  model: WORKHORSE_MODEL,
};

const PROBE = `
import { DurableObject as StartupFaultBase } from "cloudflare:workers";
export class StartupFaultProbe extends StartupFaultBase {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = request.method === "POST" ? await request.json() : {};
    const sql = this.ctx.storage.sql;
    const get = (key) => sql.exec("SELECT v FROM meta WHERE k = ?", key).toArray()[0]?.v;
    const set = (key, value) => sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", key, String(value));
    if (path === "/setup") {
      const trunk = Trunk.create(sqlOf(this.ctx), {}, { pool_id: "startup-fault" });
      trunk.openAttempt("fresh", { intent_id: "intent", intent: "add a crab", agent_kind: "real", model: ${JSON.stringify(WORKHORSE_MODEL)} });
      sql.exec("CREATE TABLE fault_calls (n INTEGER PRIMARY KEY, request TEXT NOT NULL)");
      set("new_agent_open:fresh", JSON.stringify(${JSON.stringify(REQUEST)}));
      set("fault_mode", body.mode);
      sql.exec("INSERT OR REPLACE INTO timers (kind, key, due_at) VALUES ('resume', 'fresh', ?)", Date.now());
      return Response.json({ ok: true });
    }
    if (path === "/mode") {
      set("fault_mode", body.mode);
      return Response.json({ ok: true });
    }
    if (path === "/step") {
      const agent = {
        idFromName: (name) => name,
        get: () => ({
          fetch: async (url, init) => {
            sql.exec("INSERT INTO fault_calls (request) VALUES (?)", JSON.stringify({ url, body: JSON.parse(init.body) }));
            const mode = get("fault_mode");
            if (mode === "progress_refuse" || mode === "progress_throw") {
              // A tool step reached Trunk while its delivery was waiting for the Agent.
              await Promise.resolve();
              sql.exec("UPDATE attempts SET state = 'working', last_call_id = 'fresh:1' WHERE attempt_id = 'fresh'");
            }
            if (mode === "throw" || mode === "progress_throw") throw new Error("test transport interruption");
            if (mode === "http") return Response.json({ error: "test unavailable" }, { status: 503 });
            if (mode === "refuse" || mode === "progress_refuse") return Response.json({ ok: false, error: "test refusal" });
            return Response.json({ ok: true, attempt_id: "fresh" });
          }
        })
      };
      await deliverResumes({ AGENT: agent }, this.ctx, body.now);
      return Response.json({ ok: true });
    }
    if (path === "/state") {
      return Response.json({
        meta: Object.fromEntries(sql.exec("SELECT k, v FROM meta").toArray().map((row) => [row.k, row.v])),
        attempts: sql.exec("SELECT attempt_id, state, stop_reason, last_call_id FROM attempts").toArray(),
        timers: sql.exec("SELECT kind, key, due_at FROM timers").toArray(),
        cards: sql.exec("SELECT body FROM cards WHERE state = 'open'").toArray().map((row) => JSON.parse(row.body)),
        calls: sql.exec("SELECT request FROM fault_calls ORDER BY n").toArray().map((row) => JSON.parse(row.request)),
        events: sql.exec("SELECT body FROM events_out ORDER BY n").toArray().map((row) => JSON.parse(row.body))
      });
    }
    return new Response("unknown test probe path", { status: 404 });
  }
}
`;

type Stub = { fetch(url: string, init?: RequestInit): Promise<Response> };
type Namespace = { idFromName(name: string): unknown; get(id: unknown): Stub };
type Snapshot = {
  meta: Record<string, string>;
  attempts: Array<{ attempt_id: string; state: string; stop_reason: string | null; last_call_id: string | null }>;
  timers: Array<{ kind: string; key: string; due_at: number }>;
  cards: Array<{ reason: string; options: Array<{ id: string }> }>;
  calls: Array<{ url: string; body: AgentOpenRequest }>;
  events: Array<Record<string, unknown>>;
};

describe("durable fresh-Agent delivery after a reopen failure", () => {
  let worker: Miniflare;
  let namespace: Namespace;

  beforeAll(async () => {
    const original = readFileSync(BUNDLE, "utf8");
    for (const declaration of ["async function deliverResumes(", "var Trunk = class _Trunk", "function sqlOf("]) {
      if (!original.includes(declaration))
        throw new Error(`Missing production symbol for startup fault fixture: ${declaration}`);
    }
    worker = new Miniflare(
      convertV4MiniflareOptions({
        cf: false,
        telemetry: { enabled: false },
        workers: [
          {
            name: "startup-faults",
            modules: [{ type: "ESModule", path: BUNDLE, contents: original + PROBE }],
            compatibilityDate: "2026-10-01",
            compatibilityFlags: ["nodejs_compat"],
            durableObjects: { PROBE: { className: "StartupFaultProbe", useSQLite: true } },
          },
        ],
      }),
    );
    await worker.ready;
    namespace = (await worker.getDurableObjectNamespace("PROBE")) as unknown as Namespace;
  }, 60_000);

  afterAll(async () => {
    await worker?.dispose();
  });

  async function post(stub: Stub, path: string, body: unknown = {}): Promise<void> {
    const response = await stub.fetch(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }

  async function start(name: string, mode: string): Promise<Stub> {
    const stub = namespace.get(namespace.idFromName(name));
    await post(stub, "/setup", { mode });
    return stub;
  }

  async function state(stub: Stub): Promise<Snapshot> {
    const response = await stub.fetch(`${ORIGIN}/state`);
    expect(response.status).toBe(200);
    return (await response.json()) as Snapshot;
  }

  function cycle(snapshot: Snapshot): { deadline: number; next_send: number } {
    return JSON.parse(snapshot.meta["new_agent_cycle:fresh"]!);
  }

  function finished(snapshot: Snapshot): void {
    expect(snapshot.meta["new_agent_open:fresh"]).toBeUndefined();
    expect(snapshot.meta["new_agent_cycle:fresh"]).toBeUndefined();
    expect(snapshot.timers.filter((timer) => timer.kind === "resume")).toEqual([]);
  }

  it.each(["throw", "http"])(
    "retries the identical open after %s, respects the cadence, and clears it after acknowledgment",
    async (mode) => {
      const stub = await start(`retry-${mode}`, mode);
      await post(stub, "/step");
      const first = await state(stub);
      expect(first.calls).toEqual([{ url: "https://agent/open", body: REQUEST }]);
      expect(first.cards).toEqual([]);
      expect(first.timers).toContainEqual({ kind: "resume", key: "fresh", due_at: cycle(first).next_send });
      await post(stub, "/step", { now: cycle(first).next_send - 1 });
      expect((await state(stub)).calls).toHaveLength(1);
      await post(stub, "/step", { now: cycle(first).next_send });
      const second = await state(stub);
      expect(second.calls).toEqual([first.calls[0], first.calls[0]]);
      expect(cycle(second).deadline).toBe(cycle(first).deadline);

      await post(stub, "/mode", { mode: "ack" });
      await post(stub, "/step", { now: cycle(second).next_send });
      const done = await state(stub);
      expect(done.calls).toHaveLength(3);
      expect(done.cards).toEqual([]);
      expect(done.attempts[0]).toMatchObject({ state: "opened", stop_reason: null });
      finished(done);
    },
  );

  it("T20 stops a silent fresh startup as lost at its persisted deadline", async () => {
    const stub = await start("deadline", "throw");
    await post(stub, "/step");
    const first = await state(stub);
    const deadline = cycle(first).deadline;
    await post(stub, "/step", { now: deadline });
    const failed = await state(stub);
    expect(failed.calls).toHaveLength(1);
    expect(failed.attempts[0]).toMatchObject({ state: "stopped", stop_reason: "lost" });
    expect(failed.cards).toEqual([]);
    expect(failed.events).toContainEqual(
      expect.objectContaining({
        type: "attempt.state",
        from: "opened",
        to: "stopped",
        transition: "T20",
        reason: "lost",
      }),
    );
    finished(failed);
    await post(stub, "/step", { now: deadline + 1 });
    expect((await state(stub)).calls).toHaveLength(1);
    expect((await state(stub)).cards).toEqual([]);
  });

  it("T20 records a lost fresh Agent immediately when startup is refused", async () => {
    const stub = await start("refusal", "refuse");
    await post(stub, "/step");
    const failed = await state(stub);
    expect(failed.calls).toHaveLength(1);
    expect(failed.attempts[0]).toMatchObject({ state: "stopped", stop_reason: "lost" });
    expect(failed.cards).toEqual([]);
    expect(failed.events).toContainEqual(
      expect.objectContaining({
        type: "attempt.state",
        from: "opened",
        to: "stopped",
        transition: "T20",
        reason: "lost",
      }),
    );
    finished(failed);
  });

  it.each(["progress_refuse", "progress_throw"])(
    "preserves an Agent that took a step while %s was in flight",
    async (mode) => {
      const stub = await start(mode, mode);
      await post(stub, "/step");
      const first = await state(stub);
      if (mode === "progress_throw") {
        // A lost answer leaves the durable retry. Observing the completed step resolves it.
        await post(stub, "/step", { now: cycle(first).deadline });
      }
      const done = await state(stub);
      expect(done.calls).toHaveLength(1);
      expect(done.attempts[0]).toMatchObject({ state: "working", stop_reason: null, last_call_id: "fresh:1" });
      expect(done.cards).toEqual([]);
      finished(done);
    },
  );
});
