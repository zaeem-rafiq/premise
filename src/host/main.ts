// The pool host (02-tidepool 4.5): platform code that runs one pool version inside a sandboxed frame.
// Start-up order is fixed by the spec: HO2 (seeded Math.random), then PN9 (frozen built-ins), then
// HO1 (imports). Everything DOM-facing goes through HostEnv so the same code runs in a Node harness.

import {
  DEFAULT_GLOBALS,
  HEAD_POLL_MS,
  HIGHLIGHT_COLOUR,
  HIGHLIGHT_RADIUS,
  HIGHLIGHT_WIDTH,
  HOST_MAX_CATCH_UP,
  HOST_SEED,
  MAX_ADOPTS,
  MAX_KINDS,
  STATS_EVERY_MS,
  SWAP_MIN_MS,
} from "../protocol/constants.ts";
import type { FloorToPool } from "../protocol/channel.ts";
import { browserEnv, type HostEnv } from "./env.ts";
import { mulberry32 } from "./mulberry.ts";
import { createSurface, type Surface } from "./surface.ts";

/** The `landed` export of a generated `~head.js` (4.4), and the value HO14 builds for `advance`. */
export type Landed = {
  pool: string;
  source: string;
  version: string;
  /** Base URL of the version's files, ending in `/` (`/pool/<pool>/v/<version>/` in the browser). */
  base: string;
  seq: number | null;
};

type RegistryKind = { kind: string; path: string; oid: string };

/** The `registry` export of a generated `~registry.js` (4.4). */
export type Registry = {
  version: string;
  shared: string;
  kinds: RegistryKind[];
  total: number;
  skipped: unknown[];
};

type PoolModule = {
  poolSize(): { width: number; height: number };
  createPool(kinds: Record<string, unknown>): unknown;
  adoptPool(pool: unknown, kinds: Record<string, unknown>, changed: string[]): unknown;
  tick(pool: unknown): void;
  draw(pool: unknown, control: unknown): unknown;
  creatureAt(pool: unknown, x: number, y: number): { kind: string; id: number } | null;
  stats(pool: unknown): {
    tick: number;
    kinds: Record<string, { count: number; resting: number; errors: number; benched: boolean }>;
  };
};

type PenModule = { createPen(surface: Surface): unknown };

type SelfTestModule = {
  runSelfTest(args: { kinds: Record<string, unknown>; reseed: (seed: number) => void; ticks?: number }): {
    ok: boolean;
    failed: Array<{ name: string; kind?: string | null }>;
  };
};

/** The stream behind `Math.random` while this host runs (HO2); `reseed` swaps it. */
let hostRng = mulberry32(HOST_SEED);

const KIND_NAME = /^[a-z][a-z0-9-]{0,30}$/;
const VERSION_TOKEN = /^[cp]-[0-9a-f]{40}$/;
const COMMIT_SEGMENT = /^[0-9a-f]{40}$/;

/** A kind name of 2.6: the pattern, minus the reserved word. */
export function isKindName(name: string): boolean {
  return KIND_NAME.test(name) && name !== "constructor";
}

/** A commit source segment (4.1): `<40 hex>` or `p-<40 hex>`. */
export function isCommitSource(source: string): boolean {
  return COMMIT_SEGMENT.test(source) || /^p-[0-9a-f]{40}$/.test(source);
}

/** PN9: freeze the objects named in DEFAULT_GLOBALS, their prototypes, and Function.prototype. */
function freezeBuiltins(): void {
  const g = globalThis as Record<string, unknown>;
  const freeze = (value: unknown) => {
    if (value !== null && (typeof value === "object" || typeof value === "function")) Object.freeze(value);
  };
  for (const name of DEFAULT_GLOBALS) {
    const value = g[name];
    freeze(value);
    if ((typeof value === "object" || typeof value === "function") && value !== null) {
      freeze((value as { prototype?: unknown }).prototype);
    }
  }
  freeze(Function.prototype);
}

