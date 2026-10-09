// Expected values: 04-build-plan 2.7 items 2/5 and 02-tidepool 7.11, never runner output.
import { describe, expect, it } from "vitest";
import type { PoolEvent } from "../../src/protocol/events.ts";
import { fakeFloor, type FakeFloor } from "../soak/fake-floor.ts";
import { heroCommand, OUTPUT, parseArgs, runHero, type HeroDeps } from "./hero.ts";

const BUILD = "b".repeat(40);
const MAIN = "a".repeat(40);
const PLAIN = "c".repeat(40);
const ORIGIN = "https://rehearsal.example.test";
type Fault =
  | "late"
  | "wrong_tree"
  | "comment_only"
  | "j_headsup"
  | "skipped"
  | "wrong_rule"
  | "drop"
  | "http"
  | "silent"
  | "gap"
  | "stale_card"
  | "moving_head"
  | "late_j";

function fixture(fault?: Fault, reflected = "fixture-private-value") {
  let now = 1_800_000_000_000;
  let floor: FakeFloor;
  let pool = "";
  let n = 0;
  let seq = 0;
  let order: 1 | 2 = 1;
  let dropped = false;
  let stale = false;
  const history: PoolEvent[] = [];
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const reads: string[] = [];
  const outputs: string[] = [];
  const logs: string[] = [];
  const floors: FakeFloor[] = [];
  const browser: string[] = [];
  const emit = (body: Record<string, unknown>) => {
    const event = { n: ++n, ts: now, t: now, pool, src: "trunk", ...body } as unknown as PoolEvent;
    history.push(event);
    floor.push(event);
  };
  const aid = (p: string) => `attempt-${p}`;
  const hs = (pattern: string, rule: string) =>
    emit({
      type: "headsup.sent",
      attempt_id: aid(pattern),
      result: "repair",
      hn: 1,
      wake: true,
      cause: { type: "landing", seqs: [1], changes: [] },
      keys: [
        {
          kind: rule === "QR1" ? "query" : "entity",
          key: rule === "QR1" ? "refs:world/energy.js#ENERGY_MAX" : "world/energy.js#ENERGY_MAX",
          rule: fault === "wrong_rule" ? "F3" : rule,
        },
      ],
      items: [],
      dropped_ops: [],
      go_around: 1,
    });
  const land = (pattern: string) => {
    seq++;
    emit({
      type: "landing.accepted",
      seq,
      batch_id: seq,
      kind: "change",
      attempt_id: aid(pattern),
      change_id: `change-${pattern}`,
      intent_id: `intent-${pattern}`,
      request_id: null,
      paths: [],
      writes: [],
    });
    emit({
      type: "landing.landed",
      seq,
      batch_id: seq,
      commit: MAIN,
      tree: "d".repeat(40),
      note: "e".repeat(40),
      note_json: null,
      time_to_land_ms: 100,
    });
  };
  const card = (id: string) =>
    emit({
      type: "card.opened",
      card: {
        card_id: id,
        kind: "held",
        attempt_ids: [aid("hero-s")],
        intent_ids: ["intent-hero-s"],
        submit_ids: { [aid("hero-s")]: `submit-${id}` },
        title: "Land",
        body: [],
        options: [{ id: "land", label: "Land" }],
        paths: [],
        blast_radius: {},
        preview: null,
        candidates: null,
        risk: null,
        reason: "held_path",
      },
    });
  const plain = () =>
    emit({
      type: "plain.updated",
      commit: PLAIN,
      tree: "f".repeat(40),
      through_seq: 4,
      skipped: fault === "skipped" ? [2] : [],
      interrupted: order === 1 ? [2, 3] : [],
    });
  const deps: HeroDeps = {
    tag: "offline",
    budgetMs: 5000,
    pollMs: 10,
    now: () => now,
    sleep: async (ms) => {
      await new Promise<void>((r) => setImmediate(r));
      now += ms;
    },
    build: () => BUILD,
    write: (path, text) => {
      expect(path).toBe(OUTPUT);
      outputs.push(text);
    },
    log: (text) => logs.push(text),
    frames: async () => ({
      compare: async () => {
        browser.push("compare");
        return [
          { type: "stats", frame: "main" },
          { type: "stats", frame: "plain" },
        ];
      },
      probe: async (versions) => {
        expect(versions).toEqual({ main: `c-${MAIN}`, plain: `p-${PLAIN}` });
        browser.push("probe");
        return [
          { type: "stats", frame: "main", selftest: { ok: true } },
          { type: "stats", frame: "plain", selftest: { ok: false } },
        ];
      },
      close: async () => {
        browser.push("close");
      },
    }),
    service: {
      async postJson(path, raw) {
        const body = raw as Record<string, unknown>;
        requests.push({ path, body });
        if (fault === "http") throw new Error(reflected);
        if (path === "/api/pools") {
          pool = body.pool as string;
          n = seq = 0;
          history.length = 0;
          floor = fakeFloor();
          floors.push(floor);
          emit({
            type: "pool.state",
            head_seq: 0,
            head_commit: MAIN,
            landed_seq: 0,
            landed_commit: MAIN,
            green_seq: 0,
            state: "ready",
            reason: null,
            epoch: 0,
            remote: "https://git.example.test/main",
            plain_remote: "https://git.example.test/plain",
            rebuild: null,
            unwitnessed: [],
            real_agents: 0,
            max_real_agents: 0,
            synthetic: true,
            summary_only: false,
          });
          return { status: 201, body: { ok: true } };
        }
        if (Array.isArray(body.patterns)) {
          const patterns = body.patterns as string[];
          if (seq === 0 && !history.some((e) => e.type === "attempt.opened")) order = patterns[0] === "hero-s" ? 2 : 1;
          for (const pattern of patterns) {
            emit({
              type: "intent.created",
              intent_id: `intent-${pattern}`,
              text: pattern,
              requester: "swarm",
              race: false,
              prewritten: false,
            });
            emit({
              type: "attempt.opened",
              attempt_id: aid(pattern),
              intent_id: `intent-${pattern}`,
              change_id: `change-${pattern}`,
              agent: "synthetic",
              model: null,
              race: false,
            });
          }
          if (fault === "drop" && !dropped && patterns.includes("hero-c")) {
            floor.dropAll();
            dropped = true;
          }
          if (patterns.includes("hero-s")) {
            card("first");
            emit({
              type: "submit.result",
              attempt_id: aid("hero-s"),
              submit_id: "submit-first",
              status: "held",
              tier: "held",
              checks: [],
              duplicate: false,
            });
          } else if (order === 1) {
            for (const [pattern, path] of [
              ["hero-c", "creatures/crab.js"],
              ["hero-h", "creatures/shrimp.js"],
            ])
              emit({
                type: "op.recorded",
                attempt_id: aid(pattern!),
                op_seq: 1,
                op: "write",
                path,
                targets: [],
                altered: [],
                added: [],
                removed: [],
              });
          } else {
            land("hero-c");
            land("hero-h");
            land("hero-j");
            hs("hero-s", "QR1");
            emit({ type: "card.closed", card_id: "first", action: "stale", attempt_id: null });
            card("repaired");
          }
          return { status: 200, body: { launched: patterns.map(aid), released: [] } };
        }
        if (path.includes("/cards/")) {
          expect(body.submit_ids).toEqual({
            [aid("hero-s")]: stale ? "submit-latest" : order === 1 ? "submit-first" : "submit-repaired",
          });
          if (fault === "stale_card" && !stale) {
            stale = true;
            emit({ type: "card.closed", card_id: "repaired", action: "stale", attempt_id: null });
            card("latest");
            return { status: 200, body: { ok: true, stale: true } };
          }
          if (order === 1) {
            if (fault === "late") land("hero-c");
            hs("hero-c", "E2");
            hs("hero-h", "E2");
          }
          land("hero-s");
          if (order === 2) plain();
        } else if (Array.isArray(body.release)) {
          for (const pattern of ["hero-c", "hero-h", "hero-j"]) {
            if (fault !== "late" || pattern !== "hero-c") land(pattern);
          }
          if (fault === "j_headsup") hs("hero-j", "E2");
          plain();
        } else throw new Error("unexpected POST");
        return { status: 200, body: { ok: true } };
      },
      getJson: async () => {
        throw new Error("unexpected JSON GET");
      },
      getAuthed: async (path) => {
        expect(path).toBe(`/api/pools/${pool}/replay.ndjson`);
        const text = floor.exportNdjson(pool);
        return { status: 200, text: fault === "gap" ? text.replace('"n":2,', '"n":20,') : text };
      },
      getText: async (path) => {
        reads.push(path);
        const isPlain = path.includes(`/p-${PLAIN}/`);
        if (path.endsWith("world/energy.js")) return { status: 200, text: "export const ENERGY_MAX = 1;" };
        if (path.endsWith("creatures/crab.js"))
          return {
            status: 200,
            text:
              fault === "comment_only"
                ? "// crab.energy < 0.3\n"
                : `export function update(crab) { return crab.energy < ${isPlain ? 30 : fault === "wrong_tree" ? 30 : 0.3}; }`,
          };
        if (path.endsWith("creatures/shrimp.js")) {
          if (isPlain && fault === "moving_head") land("hero-j");
          if (isPlain && fault === "late_j") hs("hero-j", "E2");
          return { status: 200, text: `export function update(shrimp) { drain(shrimp, ${isPlain ? 5 : 0.05}); }` };
        }
        throw new Error("unexpected file");
      },
      probe: async (p) => floor.probe(p),
      socket: (p) => {
        if (fault !== "silent") return floor.socket(p);
        return { onopen: null, onclose: null, onerror: null, onmessage: null, send() {}, close() {} };
      },
    },
  };
  return { deps, outputs, logs, requests, reads, floors, browser };
}

