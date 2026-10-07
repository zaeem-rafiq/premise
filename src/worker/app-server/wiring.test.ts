import { afterEach, describe, expect, it, vi } from "vitest";
import type { FloorRead } from "../../protocol/internal.ts";
import type { Route } from "../../protocol/routes.ts";
import type { Env } from "../env.ts";
import type { RouteTable } from "../index.ts";
import { wire } from "./wiring.ts";

const COMMIT = "a".repeat(40);
const ORIGIN = "https://app.example.test";
const POOL = "registered-pool";
const MAIN = "https://artifacts.example.test/git/pool-space/registered-main.git";
const PLAIN = "https://artifacts.example.test/git/pool-space/registered-plain.git";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const floorCalls: string[] = [];
  const cached = new Map<string, Response>();
  const events: Array<Record<string, unknown>> = [
    { type: "pool.state", src: "trunk", pool: POOL, remote: MAIN, plain_remote: PLAIN, app: "tidepool" },
  ];
  const read: FloorRead = {
    n: 1,
    pool: { state: "ready", head_seq: 1, head_commit: COMMIT, landed_seq: 1, landed_commit: COMMIT },
    green: { seq: 0, commit: null },
    plain: { commit: COMMIT, tree: "b".repeat(40), through_seq: 1 },
    landings_by_commit: { [COMMIT]: 1 },
    paths: {},
  };
  let replayStatus = 200;
  const cache = {
    async match(request: Request) {
      return cached.get(request.url)?.clone();
    },
    async put(request: Request, response: Response) {
      cached.set(request.url, response.clone());
    },
  };
  vi.stubGlobal("caches", { default: cache });
  const env = {
    FLOOR: {
      idFromName: (name: string) => name,
      get: (pool: string) => ({
        async fetch(url: string) {
          floorCalls.push(url);
          if (new URL(url).pathname === "/internal/state") return Response.json(read);
          if (replayStatus !== 200) return new Response(null, { status: replayStatus });
          const matching = events.filter((event) => event.pool === pool);
          return new Response(matching.map((event) => JSON.stringify(event)).join("\n"));
        },
      }),
    },
    POOLS: {
      async get(name: string) {
        calls.push({ method: "get", args: [name] });
        return {
          async readFile(args: { ref: string; path: string }) {
            calls.push({ method: "readFile", args: [name, args] });
            return new Blob([`export const repo = ${JSON.stringify(name)};`]);
          },
          async readCommit(hash: string) {
            calls.push({ method: "readCommit", args: [name, hash] });
            return { treeHash: "b".repeat(40) };
          },
          async readTree(hash: string) {
            calls.push({ method: "readTree", args: [name, hash] });
            return [];
          },
        };
      },
    },
  } as unknown as Env;
  const table: RouteTable = { handlers: new Map() };
  wire(table);
  const fileUrl = (pool: string, version = `c-${COMMIT}`) =>
    `${ORIGIN}/pool/${encodeURIComponent(pool)}/v/${version}/main.js`;
  const get = (pool: string, version = `c-${COMMIT}`, path = "main.js") =>
    table.handlers.get("GET /pool/{pool}/v/{version}/{path}")!({
      request: new Request(fileUrl(pool, version).replace(/main\.js$/, path)),
      env,
      params: { pool, version, path },
      route: {} as Route,
    });
  const page = (pool: string, source: string) =>
    table.handlers.get("GET /pool/{pool}/{source}/")!({
      request: new Request(`${ORIGIN}/pool/${encodeURIComponent(pool)}/${source}/`),
      env,
      params: { pool, source },
      route: {} as Route,
    });
  return {
    calls,
    floorCalls,
    cached,
    events,
    read,
    get,
    page,
    fileUrl,
    failReplay(status: number) {
      replayStatus = status;
    },
  };
}

function sandboxed(response: Response) {
  expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
  expect(response.headers.get("content-security-policy")).toContain("connect-src 'none'");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.has("set-cookie")).toBe(false);
}

