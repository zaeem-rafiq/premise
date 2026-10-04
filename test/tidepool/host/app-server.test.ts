// The app server of 02-tidepool section 4, run against a directory-on-disk PoolSource (4.9 option E)
// and a fake Floor read (FS2). Every rule named in a test comes from the spec text; expected values
// (blob ids, the shared digest, the cut of AS11) are computed from git's own formulas in harness.ts.

import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createApp, type AppDeps, type AppInput } from "../../../src/worker/app-server/app.ts";
import { RateLimiter } from "../../../src/worker/app-server/respond.ts";
import { directoryPoolSource } from "../../../src/worker/adapters/pool-source/directory.ts";
import { resolveSource } from "../../../src/worker/adapters/pool-source/resolve.ts";
import { HOST_BUILD, HOST_SOURCE } from "../../../src/worker/app-server/host-bundle.ts";
import type { PoolFloorRead } from "../../../src/worker/adapters/pool-source/resolve.ts";
import type { PoolSource } from "../../../src/protocol/ports.ts";
import { blobId, importText, sha256Hex, versionOf, writeVersion, creatureJs } from "./harness.ts";

const ORIGIN = "https://app.example.test";
const POOL = "tidepool";
const SEED = "f".repeat(40);
const LANDED = "a".repeat(40);
const GREEN = "b".repeat(40);
const PLAIN = "c".repeat(40);
const OTHER = "d".repeat(40);

function floorRead(over: Partial<PoolFloorRead> = {}): PoolFloorRead {
  return {
    n: 12,
    pool: { state: "ready", head_seq: 13, head_commit: OTHER, landed_seq: 12, landed_commit: LANDED },
    green: { seq: 11, commit: GREEN },
    plain: { commit: PLAIN, tree: "t".repeat(40), through_seq: 9 },
    landings_by_commit: { [LANDED]: 12, [OTHER]: 10 },
    paths: {},
    ...over,
  };
}

type Call = { method: string; args: readonly unknown[] };

function recordingSource(inner: PoolSource): { pools: PoolSource; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    pools: {
      resolve: async (pool, source) => {
        calls.push({ method: "resolve", args: [pool, source] });
        return inner.resolve(pool, source);
      },
      read: async (pool, version, path) => {
        calls.push({ method: "read", args: [pool, version, path] });
        return inner.read(pool, version, path);
      },
      list: async (pool, version, dir) => {
        calls.push({ method: "list", args: [pool, version, dir] });
        return inner.list(pool, version, dir);
      },
    },
  };
}

/** The app with a directory PoolSource over `root` and a `floorState` the test controls. */
async function makeApp(
  root: string,
  read: PoolFloorRead | ((pool: string) => PoolFloorRead),
): Promise<{ get: (path: string) => Promise<Response>; calls: Call[]; readCalls: number }> {
  const pools = directoryPoolSource({ root });
  const recorded = recordingSource(pools);
  const deps: AppDeps = {
    floorState: async (pool) => {
      const value = typeof read === "function" ? read(pool) : read;
      return value;
    },
    pools: recorded.pools,
    host: { build: HOST_BUILD, source: HOST_SOURCE },
    now: () => 1_000,
    limiter: new RateLimiter(),
  };
  const app = createApp(deps);
  // Route table mirror of APP_ROUTES: /pool/~host.<build>.js, /pool/{pool}/{source}/[~head|~boot].js,
  // /pool/{pool}/{source}/, /pool/{pool}/v/{version}/{path|~registry.js}, else the {rest} catch-all.
  const get = (path: string) => {
    const request = new Request(`${ORIGIN}${path}`);
    const { pathname } = new URL(request.url);
    const segments = pathname.split("/").filter(Boolean); // ["pool", ...]
    let input: AppInput;
    if (/^~host\.[^/]+\.js$/.test(segments[1] ?? "")) {
      input = {
        request,
        params: { build: (segments[1]!.match(/^~host\.([^.]+)\.js$/) ?? [])[1] ?? "" },
        route: "host",
      };
    } else if (segments.length === 3) {
      input = { request, params: { pool: segments[1]!, source: segments[2]! }, route: "page" };
    } else if (segments.length === 4 && segments[3] === "~head.js") {
      input = { request, params: { pool: segments[1]!, source: segments[2]! }, route: "head" };
    } else if (segments.length === 4 && segments[3] === "~boot.js") {
      input = { request, params: { pool: segments[1]!, source: segments[2]! }, route: "boot" };
    } else if (segments[2] === "v" && segments[4] === "~registry.js") {
      input = { request, params: { pool: segments[1]!, version: segments[3]! }, route: "registry" };
    } else if (segments[2] === "v" && segments.length === 5) {
      input = { request, params: { pool: segments[1]!, version: segments[3]!, path: segments[4]! }, route: "file" };
    } else {
      input = { request, params: { rest: pathname.slice("/pool/".length) }, route: "rest" };
    }
    return app.handle(input);
  };
  return { get, calls: recorded.calls, readCalls: 0 };
}

