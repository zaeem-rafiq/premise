// Slice 6 item 5 / M4. Effects are injected; the CLI only wires them to the deployment.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "acorn";
import type { PoolEvent } from "../../src/protocol/events.ts";
import type { Card } from "../../src/protocol/cards.ts";
import { versionToken } from "../../src/protocol/cards.ts";
import { heroConductor } from "../../src/swarm/conductor.ts";
import { httpService, type EngineService } from "../measure/engine/service.ts";
import { openPoolStream, parseReplayNdjson } from "../soak/stream.ts";

export const OUTPUT = "docs/measurements/rehearsal/hero-20.json";
const CAST = ["hero-s", "hero-c", "hero-h", "hero-j"] as const;
type Pattern = (typeof CAST)[number];
type Order = 1 | 2;
type Versions = { main: string; plain: string };
export type HeroFrames = {
  compare(): Promise<Record<string, unknown>[]>;
  probe(versions: Versions): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
};
export type HeroDeps = {
  service: EngineService;
  frames(pool: string): Promise<HeroFrames>;
  preflight?(): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Local git only: the commit checked out for this build. */
  build(): string;
  write(path: string, text: string): void;
  log(text: string): void;
  /** Unique pool namespace, supplied by the CLI's clock and process id. */
  tag: string;
  budgetMs?: number;
  pollMs?: number;
};
export type Options = { runs: number; order?: Order };
type TreeFacts = {
  commit: string;
  tree: string;
  energy_max: number[];
  crab_threshold: number[];
  shrimp_drain: number[];
  ok: boolean;
};
export type HeroRun = {
  run: number;
  pool: string;
  order: Order;
  duration_ms: number;
  conductor_complete: boolean;
  expected_rule: "E2" | "QR1";
  heads_up: Array<{ pattern: Pattern; sent_n: number | null; landed_n: number | null; before_landing: boolean }>;
  landing_order_ok: boolean;
  main: TreeFacts | null;
  plain: TreeFacts | null;
  plain_skipped: number[] | null;
  plain_interrupted: number[] | null;
  j_heads_up: number;
  events: number;
  error: string | null;
  pass: boolean;
};
export type HeroMeasurement = {
  v: 1;
  build: string;
  deployment_host: string;
  recorded_at: string;
  options: Options;
  runs: HeroRun[];
  totals: { runs: number; passed: number; failed: number; order_1: number; order_2: number; m4: "pass" | "fail" };
};

export function parseArgs(args: readonly string[]): Options {
  const result: Options = { runs: 20 };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === undefined || seen.has(flag)) throw new Error("invalid arguments");
    seen.add(flag);
    if (flag === "--runs" && value !== undefined && /^(?:[1-9]|1[0-9]|20)$/.test(value)) {
      result.runs = Number(value);
    } else if (flag === "--order" && (value === "1" || value === "2")) {
      result.order = Number(value) as Order;
    } else throw new Error("usage: node scripts/rehearse/hero.ts [--runs 1..20] [--order 1|2]");
  }
  return result;
}

function deployment(value: string): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("PREMISE_URL must be an HTTP origin without credentials");
  }
  return url;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** AST reads exclude comments and strings that merely quote the expected source. No pool code executes. */
function numbers(source: string, field: "energy" | "crab" | "shrimp"): number[] {
  const found: number[] = [];
  const ident = (node: unknown, name: string) => record(node).type === "Identifier" && record(node).name === name;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const n = record(value);
    let number: unknown;
    if (field === "energy" && n.type === "VariableDeclarator" && ident(n.id, "ENERGY_MAX"))
      number = record(n.init).value;
    if (field === "crab" && n.type === "BinaryExpression" && n.operator === "<") {
      const left = record(n.left);
      if (
        left.type === "MemberExpression" &&
        !left.computed &&
        ident(left.object, "crab") &&
        ident(left.property, "energy")
      )
        number = record(n.right).value;
    }
    if (field === "shrimp" && n.type === "CallExpression" && ident(n.callee, "drain")) {
      const args = n.arguments;
      if (Array.isArray(args) && args.length === 2 && ident(args[0], "shrimp")) number = record(args[1]).value;
    }
    if (typeof number === "number" && Number.isFinite(number)) found.push(number);
    for (const child of Object.values(n)) visit(child);
  };
  visit(parse(source, { ecmaVersion: "latest", sourceType: "module" }));
  return found;
}