describe("registered app repositories", () => {
  it("SE22: serves commits from the registered main and plain repositories", async () => {
    const f = fixture();
    for (const [prefix, name] of [
      ["c", "registered-main"],
      ["p", "registered-plain"],
    ]) {
      const response = await f.get(POOL, `${prefix}-${COMMIT}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(`export const repo = "${name}";`);
      sandboxed(response);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(f.calls.at(-1)).toEqual({ method: "readFile", args: [name, { ref: COMMIT, path: "main.js" }] });
    }
    expect(f.calls.filter((call) => call.method === "get").map((call) => call.args)).toEqual([
      ["registered-main"],
      ["registered-plain"],
    ]);
  });

  it("SE22/SE13/SE14: unregistered, other-namespace and attempt names return sandboxed 404s without Artifacts reads", async () => {
    const f = fixture();
    for (const name of [
      "unregistered",
      "other-space/registered-main",
      "other-space%2Fregistered-main",
      "a_attempt-transcript",
    ]) {
      for (const prefix of ["c", "p"]) {
        const response = await f.get(name, `${prefix}-${COMMIT}`);
        expect(response.status).toBe(404);
        expect(await response.text()).toBe("not found\n");
        sandboxed(response);
      }
      expect((await f.page(name, COMMIT)).status).toBe(404);
      expect((await f.get(name, `c-${COMMIT}`, "~registry.js")).status).toBe(404);
    }
    expect(f.calls).toEqual([]);
  });

  it("SE22: missing plain registration never guesses the plain repository", async () => {
    const f = fixture();
    f.events[0]!.plain_remote = null;
    expect((await f.get(POOL, `p-${COMMIT}`)).status).toBe(404);
    expect(f.calls).toEqual([]);
  });

  it("SE22: malformed pool names are rejected before Floor or Artifacts reads", async () => {
    const f = fixture();
    for (const name of ["UPPER", "with_under_score", "other-space/registered-main", "a".repeat(64)]) {
      const response = await f.get(name);
      expect(response.status).toBe(404);
      sandboxed(response);
    }
    expect(f.floorCalls).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it("SE22: follows the latest registered remote and refuses malformed remotes", async () => {
    const f = fixture();
    f.events.push({ ...f.events[0], remote: "http://127.0.0.1:9999/replacement" });
    expect((await f.get(POOL)).status).toBe(200);
    expect(f.calls[0]).toEqual({ method: "get", args: ["replacement"] });
    for (const remote of [null, "", "https://host/git/space/name%2Fsecret.git", "https://host/name.git?token=bad"]) {
      f.cached.clear();
      f.calls.length = 0;
      f.events.push({ ...f.events[0], remote });
      expect((await f.get(POOL)).status).toBe(404);
      expect(f.calls).toEqual([]);
    }
  });

  it("SE22/SE20: cached registered commits need no Floor or Artifacts lookup", async () => {
    const f = fixture();
    expect((await f.get(POOL)).status).toBe(200);
    expect(f.floorCalls).toHaveLength(2); // One shared Floor snapshot within the request.
    f.floorCalls.length = 0;
    f.calls.length = 0;
    f.failReplay(503);
    const response = await f.get(POOL);
    expect(response.status).toBe(200);
    sandboxed(response);
    expect(f.floorCalls).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it("SE22: cache entries from before registration enforcement cannot serve unknown repositories", async () => {
    const f = fixture();
    f.cached.set(f.fileUrl("unregistered"), new Response("old unsafe response"));
    expect((await f.get("unregistered")).status).toBe(404);
    expect(f.calls).toEqual([]);
  });

  it("SE22: unavailable registration fails closed even when the Floor projection has app", async () => {
    const f = fixture();
    f.read.pool.app = "tidepool";
    f.failReplay(503);
    const response = await f.get(POOL);
    expect(response.status).toBe(503);
    sandboxed(response);
    expect(f.calls).toEqual([]);
  });
});