/** Lay a small pool version on disk and return its token. */
async function writeStandard(root: string, version: string): Promise<void> {
  await writeVersion(root, POOL, version, {
    creatures: { fish: creatureJs("fish"), crab: creatureJs("crab", 1) },
    shared: { "world/energy.js": "export const ENERGY_MAX = 100;\n", "GUIDE.md": "# guide\n" },
  });
}

const CSP =
  "sandbox allow-scripts; default-src 'none'; script-src https://app.example.test; img-src data:; " +
  "style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; " +
  "frame-ancestors https://app.example.test";

describe("source resolution (02 4.1, SE19, AS2, AS17)", () => {
  it("S7a/AS2: main resolves to pool.state.landed_commit as c-<commit> with the landed seq", () => {
    const read = floorRead();
    expect(resolveSource(read, "main")).toEqual({ version: `c-${LANDED}`, seq: 12 });
  });

  it("SE19: green resolves to the green commit when present, else the seed commit of landed_commit", () => {
    expect(resolveSource(floorRead(), "green")).toEqual({ version: `c-${GREEN}`, seq: 11 });
    expect(resolveSource(floorRead({ green: { seq: null, commit: null } }), "green")).toEqual({
      version: `c-${LANDED}`,
      seq: 12,
    });
  });

  it("AS17: plain resolves to the latest plain.updated commit, else the seed commit of the pool repo", () => {
    expect(resolveSource(floorRead(), "plain")).toEqual({ version: `p-${PLAIN}`, seq: 9 });
    expect(resolveSource(floorRead({ plain: null }), "plain")).toEqual({ version: `c-${LANDED}`, seq: 12 });
  });

  it("PV5: <40 hex> resolves to itself with the landing's seq while the state holds it, else null", () => {
    expect(resolveSource(floorRead(), OTHER)).toEqual({ version: `c-${OTHER}`, seq: 10 });
    expect(resolveSource(floorRead(), "e".repeat(40))).toEqual({ version: `c-${"e".repeat(40)}`, seq: null });
  });

  it("PV5: p-<40 hex> resolves to itself and always reports seq null", () => {
    expect(resolveSource(floorRead(), `p-${OTHER}`)).toEqual({ version: `p-${OTHER}`, seq: null });
  });

  it("AS4: unknown sources — attempts, bogus segments — do not resolve", () => {
    const read = floorRead();
    for (const source of ["a_01JKX", "latest", "HEAD", "v", "main/x", ""]) {
      expect(resolveSource(read, source), source).toBeNull();
    }
  });
});