function scoreEvents(result: HeroRun, events: readonly PoolEvent[], bindings: Map<Pattern, string>): void {
  const accepted = events.filter((e) => e.type === "landing.accepted");
  const landings = events.filter((e) => e.type === "landing.landed");
  const landingOf = (pattern: Pattern) => {
    const entry = accepted.find((e) => e.attempt_id === bindings.get(pattern));
    return entry === undefined ? undefined : landings.find((e) => e.seq === entry.seq);
  };
  const dependents: Pattern[] = result.order === 1 ? ["hero-c", "hero-h"] : ["hero-s"];
  result.heads_up = dependents.map((pattern) => {
    const sent = events.find(
      (e) =>
        e.type === "headsup.sent" &&
        e.attempt_id === bindings.get(pattern) &&
        e.result === "repair" &&
        e.keys.some(
          (k) =>
            k.rule === result.expected_rule &&
            k.key === (result.order === 1 ? "world/energy.js#ENERGY_MAX" : "refs:world/energy.js#ENERGY_MAX") &&
            k.kind === (result.order === 1 ? "entity" : "query"),
        ),
    );
    const landed = landingOf(pattern);
    return {
      pattern,
      sent_n: sent?.n ?? null,
      landed_n: landed?.n ?? null,
      before_landing: sent !== undefined && landed !== undefined && sent.n < landed.n,
    };
  });
  const s = landingOf("hero-s");
  result.landing_order_ok =
    landings.length === 4 &&
    s !== undefined &&
    CAST.slice(1).every((p) => {
      const creature = landingOf(p);
      return creature !== undefined && (result.order === 1 ? s.seq < creature.seq : creature.seq < s.seq);
    });
  result.j_heads_up = events.filter((e) => e.type === "headsup.sent" && e.attempt_id === bindings.get("hero-j")).length;
  result.events = events.length;
}

