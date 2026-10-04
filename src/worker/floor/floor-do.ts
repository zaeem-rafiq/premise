// The Floor Durable Object: one per pool, it keeps the pool's event stream (01-core 12).
//
//   sources          append events with (source, epoch, source_n) — EV2/EV2a deduplication
//   the page         opens a read-only WebSocket on /api/pools/{pool}/stream (12.2, EV7)
//   the app server   reads the reducer state on /internal/state (FS2) and never calls Trunk (AS16)
//   the owner        exports the stream as a Replay file on /api/pools/{pool}/replay.ndjson (RP1)
//
// Everything a request needs lives in `ctx.storage` or in a WebSocket attachment; nothing per-socket
// is kept in memory, so the object can hibernate and be evicted at any time (EV7).

import { DurableObject } from "cloudflare:workers";
import type { PoolEvent } from "../../protocol/events.ts";
import type { StreamFrame, StreamHello, StreamSource } from "../../protocol/stream.ts";
import type { FloorState } from "../../protocol/reducer/index.ts";
import { computeMetrics, emptyFloorState, reduce } from "../../protocol/reducer/index.ts";
import { redactMatch } from "../../protocol/redact.ts";
import { REPLAY_FORMAT, type ReplayHeader } from "../../protocol/replay.ts";
import { MAX_SOCKETS_PER_ADDR, METRICS_EVERY_MS } from "../../protocol/constants.ts";
import type { Env } from "../env.ts";
import { notBuilt } from "../not-built.ts";
import {
  allEvents,
  eventsAfter,
  landingEvent,
  initSchema,
  loadState,
  maxN,
  recordSource,
  sourceRow,
  insertEvent,
  writeSnapshot,
} from "./store.ts";

const STREAM_SOURCES = new Set<string>(["trunk", "gate", "swarm"]);
const EVICT_CLOSE = { code: 1008, reason: "stream_closed" } as const;

/** The append request a source posts to `/internal/events`. */
type AppendRequest = {
  source: StreamSource;
  epoch: number;
  events: Array<{ source_n: number; event: Omit<PoolEvent, "n" | "t"> }>;
};

/** What the app server reads on `/internal/state` (FS2): everything the routes of 02-tidepool 4.2
 * need from the stream, and nothing they would have asked Trunk for (AS16). */
export type FloorRead = {
  n: number;
  pool: {
    state: FloorState["pool"]["state"];
    head_seq: number;
    head_commit: string | null;
    landed_seq: number;
    landed_commit: string | null; // resolves the moving source `main`
  };
  green: { seq: number | null; commit: string | null }; // resolves `green`
  plain: { commit: string; tree: string; through_seq: number } | null; // resolves `plain`
  /** seq of a landing by its commit, while the state holds it (`<40 hex>` sources, AS11 seq). */
  landings_by_commit: Record<string, number>;
  /** seq of the last confirmed landing that changed each path (AS11's "newest paths"). */
  paths: Record<string, number>;
};

export function floorRead(n: number, state: FloorState): FloorRead {
  const paths: Record<string, number> = {};
  for (const [path, file] of Object.entries(state.files)) {
    if (file.last_landed_seq !== null) paths[path] = file.last_landed_seq;
  }
  const landingsByCommit: Record<string, number> = {};
  for (const entry of Object.values(state.landings)) {
    const commit = entry.digest === true ? entry.commit : entry.landed?.commit;
    if (commit !== null && commit !== undefined) landingsByCommit[commit] = entry.seq;
  }
  return {
    n,
    pool: {
      state: state.pool.state,
      head_seq: state.pool.head_seq,
      head_commit: state.pool.head_commit,
      landed_seq: state.pool.landed_seq,
      landed_commit: state.pool.landed_commit,
    },
    green: { seq: state.green.seq, commit: state.green.commit },
    plain:
      state.plain === null
        ? null
        : { commit: state.plain.commit, tree: state.plain.tree, through_seq: state.plain.through_seq },
    landings_by_commit: landingsByCommit,
    paths,
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function jsonError(code: string, status: number, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: { code, ...extra } }, { status });
}

/** The client address a socket is tagged by (EV7): the per-address limit counts tags. */
function clientAddress(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "local";
}