describe("the page route (02 4.2, AS2, AS4, AS7, AS15)", () => {
  it("AS2/S7a: GET /pool/<pool>/main/ serves index.html of the landed commit, read by commit id", async () => {
    const root = join(".tmp-test", "app", "page-main");
    const version = `c-${LANDED}`;
    await writeStandard(root, version);
    const { get, calls } = await makeApp(root, floorRead());
    const response = await get("/pool/tidepool/main/");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain('id="pool"');
    const reads = calls.filter((call) => call.method === "read");
    expect(reads).toEqual([{ method: "read", args: [POOL, `c-${LANDED}`, "index.html"] }]);
  });

  it("AS16/SE19: resolving and serving main touches Floor state and Artifacts only — no Trunk exists in deps", async () => {
    const root = join(".tmp-test", "app", "no-trunk");
    await writeStandard(root, `c-${LANDED}`);
    const pools = directoryPoolSource({ root });
    const trunkCalls: unknown[] = [];
    const deps: AppDeps = {
      floorState: async () => floorRead(),
      pools,
      host: { build: HOST_BUILD, source: HOST_SOURCE },
      now: () => 0,
      limiter: new RateLimiter(),
      // `trunk` is not a field of AppDeps: a public route cannot reach it (AS16). A spy that would
      // record a call is asserted to record none.
    };
    void trunkCalls;
    const app = createApp(deps);
    const request = new Request(`${ORIGIN}/pool/tidepool/main/`);
    const response = await app.handle({ request, params: { pool: "tidepool", source: "main" }, route: "page" });
    expect(response.status).toBe(200);
    expect(trunkCalls).toHaveLength(0);
  });

  it("308: a page address without the final slash redirects to the same path with it (4.2, AS7)", async () => {
    const root = join(".tmp-test", "app", "slash");
    await writeStandard(root, `c-${LANDED}`);
    const { get } = await makeApp(root, floorRead());
    const response = await get("/pool/tidepool/main?seed=3");
    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe("/pool/tidepool/main/?seed=3");
  });

  it("AS4: unknown pool (no landed commit), unknown source and a missing version answer 404", async () => {
    const root = join(".tmp-test", "app", "not-found");
    await writeStandard(root, `c-${LANDED}`);
    const empty = floorRead({
      pool: { state: "ready", head_seq: 0, head_commit: null, landed_seq: 0, landed_commit: null },
      green: { seq: null, commit: null },
      plain: null,
      landings_by_commit: {},
    });
    const { get } = await makeApp(root, empty);
    expect((await get("/pool/nobody/main/")).status).toBe(404);
    expect((await get("/pool/tidepool/made-up/")).status).toBe(404);
    const missing = floorRead();
    const second = await makeApp(root, missing);
    expect((await second.get(`/pool/tidepool/${"9".repeat(40)}/`)).status).toBe(404);
  });

  it("AS4: a Floor read that throws answers 503", async () => {
    const deps: AppDeps = {
      floorState: () => Promise.reject(new Error("floor unreachable")),
      pools: directoryPoolSource({ root: ".tmp-test" }),
      host: { build: HOST_BUILD, source: HOST_SOURCE },
      now: () => 0,
      limiter: new RateLimiter(),
    };
    const app = createApp(deps);
    const response = await app.handle({
      request: new Request(`${ORIGIN}/pool/tidepool/main/`),
      params: { pool: "tidepool", source: "main" },
      route: "page",
    });
    expect(response.status).toBe(503);
  });
});