/** HO17: a message counts only when `data` has the shape of a FloorToPool member. */
function asFloorMessage(data: unknown): FloorToPool | null {
  if (typeof data !== "object" || data === null) return null;
  const type = (data as { type?: unknown }).type;
  switch (type) {
    case "pause":
    case "resume":
      return { type };
    case "probe": {
      const selftest = (data as { selftest?: unknown }).selftest;
      if (selftest !== undefined && typeof selftest !== "boolean") return null;
      return { type: "probe", selftest };
    }
    case "advance": {
      const version = (data as { version?: unknown }).version;
      return typeof version === "string" ? { type: "advance", version } : null;
    }
    case "highlight": {
      const kinds = (data as { kinds?: unknown }).kinds;
      if (!Array.isArray(kinds) || kinds.length > MAX_KINDS) return null;
      if (!kinds.every((kind) => typeof kind === "string" && isKindName(kind))) return null;
      return { type: "highlight", kinds };
    }
    default:
      return null;
  }
}

function asLanded(value: unknown): Landed | null {
  if (typeof value !== "object" || value === null) return null;
  const landed = value as Record<string, unknown>;
  if (
    typeof landed.pool !== "string" ||
    typeof landed.source !== "string" ||
    typeof landed.version !== "string" ||
    !VERSION_TOKEN.test(landed.version) ||
    typeof landed.base !== "string" ||
    (landed.seq !== null && typeof landed.seq !== "number")
  ) {
    return null;
  }
  return landed as unknown as Landed;
}

function asRegistry(value: unknown, version: string): Registry | null {
  if (typeof value !== "object" || value === null) return null;
  const registry = value as Record<string, unknown>;
  if (registry.version !== version || typeof registry.shared !== "string" || !Array.isArray(registry.kinds)) {
    return null;
  }
  const kinds: RegistryKind[] = [];
  for (const entry of registry.kinds as unknown[]) {
    const kind = entry as Record<string, unknown>;
    if (
      typeof kind !== "object" ||
      kind === null ||
      typeof kind.kind !== "string" ||
      !isKindName(kind.kind) ||
      typeof kind.path !== "string" ||
      typeof kind.oid !== "string"
    ) {
      return null;
    }
    kinds.push({ kind: kind.kind, path: kind.path, oid: kind.oid });
  }
  return {
    version,
    shared: registry.shared,
    kinds,
    total: typeof registry.total === "number" ? registry.total : kinds.length,
    skipped: Array.isArray(registry.skipped) ? registry.skipped : [],
  };
}