export class Floor extends DurableObject<Env> {
  /** The reducer state, in memory between eviction and the first request that needs it. */
  private loaded: { n: number; state: FloorState } | null = null;
  /** EV7/AC: a random token per object lifetime; an eviction replaces it (tests detect it). */
  private marker: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initSchema(ctx.storage.sql);
  }

  /** The state at the stream's newest `n`, loaded from storage on first use after a wake. */
  private state(): { n: number; state: FloorState } {
    if (this.loaded === null) {
      this.loaded = loadState(this.ctx.storage.sql);
      this.marker = crypto.randomUUID();
    }
    return this.loaded;
  }

  /** Appends an already-checked event: assigns `n` and `t` (EV1), stores it, reduces it, fans out. */
  private append(event: Omit<PoolEvent, "n" | "t">): PoolEvent {
    const { state } = this.state();
    const appended = { ...event, n: maxN(this.ctx.storage.sql) + 1, t: Date.now() } as PoolEvent;
    this.ctx.storage.transactionSync(() => {
      insertEvent(this.ctx.storage.sql, appended);
      reduce(state, appended);
      this.loaded = { n: appended.n, state };
      writeSnapshot(this.ctx.storage.sql, appended.n, state);
    });
    this.fanout();
    return appended;
  }

  /** EV7: every open socket gets the events above the `after` of its attachment. */
  private fanout(): void {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as { after: number } | null;
      if (attachment === null) continue; // no hello yet — nothing was sent, nothing is owed
      try {
        const events = eventsAfter(this.ctx.storage.sql, attachment.after);
        if (events.length === 0) continue;
        ws.send(JSON.stringify({ events } satisfies StreamFrame));
        ws.serializeAttachment({ after: events[events.length - 1]?.n ?? attachment.after });
      } catch {
        ws.close(EVICT_CLOSE.code, EVICT_CLOSE.reason);
      }
    }
  }

  /** EM5: while at least one socket is open, the Floor appends its own metrics event each tick. */
  override async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) return; // nobody watches: the tick stops
    const { state } = this.state();
    if (state.n === 0) return;
    const now = Date.now();
    this.append({ ts: now, pool: this.poolId(), src: "floor", type: "metrics", ...computeMetrics(state, now) });
    await this.scheduleAlarm();
  }

  private async scheduleAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null) await this.ctx.storage.setAlarm(Date.now() + METRICS_EVERY_MS);
  }

  /** The pool this object serves: its Durable Object name. */
  private poolId(): string {
    return this.ctx.id.name ?? "default";
  }

  // ---- HTTP ----

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/internal/events" && request.method === "POST") return this.appendEvents(request);
    if (path === "/internal/state" && request.method === "GET") {
      const { n, state } = this.state();
      return json(floorRead(n, state));
    }
    if (path === "/internal/marker" && request.method === "GET") {
      this.state(); // loads on the first request after an eviction, which mints a new marker
      return json({ marker: this.marker });
    }
    const stream = /^\/api\/pools\/([^/]+)\/stream$/.exec(path);
    if (stream !== null && request.method === "GET") return this.openSocket(request);

    const note = /^\/api\/pools\/[^/]+\/landings\/(\d+)\/note$/.exec(path);
    if (note !== null && request.method === "GET") return this.landingNote(Number(note[1]));

    if (/^\/api\/pools\/[^/]+\/replay\.ndjson$/.test(path) && request.method === "GET") {
      return this.replayExport(url);
    }

    // A path the Floor of 13.6 does not answer fails closed (the seam sends only its own routes).
    return notBuilt();
  }

  // ---- The source append path (EV2/EV2a) ----

  private async appendEvents(request: Request): Promise<Response> {
    let body: AppendRequest;
    try {
      body = (await request.json()) as AppendRequest;
    } catch {
      return jsonError("bad_json", 400);
    }
    return this.appendEventsBody(body);
  }

  private async appendEventsBody(body: AppendRequest): Promise<Response> {
    const source = typeof body?.source === "string" ? body.source : null;
    if (source === null || (!STREAM_SOURCES.has(source) && !source.startsWith("agent:"))) {
      return jsonError("bad_source", 400);
    }
    const epoch = body.epoch;
    const events = body.events;
    if (!Number.isInteger(epoch) || epoch < 1 || !Array.isArray(events)) {
      return jsonError("bad_append", 400);
    }
    const stored = sourceRow(this.ctx.storage.sql, source);
    // RB5/EV2: a higher epoch is a new sequence restarting at 1; a lower one is stale and ignored.
    const currentEpoch = stored?.epoch ?? 0;
    if (epoch < currentEpoch) return json({ appended: 0, duplicate: true, last_n: this.state().n });
    const lastN = epoch > currentEpoch ? 0 : (stored?.last_n ?? 0);
    // EV2: a source_n the Floor already has is ignored; the first unseen one must be last_n + 1.
    const fresh = epoch > currentEpoch ? events : events.filter((item) => item.source_n > lastN);
    const first = fresh[0];
    if (first === undefined) return json({ appended: 0, duplicate: true, last_n: this.state().n });
    if (first.source_n !== lastN + 1) {
      return jsonError("gap", 409, { expected: lastN + 1 });
    }
    const appended: PoolEvent[] = [];
    for (const [index, item] of fresh.entries()) {
      if (item.source_n !== lastN + 1 + index) return jsonError("gap", 409, { expected: lastN + 1 + index });
      appended.push(this.append(item.event));
    }
    recordSource(this.ctx.storage.sql, source, epoch, lastN + fresh.length);
    return json({ appended: appended.length, last_n: this.state().n });
  }

  // ---- The read-only stream socket (12.2, EV7, FS3) ----

  private openSocket(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonError("upgrade_required", 426);
    }
    const { n } = this.state();
    if (n === 0) return jsonError("not_found", 404); // FR30: an unknown pool answers 404
    const address = clientAddress(request);
    if (this.ctx.getWebSockets(address).length >= MAX_SOCKETS_PER_ADDR) {
      return jsonError("too_many_sockets", 429);
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [address]);
    void this.scheduleAlarm(); // EM5: metrics tick while at least one socket is open
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const attachment = ws.deserializeAttachment() as { after: number } | null;
    if (attachment !== null) {
      ws.close(EVICT_CLOSE.code, EVICT_CLOSE.reason); // any second client message closes the socket
      return;
    }
    let hello: StreamHello;
    try {
      hello = JSON.parse(String(message)) as StreamHello;
    } catch {
      ws.close(1007, "bad_message");
      return;
    }
    if (hello?.hello !== 1 || !Number.isInteger(hello.after) || hello.after < 0) {
      ws.close(1007, "bad_message");
      return;
    }
    const { n, state } = this.state();
    // A snapshot answers `after` older than the oldest retained snapshot, or 0 (12.2). The stored
    // snapshot always sits at the newest `n`, so the tail that follows it is empty.
    if (hello.after < n) {
      const frame: StreamFrame = { snapshot: { n, state } };
      ws.send(JSON.stringify(frame));
    }
    ws.serializeAttachment({ after: n });
  }

  // ---- The note route (13.6) ----

  private landingNote(seq: number): Response {
    const event = landingEvent(this.ctx.storage.sql, seq);
    if (event === null || event.type !== "landing.landed") return jsonError("not_found", 404);
    if (event.note_json === null) return jsonError("not_found", 404); // EV6: summary_only has no notes
    return new Response(event.note_json, { headers: { "content-type": "application/json" } });
  }

  // ---- The Replay export (12.3, RP1) ----

  private replayExport(url: URL): Response {
    const events = allEvents(this.ctx.storage.sql);
    if (events.length === 0) return jsonError("not_found", 404); // FR30
    const secrets = this.env.OWNER_KEY === undefined ? [] : [this.env.OWNER_KEY];
    const lines: string[] = [];
    const header: ReplayHeader = {
      premise_replay: REPLAY_FORMAT,
      pool: this.poolId(),
      recorded_at: new Date(events[events.length - 1]?.t ?? 0).toISOString(),
      events: events.length,
      synthetic: events.some((event) => event.type === "pool.state" && event.synthetic),
      build: url.searchParams.get("build") ?? "local",
      label: url.searchParams.get("label") ?? "live",
    };
    lines.push(JSON.stringify(header));
    for (const event of events) {
      const line = JSON.stringify(event);
      const match = redactMatch(line, secrets);
      if (match !== null) {
        // RP1: the exporter refuses to export and names the line number.
        return jsonError("redacted", 409, { line: lines.length + 1, family: match });
      }
      lines.push(line);
    }
    return new Response(`${lines.join("\n")}\n`, {
      headers: {
        "content-type": "application/x-ndjson",
        "content-disposition": `attachment; filename="${this.poolId()}.ndjson"`,
      },
    });
  }
}
