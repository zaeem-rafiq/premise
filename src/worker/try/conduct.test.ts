// The try conductor's loop (09-try TY8, TY9) driven by a fake step and a fake `env`: a stand-in
// pool answers each launch, release and tap with the events TY8's rows wait for, so these tests
// see every Durable Object call the loop makes. What they pin:
//   - TY8: the launches, holds, release and tap of the table, in its order, and nothing else;
//   - TY9: a resumed instance replays its completed steps and repeats no call;
//   - TY7, TY9: the kill switch and a failed pool end the run.

import { describe, expect, it } from "vitest";
import type { Env } from "../env.ts";
import { patternById } from "../../swarm/pattern.ts";
import { projectEvent, runTry, type TryStep } from "./conduct.ts";

const POOL = "try-abcdefghij";

/** The engine's contract for `do` and `sleep`: a completed name returns its stored result. */
class FakeStep {
  readonly calls: string[] = [];
  readonly memo: Map<string, unknown>;
  constructor(memo = new Map<string, unknown>()) {
    this.memo = memo;
  }
  step(): TryStep {
    const self = this;
    return {
      do: ((name: string, configOrCb: unknown, maybeCb?: unknown) => {
        const callback = (maybeCb ?? configOrCb) as () => Promise<unknown>;
        self.calls.push(name);
        if (self.memo.has(name)) return Promise.resolve(self.memo.get(name));
        return callback().then((value) => {
          self.memo.set(name, value);
          return value;
        });
      }) as TryStep["do"],
      sleep: (name: string) => {
        self.calls.push(name);
        return Promise.resolve();
      },
    };
  }
}

type Call = { target: string; path: string; body: Record<string, unknown> | null };

/** A pool that plays TY8's scene: each call the conductor makes appends the events that follow. */
function fakePool(opts: { killed?: boolean; failAfterStart?: boolean } = {}) {
  const calls: Call[] = [];
  const events: Record<string, unknown>[] = [];
  const byPattern = new Map<string, string>();
  const held = new Map<string, string[]>();
  let seq = 0;
  const emit = (fields: Record<string, unknown>) => events.push({ n: events.length + 1, ...fields });
  const land = (attempt: string) => {
    seq += 1;
    emit({ type: "landing.accepted", seq, attempt_id: attempt });
    emit({ type: "landing.landed", seq, note_json: "{}" });
  };
  emit({ type: "pool.state", summary_only: false });
  emit({ type: "batch.pushed" });

  const answer = (target: string) => ({
    get: (_id: unknown) => ({
      fetch: async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname + new URL(url).search;
        const body = init?.body === undefined ? null : (JSON.parse(String(init.body)) as Record<string, unknown>);
        calls.push({ target, path, body });
        if (target === "GATE") return Response.json({ killed: opts.killed === true });
        if (target === "FLOOR") {
          const lines = [JSON.stringify({ premise_replay: 1 }), ...events.map((e) => JSON.stringify(e))];
          return new Response(lines.join("\n") + "\n");
        }
        if (target === "TRUNK" && path === "/internal/open-attempt") {
          const pattern = ["hero-s", "hero-c", "hero-h", "hero-j"].find(
            (p) => patternById(p)!.intent === body!.intent,
          )!;
          byPattern.set(pattern, String(body!.attempt_id));
          return Response.json({ ok: true, attempt_id: body!.attempt_id, change_id: "c", intent_id: body!.intent_id });
        }
        if (target === "TRUNK" && path === "/internal/swarm-hold") {
          held.set(String(body!.pattern), [String(body!.attempt_id)]);
          return Response.json({ ok: true });
        }
        if (target === "TRUNK" && path.startsWith("/internal/swarm-held")) {
          return Response.json({ attempts: held.get(new URL(url).searchParams.get("pattern") ?? "") ?? [] });
        }
        if (target === "AGENT" && path === "/open") {
          const attempt = String(body!.attempt_id);
          const pattern = String(body!.pattern);
          if (opts.failAfterStart === true) emit({ type: "pool.paused", reason: "test" });
          if (pattern === "hero-c") emit({ type: "op.recorded", path: "creatures/crab.js", attempt_id: attempt });
          if (pattern === "hero-h") emit({ type: "op.recorded", path: "creatures/shrimp.js", attempt_id: attempt });
          if (pattern === "hero-j") land(attempt);
          if (pattern === "hero-s") {
            emit({
              type: "card.opened",
              card: {
                card_id: "card-1",
                kind: "held",
                attempt_ids: [attempt],
                submit_ids: { [attempt]: "s_1" },
                options: [{ id: "land", label: "Land" }],
                title: "dropped by the projection",
              },
            });
          }
          return Response.json({ ok: true });
        }
        if (target === "TRUNK" && path === `/api/pools/${POOL}/cards/card-1`) {
          land(byPattern.get("hero-s")!);
          emit({ type: "headsup.sent", result: "repair", attempt_id: byPattern.get("hero-c") });
          emit({ type: "headsup.sent", result: "repair", attempt_id: byPattern.get("hero-h") });
          emit({ type: "card.closed", card_id: "card-1", action: "land" });
          return Response.json({ ok: true });
        }
        if (target === "AGENT" && path === "/release") {
          land(String(body!.attempt_id));
          return Response.json({ ok: true });
        }
        throw new Error(`unexpected ${target} ${path}`);
      },
    }),
    idFromName: (name: string) => name,
  });
  const env = {
    GATE: answer("GATE"),
    FLOOR: answer("FLOOR"),
    TRUNK: answer("TRUNK"),
    AGENT: answer("AGENT"),
  } as unknown as Env;
  return { env, calls, byPattern };
}

