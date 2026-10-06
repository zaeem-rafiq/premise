// The fake EngineService of the engine tests: scripted event streams, canned route answers and a
// record of every call. No network, no credentials — the tests build the events by hand (BP1:
// expected values come from the specification and the events the test writes, never from the
// implementation's own output).

import type { PoolEvent } from "../../../src/protocol/events.ts";
import type { Clock } from "../early/run.ts";
import type { EngineResponse, EngineService, EngineStream } from "./service.ts";

export type FakeCall = { method: "POST" | "GET"; path: string; body: unknown | null };

export type FakeFiles = Record<string, string>; // "<path>" -> text, keyed by path alone

/** Build one stream event; every field of `EventBase` is filled unless the test overrides it. */
export function ev(n: number, ts: number, type: string, fields: Record<string, unknown>, pool = "m-test"): PoolEvent {
  return { n, t: ts, ts, pool, src: "trunk", type, ...fields } as PoolEvent;
}

/** A stream that hands out `script` in order, then answers null (as a dropped/dead socket would
 * at the deadline). `pushed` lets a test append more events while the run is watching. */
export function fakeStream(script: PoolEvent[], pushed?: PoolEvent[]): EngineStream {
  const queue = pushed ?? script;
  if (pushed !== undefined) queue.push(...script);
  let cursor = 0;
  return {
    events: () => queue.slice(0, cursor),
    close() {},
    async next() {
      return cursor < queue.length ? (queue[cursor++] as PoolEvent) : null;
    },
  };
}

/** A `Clock` fixed at `at` with an instant sleep — the runs' deadlines never really wait. */
export function fakeClock(at = 1_700_000_000_000): Clock {
  return {
    now: () => at,
    sleep: () => Promise.resolve(),
  };
}

/**
 * The fake service. `streams` is one event list per `openStream` call, in call order (each run
 * opens a fresh pool). `post` overrides the default answers; the defaults give a pool, an intent
 * id (`i_test`), a swarm `ok` and a release list of one — enough for a plain additive run.
 */
export function fakeService(opts: {
  streams: PoolEvent[][];
  files?: FakeFiles;
  intentId?: string;
  post?: (path: string, body: Record<string, unknown>, call: number) => EngineResponse | null;
  getJson?: (path: string) => EngineResponse;
}): { service: EngineService; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const streams = [...opts.streams];
  const files = opts.files ?? {};
  let posts = 0;
  return {
    calls,
    service: {
      async postJson(path, body) {
        calls.push({ method: "POST", path, body });
        posts++;
        const answer = opts.post?.(path, body as Record<string, unknown>, posts);
        if (answer != null) return answer;
        if (path === "/api/pools") return { status: 200, body: { ok: true } };
        if (path === "/api/swarm") {
          const release = (body as { release?: unknown }).release;
          if (Array.isArray(release)) return { status: 200, body: { ok: true, launched: [], released: ["syn-1"] } };
          return { status: 200, body: { ok: true, launched: [], released: [] } };
        }
        if (path.endsWith("/intents")) return { status: 200, body: { intent_id: opts.intentId ?? "i_test" } };
        if (path.endsWith("/stop")) return { status: 200, body: { ok: true } };
        return { status: 404, body: { error: { code: "no_route" } } };
      },
      async getJson(path) {
        calls.push({ method: "GET", path, body: null });
        if (opts.getJson !== undefined) return opts.getJson(path);
        return { status: 404, body: { error: { code: "no_route" } } };
      },
      async getText(path) {
        calls.push({ method: "GET", path, body: null });
        const text = files[filePathOf(path)];
        return text === undefined ? { status: 404, text: "" } : { status: 200, text };
      },
      openStream() {
        const script = streams.shift() ?? [];
        return fakeStream(script);
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