async function runOne(run: number, order: Order, deps: HeroDeps): Promise<HeroRun> {
  const pool = `hero-${deps.tag}-${run}`;
  const start = deps.now();
  const budget = deps.budgetMs ?? 10 * 60_000;
  const deadline = start + budget;
  const poll = deps.pollMs ?? 500;
  const result: HeroRun = {
    run,
    pool,
    order,
    duration_ms: 0,
    conductor_complete: false,
    expected_rule: order === 1 ? "E2" : "QR1",
    heads_up: [],
    landing_order_ok: false,
    main: null,
    plain: null,
    plain_skipped: null,
    plain_interrupted: null,
    j_heads_up: 0,
    events: 0,
    error: null,
    pass: false,
  };
  const bindings = new Map<Pattern, string>();
  const conductor = heroConductor(order, "tidepool");
  let events: PoolEvent[] = [];
  let cursor = 0;
  let actionId = 0;
  let stage = "create_pool";
  let stream: ReturnType<typeof openPoolStream> | undefined;
  let frames: HeroFrames | undefined;

  // Bound even a socket that opens but never sends a frame, and an HTTP/browser effect that hangs.
  const bounded = async <T>(effect: Promise<T>, until = deadline): Promise<T> => {
    let finished = false;
    try {
      return await Promise.race([
        effect,
        (async () => {
          while (!finished && deps.now() < until) await deps.sleep(Math.min(poll, until - deps.now()));
          if (!finished) throw new Error("deadline");
          return new Promise<T>(() => {});
        })(),
      ]);
    } finally {
      finished = true;
    }
  };
  const post = async (path: string, body: Record<string, unknown>): Promise<unknown> => {
    const response = await bounded(deps.service.postJson(path, { ...body, request_id: `${pool}-${++actionId}` }));
    if (response.status < 200 || response.status >= 300) throw new Error("http");
    return response.body;
  };
  const replay = async (): Promise<void> => {
    const response = await bounded(deps.service.getAuthed(`/api/pools/${pool}/replay.ndjson`));
    if (response.status !== 200) throw new Error("replay_http");
    const parsed = parseReplayNdjson(response.text);
    if (
      parsed.header?.pool !== pool ||
      parsed.header.events !== parsed.events.length ||
      parsed.events.some((e, i) => e.n !== i + 1 || e.pool !== pool) ||
      parsed.events.length < events.length
    )
      throw new Error("replay_gap");
    events = parsed.events;
  };
  const finals = () => ({
    main: events.findLast(
      (e): e is Extract<PoolEvent, { type: "landing.landed" }> => e.type === "landing.landed" && e.seq === 4,
    ),
    plain: events.findLast(
      (e): e is Extract<PoolEvent, { type: "plain.updated" }> => e.type === "plain.updated" && e.through_seq === 4,
    ),
  });
  const versions = (): Versions => {
    const f = finals();
    if (!f.main || !f.plain) throw new Error("finals_missing");
    return {
      main: versionToken({ repo: "main", commit: f.main.commit }),
      plain: versionToken({ repo: "plain", commit: f.plain.commit }),
    };
  };
  const perform = async (): Promise<void> => {
    for (;;) {
      const actions = conductor.takeActions();
      if (actions.length === 0) return;
      for (const action of actions) {
        stage = `conductor_${conductor.row}_${action.type}`;
        if (action.type === "start") {
          const body = record(
            await post("/api/swarm", {
              pool,
              running: true,
              seed: 7,
              agents: action.patterns.length,
              launch_per_second: 1,
              collision_dial: 0,
              think_ms: [0, 0],
              rescale_every_s: 0,
              patterns: action.patterns,
              hold_before_submit: action.hold_before_submit,
            }),
          );
          const launched = body.launched;
          if (
            !Array.isArray(launched) ||
            launched.length !== action.patterns.length ||
            launched.some((id) => typeof id !== "string") ||
            new Set(launched).size !== launched.length
          )
            throw new Error("launch_response");
          action.patterns.forEach((pattern, i) => {
            bindings.set(pattern as Pattern, launched[i] as string);
            conductor.bind(pattern, launched[i] as string);
          });
        } else if (action.type === "release") {
          await post("/api/swarm", { pool, running: true, release: action.patterns });
        } else if (action.type === "tap") {
          for (;;) {
            if (deps.now() >= deadline) throw new Error("deadline");
            // A later event in this same export may already supersede the card that advanced
            // the conductor. Use the newest open card, then recheck after a stale HTTP 200.
            const cards = new Map<string, Card>();
            for (const event of events) {
              if (event.type === "card.opened" || event.type === "card.updated")
                cards.set(event.card.card_id, event.card);
              if (event.type === "card.closed") cards.delete(event.card_id);
            }
            const card = [...cards.values()].findLast(
              (c) =>
                c.kind === "held" &&
                c.attempt_ids.includes(bindings.get("hero-s") ?? "") &&
                c.options.some((o) => o.id === action.option),
            );
            if (card) {
              const response = record(
                await post(`/api/pools/${pool}/cards/${encodeURIComponent(card.card_id)}`, {
                  option: action.option,
                  submit_ids: card.submit_ids,
                }),
              );
              if (response.ok !== true) throw new Error("card_response");
              if (response.stale !== true) break;
            }
            await deps.sleep(poll);
            await replay();
          }
        } else {
          frames ??= await bounded(deps.frames(pool));
          const stats = await bounded(action.type === "open_compare" ? frames.compare() : frames.probe(versions()));
          for (const stat of stats) conductor.observe(stat);
        }
      }
    }
  };
  try {
    await post("/api/pools", { pool, seed: "tidepool", summary_only: false });
    stage = "stream_ready";
    stream = openPoolStream(
      pool,
      { probe: deps.service.probe, socket: deps.service.socket, now: deps.now, sleep: deps.sleep },
      { deadlineMs: budget, reconnectMs: poll, probeMs: poll },
    );
    if (!(await bounded(stream.ready()))) throw new Error("stream_lost");
    await perform();
    for (;;) {
      stage = `conductor_${conductor.row}_events`;
      if (deps.now() >= deadline || stream.dead()) throw new Error("deadline");
      // Replay is the authority, including events hidden by a reconnect's snapshot. The stream
      // wakes these reads. Periodic reads also cover the export catching up to the latest frame.
      await replay();
      while (cursor < events.length) {
        const e = events[cursor++]!;
        if (e.type === "pool.state" && e.summary_only) throw new Error("summary_only");
        if (e.type === "pool.paused" || e.type === "trunk.error") throw new Error("pool_failed");
        conductor.observe(e as unknown as Record<string, unknown>);
        await perform();
      }
      if (conductor.done && finals().main && finals().plain) break;
      await stream.wait(Math.min(deadline, deps.now() + poll));
    }
    result.conductor_complete = conductor.done;
    stage = "final_trees";
    const readTree = async (repo: "main" | "plain"): Promise<TreeFacts> => {
      const final = finals()[repo]!;
      if (!/^[a-f0-9]{40}$/.test(final.commit) || !/^[a-f0-9]{40}$/.test(final.tree)) throw new Error("invalid_oid");
      const read = async (path: string) => {
        const response = await bounded(deps.service.getText(`/pool/${pool}/v/${versions()[repo]}/${path}`));
        if (response.status !== 200) throw new Error("file_read");
        return response.text;
      };
      const energy_max = numbers(await read("world/energy.js"), "energy");
      const crab_threshold = numbers(await read("creatures/crab.js"), "crab");
      const shrimp_drain = numbers(await read("creatures/shrimp.js"), "shrimp");
      const equal = (ns: number[], expected: number) => ns.length === 1 && ns[0] === expected;
      return {
        commit: final.commit,
        tree: final.tree,
        energy_max,
        crab_threshold,
        shrimp_drain,
        ok:
          equal(energy_max, 1) &&
          equal(crab_threshold, repo === "main" ? 0.3 : 30) &&
          equal(shrimp_drain, repo === "main" ? 0.05 : 5),
      };
    };
    result.main = await readTree("main");
    result.plain = await readTree("plain");
    stage = "close_frames";
    if (frames) {
      const closing = frames;
      frames = undefined;
      await bounded(closing.close(), deps.now() + 5000);
    }
    stage = "final_snapshot";
    await replay();
    const main = events.findLast((e) => e.type === "landing.landed");
    const plain = events.findLast((e) => e.type === "plain.updated");
    if (
      !main ||
      !plain ||
      main.seq !== 4 ||
      plain.through_seq !== 4 ||
      main.commit !== result.main.commit ||
      main.tree !== result.main.tree ||
      plain.commit !== result.plain.commit ||
      plain.tree !== result.plain.tree
    )
      throw new Error("head_moved");
    result.plain_skipped = plain.skipped;
    result.plain_interrupted = plain.interrupted;
  } catch (error) {
    // Never retain an exception or an HTTP body: either may contain a reflected owner key.
    result.error = stage;
    // REHEARSE_DEBUG=1 prints the message for diagnosis; deps.log redacts the key like every line.
    if (process.env.REHEARSE_DEBUG === "1")
      deps.log(`run ${run} stage ${stage}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    stream?.close();
    try {
      if (frames) await bounded(frames.close(), deps.now() + 5000);
    } catch {
      result.error ??= "close_frames";
    }
  }
  scoreEvents(result, events, bindings);
  result.duration_ms = Math.max(0, deps.now() - start);
  result.pass =
    result.error === null &&
    result.conductor_complete &&
    result.landing_order_ok &&
    result.heads_up.every((h) => h.before_landing) &&
    result.main?.ok === true &&
    result.plain?.ok === true &&
    result.plain_skipped?.length === 0 &&
    result.j_heads_up === 0;
  return result;
}

/** Runs sequentially and checkpoints after every run. Partial diagnostics cannot claim M4. */
export async function runHero(options: Options, origin: string, deps: HeroDeps): Promise<HeroMeasurement> {
  // Validate programmatic callers as strictly as the CLI, before making a pool.
  parseArgs([
    "--runs",
    String(options.runs),
    ...(options.order === undefined ? [] : ["--order", String(options.order)]),
  ]);
  if (!/^[a-z0-9-]+$/.test(deps.tag)) throw new Error("invalid run tag");
  const url = deployment(origin);
  const build = deps.build();
  if (!/^[a-f0-9]{40}$/.test(build)) throw new Error("invalid build commit");
  await deps.preflight?.();
  const measurement: HeroMeasurement = {
    v: 1,
    build,
    deployment_host: url.host,
    recorded_at: new Date(deps.now()).toISOString(),
    options,
    runs: [],
    totals: { runs: 0, passed: 0, failed: 0, order_1: 0, order_2: 0, m4: "fail" },
  };
  for (let i = 0; i < options.runs; i++) {
    const result = await runOne(i + 1, options.order ?? (i % 2 === 0 ? 1 : 2), deps);
    measurement.runs.push(result);
    const t = measurement.totals;
    t.runs++;
    if (result.pass) t.passed++;
    else t.failed++;
    if (result.order === 1) t.order_1++;
    else t.order_2++;
    t.m4 = t.runs === 20 && t.passed === 20 && t.order_1 === 10 && t.order_2 === 10 ? "pass" : "fail";
    deps.write(OUTPUT, JSON.stringify(measurement, null, 2) + "\n");
    deps.log(
      `run ${result.run} order ${result.order}: ${result.pass ? "pass" : "FAIL"}${result.error ? ` (${result.error})` : ""}`,
    );
  }
  return measurement;
}

/** All command outputs are sanitized, including configuration, browser and disk failures. */
export async function heroCommand(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  makeDeps: (origin: string, key: string) => HeroDeps,
  report: (text: string) => void,
): Promise<number> {
  const key = env.PREMISE_OWNER_KEY ?? "";
  const clean = (text: string) => (key === "" ? text : text.split(key).join("[redacted]"));
  try {
    const options = parseArgs(argv);
    if (!env.PREMISE_URL || !key) throw new Error("configuration");
    const origin = deployment(env.PREMISE_URL).origin;
    const deps = makeDeps(origin, key);
    const result = await runHero(options, origin, {
      ...deps,
      log: (text) => report(clean(text)),
      write: (path, text) => {
        // Refuse any unexpected reflection rather than writing altered measurement facts.
        if (text.includes(key) || text.includes(JSON.stringify(key).slice(1, -1))) throw new Error("secret_in_output");
        deps.write(path, text);
      },
    });
    report(clean(`M4 ${result.totals.m4}: ${result.totals.passed}/${result.totals.runs}; ${OUTPUT}`));
    return result.totals.m4 === "pass" ? 0 : 1;
  } catch (error) {
    report(
      clean(
        "rehearse:hero failed. Check arguments, environment, browser installation and output permissions; no exception details are printed.",
      ),
    );
    // REHEARSE_DEBUG=1 prints the error itself, with the owner key redacted like every other line.
    if (env.REHEARSE_DEBUG === "1")
      report(clean(error instanceof Error ? (error.stack ?? error.message) : String(error)));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { openHeroFrames } = await import("./browser.ts");
  process.exitCode = await heroCommand(
    process.argv.slice(2),
    process.env,
    (origin, key) => ({
      service: httpService({ origin, ownerKey: key }),
      preflight: async () => {
        // Launch and close the browser the frames use: Playwright may install only its headless
        // shell, so the full Chromium's executablePath() is no test of what can run.
        const { chromium } = await import("@playwright/test");
        const browser = await chromium.launch();
        await browser.close();
      },
      frames: (pool) => openHeroFrames(origin, pool),
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      build: () =>
        execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
      write: (path, text) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
      },
      log: (text) => process.stdout.write(text + "\n"),
      tag: `${Date.now().toString(36)}-${process.pid}`,
    }),
    (text) => process.stdout.write(text + "\n"),
  );
}