describe("content types and served paths (AS3, AS5, SE15)", () => {
  it("AS5: .js is JavaScript, index.html at the root is HTML, .json/.md serve, other files 404", async () => {
    const root = join(".tmp-test", "app", "types");
    const version = `c-${LANDED}`;
    await writeVersion(root, POOL, version, {
      creatures: { fish: creatureJs("fish") },
      shared: {
        "GUIDE.md": "# guide\n",
        "data.json": '{"a":1}\n',
        "docs/inner.html": "<p>no</p>\n",
        "img.png": "bytes\n",
      },
    });
    await fs.mkdir(join(root, POOL, version, ".premise"), { recursive: true });
    await fs.writeFile(join(root, POOL, version, ".premise", "policy.json"), "{}\n");
    const { get } = await makeApp(root, floorRead());
    const base = `/pool/tidepool/v/${version}/`;
    const js = await get(`${base}main.js`);
    expect(js.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(js.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(js.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    const html = await get(`${base}index.html`);
    expect(html.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect((await get(`${base}data.json`)).headers.get("Content-Type")).toBe("application/json");
    expect((await get(`${base}GUIDE.md`)).headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect((await get(`${base}docs/inner.html`)).status).toBe(404); // every other .html is 404
    expect((await get(`${base}img.png`)).status).toBe(404);
    expect((await get(`${base}.premise/policy.json`)).status).toBe(404); // AS5: never served
    expect((await get(`${base}~evil.js`)).status).toBe(404); // AS3: only the three ~ modules exist
    const nested = await get(`${base}world/time.js`); // nested path comes through the catch-all
    expect(nested.status).toBe(200);
    expect(nested.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
  });

  it("AS15/SE14: the full header set travels on every response, errors included", async () => {
    const root = join(".tmp-test", "app", "headers");
    await writeStandard(root, `c-${LANDED}`);
    const { get } = await makeApp(root, floorRead());
    for (const path of [
      "/pool/tidepool/main/",
      "/pool/tidepool/main/~head.js",
      "/pool/tidepool/zzz/",
      "/pool/tidepool/v/c-0000000000000000000000000000000000000000/missing.js",
    ]) {
      const response = await get(path);
      expect(response.headers.get("Content-Security-Policy"), path).toBe(CSP);
      expect(response.headers.get("X-Content-Type-Options"), path).toBe("nosniff");
    }
  });
});

describe("the generated ~ modules (4.4)", () => {
  it("~head.js exports landed { pool, source, version, base, seq } of the resolved source", async () => {
    const root = join(".tmp-test", "app", "head");
    await writeStandard(root, `c-${LANDED}`);
    const { get } = await makeApp(root, floorRead());
    const response = await get("/pool/tidepool/main/~head.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const mod = await importText(await response.text());
    expect(mod.landed).toEqual({
      pool: "tidepool",
      source: "main",
      version: `c-${LANDED}`,
      base: `/pool/tidepool/v/c-${LANDED}/`,
      seq: 12,
    });
  });

  it("~boot.js imports the host bundle by build id and hands it landed plus the frame's import()", async () => {
    const root = join(".tmp-test", "app", "boot");
    await writeStandard(root, `c-${LANDED}`);
    const { get } = await makeApp(root, floorRead());
    const response = await get("/pool/tidepool/main/~boot.js");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain(`import { startHost } from "/pool/~host.${HOST_BUILD}.js";`);
    expect(text).toContain('import { landed } from "./~head.js";');
    expect(text).toContain("startHost(landed");
  });

  it("~registry.js (AS9, AS10): kinds sorted with git blob ids; skipped carries reasons; shared is the spec digest", async () => {
    const root = join(".tmp-test", "app", "registry");
    const version = `c-${LANDED}`;
    await writeVersion(root, POOL, version, {
      creatures: {
        fish: creatureJs("fish"),
        anemone: creatureJs("anemone"),
        "bad-name!": "export const x = 1;\n",
      },
      shared: { "GUIDE.md": "# guide\n", "world/extra.js": "export const E = 1;\n" },
    });
    const dir = join(root, POOL, version);
    // A real commit never holds the generated ~registry.js — the host fixture writes one for the
    // directory PoolSource's own registry reads; the app server must not hash it (AS10).
    await fs.rm(join(dir, "~registry.js"));
    await fs.writeFile(join(dir, "creatures", "constructor.js"), creatureJs("constructor"));
    await fs.writeFile(join(dir, "creatures", "README.md"), "# not a kind\n");
    await fs.mkdir(join(dir, "creatures", "nested"), { recursive: true });
    const { get } = await makeApp(root, floorRead());
    const response = await get(`/pool/tidepool/v/${version}/~registry.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    const mod = (await importText(await response.text())) as {
      registry: {
        version: string;
        kinds: Array<{ kind: string; path: string; oid: string }>;
        total: number;
        skipped: Array<{ name: string; reason: string }>;
        shared: string;
      };
    };
    const registry = mod.registry;
    expect(registry.version).toBe(version);
    expect(registry.kinds).toEqual([
      { kind: "anemone", path: "creatures/anemone.js", oid: blobId(creatureJs("anemone")) },
      { kind: "fish", path: "creatures/fish.js", oid: blobId(creatureJs("fish")) },
    ]);
    expect(registry.total).toBe(2);
    expect(registry.skipped).toEqual([
      { name: "README.md", reason: "not_a_kind" },
      { name: "bad-name!.js", reason: "not_a_kind" },
      { name: "constructor.js", reason: "reserved_name" },
      { name: "nested", reason: "not_a_kind" },
    ]);
    const sharedLines = [
      "GUIDE.md " + blobId("# guide\n"),
      "index.html " + blobId(await fs.readFile(join(dir, "index.html"), "utf8")),
      "main.js " + blobId(await fs.readFile(join(dir, "main.js"), "utf8")),
      "pen.js " + blobId(await fs.readFile(join(dir, "pen.js"), "utf8")),
      "selftest/run.js " + blobId(await fs.readFile(join(dir, "selftest/run.js"), "utf8")),
      "world/extra.js " + blobId("export const E = 1;\n"),
      "world/time.js " + blobId(await fs.readFile(join(dir, "world/time.js"), "utf8")),
    ].sort();
    expect(registry.shared).toBe(sha256Hex(sharedLines.join("\n")).slice(0, 32));
  });

  it("AS11: over MAX_KINDS the cut keeps the most recently landed paths (Floor `paths`), ties by name", async () => {
    const root = join(".tmp-test", "app", "cap");
    const version = `c-${LANDED}`;
    const creatures: Record<string, string> = {};
    for (let i = 0; i < 70; i += 1) creatures[`k${String(i).padStart(2, "0")}`] = creatureJs(`k${i}`, i);
    await writeVersion(root, POOL, version, { creatures });
    const paths: Record<string, number> = {};
    for (let i = 5; i < 70; i += 1) paths[`creatures/k${String(i).padStart(2, "0")}.js`] = i;
    const { get } = await makeApp(root, floorRead({ paths }));
    const mod = (await importText(await (await get(`/pool/tidepool/v/${version}/~registry.js`)).text())) as {
      registry: { total: number; kinds: Array<{ kind: string }> };
    };
    expect(mod.registry.total).toBe(70);
    expect(mod.registry.kinds).toHaveLength(64);
    const kept = new Set(mod.registry.kinds.map((entry: { kind: string }) => entry.kind));
    // k00..k04 have no seq (unknown → name order, below every known seq); k05 has the lowest known seq.
    for (const dropped of ["k00", "k01", "k02", "k03", "k04", "k05"]) expect(kept.has(dropped)).toBe(false);
    expect(kept.has("k06")).toBe(true);
    expect(kept.has("k69")).toBe(true);
  });
});

describe("rate limits and caching (AS8, SE20)", () => {
  it("AS8: the no-store routes are limited to PUBLIC_RATE_PER_MIN per address per minute", async () => {
    const root = join(".tmp-test", "app", "rate");
    await writeStandard(root, `c-${LANDED}`);
    let now = 0;
    const deps: AppDeps = {
      floorState: async () => floorRead(),
      pools: directoryPoolSource({ root }),
      host: { build: HOST_BUILD, source: HOST_SOURCE },
      now: () => now,
      limiter: new RateLimiter(),
    };
    const app = createApp(deps);
    const request = () => new Request(`${ORIGIN}/pool/tidepool/main/`);
    let limited = 0;
    for (let i = 0; i < 121; i += 1) {
      const response = await app.handle({
        request: request(),
        params: { pool: "tidepool", source: "main" },
        route: "page",
      });
      if (response.status === 429) limited += 1;
    }
    expect(limited).toBe(1);
    now = 61_000; // next window
    const again = await app.handle({ request: request(), params: { pool: "tidepool", source: "main" }, route: "page" });
    expect(again.status).toBe(200);
  });

  it("SE20: a version file is read from the source once, then served from the cache", async () => {
    const root = join(".tmp-test", "app", "cache");
    const version = `c-${LANDED}`;
    await writeStandard(root, version);
    const pools = directoryPoolSource({ root });
    const recorded = recordingSource(pools);
    const stored = new Map<string, Response>();
    const deps: AppDeps = {
      floorState: async () => floorRead(),
      pools: recorded.pools,
      host: { build: HOST_BUILD, source: HOST_SOURCE },
      now: () => 0,
      cache: {
        match: async (request) => stored.get(request.url)?.clone(),
        put: async (request, response) => void stored.set(request.url, response.clone()),
      },
      limiter: new RateLimiter(),
    };
    const app = createApp(deps);
    const url = `${ORIGIN}/pool/tidepool/v/${version}/main.js`;
    const first = await app.handle({
      request: new Request(url),
      params: { pool: "tidepool", version, path: "main.js" },
      route: "file",
    });
    const second = await app.handle({
      request: new Request(url),
      params: { pool: "tidepool", version, path: "main.js" },
      route: "file",
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(await first.clone().text());
    expect(recorded.calls.filter((c) => c.method === "read")).toHaveLength(1);
  });
});

describe("the host bundle route (4.2, 4.5)", () => {
  it("GET /pool/~host.<build>.js serves the committed host bundle as immutable JavaScript", async () => {
    const { get } = await makeApp(".tmp-test", floorRead());
    const response = await get(`/pool/~host.${HOST_BUILD}.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(await response.text()).toBe(HOST_SOURCE);
  });

  it("an unknown build id answers 404", async () => {
    const { get } = await makeApp(".tmp-test", floorRead());
    expect((await get("/pool/~host.deadbeef00deadbeef.js")).status).toBe(404);
  });
});