describe("hero rehearsal (M4)", () => {
  it.each([1, 2] as const)("runs the conductor offline in order %i and checks both immutable trees", async (order) => {
    const f = fixture();
    const result = await runHero({ runs: 1, order }, ORIGIN, f.deps);
    const run = result.runs[0]!;
    expect(run.pass).toBe(true);
    expect(run.expected_rule).toBe(order === 1 ? "E2" : "QR1");
    expect(run.heads_up).toHaveLength(order === 1 ? 2 : 1);
    expect(run.heads_up.every((h) => h.sent_n! < h.landed_n!)).toBe(true);
    expect(run.main).toMatchObject({ energy_max: [1], crab_threshold: [0.3], shrimp_drain: [0.05], ok: true });
    expect(run.plain).toMatchObject({ energy_max: [1], crab_threshold: [30], shrimp_drain: [5], ok: true });
    expect(run.plain_skipped).toEqual([]);
    expect(run.j_heads_up).toBe(0);
    expect(run.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.deployment_host).toBe("rehearsal.example.test");
    expect(result.build).toBe(BUILD);
    expect(result.totals.m4).toBe("fail");
    expect(f.requests[0]?.body).toMatchObject({ seed: "tidepool", summary_only: false });
    expect(f.reads).toHaveLength(6);
    expect(f.browser).toEqual(order === 1 ? ["compare", "probe", "close"] : []);
    expect(f.floors.every((floor) => floor.sockets.every((s) => s.closed))).toBe(true);
  });

  it("requires 20/20, alternating 10 in each order, and checkpoints every run", async () => {
    const f = fixture();
    const result = await runHero(parseArgs([]), ORIGIN, f.deps);
    expect(result.runs.map((r) => r.order)).toEqual(Array.from({ length: 20 }, (_, i) => (i % 2) + 1));
    expect(result.totals).toEqual({ runs: 20, passed: 20, failed: 0, order_1: 10, order_2: 10, m4: "pass" });
    expect(new Set(result.runs.map((r) => r.pool)).size).toBe(20);
    expect(f.outputs).toHaveLength(20);
    expect(JSON.parse(f.outputs[0]!).totals.m4).toBe("fail");
  });

  it.each(["wrong_tree", "comment_only", "j_headsup", "skipped", "wrong_rule", "late", "gap"] as const)(
    "fails when %s",
    async (fault) => {
      const f = fixture(fault);
      const run = (await runHero({ runs: 1 }, ORIGIN, f.deps)).runs[0]!;
      expect(run.pass).toBe(false);
      if (fault === "late") expect(run.heads_up.find((h) => h.pattern === "hero-c")?.before_landing).toBe(false);
      if (fault === "wrong_tree") expect(run.main?.ok).toBe(false);
    },
  );

  it("reconnects with the last n and recovers snapshot-only operations from Replay", async () => {
    const f = fixture("drop");
    const result = await runHero({ runs: 1 }, ORIGIN, f.deps);
    expect(result.runs[0]?.pass).toBe(true);
    // Allow the reconnection task to finish its current microtask before inspecting sockets.
    expect(f.floors[0]!.sockets.length).toBeGreaterThan(1);
    const hellos = f.floors[0]!.sockets.map((s) => JSON.parse(s.sent[0]!));
    expect(hellos[0]).toEqual({ hello: 1, after: 0 });
    expect(hellos[1].after).toBeGreaterThan(0);
    expect(f.floors[0]!.sockets[1]!.frames.some((f) => "snapshot" in f)).toBe(true);
  });

  it("bounds an open socket that never delivers a frame", async () => {
    const f = fixture("silent");
    const result = await runHero({ runs: 1 }, ORIGIN, f.deps);
    expect(result.runs[0]).toMatchObject({ pass: false, error: "stream_ready" });
    expect(f.requests).toHaveLength(1);
  });

  it.each(["moving_head", "late_j"] as const)("refreshes final evidence after file reads: %s", async (fault) => {
    const f = fixture(fault);
    const run = (await runHero({ runs: 1 }, ORIGIN, f.deps)).runs[0]!;
    expect(run.pass).toBe(false);
    if (fault === "moving_head") expect(run.error).toBe("final_snapshot");
    else expect(run.j_heads_up).toBe(1);
  });

  it("refreshes the held card and submit echo after a stale HTTP 200", async () => {
    const f = fixture("stale_card");
    const result = await runHero({ runs: 1, order: 2 }, ORIGIN, f.deps);
    expect(result.runs[0]?.pass).toBe(true);
    const taps = f.requests.filter((r) => r.path.includes("/cards/"));
    expect(taps.map((t) => t.path.split("/").at(-1))).toEqual(["repaired", "latest"]);
    expect(taps[0]?.body.request_id).not.toBe(taps[1]?.body.request_id);
  });

  it("fails preflight before spending a pool and bounds browser teardown", async () => {
    const f = fixture();
    await expect(
      runHero({ runs: 1 }, ORIGIN, {
        ...f.deps,
        preflight: async () => {
          throw new Error("missing browser");
        },
      }),
    ).rejects.toThrow("missing browser");
    expect(f.requests).toHaveLength(0);
    const frames = f.deps.frames;
    f.deps.frames = async (pool) => ({ ...(await frames(pool)), close: () => new Promise(() => {}) });
    const result = await runHero({ runs: 1 }, ORIGIN, f.deps);
    expect(result.runs[0]).toMatchObject({ pass: false, error: "close_frames" });
  });

  it("never includes a reflected key in command outputs or measurement files", async () => {
    const key = 'private-"value\\fixture';
    const f = fixture("http", key);
    const code = await heroCommand(
      ["--runs", "1"],
      { PREMISE_URL: ORIGIN, PREMISE_OWNER_KEY: key },
      () => f.deps,
      (text) => f.logs.push(text),
    );
    expect(code).toBe(1);
    expect(f.outputs).toHaveLength(1);
    const output = f.outputs.join("") + f.logs.join("");
    expect(output).not.toContain(key);
    expect(output).not.toContain(JSON.stringify(key).slice(1, -1));
    expect(JSON.parse(f.outputs[0]!).runs[0].error).toBe("create_pool");
  });

  it("sanitizes config and output failures and never calls the service on invalid args", async () => {
    const f = fixture();
    const key = "private-fixture";
    const env = { PREMISE_URL: ORIGIN, PREMISE_OWNER_KEY: key };
    for (const argv of [[key], ["--runs", "21"], ["--order", "3"], ["--runs", "1", "--runs", "2"]]) {
      expect(
        await heroCommand(
          argv,
          env,
          () => {
            throw new Error(key);
          },
          (t) => f.logs.push(t),
        ),
      ).toBe(1);
    }
    expect(f.requests).toHaveLength(0);
    expect(
      await heroCommand(
        ["--runs", "1"],
        env,
        () => ({
          ...f.deps,
          write: () => {
            throw new Error(key);
          },
        }),
        (t) => f.logs.push(t),
      ),
    ).toBe(1);
    expect(f.logs.join("")).not.toContain(key);
  });
});
