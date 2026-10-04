// test/cases/driver.ts — plays one vector of docs/spec/premise-cases.json against the engine
// (01-core Appendix A): the pool's seed files become the head at seq 0, every step of `steps`
// is one synchronous call, and every `expect` and the `final` block are compared against the
// engine's answers and its per-call trace.
//
// Expected values come from the vector file and the specification only (BP1): `at: n` inside a
// premise expectation asks for the key's hash in the pool's own head after landing n, computed
// here through `keyHash`/`fileMapAt` — the same hash functions 2.5 defines, never a stored copy.

import { DatabaseSync } from "node:sqlite";
import type { Sql } from "../../src/protocol/ports.ts";
import type { ToolRequest, ToolResponse } from "../../src/protocol/tools.ts";
import type { Vector } from "./load.ts";
import { Trunk, type Pool } from "../../src/core/trunk/registry.ts";
import { keyHash } from "../../src/core/trunk/sets.ts";
import { ABSENT } from "../../src/protocol/premise.ts";
import { ScriptedTriage } from "../../src/swarm/scripted-triage.ts";

/** `node:sqlite` speaks the `Sql` port (it stands in for the Durable Object's storage). */
export function sqlOver(db: DatabaseSync): Sql {
  return {
    exec: (query, ...bindings) => {
      const rows = db.prepare(query).all(...bindings) as Array<Record<string, unknown>>;
      return { toArray: () => rows };
    },
    transaction: (run) => {
      db.exec("BEGIN");
      try {
        const r = run();
        db.exec("COMMIT");
        return r;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

type StepRecord = { resp: ToolResponse | null; extra: Record<string, unknown> };

/** Recursive subset match: every member of `want` must equal the member of the same name in `got`. */
function subset(want: unknown, got: unknown): boolean {
  if (want === null || typeof want !== "object") return want === got;
  if (Array.isArray(want)) {
    if (!Array.isArray(got) || want.length !== got.length) return false;
    return want.every((w, i) => subset(w, got[i]));
  }
  if (got === null || typeof got !== "object" || Array.isArray(got)) return false;
  const g = got as Record<string, unknown>;
  return Object.entries(want as Record<string, unknown>).every(([k, v]) => subset(v, g[k]));
}

/** The vectors' heads-up items already match the trace's flat item shape; `after_contains` is a
 * substring check against the item's `after` source (Appendix A's own shorthand). */
function itemMatches(want: Record<string, unknown>, got: Record<string, unknown>): boolean {
  return Object.entries(want).every(([k, v]) => {
    if (k === "after_contains") return typeof got.after === "string" && got.after.includes(String(v));
    return subset(v, got[k]);
  });
}

function flatItem(it: unknown): Record<string, unknown> {
  if (it === null || typeof it !== "object") return {};
  return { ...(it as Record<string, unknown>) };
}

function flatJudgment(j: {
  attempt_id: string;
  kind: string;
  key: string;
  rule: string;
  klass: string;
  result: unknown;
  reason: string;
  clef_p: unknown;
}): Record<string, unknown> {
  return {
    attempt: j.attempt_id,
    kind: j.kind,
    key: j.key,
    rule: j.rule,
    class: j.klass,
    result: j.result,
    reason: j.reason,
    clef_p: j.clef_p,
  };
}

function flatHeadsUp(h: {
  to: string;
  hn: number;
  result: string;
  cause: string;
  wake: boolean;
  items: unknown[];
  dropped_ops: unknown[];
}): Record<string, unknown> {
  return {
    to: h.to,
    hn: h.hn,
    result: h.result,
    cause: h.cause,
    wake: h.wake,
    items: h.items.map(flatItem),
    dropped_ops: h.dropped_ops,
  };
}

function flatLanding(l: {
  seq: number;
  attempt_id: string | null;
  kind: string;
  undoes?: number[];
}): Record<string, unknown> {
  return { seq: l.seq, attempt: l.attempt_id, kind: l.kind, undoes: l.undoes };
}

/** The hash the vector's `at: n` asks for (Appendix A: the key's hash after landing n). */
function hashAt(pool: Pool, kind: string, key: string, at: unknown): string {
  if (at === undefined) return "";
  const n = typeof at === "number" ? at : Number(at);
  return keyHash(pool.fileMapAt(n), kind as "entity" | "file" | "listing" | "query", key).hash;
}

const TOOL_NAMES = new Set(["outline", "read", "list", "search", "write", "replace", "submit"]);

export type Pools = Record<string, { files: Record<string, string> }>;

/** Run one vector; returns the list of failed expectations, empty on a pass. */
export function runCase(vector: Vector, pools: Pools): string[] {
  const fails: string[] = [];
  const fail = (where: string, want: unknown, got: unknown): void => {
    fails.push(`${where}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  };

  const file = vector as unknown as {
    id: string;
    pool: string;
    attempts: Record<
      string,
      {
        intent: string;
        intent_id?: string;
        agent?: string;
        model?: string;
        race?: boolean;
        truth?: string[];
        requester?: string;
      }
    >;
    files?: Record<string, string | null>;
    steps: Array<Record<string, unknown>>;
    final?: Record<string, unknown>;
  };
  const db = new DatabaseSync(":memory:");
  const sql = sqlOver(db);
  const top = vector as unknown as { constants?: Partial<Pool["K"]>; switches?: Record<string, string> };
  // The seed is the pool's files plus the case's own `files` overrides (Appendix A: null deletes).
  const seed = { ...(pools[file.pool]?.files ?? {}) };
  for (const [p, v] of Object.entries(file.files ?? {})) {
    if (v === null) delete seed[p];
    else seed[p] = v;
  }
  let trunk = Trunk.create(sql, seed, {
    constants: top.constants,
    switches: { CLEF_TRIAGE: top.switches?.CLEF_TRIAGE === "off" ? "off" : "on" },
    // The cases run on the engine in Node, where every engine part is present: the full held
    // form shows the blast radius and offers `land_now` (C49, C55). The `SyncTriage` port is
    // the one scripted implementation (S6a): the vectors' attempts are real, so it answers
    // only if a case ever opens a synthetic one.
    syncTriage: ScriptedTriage,
    features: { held: true },
  });
  // PL1: the seed's batch 0 is on Artifacts before any attempt works — the vectors predate the
  // seed push, so the driver replays it here (the `batch.pushed` it emits only adds to the trace;
  // `events_include` checks are membership, not order).
  trunk.pushOk();
  let pool = trunk.pool;

  // The attempt ids are the vector's letters: "A", "B", ...
  for (const [id, args] of Object.entries(file.attempts ?? {})) {
    trunk.openAttempt(id, {
      intent: args.intent ?? id,
      intent_id: args.intent_id,
      requester: args.requester === "owner" ? "owner" : "agent",
      race: args.race === true,
      truth: args.truth ?? null,
      agent_kind: "real",
      model: args.model ?? null,
    });
  }

  const records: StepRecord[] = [];

  const trace = () => ({
    judgments: pool.out.judgments.map(flatJudgment),
    heads_ups: pool.out.heads_ups.map(flatHeadsUp),
    cards: pool.out.cards,
    events: pool.out.events,
    accepted: pool.out.accepted,
    skipped: pool.out.skipped,
    landings: pool.out.landings.map((l) => ({
      seq: l.seq,
      attempt: l.attempt ?? null,
      kind: l.kind,
      undoes: l.undoes,
    })),
    landed: pool.out.landed,
    reasked: pool.out.reasked,
    waiting: pool.out.waiting,
  });

  const checkStates = (want: Record<string, unknown>, where: string): void => {
    for (const [k, v] of Object.entries(want)) {
      const a = pool.attempts.get(k);
      if ((a?.state ?? null) !== v) fail(`${where} states.${k}`, v, a?.state ?? null);
    }
  };

  const checkAttempts = (
    field: "go_arounds" | "pull_backs" | "stop_reasons" | "right_of_way",
    want: Record<string, unknown>,
    where: string,
  ): void => {
    for (const [k, v] of Object.entries(want)) {
      const a = pool.attempts.get(k);
      const got =
        field === "go_arounds"
          ? a?.go_arounds
          : field === "pull_backs"
            ? a?.pull_backs
            : field === "stop_reasons"
              ? a?.stop_reason
              : (a?.right_of_way_at ?? null) !== null;
      if (got !== v) fail(`${where} ${field}.${k}`, v, got);
    }
  };

  const checkPremises = (want: unknown[], resp: ToolResponse, where: string): void => {
    const got = resp.premises.map((p) => {
      const row: Record<string, unknown> = { kind: p.kind, key: p.key, read: p.read, edit: p.edit, derived: p.derived };
      row.hash = p.hash;
      row.seq = p.seq;
      return row;
    });
    const norm = (p: Record<string, unknown>): string =>
      JSON.stringify([p.kind, p.key, p.hash, p.read, p.edit, p.derived]);
    const normalized = want
      .map((w) => {
        const e = { ...(w as Record<string, unknown>) };
        if ("at" in e) {
          e.hash = hashAt(pool, String(e.kind), String(e.key), e.at);
          delete e.at;
        }
        if (e.hash === "absent") e.hash = ABSENT;
        return e;
      })
      .map(norm)
      .sort();
    const actualNorm = got.map(norm).sort();
    if (JSON.stringify(normalized) !== JSON.stringify(actualNorm)) {
      fail(`${where} premises`, normalized, actualNorm);
    }
  };

  const checkExpect = (expect: Record<string, unknown>, rec: StepRecord, index: number, where: string): void => {
    const resp = rec.resp;
    if ("ok" in expect) {
      if (resp === null || resp.ok !== expect.ok) fail(`${where} ok`, expect.ok, resp?.ok ?? null);
    }
    if ("error" in expect) {
      const want = expect.error;
      const code = typeof want === "string" ? want : (want as Record<string, unknown>).code;
      if (resp?.error?.code !== code) fail(`${where} error`, code, resp?.error?.code ?? null);
      if (typeof want === "object" && want !== null && resp?.error !== undefined && !subset(want, resp.error)) {
        fail(`${where} error`, want, resp.error);
      }
    }
    if ("result" in expect) {
      if (resp === null || !subset(expect.result, resp.result ?? null))
        fail(`${where} result`, expect.result, resp?.result ?? null);
    }
    if ("status" in expect) {
      const st =
        resp?.result === null || resp?.result === undefined ? null : (resp.result as Record<string, unknown>).status;
      if (st !== expect.status) fail(`${where} status`, expect.status, st);
    }
    if ("duplicate" in expect) {
      const d =
        resp?.result === null || resp?.result === undefined
          ? false
          : Boolean((resp.result as Record<string, unknown>).duplicate);
      if (d !== expect.duplicate) fail(`${where} duplicate`, expect.duplicate, d);
    }
    if ("same_response_as" in expect) {
      const earlier = records[Number(expect.same_response_as)];
      const a2 = resp ?? null;
      const b2 = earlier?.resp ?? null;
      if (!(subset(a2, b2) && subset(b2, a2))) fail(`${where} same_response_as`, b2, a2);
    }
    if ("same_submit_id_as" in expect) {
      const earlier = records[Number(expect.same_submit_id_as)]?.resp;
      const want =
        earlier?.result === null || earlier?.result === undefined
          ? null
          : (earlier.result as Record<string, unknown>).submit_id;
      const got =
        resp?.result === null || resp?.result === undefined ? null : (resp.result as Record<string, unknown>).submit_id;
      if (want === null || got !== want) fail(`${where} same_submit_id_as`, want, got);
    }
    if ("premises" in expect && resp !== null) checkPremises(expect.premises as unknown[], resp, where);
    const t = trace();
    if ("accepted" in expect && JSON.stringify(t.accepted) !== JSON.stringify(expect.accepted))
      fail(`${where} accepted`, expect.accepted, t.accepted);
    if ("skipped" in expect && JSON.stringify(t.skipped) !== JSON.stringify(expect.skipped))
      fail(`${where} skipped`, expect.skipped, t.skipped);
    if ("landed" in expect && JSON.stringify(t.landed) !== JSON.stringify(expect.landed))
      fail(`${where} landed`, expect.landed, t.landed);
    if ("waiting_behind" in expect && t.waiting !== expect.waiting_behind)
      fail(`${where} waiting_behind`, expect.waiting_behind, t.waiting);
    if ("landings" in expect && !subset(expect.landings, t.landings))
      fail(`${where} landings`, expect.landings, t.landings);
    if ("heads_ups" in expect) {
      // Reference-runner semantics: heads-ups are found by (to, hn), items by (kind, key),
      // `added`/`removed`/`context` compare as sorted sets, `after_contains` is a substring test.
      const wantHu = expect.heads_ups as Array<Record<string, unknown>>;
      const gotHu = t.heads_ups as Array<Record<string, unknown>>;
      if (wantHu.length !== gotHu.length) {
        fail(`${where} heads_ups count`, wantHu.length, gotHu);
      } else {
        for (const x of wantHu) {
          const g = gotHu.find((h) => h.to === x.to && h.hn === x.hn);
          if (g === undefined) {
            fail(`${where} heads-up`, `${String(x.to)}#${String(x.hn)}`, gotHu);
            continue;
          }
          if (g.result !== x.result) fail(`${where} heads-up result`, x.result, g.result);
          if (x.cause !== undefined && g.cause !== x.cause) fail(`${where} heads-up cause`, x.cause, g.cause);
          if ("wake" in x && g.wake !== x.wake) fail(`${where} heads-up wake`, x.wake, g.wake);
          const wItems = (x.items ?? []) as Array<Record<string, unknown>>;
          const gItems = (g.items ?? []) as Array<Record<string, unknown>>;
          if (wItems.length !== gItems.length) {
            fail(`${where} heads-up items`, wItems, gItems);
            continue;
          }
          for (const it of wItems) {
            const gi = gItems.find((y) => y.kind === it.kind && y.key === it.key);
            if (gi === undefined) {
              fail(`${where} heads-up item`, `${String(it.kind)}|${String(it.key)}`, gItems);
              continue;
            }
            if (gi.rule !== it.rule || gi.result !== it.result) {
              fail(`${where} item rule/result`, [it.rule, it.result], [gi.rule, gi.result]);
            }
            for (const k of ["added", "removed", "context"] as const) {
              if (k in it) {
                const want = JSON.stringify([...((it[k] ?? []) as unknown[])].sort());
                const got = JSON.stringify([...((gi[k] ?? []) as unknown[])].sort());
                if (want !== got) fail(`${where} item ${k}`, it[k], gi[k]);
              }
            }
            if (
              "after_contains" in it &&
              !(typeof gi.after === "string" && gi.after.includes(String(it.after_contains)))
            ) {
              fail(`${where} item after_contains`, it.after_contains, gi.after);
            }
          }
          if (x.dropped_ops !== undefined && JSON.stringify(x.dropped_ops) !== JSON.stringify(g.dropped_ops)) {
            fail(`${where} dropped_ops`, x.dropped_ops, g.dropped_ops);
          }
        }
      }
    }
    if ("judgments" in expect) {
      // Reference-runner semantics: a bag of [attempt,kind,key,rule,class,result?] —
      // `result` is compared only where an expected entry for that attempt+key carries one.
      const wantJ = expect.judgments as Array<Record<string, unknown>>;
      const norm = (j: Record<string, unknown>, withRes: boolean): string =>
        JSON.stringify([j.attempt, j.kind, j.key, j.rule, j.class, withRes ? j.result : undefined]);
      const exp = wantJ.map((j) => norm(j, "result" in j)).sort();
      const got = (t.judgments as Array<Record<string, unknown>>)
        .map((j) =>
          norm(
            j,
            wantJ.some((x) => x.attempt === j.attempt && x.key === j.key && "result" in x),
          ),
        )
        .sort();
      if (JSON.stringify(exp) !== JSON.stringify(got)) fail(`${where} judgments`, exp, got);
    }
    if ("cards" in expect) {
      // The card's `blast_radius` is stored keyed by attempt id; the vectors write it flat.
      const flatCards = t.cards.map((c) => {
        const flat = { ...(c as Record<string, unknown>) } as Record<string, unknown> & {
          blast_radius?: unknown;
          attempts?: string[];
        };
        if (flat.blast_radius !== null && typeof flat.blast_radius === "object") {
          const br = flat.blast_radius as Record<string, unknown>;
          const first = (flat.attempts ?? [])[0];
          flat.blast_radius = (first !== undefined ? br[first] : undefined) ?? br;
        }
        return flat;
      });
      if (!subset(expect.cards, flatCards)) fail(`${where} cards`, expect.cards, flatCards);
    }
    if ("reasked" in expect) {
      const rn = (r: Record<string, unknown>): string => JSON.stringify([r.attempt, r.kind, r.key]);
      const exp = (expect.reasked as Array<Record<string, unknown>>).map(rn).sort();
      const got = (t.reasked as Array<Record<string, unknown>>).map(rn).sort();
      if (JSON.stringify(exp) !== JSON.stringify(got)) fail(`${where} reasked`, exp, got);
    }
    if ("events_include" in expect) {
      for (const e of expect.events_include as string[]) {
        if (!t.events.includes(e)) fail(`${where} events_include`, e, t.events);
      }
    }
    if ("events_exclude" in expect) {
      for (const e of expect.events_exclude as string[]) {
        if (t.events.includes(e)) fail(`${where} events_exclude`, `not ${e}`, t.events);
      }
    }
    if ("action" in expect && rec.extra.action !== expect.action)
      fail(`${where} action`, expect.action, rec.extra.action ?? null);
    if ("refused" in expect && rec.extra.refused !== expect.refused)
      fail(`${where} refused`, expect.refused, rec.extra.refused ?? null);
    if ("undo" in expect && !subset(expect.undo, rec.extra.undo ?? null))
      fail(`${where} undo`, expect.undo, rec.extra.undo ?? null);
    if ("states" in expect) checkStates(expect.states as Record<string, unknown>, where);
    if ("go_arounds" in expect) checkAttempts("go_arounds", expect.go_arounds as Record<string, unknown>, where);
    if ("pull_backs" in expect) checkAttempts("pull_backs", expect.pull_backs as Record<string, unknown>, where);
    if ("stop_reasons" in expect) checkAttempts("stop_reasons", expect.stop_reasons as Record<string, unknown>, where);
    if ("right_of_way" in expect) checkAttempts("right_of_way", expect.right_of_way as Record<string, unknown>, where);
    if ("pool_state" in expect) {
      const got = pool.meta.get("pool_state");
      if (got !== expect.pool_state) fail(`${where} pool_state`, expect.pool_state, got);
    }
    void index;
  };

  const steps = file.steps ?? [];
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i]!;
    const doWhat = String(st.do);
    const by = typeof st.by === "string" ? st.by : undefined;
    const args = (st.args ?? {}) as Record<string, unknown>;
    const where = `${file.id} step ${i} (${doWhat})`;
    const rec: StepRecord = { resp: null, extra: {} };
    if (by !== undefined && TOOL_NAMES.has(doWhat)) {
      const req: ToolRequest = {
        attempt_id: by,
        call_id: typeof st.call_id === "string" ? st.call_id : `${by}:${i + 1}`,
        tool: doWhat as ToolRequest["tool"],
        args,
        // Runner rule: `ack` defaults to the attempt's own heads-up count (everything shown).
        ack: typeof st.ack === "number" ? st.ack : (trunk.pool.attempts.get(by)?.heads.length ?? 0),
      };
      rec.resp = trunk.tool(req);
    } else if (doWhat === "tick") {
      trunk.tick();
    } else if (doWhat === "push_ok") {
      trunk.pushOk();
    } else if (doWhat === "push_result") {
      rec.extra.action = trunk.pushResult(
        args.remote_main as "old" | "new" | "other",
        args.remote_notes as "old" | "new" | "other" | undefined,
      );
    } else if (doWhat === "restart") {
      // TR6: a fresh instance over the same storage, then the restart reconcile.
      trunk = Trunk.open(sql);
      pool = trunk.pool;
      rec.extra.action = trunk.restart({
        remote_main: args.remote_main as "old" | "new" | "other",
        remote_notes: args.remote_notes as "old" | "new" | "other" | undefined,
      });
    } else if (doWhat === "triage") {
      trunk.triage({
        attempt: String(args.attempt),
        kind: String(args.kind),
        key: String(args.key),
        p: (args.p as number | null | undefined) ?? null,
      });
    } else if (doWhat === "owner") {
      const out = trunk.owner(args as { action: string; attempt?: string; seq?: number; expect_reverted?: number[] });
      rec.extra = out;
      if (typeof out.action === "string") rec.extra.action = out.action;
    } else if (doWhat === "sync" && by !== undefined) {
      rec.extra = trunk.sync({ attempt_id: by, ack: Number(args.ack ?? 0) });
    } else if (doWhat === "stop" && by !== undefined) {
      rec.extra = trunk.stop({ attempt_id: by, reason: String(args.reason ?? "stopped") });
    } else {
      fail(where, "a known step kind", doWhat);
    }
    records.push(rec);
    if (st.expect !== undefined) {
      checkExpect(st.expect as Record<string, unknown>, rec, i, where);
    }
  }

  // The `final` block: head sequence, file contents, states, counters, landings.
  const f = file.final;
  if (f !== undefined) {
    if ("head_seq" in f && pool.headSeq() !== f.head_seq) fail("final head_seq", f.head_seq, pool.headSeq());
    if ("files" in f) {
      for (const [path, want] of Object.entries(f.files as Record<string, string>)) {
        const got = pool.files.get(path) ?? null;
        if (got !== want) fail(`final files ${path}`, want, got);
      }
    }
    if ("states" in f) checkStates(f.states as Record<string, unknown>, "final");
    if ("go_arounds" in f) checkAttempts("go_arounds", f.go_arounds as Record<string, unknown>, "final");
    if ("pull_backs" in f) checkAttempts("pull_backs", f.pull_backs as Record<string, unknown>, "final");
    if ("landings" in f) {
      const got = pool.landings.map((l) => flatLanding({ seq: l.seq, attempt_id: l.attempt_id, kind: l.kind }));
      if (!subset(f.landings, got)) fail("final landings", f.landings, got);
    }
    if ("pool_state" in f && pool.meta.get("pool_state") !== f.pool_state) {
      fail("final pool_state", f.pool_state, pool.meta.get("pool_state"));
    }
  }

  db.close();
  return fails;
}
