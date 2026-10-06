// The fake EngineService of the engine tests: scripted event streams, canned route answers and a
// record of every call. No network, no credentials — the tests build the events by hand (BP1:
// expected values come from the specification and the events the test writes, never from the
// implementation's own output).
//
// The pools' streams are real fake Floors (`../../soak/fake-floor.ts`): FR30's probe, the
// hello/snapshot/events protocol, drops and reconnects, and the owner Replay export — so a test
// can hold events in a gap the live stream never carries and still score them from the export.

import type { PoolEvent } from "../../../src/protocol/events.ts";
import type { Clock } from "../early/run.ts";
import { fakeFloor, type FakeFloor } from "../../soak/fake-floor.ts";
import type { StreamSocket } from "../../soak/stream.ts";
import type { EngineResponse, EngineService } from "./service.ts";

/** `frames` is how many stream frames all the fake's Floors had sent when the call was
 * answered — the gate's tests read it to prove the scripted work started after the first frame. */
export type FakeCall = { method: "POST" | "GET"; path: string; body: unknown | null; frames: number };

export type FakeFiles = Record<string, string>; // "<path>" -> text, keyed by path alone

/** Build one stream event; every field of `EventBase` is filled unless the test overrides it. */
export function ev(n: number, ts: number, type: string, fields: Record<string, unknown>, pool = "m-test"): PoolEvent {
  return { n, t: ts, ts, pool, src: "trunk", type, ...fields } as PoolEvent;
}

/** A `Clock` that starts at `at`; every sleep advances it — a quiet stream lets a deadline
 * pass, the way a real clock would. */
export function fakeClock(at = 1_700_000_000_000): Clock {
  let now = at;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

/**
 * The fake service. Two ways to hand a pool its events:
 *
 * - `streams`: one script per `POST /api/pools`, in call order. The script's first event seeds
 *   the Floor (so FR30's probe answers 426 and the first hello gets its snapshot); the rest is
 *   pushed live when the run posts its intent — the order a real pool emits them.
 * - `floors`: ready-built `fakeFloor`s, again one per `POST /api/pools`. Every scripted event is
 *   on the Floor before the hello (the snapshot covers them all), and the test drives
 *   `push`/`dropAll`/`refuseSockets` itself — the shape for the drop, gap and `stream_lost`
 *   cases. Reach a pool's floor through `floorOf`.
 *
 * `post` overrides the default answers; the defaults give a pool, an intent id (`i_test`), a
 * swarm `ok` and a release list of one — enough for a plain additive run.
 */
export function fakeService(opts: {
  streams?: PoolEvent[][];
  floors?: FakeFloor[];
  files?: FakeFiles;
  intentId?: string;
  post?: (path: string, body: Record<string, unknown>, call: number) => EngineResponse | null;
  getJson?: (path: string) => EngineResponse;
}): { service: EngineService; calls: FakeCall[]; floorOf(pool: string): FakeFloor | undefined } {
  const calls: FakeCall[] = [];
  const scripts = [...(opts.streams ?? [])];
  const preset = [...(opts.floors ?? [])];
  const floors = new Map<string, FakeFloor>();
  const pending = new Map<string, PoolEvent[]>();
  const files = opts.files ?? {};
  let posts = 0;
  const floorOf = (pool: string) => floors.get(pool);
  const frames = () => [...floors.values()].reduce((sum, floor) => sum + floor.framesSent, 0);
  const record = (method: "POST" | "GET", path: string, body: unknown | null): void => {
    calls.push({ method, path, body, frames: frames() });
  };
  /** The pool an `/api/pools/{pool}/...` path names. */
  const poolOfPath = (path: string): string => {
    const match = /^\/api\/pools\/([^/]+)\//.exec(path);
    return match === null ? "" : decodeURIComponent(match[1] as string);
  };
  /** A socket that closes before it ever opens — a pool the fake has no Floor for. */
  const deadSocket = (): StreamSocket => {
    const ws: StreamSocket = {
      send(): void {},
      close(): void {},
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    queueMicrotask(() => ws.onclose?.({ code: 1006, reason: "no_floor" }));
    return ws;
  };
  return {
    calls,
    floorOf,
    service: {
      async postJson(path, body) {
        const fields = (body ?? {}) as Record<string, unknown>;
        if (path === "/api/pools" && typeof fields.pool === "string") {
          if (preset.length > 0) {
            floors.set(fields.pool, preset.shift() as FakeFloor);
          } else {
            const script = scripts.shift() ?? [];
            floors.set(fields.pool, fakeFloor(script.slice(0, 1)));
            pending.set(fields.pool, script.slice(1));
          }
        }
        posts++;
        const answer = opts.post?.(path, fields, posts);
        record("POST", path, body);
        if (answer != null) return answer;
        if (path === "/api/pools") return { status: 200, body: { ok: true } };
        if (path === "/api/swarm") {
          const release = fields.release;
          if (Array.isArray(release)) return { status: 200, body: { ok: true, launched: [], released: ["syn-1"] } };
          return { status: 200, body: { ok: true, launched: [], released: [] } };
        }
        if (path.endsWith("/intents")) {
          // The intent's POST is the moment the run's events exist: the held script lands.
          const rest = pending.get(poolOfPath(path));
          if (rest !== undefined) {
            pending.delete(poolOfPath(path));
            floorOf(poolOfPath(path))?.push(...rest);
          }
          return { status: 200, body: { intent_id: opts.intentId ?? "i_test" } };
        }
        if (path.endsWith("/stop")) return { status: 200, body: { ok: true } };
        return { status: 404, body: { error: { code: "no_route" } } };
      },
      async getJson(path) {
        record("GET", path, null);
        if (opts.getJson !== undefined) return opts.getJson(path);
        return { status: 404, body: { error: { code: "no_route" } } };
      },
      async getText(path) {
        record("GET", path, null);
        const text = files[filePathOf(path)];
        return text === undefined ? { status: 404, text: "" } : { status: 200, text };
      },
      async getAuthed(path) {
        record("GET", path, null);
        if (path.endsWith("/replay.ndjson")) {
          const floor = floorOf(poolOfPath(path));
          if (floor === undefined) return { status: 404, text: "" };
          return { status: 200, text: floor.exportNdjson(poolOfPath(path)) };
        }
        return { status: 404, text: "" };
      },
      async probe(pool) {
        return floorOf(pool)?.probe(pool) ?? 404;
      },
      socket(pool) {
        return floorOf(pool)?.socket(pool) ?? deadSocket();
      },
    },
  };
}

/** The fake's view of `getText`: find the file name a `/pool/<pool>/v/<version>/<path>` asks for. */
export function filePathOf(urlPath: string): string {
  const mark = urlPath.indexOf("/v/");
  return mark < 0
    ? urlPath
    : decodeURIComponent(
        urlPath
          .slice(mark + 3)
          .split("/")
          .slice(1)
          .join("/"),
      );
}