function intParam(params: URLSearchParams, name: string, fallback: number): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Run the host inside `env`. Resolves once start-up is done (a dead pool still resolves — the frame
 * then stays silent so the Floor's stall watchdog can reload it, HO8).
 */
export async function runHost(env: HostEnv, landed: Landed): Promise<void> {
  let pageUrl: URL;
  try {
    pageUrl = new URL(env.pageUrl);
  } catch {
    return; // a host without a page URL cannot reach its modules
  }
  const params = pageUrl.searchParams;
  const follow = params.get("follow") !== "0";
  let paused = params.get("paused") === "1";

  // ---- HO2: seeded Math.random, installed before any pool module is imported. ----
  // The dispatcher is assigned once per realm — after PN9 freezes `Math` a second host in the
  // same realm (a test only; a frame is always fresh) seeds by reseeding the stream it reads.
  try {
    Math.random = () => hostRng();
  } catch {
    /* Math already frozen: the dispatcher is in place */
  }
  const reseed = (seed: number) => {
    hostRng = mulberry32(seed);
  };
  reseed(intParam(params, "seed", HOST_SEED));

  // ---- PN9: freeze the built-ins of DEFAULT_GLOBALS, their prototypes, Function.prototype. ----
  freezeBuiltins();

  // ---- HO1: canvas, surface, registry and modules, pen and pool. ----
  const canvas = env.canvas;
  const surface = canvas ? createSurface(canvas, env.pixelRatio) : null;

  // `landed.base` is a path (`/pool/<pool>/v/<version>/`) in the frame and a `file:` URL in tests.
  const fileUrl = (base: string, path: string) => new URL(path, new URL(base, pageUrl)).href;
  const headUrl = (counter: number) => new URL(`./~head.js?n=${counter}`, pageUrl).href;

  let registry: Registry | null = null;
  let main: PoolModule | null = null;
  let pen: PenModule | null = null;
  let ticksPerSecond = 60; // world/time.js#TICKS_PER_SECOND; 60 is the spec value
  const modules = new Map<string, Record<string, unknown>>(); // kind -> module
  const oids = new Map<string, string>(); // kind -> blob id of the module actually loaded
  const importFailed = new Set<string>(); // kinds the last load attempt dropped (HO1)
  let pool: unknown = null;
  let control: unknown = null;
  let dead = false;

  const importJson = async <T>(specifier: string, read: (mod: Record<string, unknown>) => T | null) => {
    const mod = (await env.importModule(specifier)) as Record<string, unknown>;
    const value = read(mod);
    if (value === null) throw new Error(`bad module: ${specifier}`);
    return value;
  };

  const loadRegistry = (base: string, version: string): Promise<Registry> =>
    importJson(fileUrl(base, "~registry.js"), (mod: Record<string, unknown>) => asRegistry(mod.registry, version));

  const loadKind = async (base: string, entry: RegistryKind) => {
    const mod = (await env.importModule(fileUrl(base, entry.path))) as Record<string, unknown>;
    if (typeof mod.spawn !== "function" || typeof mod.update !== "function" || typeof mod.draw !== "function") {
      throw new Error(`bad creature module: ${entry.kind}`);
    }
    return mod;
  };

  /** Swap state (4.7): at most one in flight, at most one start every SWAP_MIN_MS (HO10). */
  let running = landed; // the version the pool is running
  let swapBusy = false;
  let lastSwapAt = -Infinity;
  let pendingProbe = false;
  let pendingAdvance: Landed | null = null;
  let flushTimer: number | null = null;
  let lastSwap: { mode: "adopt" | "restart"; arrived: string[]; failed: string[] } | null = null;
  let lastSelftest: { version: string; ok: boolean; failed: Array<{ name: string; kind: string | null }> } | null =
    null;
  let adopts = 0;
  let headCounter = 0;
  const highlight = new Set<string>();
  let broken = false; // pool code threw mid-run: keep reporting, stop ticking (HO8 stays a Floor concern)

  const commitFrame = isCommitSource(running.source); // never becomes false: a live frame ignores advance

  const statsMessage = () => {
    const body = {
      type: "stats" as const,
      source: running.source,
      version: running.version,
      seq: running.seq,
      tick: 0,
      paused,
      kinds: {} as Record<string, { count: number; resting: number; errors: number; benched: boolean }>,
      shown: modules.size,
      total: registry?.total ?? 0,
      swap: lastSwap,
      selftest: lastSelftest,
    };
    if (pool && main) {
      try {
        const stats = main.stats(pool);
        body.tick = typeof stats.tick === "number" ? stats.tick : 0;
        body.kinds = stats.kinds ?? {};
      } catch {
        /* a stats() that throws leaves the zero defaults */
      }
    }
    return body;
  };

  const postStats = () => {
    if (dead) return; // HO8: a pool that never got started stays silent so the Floor can reload it
    env.postMessage(statsMessage());
  };

  /** The restart of 4.7 step 2: a live frame reloads; a commit frame navigates to the new address. */
  const restart = (next: Landed) => {
    if (commitFrame) {
      const segment = next.version.startsWith("c-") ? next.version.slice(2) : next.version;
      env.navigate(`/pool/${next.pool}/${segment}/${pageUrl.search}`);
    } else {
      env.reload();
    }
  };

  const swapTo = async (next: Landed): Promise<void> => {
    swapBusy = true;
    lastSwapAt = env.now();
    try {
      // Step 1: the new registry. A failure keeps the running version and reports ["*"] (HO12).
      let nextRegistry: Registry;
      try {
        nextRegistry = await loadRegistry(next.base, next.version);
      } catch {
        lastSwap = { mode: "adopt", arrived: [], failed: ["*"] };
        postStats();
        return;
      }
      // Step 2: shared files changed -> restart.
      if (registry !== null && nextRegistry.shared !== registry.shared) {
        lastSwap = { mode: "restart", arrived: [], failed: [] };
        postStats();
        restart(next);
        return;
      }
      // Step 3: creature-only change -> adopt.
      const nextEntries = new Map(nextRegistry.kinds.map((entry) => [entry.kind, entry]));
      const changed = nextRegistry.kinds.filter((entry) => oids.get(entry.kind) !== entry.oid).map((e) => e.kind);
      const arrived: string[] = [];
      const failed: string[] = [];
      const nextModules = new Map<string, Record<string, unknown>>();
      for (const entry of nextRegistry.kinds) {
        if (!changed.includes(entry.kind)) {
          const existing = modules.get(entry.kind);
          if (existing) {
            nextModules.set(entry.kind, existing);
            continue;
          }
        }
        try {
          nextModules.set(entry.kind, await loadKind(next.base, entry));
          arrived.push(entry.kind);
        } catch {
          const existing = modules.get(entry.kind);
          if (existing && nextEntries.get(entry.kind)) {
            nextModules.set(entry.kind, existing); // keeps its old module (4.7.3.ii)
          }
          failed.push(entry.kind);
        }
      }
      if (main && pool) {
        const kinds: Record<string, unknown> = {};
        for (const [kind, mod] of nextModules) kinds[kind] = mod;
        try {
          pool = main.adoptPool(pool, kinds, arrived);
        } catch {
          /* adoptPool throwing keeps the old pool; the swap still reports */
        }
      }
      modules.clear();
      for (const [kind, mod] of nextModules) modules.set(kind, mod);
      for (const entry of nextRegistry.kinds) {
        if (nextModules.has(entry.kind)) oids.set(entry.kind, entry.oid);
      }
      for (const kind of [...oids.keys()]) if (!nextModules.has(kind)) oids.delete(kind);
      registry = nextRegistry;
      running = next;
      importFailed.clear();
      for (const kind of failed) if (!modules.has(kind)) importFailed.add(kind);
      adopts += 1;
      lastSwap = { mode: "adopt", arrived, failed };
      postStats();
      if (adopts >= MAX_ADOPTS) restart(next); // 4.7 step 5: release old module graphs
    } finally {
      swapBusy = false;
      flushPending();
    }
  };

  /** HO10: at most one swap every SWAP_MIN_MS; a probe or the newest advance is remembered. */
  const requestSwap = (next: Landed, cause: "probe" | "advance") => {
    const wait = SWAP_MIN_MS - (env.now() - lastSwapAt);
    if (swapBusy || wait > 0) {
      if (cause === "advance") pendingAdvance = next;
      else pendingProbe = true;
      if (flushTimer === null) {
        flushTimer = env.setTimeout(flushPending, Math.max(1, wait));
      }
      return;
    }
    void swapTo(next);
  };

  const flushPending = () => {
    if (flushTimer !== null) {
      env.clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (swapBusy) return;
    const wait = SWAP_MIN_MS - (env.now() - lastSwapAt);
    if (wait > 0) {
      flushTimer = env.setTimeout(flushPending, Math.max(1, wait));
      return;
    }
    // HO10: the newest pending advance wins; a pending probe re-runs the step of 4.6.
    const next = pendingAdvance;
    const probe = pendingProbe;
    pendingAdvance = null;
    pendingProbe = false;
    if (next !== null) void swapTo(next);
    else if (probe) void lookForNewVersion();
  };

  /** The step of 4.6: re-import `./~head.js` and swap when `landed.version` moved. */
  const lookForNewVersion = async () => {
    try {
      const mod = (await env.importModule(headUrl(++headCounter))) as Record<string, unknown>;
      const next = asLanded(mod.landed);
      if (!next || next.version === running.version) return;
      requestSwap(next, "probe");
    } catch {
      /* an unreadable ~head.js is a no-op; the next poll retries */
    }
  };

  const runSelftest = async () => {
    if (!running) return;
    const before = hostRng; // the self-test reseeds Math.random; restore the host's stream after it
    try {
      const mod = (await env.importModule(fileUrl(running.base, "selftest/run.js"))) as SelfTestModule;
      if (typeof mod.runSelfTest !== "function") throw new Error("no runSelfTest");
      const kinds: Record<string, unknown> = {};
      for (const [kind, m] of modules) kinds[kind] = m;
      const verdict = mod.runSelfTest({ kinds, reseed });
      lastSelftest = {
        version: running.version,
        ok: Boolean(verdict?.ok),
        failed: Array.isArray(verdict?.failed)
          ? verdict.failed.map((f) => ({ name: String(f?.name ?? ""), kind: f?.kind ?? null }))
          : [],
      };
    } catch {
      lastSelftest = { version: running.version, ok: false, failed: [{ name: "selftest", kind: null }] };
    } finally {
      hostRng = before;
    }
  };

  /** Draw one frame plus the host's own highlight rings (HO15: its own surface, world plain data). */
  const drawFrame = () => {
    if (!main || !control || !pool) return;
    try {
      main.draw(pool, control);
    } catch {
      /* a draw that throws skips the frame; the world guard counts per-creature failures */
    }
    if (!surface || highlight.size === 0) return;
    const world = (pool as { world?: { creatures?: Array<{ kind?: string; x?: number; y?: number }> } }).world;
    for (const creature of world?.creatures ?? []) {
      if (
        typeof creature?.kind !== "string" ||
        !highlight.has(creature.kind) ||
        typeof creature.x !== "number" ||
        typeof creature.y !== "number"
      ) {
        continue;
      }
      const s = surface.surface;
      s.push(creature.x, creature.y, HIGHLIGHT_RADIUS + HIGHLIGHT_WIDTH);
      s.style(null, HIGHLIGHT_COLOUR, HIGHLIGHT_WIDTH, 1);
      s.circle(0, 0, HIGHLIGHT_RADIUS);
      s.pop();
    }
  };

  /** HO4: fixed step, at most HOST_MAX_CATCH_UP ticks per frame, then one draw. */
  let lastFrameAt: number | null = null;
  let acc = 0;
  let wasIdle = false;
  const onFrame = (now: number) => {
    env.requestFrame(onFrame);
    if (lastFrameAt === null) {
      lastFrameAt = now;
      return;
    }
    const elapsed = now - lastFrameAt;
    lastFrameAt = now;
    if (dead || broken || !pool || paused || env.hidden()) {
      acc = 0;
      wasIdle = true;
      return;
    }
    acc += wasIdle ? 0 : elapsed; // a paused or hidden span is not banked — pool time stands still
    wasIdle = false;
    const tickMs = 1000 / ticksPerSecond;
    const due = Math.floor(acc / tickMs);
    if (due <= 0) return;
    const run = Math.min(due, HOST_MAX_CATCH_UP);
    acc = due > run ? 0 : acc - run * tickMs; // a backlog beyond the cap is dropped, not played back
    try {
      for (let i = 0; i < run; i += 1) main?.tick(pool);
    } catch {
      broken = true; // shared code threw: stop ticking, keep reporting the frozen tick
      return;
    }
    drawFrame();
  };

  env.onPointerDown((clientX, clientY) => {
    if (!canvas || !main || !pool) return;
    const rect = canvas.rect();
    const size = main.poolSize();
    const scale = Math.min(rect.width / size.width, rect.height / size.height);
    if (!(scale > 0)) return;
    const x = (clientX - rect.left - (rect.width - size.width * scale) / 2) / scale;
    const y = (clientY - rect.top - (rect.height - size.height * scale) / 2) / scale;
    const hit = main.creatureAt(pool, x, y);
    if (!hit) return;
    const entry = registry === null ? undefined : registry.kinds.find((kind) => kind.kind === hit.kind);
    if (!entry) return;
    env.postMessage({ type: "tapped", creature: hit.kind, path: entry.path });
  });

  env.onMessage((data, event) => {
    if (event.source !== env.parentWindow) return; // HO17
    const message = asFloorMessage(data);
    if (!message) return;
    switch (message.type) {
      case "pause":
        paused = true;
        break;
      case "resume":
        paused = false;
        break;
      case "highlight":
        highlight.clear();
        for (const kind of message.kinds) highlight.add(kind);
        break;
      case "advance": {
        // HO14: commit frames only, `^[cp]-[0-9a-f]{40}$`, same prefix as the running version.
        const valid =
          commitFrame &&
          VERSION_TOKEN.test(message.version) &&
          message.version.slice(0, 2) === running.version.slice(0, 2);
        if (valid) {
          const version = message.version;
          const source = version.startsWith("c-") ? version.slice(2) : version;
          const next: Landed = {
            pool: running.pool,
            source,
            version,
            base: `/pool/${running.pool}/v/${version}/`,
            seq: null,
          };
          requestSwap(next, "advance");
        }
        postStats(); // every advance is answered (HO7), even an ignored one
        break;
      }
      case "probe":
        void (async () => {
          // HO9/HO16: live frames look for a new version; commit frames and follow=0 never do.
          if (!commitFrame && follow && !dead) await lookForNewVersion();
          if (message.selftest && !dead) await runSelftest();
          postStats();
        })();
        break;
    }
  });

  // ---- The imports of HO1, after HO2 and PN9. ----
  try {
    registry = await loadRegistry(landed.base, landed.version);
    main = (await env.importModule(fileUrl(landed.base, "main.js"))) as PoolModule;
    pen = (await env.importModule(fileUrl(landed.base, "pen.js"))) as PenModule;
    if (
      typeof main.poolSize !== "function" ||
      typeof main.createPool !== "function" ||
      typeof main.adoptPool !== "function" ||
      typeof main.tick !== "function" ||
      typeof main.draw !== "function" ||
      typeof main.creatureAt !== "function" ||
      typeof main.stats !== "function" ||
      typeof pen.createPen !== "function"
    ) {
      throw new Error("bad pool modules");
    }
    try {
      const time = (await env.importModule(fileUrl(landed.base, "world/time.js"))) as Record<string, unknown>;
      if (typeof time.TICKS_PER_SECOND === "number" && time.TICKS_PER_SECOND > 0) {
        ticksPerSecond = time.TICKS_PER_SECOND;
      }
    } catch {
      /* keep the spec default */
    }
    for (const entry of registry.kinds) {
      try {
        const mod = await loadKind(landed.base, entry);
        modules.set(entry.kind, mod);
        oids.set(entry.kind, entry.oid);
      } catch {
        importFailed.add(entry.kind);
      }
    }
    if (!surface) throw new Error("no canvas");
    control = pen.createPen(surface.surface);
    const size = main.poolSize();
    surface.fit(size.width, size.height);
    pool = main.createPool(Object.fromEntries(modules));
  } catch {
    dead = true;
    return;
  }

  // Timers: the heartbeat of HO7, and the slow self-check of 4.6 (moving sources only, HO9).
  env.setInterval(postStats, STATS_EVERY_MS);
  if (!commitFrame && follow) {
    env.setInterval(() => void lookForNewVersion(), HEAD_POLL_MS);
  }
  env.requestFrame(onFrame);
  postStats(); // the first stats a new page sends; the Floor answers with its highlight set (HO15)
}

/**
 * The entry `~boot.js` calls (4.4). `importModule` is passed in because a checked `src/` file may not
 * hold a computed `import()`: generated code carries it instead.
 */
export function startHost(landed: Landed, importModule: (specifier: string) => Promise<unknown>): void {
  void runHost(browserEnv(importModule), landed);
}