describe("TY8 TY9: the try conductor's loop", () => {
  it("TY8: launches J, C and H with C and H held, then S; taps Land with the card's submit ids; releases C and H", async () => {
    const pool = fakePool();
    const outcome = await runTry(pool.env, { pool: POOL }, new FakeStep().step());
    expect(outcome).toBe("done");
    const opens = pool.calls.filter((c) => c.target === "AGENT" && c.path === "/open");
    expect(opens.map((c) => [c.body!.pattern, c.body!.hold, c.body!.driver])).toEqual([
      ["hero-j", false, "scripted"],
      ["hero-c", true, "scripted"],
      ["hero-h", true, "scripted"],
      ["hero-s", false, "scripted"],
    ]);
    const taps = pool.calls.filter((c) => c.path.includes("/cards/"));
    expect(taps.map((c) => [c.body!.option, c.body!.submit_ids])).toEqual([
      ["land", { [pool.byPattern.get("hero-s")!]: "s_1" }],
    ]);
    const releases = pool.calls.filter((c) => c.target === "AGENT" && c.path === "/release");
    expect(releases.map((c) => c.body!.pattern)).toEqual(["hero-c", "hero-h"]);
  });

  it("TY9: a resumed instance replays its completed steps and makes no call again", async () => {
    const first = fakePool();
    const step = new FakeStep();
    expect(await runTry(first.env, { pool: POOL }, step.step())).toBe("done");
    const second = fakePool();
    const resumed = new FakeStep(step.memo);
    expect(await runTry(second.env, { pool: POOL }, resumed.step())).toBe("done");
    expect(second.calls).toEqual([]);
    expect(resumed.calls).toEqual(step.calls);
  });

  it("TY7: with the kill switch on, the conductor starts nothing and ends `killed`", async () => {
    const pool = fakePool({ killed: true });
    expect(await runTry(pool.env, { pool: POOL }, new FakeStep().step())).toBe("killed");
    expect(pool.calls.filter((c) => c.target === "AGENT" || c.target === "TRUNK")).toEqual([]);
  });

  it("TY9: a `pool.paused` ends the run `pool_failed`", async () => {
    const pool = fakePool({ failAfterStart: true });
    expect(await runTry(pool.env, { pool: POOL }, new FakeStep().step())).toBe("pool_failed");
    expect(pool.calls.filter((c) => c.target === "AGENT" && c.path === "/open").length).toBe(3);
  });
});

describe("TY9: what a read step keeps of an event", () => {
  it("TY9: the fields a row matches and a tap needs, nothing else", () => {
    expect(
      projectEvent({
        type: "card.opened",
        n: 9,
        t: 1,
        card: {
          card_id: "k",
          kind: "held",
          attempt_ids: ["a"],
          submit_ids: { a: "s" },
          options: [{ id: "land", label: "Land" }],
          body: ["long"],
        },
      }),
    ).toEqual({
      type: "card.opened",
      n: 9,
      card: { card_id: "k", kind: "held", attempt_ids: ["a"], submit_ids: { a: "s" }, options: ["land"] },
    });
    expect(projectEvent({ type: "landing.landed", n: 3, seq: 2, note_json: "{}", commit: "x" })).toEqual({
      type: "landing.landed",
      n: 3,
      seq: 2,
    });
  });
});
