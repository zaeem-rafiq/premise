// VE8 — the design review's evidence capture (docs/spec/04-build-plan.md 5.4; the record is
// docs/reviews/design.md).
//
// The tests run only with DESIGN_REVIEW=1. Without it every test of this file is skipped, so a
// plain `npm run test:e2e` is unchanged. With it they drive the built Floor (`npm run build:floor`
// first) in the fixture project and write PNG screenshots under docs/reviews/screens/design/,
// named <row>-<area>_<size>_<theme>_<state>.png, plus JSON files of measured sizes. The visible
// text of each captured state also goes to test-results/design-review-text/ for the read of every
// string on screen. The screenshots are evidence for a person's review: the expectations below
// only make sure each screen reached the state its name claims.
//
// Pool frames are not served in the fixture project. Every /pool/** request gets a stub page that
// paints "POOL FRAME STUB" and speaks the frame channel (stats, probe, the self-test), so the pool
// picture itself is not reviewed here.
//
//   DESIGN_REVIEW=1 PREMISE_E2E_PORT=4273 npx playwright test test/e2e/lead/design-review.spec.ts

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page, type WebSocketRoute } from "@playwright/test";
import { serveSession } from "../shell/stream.ts";

test.skip(process.env.DESIGN_REVIEW !== "1", "The design review capture (VE8) runs only with DESIGN_REVIEW=1.");

const OUT = "docs/reviews/screens/design";
const TEXT_OUT = "test-results/design-review-text";

type Theme = "dark" | "light";
type Size = { name: "stage" | "laptop"; width: number; height: number };
const STAGE: Size = { name: "stage", width: 1920, height: 1080 };
const LAPTOP: Size = { name: "laptop", width: 1440, height: 900 };
const SIZES: readonly Size[] = [STAGE, LAPTOP];

// ---------------------------------------------------------------------------------------------
// The pool frame stub, the page set-up and the capture helpers.

const POOL_PAGE = `<!doctype html><meta charset="utf-8"><title>pool</title>
<style>html,body{margin:0;height:100%}body{display:grid;place-items:center;background:#2b5466;color:#e6f4f6;
font:600 15px system-ui,sans-serif;letter-spacing:.08em}</style><body>POOL FRAME STUB</body>
<script>
  window.__silent = false;
  var part = location.pathname.split("/")[3];
  var v = (part === "main" || part === "green" || part === "plain") ? "c-live" : "c-" + part;
  var st = null;
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (d && d.type === "advance") v = d.version;
    if (d && d.type === "probe" && d.selftest === true) st = { version: v, ok: true, failed: [] };
  });
  function beat() {
    if (window.__silent) return;
    parent.postMessage({ type: "stats", source: part, version: v, seq: 1, tick: 1, paused: false,
      kinds: {}, shown: 0, total: 0, swap: null, selftest: st }, "*");
  }
  beat();
  setInterval(beat, 200);
</script>`;

async function stubPool(page: Page): Promise<void> {
  await page.route("**/pool/**", (route) => route.fulfill({ contentType: "text/html", body: POOL_PAGE }));
}

/** Size, theme (kept in the browser under the page's own key, 6.3) and the pool stub. */
async function prepare(page: Page, size: { width: number; height: number }, theme: Theme = "dark"): Promise<void> {
  await page.setViewportSize({ width: size.width, height: size.height });
  await page.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key as string, value as string);
      } catch {
        // storage off: the page falls back to the system setting
      }
    },
    ["premise.theme", theme] as const,
  );
  await stubPool(page);
}

async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
  await page.waitForTimeout(60);
}

/** The visible text of the page, for the read of every string on screen (row 4). */
async function dumpText(page: Page, name: string): Promise<void> {
  const body = await page.evaluate(() => document.body.innerText);
  mkdirSync(TEXT_OUT, { recursive: true });
  writeFileSync(`${TEXT_OUT}/${name}.txt`, body);
}

type ShotOptions = {
  fullPage?: boolean;
  themes?: readonly Theme[];
  clip?: Locator;
  /** A secondary moment: captured at stage size only, to keep the folder near 25 MB. */
  stageOnly?: boolean;
};

/** One screenshot per theme: `<row>-<area>_<size>_<theme>_<state>.png`. Key moments are taken in
 * both themes; secondary ones (`stageOnly`, or a single theme) only where named. */
async function snap(page: Page, row: string, area: string, size: string, state: string, opts: ShotOptions = {}) {
  if (opts.stageOnly === true && size !== "stage") return;
  await page.waitForTimeout(320); // the 240 ms sheet and banner motion of 6.4 has ended
  await dumpText(page, `${row}-${area}_${size}_${state}`);
  for (const theme of opts.themes ?? (["dark", "light"] as const)) {
    await setTheme(page, theme);
    const path = `${OUT}/${row}-${area}_${size}_${theme}_${state}.png`;
    if (opts.clip !== undefined) await opts.clip.screenshot({ path });
    else await page.screenshot({ path, fullPage: opts.fullPage === true });
  }
  await setTheme(page, "dark");
}

function writeJson(name: string, value: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify(value, null, 2) + "\n");
}

/** Puts the keyboard back at the start of the page with nothing focused: the skip link (the first
 * focus stop, AX2) takes focus and gives it up again, so the next Tab goes to the stop after it. A
 * blur alone would leave Chromium's sequential-navigation starting point where focus last was.
 * This is a step of the harness, not a key a person can press: the single-key shortcuts of 6.6 do
 * nothing while a button holds focus (src/floor/keys/keys.ts), and the record says where the
 * keys-only run of AC10 relied on this reset. */
async function focusRoot(page: Page): Promise<void> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    const skip = document.querySelector<HTMLElement>(".skip-link");
    skip?.focus();
    skip?.blur();
  });
}

// ---------------------------------------------------------------------------------------------
// Streams. Live streams are scripted here the way test/e2e/shell/stream.ts does it; the event
// fields follow src/protocol/events.ts. `ts` is the source clock of the scripted moment, so the
// run clock and every "n s" read as they would in a run.

type Ev = Record<string, unknown>;
const POOL = "tidepool";
const T0 = Date.UTC(2026, 9, 12, 17, 0, 0);
const MODELS = ["@cf/openai/gpt-oss-120b", "@cf/zai-org/glm-5.3-flash", "@cf/moonshotai/kimi-k2.7-code"] as const;

/** A 40-hex id for a scripted commit, tree or note: distinct for every seed. */
function hex(seed: number): string {
  return createHash("sha1").update(`premise-design-review-${seed}`).digest("hex");
}

class Script {
  readonly events: Ev[] = [];
  readonly pool: string;
  readonly t0: number;
  private n = 0;
  private marks = new Map<string, number>();
  constructor(pool: string, t0: number = T0) {
    this.pool = pool;
    this.t0 = t0;
  }
  /** One event at `seconds` after T0. */
  at(seconds: number, type: string, fields: Ev = {}, src = "trunk"): this {
    this.n += 1;
    const ts = this.t0 + Math.round(seconds * 1000);
    this.events.push({ n: this.n, t: ts + 4, ts, src, pool: this.pool, type, ...fields });
    return this;
  }
  mark(name: string): this {
    this.marks.set(name, this.n);
    return this;
  }
  /** The events through the named mark. */
  upTo(name: string): Ev[] {
    const n = this.marks.get(name);
    if (n === undefined) throw new Error(`no mark ${name}`);
    return this.events.slice(0, n);
  }
}

function poolStateFields(extra: Ev = {}): Ev {
  return {
    head_seq: 0,
    head_commit: hex(0),
    green_seq: 0,
    landed_seq: 0,
    landed_commit: hex(0),
    state: "ready",
    reason: null,
    epoch: 1,
    remote: `https://artifacts.example/git/premise/${POOL}.git`,
    plain_remote: `https://artifacts.example/git/premise/${POOL}-plain.git`,
    rebuild: null,
    unwitnessed: [],
    real_agents: 0,
    max_real_agents: 12,
    synthetic: false,
    summary_only: false,
    app: "tidepool",
    source: null,
    ...extra,
  };
}

/** The seed tree in the order Trunk lists it (public/replay/hero-canned.ndjson, `pool.files`). */
const SEED_FILES: ReadonlyArray<[string, "auto" | "held"]> = [
  [".premise/policy.json", "held"],
  ["creatures/anemone.js", "auto"],
  ["creatures/fish.js", "auto"],
  ["creatures/minnow.js", "auto"],
  ["creatures/snail.js", "auto"],
  ["creatures/turtle.js", "auto"],
  ["GUIDE.md", "held"],
  ["index.html", "held"],
  ["main.js", "held"],
  ["pen.js", "held"],
  ["selftest/invariants.js", "held"],
  ["selftest/recording-surface.js", "held"],
  ["selftest/run.js", "held"],
  ["world/bounds.js", "held"],
  ["world/energy.js", "held"],
  ["world/food.js", "held"],
  ["world/movement.js", "held"],
  ["world/rules.js", "held"],
  ["world/scene.js", "held"],
  ["world/spawning.js", "held"],
  ["world/time.js", "held"],
];

function filesEvent(extra: string[] = []): Ev {
  const files = [...SEED_FILES.map(([path, tier]) => ({ path, tier }))];
  for (const path of extra) files.push({ path, tier: "auto" });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files };
}

function premise(
  kind: string,
  key: string,
  flags: { read?: boolean; edit?: boolean; derived?: boolean; hash?: string },
) {
  return {
    kind,
    key,
    hash: flags.hash ?? `h-${key.length}`,
    seq: 0,
    read: flags.read ?? false,
    edit: flags.edit ?? false,
    derived: flags.derived ?? false,
  };
}

const CHECKS = [
  { name: "replay", ok: true },
  { name: "non_empty", ok: true },
  { name: "fits", ok: true },
  { name: "parse", ok: true },
  { name: "imports_resolve", ok: true },
  { name: "globals_allowed", ok: true },
  { name: "premises_hold", ok: true },
];

const ENERGY_BEFORE =
  "// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 100;";
const ENERGY_AFTER = "// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).\nexport const ENERGY_MAX = 1;";

type Creature = { id: string; name: string; text: string; attempt: string; model: string; prewritten: boolean };

const STARTERS: Creature[] = [
  ["A01", "jellyfish", "a jellyfish that drifts up and down"],
  ["A03", "starfish", "a starfish that sits on the sand and slowly turns"],
  ["A04", "urchin", "a sea urchin on the sand that waves its spines"],
  ["A06", "octopus", "an octopus that is dark at night and bright in the day"],
  ["A11", "lobster", "a lobster that walks along the sand and turns around at the walls"],
  ["P1b", "shrimp", "a shrimp that darts every two seconds and spends 5 energy on each dart"],
].map(([id, name, text], index) => ({
  id: id!,
  name: name!,
  text: text!,
  attempt: `a_${id}`,
  model: MODELS[index % 3]!,
  prewritten: true,
}));

const CRAB_TEXT = "a crab that hides in its shell when its energy drops below 30";
const CRABS = MODELS.map((model, index) => ({ attempt: `a_crab${index + 1}`, model }));
const SHARED_TEXT = "make energy a fraction from 0 to 1";
const SWEEP_TEXT =
  "write every energy cost in percent of a full tank: change the drain rule so that 5 means five percent, and update every creature that drains energy";
const SQUID_TEXT = "a squid that shoots forward every three seconds and spends a tenth of its energy on each burst";

function note(seq: number, fields: { attempt: string; intent: string; text: string; model: string }): string {
  return JSON.stringify({
    v: 1,
    hash_version: "ast1",
    seq,
    kind: "change",
    change_id: `c_${fields.attempt}`,
    revision: 1,
    intent: { id: fields.intent, text: fields.text, requester: "owner", created_at: "2026-10-12T17:00:40Z" },
    attempt: {
      id: fields.attempt,
      agent: "real",
      model: fields.model,
      repo: null,
      opened_seq: 0,
      steps: 9,
      model_calls: 7,
      tokens_in: 18234,
      tokens_out: 2210,
    },
    summary: `Add ${fields.text}`,
    premises: [],
    writes: [],
    ops: [],
    go_arounds: [],
    confirms: [],
    judgments: [],
    checks: CHECKS,
    policy: { tier: "auto", approved_by: null, approved_at: null, option: null, risk: null },
    pull_backs: 0,
    batch: { id: seq, index: 0, size: 1 },
    timing: {
      opened_at: "2026-10-12T17:00:41Z",
      submitted_at: "2026-10-12T17:02:10Z",
      accepted_at: "2026-10-12T17:02:11Z",
    },
  });
}

/** One creature attempt: opened, working, its reads and its write (the tile marks of 3.7). */
function creatureWork(s: Script, at: number, c: Creature, race = false): void {
  s.at(at, "attempt.opened", {
    attempt_id: c.attempt,
    intent_id: `i_${c.id}`,
    change_id: `c_${c.attempt}`,
    agent: "real",
    model: c.model,
    race,
  });
  s.at(at + 0.4, "attempt.state", stateFields(c.attempt, "opened", "working", "T1"));
  s.at(at + 2, "attempt.step", step(c.attempt, 1, "list", "creatures/"), "agent");
  s.at(at + 2.1, "premise.recorded", {
    attempt_id: c.attempt,
    tool: "list",
    premise: premise("listing", "creatures/", { read: true }),
  });
  s.at(at + 4, "attempt.step", step(c.attempt, 2, "read", "world/energy.js"), "agent");
  s.at(at + 4.1, "premise.recorded", {
    attempt_id: c.attempt,
    tool: "read",
    premise: premise("entity", "world/energy.js#ENERGY_MAX", { read: true, hash: "h-energy-100" }),
  });
  s.at(at + 6, "attempt.step", step(c.attempt, 3, "read", "world/bounds.js"), "agent");
  s.at(at + 6.1, "premise.recorded", {
    attempt_id: c.attempt,
    tool: "read",
    premise: premise("entity", "world/bounds.js#FLOOR_Y", { read: true }),
  });
  s.at(at + 8, "attempt.step", step(c.attempt, 4, "read", "world/movement.js"), "agent");
  s.at(at + 8.1, "premise.recorded", {
    attempt_id: c.attempt,
    tool: "read",
    premise: premise("entity", "world/movement.js#step", { read: true }),
  });
  const path = `creatures/${c.name}.js`;
  s.at(at + 11, "attempt.step", step(c.attempt, 5, "write", path), "agent");
  s.at(at + 11.1, "premise.recorded", {
    attempt_id: c.attempt,
    tool: "write",
    premise: premise("file", path, { edit: true, hash: "absent" }),
  });
  s.at(at + 11.2, "premise.recorded", {
    attempt_id: c.attempt,
    tool: "write",
    premise: premise("entity", "world/energy.js#ENERGY_MAX", { read: true, derived: true, hash: "h-energy-100" }),
  });
  s.at(at + 11.3, "op.recorded", {
    attempt_id: c.attempt,
    op_seq: 1,
    op: "write",
    path,
    targets: [`${path}#spawn`, `${path}#update`, `${path}#draw`],
    altered: [],
    added: [`${path}#spawn`, `${path}#update`, `${path}#draw`],
    removed: [],
  });
}

function step(
  attempt: string,
  n: number,
  tool: string | null,
  target: string | null,
  ok = true,
  error: string | null = null,
) {
  return {
    attempt_id: attempt,
    step: n,
    tool,
    target,
    ok,
    error,
    ms: 140,
    tokens_in: 900,
    tokens_out: 120,
    cost_usd: 0.0004,
  };
}

function stateFields(attempt: string, from: string, to: string, transition: string, extra: Ev = {}): Ev {
  return {
    attempt_id: attempt,
    from,
    to,
    transition,
    reason: null,
    go_arounds: 0,
    pull_backs: 0,
    right_of_way: false,
    ...extra,
  };
}

/** A change that lands by itself: submit, validated, accepted, then (when `landedAt`) landed. */
function landCreature(s: Script, at: number, c: Creature, seq: number, landedAt: number | null): void {
  s.at(at, "submit.result", {
    attempt_id: c.attempt,
    submit_id: `s_${c.attempt}`,
    status: "validated",
    tier: "auto",
    checks: CHECKS,
    duplicate: false,
  });
  s.at(at + 0.1, "attempt.state", stateFields(c.attempt, "working", "validated", "T12"));
  s.at(at + 0.5, "landing.accepted", {
    seq,
    batch_id: seq,
    kind: "change",
    attempt_id: c.attempt,
    change_id: `c_${c.attempt}`,
    intent_id: `i_${c.id}`,
    request_id: null,
    paths: [`creatures/${c.name}.js`],
    writes: [{ kind: "file", key: `creatures/${c.name}.js`, old: "absent", new: `h-${c.name}` }],
  });
  s.at(at + 0.6, "attempt.state", stateFields(c.attempt, "validated", "accepted", "T15"));
  if (landedAt === null) return;
  s.at(landedAt - 0.05, "batch.pushed", pushed(seq));
  s.at(landedAt, "landing.landed", {
    seq,
    batch_id: seq,
    commit: hex(seq),
    tree: hex(seq + 50),
    note: hex(seq + 90),
    note_json: note(seq, { attempt: c.attempt, intent: `i_${c.id}`, text: c.text, model: c.model }),
    time_to_land_ms: 1400,
  });
  s.at(landedAt + 0.1, "attempt.state", stateFields(c.attempt, "accepted", "landed", "T16"));
  s.at(landedAt + 0.15, "intent.state", { intent_id: `i_${c.id}`, state: "landed" });
}

/** `batch.pushed` for a batch of one landing; it comes before that landing's `landing.landed`. */
function pushed(seq: number): Ev {
  return { batch_id: seq, first_seq: seq, last_seq: seq, main: hex(seq), notes: hex(seq + 90), tries: 1, ms: 380 };
}

function limitsFields(spend: number, extra: Ev = {}): Ev {
  return {
    spend_usd: spend,
    reserved_usd: 0.04,
    cap_usd: 40,
    killed: false,
    refusing: false,
    models: [
      { model: MODELS[0], per_minute: 240, used_last_minute: 31 },
      { model: MODELS[1], per_minute: 16, used_last_minute: 9 },
      { model: MODELS[2], per_minute: 16, used_last_minute: 11 },
    ],
    ...extra,
  };
}

function metricsFields(extra: Ev = {}): Ev {
  return {
    window_ms: 10_000,
    landings_per_second: 0.1,
    time_to_land_ms: { p50: 1400, p99: 2600 },
    time_held_ms: { p50: 9000, p99: 9000 },
    go_around_rate: 0.33,
    false_abort_rate: 0,
    escape_rate: null,
    waiting_behind: 0,
    push_backlog: 0,
    tick_cpu_ms: { p50: 3, p99: 9 },
    ...extra,
  };
}

function raceCard(state: "working" | "going_around" | "ready", ready: number): Ev {
  const candidates: Ev = {};
  const after: Ev = {};
  CRABS.forEach((crab, index) => {
    const can = state === "ready" && index < ready;
    candidates[crab.attempt] = {
      state: can ? "held" : state === "going_around" ? "going_around" : "working",
      can_choose: can,
      seconds: can ? [48, 72, 65][index] : null,
      cost_usd: can ? [0.01, 0.02, 0.02][index] : null,
    };
    if (can) after[crab.attempt] = { repo: "plain", commit: hex(200 + index) };
  });
  const title =
    ready === 0
      ? `3 attempts at "${CRAB_TEXT}" are still working.`
      : ready === 1
        ? `1 of 3 attempts at "${CRAB_TEXT}" is ready. Choose it, or wait for the others.`
        : `${ready} of 3 attempts at "${CRAB_TEXT}" are ready. Choose one.`;
  return {
    card_id: "k_race",
    kind: "race",
    attempt_ids: CRABS.map((c) => c.attempt),
    intent_ids: ["i_P1a"],
    submit_ids: Object.fromEntries(CRABS.map((c) => [c.attempt, `s_${c.attempt}`])),
    title,
    body: ["Each ran on a different model. The one you choose lands through the same gate."],
    options: [{ id: "choose", label: "Choose this one" }],
    paths: [{ path: "creatures/crab.js", tier: "auto" }],
    blast_radius: Object.fromEntries(
      CRABS.map((c) => [c.attempt, { repair: [], confirm: [], triage: [], right_of_way: [] }]),
    ),
    preview: { before: { repo: "main", commit: hex(6) }, after, error: null },
    candidates,
    risk: null,
    reason: "race",
  };
}

function heldCard(id: string, attempt: string, intent: string, paths: string[], body: string, repair: string[]): Ev {
  return {
    card_id: id,
    kind: "held",
    attempt_ids: [attempt],
    intent_ids: [intent],
    submit_ids: { [attempt]: `s_${attempt}` },
    title: "This change touches shared rules. Land it?",
    body: [body],
    options: [
      { id: "land", label: "Land" },
      { id: "decline", label: "Decline" },
    ],
    paths: paths.map((path) => ({ path, tier: "held" })),
    blast_radius: { [attempt]: { repair, confirm: [], triage: [], right_of_way: [] } },
    preview: {
      before: { repo: "main", commit: hex(6) },
      after: { [attempt]: { repo: "plain", commit: hex(300) } },
      error: null,
    },
    candidates: null,
    risk: null,
    reason: "held_path",
  };
}

/**
 * The demo pool: the beats of 03-floor 1.2 in one scripted stream of the main pool, with a mark
 * at each beat's key moment. Requests, models, files and texts are those of the beat sheet and of
 * /floor.json; the numbers are this script's own.
 */
function demoPool(): Script {
  const s = new Script(POOL);
  s.at(0, "pool.state", poolStateFields());
  s.at(0.01, "pool.files", filesEvent());
  s.at(0.5, "limits", limitsFields(1.12), "gate");
  s.at(0.6, "metrics", metricsFields({ landings_per_second: 0, go_around_rate: null }), "floor");
  s.mark("quiet");

  // Beat 1: the starter set (pre-written), then the crab request raced on three models.
  STARTERS.forEach((c, index) => {
    s.at(5 + index * 0.2, "intent.created", {
      intent_id: `i_${c.id}`,
      text: c.text,
      requester: "owner",
      race: false,
      prewritten: true,
    });
  });
  STARTERS.forEach((c, index) => creatureWork(s, 6 + index * 1.3, c));
  s.at(30, "pool.state", poolStateFields({ real_agents: 6 }));
  s.at(40, "intent.created", {
    intent_id: "i_P1a",
    text: CRAB_TEXT,
    requester: "owner",
    race: true,
    prewritten: false,
  });
  CRABS.forEach((crab, index) =>
    creatureWork(
      s,
      41 + index * 0.6,
      {
        id: "P1a",
        name: "crab",
        text: CRAB_TEXT,
        attempt: crab.attempt,
        model: crab.model,
        prewritten: false,
      },
      true,
    ),
  );
  s.at(41.5, "card.opened", { card: raceCard("working", 0) });
  s.at(42, "pool.state", poolStateFields({ real_agents: 9 }));
  s.at(44, "limits", limitsFields(1.84), "gate");
  landCreature(s, 50, STARTERS[0]!, 1, 55);
  landCreature(s, 66, STARTERS[1]!, 2, null);
  s.at(70, "metrics", metricsFields({ landings_per_second: 0.1, go_around_rate: 0 }), "floor");
  s.mark("beat1");

  // The rest of the starter set lands; the crab candidates wait on the race card.
  s.at(71.95, "batch.pushed", pushed(2));
  s.at(72, "landing.landed", {
    seq: 2,
    batch_id: 2,
    commit: hex(2),
    tree: hex(52),
    note: hex(92),
    note_json: note(2, {
      attempt: STARTERS[1]!.attempt,
      intent: "i_A03",
      text: STARTERS[1]!.text,
      model: STARTERS[1]!.model,
    }),
    time_to_land_ms: 1500,
  });
  s.at(72.05, "attempt.state", stateFields(STARTERS[1]!.attempt, "accepted", "landed", "T16"));
  STARTERS.slice(2).forEach((c, index) => landCreature(s, 78 + index * 4, c, 3 + index, 79 + index * 4));
  s.at(
    96,
    "pool.state",
    poolStateFields({ real_agents: 3, landed_seq: 6, landed_commit: hex(6), head_seq: 6, head_commit: hex(6) }),
  );
  s.at(96.1, "pool.files", filesEvent(STARTERS.map((c) => `creatures/${c.name}.js`)));
  CRABS.forEach((crab, index) => {
    s.at(100 + index * 3, "submit.result", {
      attempt_id: crab.attempt,
      submit_id: `s_${crab.attempt}`,
      status: "held",
      tier: "auto",
      checks: CHECKS,
      duplicate: false,
    });
    s.at(100.1 + index * 3, "attempt.state", stateFields(crab.attempt, "working", "held", "T13", { reason: "race" }));
  });
  s.at(107, "card.updated", { card: raceCard("ready", 3) });
  s.mark("beat1-end");

  // Beat 2: the shared rule, working.
  s.at(120, "intent.created", {
    intent_id: "i_R01",
    text: SHARED_TEXT,
    requester: "owner",
    race: false,
    prewritten: false,
  });
  s.at(120.5, "attempt.opened", {
    attempt_id: "a_R01",
    intent_id: "i_R01",
    change_id: "c_a_R01",
    agent: "real",
    model: MODELS[0],
    race: false,
  });
  s.at(121, "attempt.state", stateFields("a_R01", "opened", "working", "T1"));
  s.at(
    121.1,
    "pool.state",
    poolStateFields({ real_agents: 4, landed_seq: 6, landed_commit: hex(6), head_seq: 6, head_commit: hex(6) }),
  );
  s.at(124, "attempt.step", step("a_R01", 1, "read", "world/energy.js"), "agent");
  s.at(124.1, "premise.recorded", {
    attempt_id: "a_R01",
    tool: "read",
    premise: premise("entity", "world/energy.js#ENERGY_MAX", { read: true, hash: "h-energy-100" }),
  });
  s.at(127, "attempt.step", step("a_R01", 2, "search", "refs:world/energy.js#ENERGY_MAX"), "agent");
  s.at(127.1, "premise.recorded", {
    attempt_id: "a_R01",
    tool: "search",
    premise: premise("query", "refs:world/energy.js#ENERGY_MAX", { read: true }),
  });
  s.at(131, "attempt.step", step("a_R01", 3, "replace", "world/energy.js"), "agent");
  s.at(131.1, "premise.recorded", {
    attempt_id: "a_R01",
    tool: "replace",
    premise: premise("entity", "world/energy.js#ENERGY_MAX", { read: true, edit: true, hash: "h-energy-100" }),
  });
  s.at(131.2, "op.recorded", {
    attempt_id: "a_R01",
    op_seq: 1,
    op: "replace",
    path: "world/energy.js",
    targets: ["world/energy.js#ENERGY_MAX"],
    altered: ["world/energy.js#ENERGY_MAX"],
    added: [],
    removed: [],
  });
  s.at(133, "attempt.step", step("a_R01", 4, null, null), "agent");
  s.mark("beat2");

  // Beat 3: the shared rule waits on its held card, which names the three crab attempts.
  s.at(140, "submit.result", {
    attempt_id: "a_R01",
    submit_id: "s_a_R01",
    status: "held",
    tier: "held",
    checks: [...CHECKS, { name: "policy", ok: true, detail: "held" }],
    duplicate: false,
  });
  s.at(140.1, "attempt.state", stateFields("a_R01", "working", "held", "T13", { reason: "held_path" }));
  s.at(140.2, "card.opened", {
    card: heldCard(
      "k_R01",
      "a_R01",
      "i_R01",
      ["world/energy.js"],
      "It changes world/energy.js. Landing this sends 3 changes back to their agents: crab (gpt-oss-120b), crab (glm-5.3-flash), crab (kimi-k2.7-code).",
      CRABS.map((c) => c.attempt),
    ),
  });
  s.mark("beat3-card");

  // The owner taps Land: it lands, and the three crab attempts go around.
  s.at(160, "card.closed", { card_id: "k_R01", action: "land", by: "owner", attempt_id: null, reason: null });
  s.at(160.1, "attempt.state", stateFields("a_R01", "held", "validated", "T14"));
  s.at(160.5, "landing.accepted", {
    seq: 7,
    batch_id: 7,
    kind: "change",
    attempt_id: "a_R01",
    change_id: "c_a_R01",
    intent_id: "i_R01",
    request_id: null,
    paths: ["world/energy.js"],
    writes: [{ kind: "entity", key: "world/energy.js#ENERGY_MAX", old: "h-energy-100", new: "h-energy-1" }],
  });
  s.at(160.6, "attempt.state", stateFields("a_R01", "validated", "accepted", "T15"));
  s.at(161.35, "batch.pushed", pushed(7));
  s.at(161.4, "landing.landed", {
    seq: 7,
    batch_id: 7,
    commit: hex(7),
    tree: hex(57),
    note: hex(97),
    note_json: note(7, { attempt: "a_R01", intent: "i_R01", text: SHARED_TEXT, model: MODELS[0] }),
    time_to_land_ms: 900,
  });
  s.at(161.45, "attempt.state", stateFields("a_R01", "accepted", "landed", "T16"));
  CRABS.forEach((crab) => {
    s.at(161.5, "premise.judged", {
      attempt_id: crab.attempt,
      kind: "entity",
      key: "world/energy.js#ENERGY_MAX",
      old_hash: "h-energy-100",
      new_hash: "h-energy-1",
      cause: "landing",
      cause_seq: 7,
      rule: "E2",
      class: "rule",
      result: "repair",
      reason: "referenced_entity_changed",
      clef: null,
    });
    s.at(161.6, "headsup.sent", {
      attempt_id: crab.attempt,
      hn: 1,
      result: "repair",
      wake: true,
      cause: { type: "landing", seqs: [7], changes: [{ seq: 7, change_id: "c_a_R01", intent_text: SHARED_TEXT }] },
      keys: [{ kind: "entity", key: "world/energy.js#ENERGY_MAX", rule: "E2" }],
      items: [
        {
          premise: { kind: "entity", key: "world/energy.js#ENERGY_MAX" },
          rule: "E2",
          result: "repair",
          reason: "referenced_entity_changed",
          old_hash: "h-energy-100",
          new_hash: "h-energy-1",
          cause_seq: 7,
          diff: { kind: "entity", before: ENERGY_BEFORE, after: ENERGY_AFTER },
          uses: [
            {
              path: "creatures/crab.js",
              entity: "(import ../world/energy.js)",
              line: 1,
              text: 'import { ENERGY_MAX } from "../world/energy.js";',
            },
            {
              path: "creatures/crab.js",
              entity: "spawn",
              line: 8,
              text: "return { y: FLOOR_Y - 10, vx: 1, energy: ENERGY_MAX, hiding: false };",
            },
          ],
        },
      ],
      dropped_ops: [],
      go_around: 1,
    });
    s.at(161.7, "attempt.state", stateFields(crab.attempt, "held", "going_around", "T8", { go_arounds: 1 }));
  });
  s.at(161.8, "card.updated", { card: raceCard("going_around", 0) });
  s.at(163, "attempt.step", step(CRABS[1]!.attempt, 7, "replace", "creatures/crab.js"), "agent");
  s.mark("beat3-goaround");

  // The crab candidates adapt and wait again; the race card is ready.
  const said = [
    "Energy is now a fraction, so the crab hides below 0.3.",
    "Energy is now a fraction from 0 to 1, so the crab hides below 0.3.",
    "The crab now hides below 0.3 of a full tank.",
  ];
  CRABS.forEach((crab, index) => {
    s.at(175 + index * 2, "headsup.resolved", {
      attempt_id: crab.attempt,
      hn: 1,
      result: "repair",
      go_around: 1,
      changed: true,
      statement: said[index],
    });
    s.at(175.1 + index * 2, "submit.result", {
      attempt_id: crab.attempt,
      submit_id: `s_${crab.attempt}_2`,
      status: "held",
      tier: "auto",
      checks: CHECKS,
      duplicate: false,
    });
    s.at(
      175.2 + index * 2,
      "attempt.state",
      stateFields(crab.attempt, "going_around", "held", "T13", { go_arounds: 1, reason: "race" }),
    );
  });
  s.at(182, "card.updated", { card: raceCard("ready", 3) });
  s.mark("beat4-race");

  // Beat 4: the owner chooses the glm-5.3-flash crab; the other two are not chosen.
  s.at(195, "card.closed", {
    card_id: "k_race",
    action: "choose",
    by: "owner",
    attempt_id: CRABS[1]!.attempt,
    reason: null,
  });
  s.at(195.1, "attempt.state", stateFields(CRABS[1]!.attempt, "held", "validated", "T14", { go_arounds: 1 }));
  [0, 2].forEach((index) =>
    s.at(195.2, "attempt.state", {
      ...stateFields(CRABS[index]!.attempt, "held", "stopped", "T20", { go_arounds: 1 }),
      reason: "not_chosen",
    }),
  );
  s.at(195.5, "landing.accepted", {
    seq: 8,
    batch_id: 8,
    kind: "change",
    attempt_id: CRABS[1]!.attempt,
    change_id: `c_${CRABS[1]!.attempt}`,
    intent_id: "i_P1a",
    request_id: null,
    paths: ["creatures/crab.js"],
    writes: [{ kind: "file", key: "creatures/crab.js", old: "absent", new: "h-crab" }],
  });
  s.at(195.6, "attempt.state", stateFields(CRABS[1]!.attempt, "validated", "accepted", "T15", { go_arounds: 1 }));
  s.at(196.35, "batch.pushed", pushed(8));
  s.at(196.4, "landing.landed", {
    seq: 8,
    batch_id: 8,
    commit: hex(8),
    tree: hex(58),
    note: hex(98),
    note_json: note(8, { attempt: CRABS[1]!.attempt, intent: "i_P1a", text: CRAB_TEXT, model: CRABS[1]!.model }),
    time_to_land_ms: 900,
  });
  s.at(196.45, "attempt.state", stateFields(CRABS[1]!.attempt, "accepted", "landed", "T16", { go_arounds: 1 }));
  s.at(196.5, "intent.state", { intent_id: "i_P1a", state: "landed" });
  s.at(197, "plain.updated", { commit: hex(408), tree: hex(458), through_seq: 8, skipped: [], interrupted: [] });
  s.at(
    197.1,
    "pool.state",
    poolStateFields({ real_agents: 0, landed_seq: 8, landed_commit: hex(8), head_seq: 8, head_commit: hex(8) }),
  );
  s.at(198, "metrics", metricsFields({ landings_per_second: 0.1, go_around_rate: 0.75 }), "floor");
  s.mark("beat4-compare");

  // Beat 5: the sweep waits on its card; the late squid lands; the sweep's search gains a match.
  s.at(210, "intent.created", {
    intent_id: "i_P9a",
    text: SWEEP_TEXT,
    requester: "owner",
    race: false,
    prewritten: true,
  });
  s.at(210.5, "attempt.opened", {
    attempt_id: "a_P9a",
    intent_id: "i_P9a",
    change_id: "c_a_P9a",
    agent: "real",
    model: MODELS[2],
    race: false,
  });
  s.at(211, "attempt.state", stateFields("a_P9a", "opened", "working", "T1"));
  s.at(214, "attempt.step", step("a_P9a", 1, "search", "drain("), "agent");
  s.at(214.1, "premise.recorded", {
    attempt_id: "a_P9a",
    tool: "search",
    premise: premise("query", "text:creatures/:drain(", { read: true }),
  });
  s.at(217, "premise.recorded", {
    attempt_id: "a_P9a",
    tool: "replace",
    premise: premise("entity", "world/energy.js#drain", { read: true, edit: true }),
  });
  s.at(217.1, "op.recorded", {
    attempt_id: "a_P9a",
    op_seq: 1,
    op: "replace",
    path: "world/energy.js",
    targets: ["world/energy.js#drain"],
    altered: ["world/energy.js#drain"],
    added: [],
    removed: [],
  });
  s.at(219, "op.recorded", {
    attempt_id: "a_P9a",
    op_seq: 2,
    op: "replace",
    path: "creatures/shrimp.js",
    targets: ["creatures/shrimp.js#update"],
    altered: ["creatures/shrimp.js#update"],
    added: [],
    removed: [],
  });
  s.at(222, "submit.result", {
    attempt_id: "a_P9a",
    submit_id: "s_a_P9a",
    status: "held",
    tier: "held",
    checks: CHECKS,
    duplicate: false,
  });
  s.at(222.1, "attempt.state", stateFields("a_P9a", "working", "held", "T13", { reason: "held_path" }));
  s.at(222.2, "card.opened", {
    card: heldCard(
      "k_P9a",
      "a_P9a",
      "i_P9a",
      ["world/energy.js", "creatures/shrimp.js"],
      "It changes world/energy.js and creatures/shrimp.js. No change in flight relies on what this changes.",
      [],
    ),
  });
  const squid: Creature = {
    id: "P9b",
    name: "squid",
    text: SQUID_TEXT,
    attempt: "a_P9b",
    model: MODELS[0],
    prewritten: true,
  };
  s.at(225, "intent.created", {
    intent_id: "i_P9b",
    text: SQUID_TEXT,
    requester: "owner",
    race: false,
    prewritten: true,
  });
  creatureWork(s, 225.5, squid);
  landCreature(s, 240, squid, 9, 241);
  s.at(241.3, "premise.judged", {
    attempt_id: "a_P9a",
    kind: "query",
    key: "text:creatures/:drain(",
    old_hash: "h-q1",
    new_hash: "h-q2",
    cause: "landing",
    cause_seq: 9,
    rule: "QT1",
    class: "rule",
    result: "repair",
    reason: "sweep_incomplete",
    clef: null,
  });
  s.at(241.4, "headsup.sent", {
    attempt_id: "a_P9a",
    hn: 1,
    result: "repair",
    wake: true,
    cause: { type: "landing", seqs: [9], changes: [{ seq: 9, change_id: "c_a_P9b", intent_text: SQUID_TEXT }] },
    keys: [{ kind: "query", key: "text:creatures/:drain(", rule: "QT1" }],
    items: [
      {
        premise: { kind: "query", key: "text:creatures/:drain(" },
        rule: "QT1",
        result: "repair",
        reason: "sweep_incomplete",
        old_hash: "h-q1",
        new_hash: "h-q2",
        cause_seq: 9,
        diff: {
          kind: "query",
          added: [{ key: "creatures/squid.js#update", source: "    drain(squid, ENERGY_MAX / 10);" }],
          removed: [],
          context: [],
        },
        uses: [],
      },
    ],
    dropped_ops: [],
    go_around: 1,
  });
  s.at(241.5, "card.closed", { card_id: "k_P9a", action: "stale", by: "system", attempt_id: null, reason: null });
  s.at(241.6, "attempt.state", stateFields("a_P9a", "held", "going_around", "T8", { go_arounds: 1 }));
  s.at(244, "attempt.step", step("a_P9a", 6, "read", "creatures/squid.js"), "agent");
  s.mark("beat5");

  // The sweep adapts the squid too and lands after one tap; then the pool is quiet for a while.
  s.at(255, "headsup.resolved", {
    attempt_id: "a_P9a",
    hn: 1,
    result: "repair",
    go_around: 1,
    changed: true,
    statement: "The squid drains a tenth of a full tank too, so its burst now costs 10 percent.",
  });
  s.at(256, "attempt.state", stateFields("a_P9a", "going_around", "validated", "T12", { go_arounds: 1 }));
  s.at(256.5, "landing.accepted", {
    seq: 10,
    batch_id: 10,
    kind: "change",
    attempt_id: "a_P9a",
    change_id: "c_a_P9a",
    intent_id: "i_P9a",
    request_id: null,
    paths: ["world/energy.js", "creatures/shrimp.js", "creatures/squid.js"],
    writes: [{ kind: "entity", key: "world/energy.js#drain", old: "h-drain-1", new: "h-drain-2" }],
  });
  s.at(256.6, "attempt.state", stateFields("a_P9a", "validated", "accepted", "T15", { go_arounds: 1 }));
  s.at(257.35, "batch.pushed", pushed(10));
  s.at(257.4, "landing.landed", {
    seq: 10,
    batch_id: 10,
    commit: hex(10),
    tree: hex(60),
    note: hex(100),
    note_json: note(10, { attempt: "a_P9a", intent: "i_P9a", text: SWEEP_TEXT, model: MODELS[2] }),
    time_to_land_ms: 900,
  });
  s.at(257.45, "attempt.state", stateFields("a_P9a", "accepted", "landed", "T16", { go_arounds: 1 }));
  s.at(258, "plain.updated", { commit: hex(410), tree: hex(460), through_seq: 10, skipped: [], interrupted: [] });
  s.at(
    258.1,
    "pool.state",
    poolStateFields({ real_agents: 0, landed_seq: 10, landed_commit: hex(10), head_seq: 10, head_commit: hex(10) }),
  );
  s.at(260, "metrics", metricsFields({ landings_per_second: 0, go_around_rate: 0.8 }), "floor");
  s.mark("beat6");
  // Ninety quiet seconds: no attempt in flight, no landing in the last 60 s (RY23).
  s.at(350, "metrics", metricsFields({ landings_per_second: 0, go_around_rate: null }), "floor");
  s.mark("quiet-later");
  return s;
}

const DEMO = demoPool();

/** The undo of the shared rule (beat 7): the plan, then the stream after the owner's tap. */
const UNDO_PLAN = { target_seq: 7, reverted: [7, 8], reopened: [CRABS[1]!.attempt], kept_readers: [10], repairs: [] };

function afterUndo(): Ev[] {
  // Continue the numbering after the demo's beat-6 mark.
  const base = DEMO.upTo("beat6");
  const lastN = base.length;
  const tail: Ev[] = [];
  const push = (seconds: number, type: string, fields: Ev, src = "trunk") => {
    const ts = T0 + Math.round(seconds * 1000);
    tail.push({ n: lastN + tail.length + 1, t: ts + 4, ts, src, pool: POOL, type, ...fields });
  };
  push(280, "undo.planned", {
    request_id: "r_undo",
    cause: "undo",
    target_seq: 7,
    reverted: [7, 8],
    reopened: [CRABS[1]!.attempt],
    kept_readers: [10],
  });
  push(280.5, "landing.accepted", {
    seq: 11,
    batch_id: 11,
    kind: "undo",
    attempt_id: null,
    change_id: "c_undo_11",
    intent_id: null,
    request_id: "r_undo",
    paths: ["world/energy.js", "creatures/crab.js"],
    writes: [{ kind: "entity", key: "world/energy.js#ENERGY_MAX", old: "h-energy-1", new: "h-energy-100" }],
  });
  push(281.25, "batch.pushed", pushed(11));
  push(281.3, "landing.landed", {
    seq: 11,
    batch_id: 11,
    commit: hex(11),
    tree: hex(61),
    note: hex(101),
    note_json: null,
    time_to_land_ms: 800,
  });
  push(281.4, "attempt.reopened", { attempt_id: CRABS[1]!.attempt, cause: "undo", revision: 2, model_changed: false });
  push(281.5, "attempt.state", stateFields(CRABS[1]!.attempt, "landed", "going_around", "T19", { go_arounds: 2 }));
  push(281.6, "headsup.sent", {
    attempt_id: CRABS[1]!.attempt,
    hn: 2,
    result: "repair",
    wake: true,
    cause: { type: "undo", seqs: [11], changes: [{ seq: 11, change_id: "c_undo_11", intent_text: null }] },
    keys: [{ kind: "entity", key: "world/energy.js#ENERGY_MAX", rule: "E2" }],
    items: [
      {
        premise: { kind: "entity", key: "world/energy.js#ENERGY_MAX" },
        rule: "E2",
        result: "repair",
        reason: "referenced_entity_changed",
        old_hash: "h-energy-1",
        new_hash: "h-energy-100",
        cause_seq: 11,
        diff: { kind: "entity", before: ENERGY_AFTER, after: ENERGY_BEFORE },
        uses: [
          {
            path: "creatures/crab.js",
            entity: "spawn",
            line: 8,
            text: "return { y: FLOOR_Y - 10, vx: 1, energy: ENERGY_MAX, hiding: false };",
          },
        ],
      },
    ],
    dropped_ops: [],
    go_around: 2,
  });
  return [...base, ...tail];
}

// ---------------------------------------------------------------------------------------------
// Serving a live stream, the owner's routes, and the recordings.

type LiveOptions = {
  owner?: boolean;
  onSocket?: (ws: WebSocketRoute) => void;
  sockets?: string[];
};

async function serveLive(page: Page, events: Ev[], opts: LiveOptions = {}): Promise<void> {
  await serveSession(page, opts.owner === true);
  await page.route("**/api/pools/*/intents", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, intent_id: "i_new" }) }),
  );
  await page.route("**/api/pools/*/cards/*", (route) => route.fulfill({ contentType: "application/json", body: "{}" }));
  await page.route("**/api/pools/*/undo-plan**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, plan: UNDO_PLAN }) }),
  );
  await page.route("**/api/pools/*/undo", async (route) => {
    const body = (await route.request().postDataJSON()) as Record<string, unknown>;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, request_id: body["request_id"] }),
    });
  });
  await page.routeWebSocket(/\/api\/pools\/[^/]+\/stream/, (ws) => {
    opts.sockets?.push(ws.url());
    opts.onSocket?.(ws);
    ws.onMessage((message) => {
      const request = JSON.parse(message.toString()) as { hello?: number };
      if (request.hello === 1) ws.send(JSON.stringify({ events }));
    });
  });
}

/** The event lines of a stream fixture of test/fixtures/streams/, without its header. */
function fixtureEvents(name: string): Ev[] {
  return readFileSync(`test/fixtures/streams/${name}`, "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line) as Ev);
}

const HERO_CANNED = readFileSync("public/replay/hero-canned.ndjson", "utf8")
  .trim()
  .split("\n")
  .slice(1)
  .map((line) => JSON.parse(line) as Ev & { n: number; ts: number });

/** Replay position (ms from the first event) at which event `n` has been applied (RY13). */
function positionAfter(events: Array<{ n: number; ts: number }>, n: number): number {
  let max = -Infinity;
  for (const event of events) {
    if (event.n > n) break;
    max = Math.max(max, event.ts);
  }
  return max - events[0]!.ts;
}

/** Opens a recording, pauses it and seeks to `position` ms (RY16). */
async function openReplayAt(page: Page, id: string, position: number | "end"): Promise<void> {
  await page.goto(`/replay/${id}`);
  await expect(page.locator(".replay-bar")).toBeVisible();
  await focusRoot(page);
  if (position === "end") {
    await page.keyboard.press(".");
    await page.keyboard.press(".");
    await page.keyboard.press(".");
    await expect(page.locator(".replay-ended")).toBeVisible({ timeout: 30_000 });
    return;
  }
  await page.locator(".replay-bar").getByRole("button", { name: "Pause", exact: true }).click();
  await page.locator(".replay-track").evaluate((element, value) => {
    const input = element as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, position);
  await page.waitForTimeout(400);
  await focusRoot(page);
}

/** Dismisses the start card if it is on screen once the stream has been applied. The card mounts
 * while the page is still empty (a quiet pool) and unmounts when the events arrive, so the click
 * goes through the DOM as it stands (the pattern of test/e2e/lead/layout.spec.ts). */
async function dismissStart(page: Page): Promise<void> {
  await expect(page.locator(".tiles-grid .tile").first()).toBeVisible();
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>(".start-card button")) {
      if (/Look around/.test(button.textContent ?? "")) button.click();
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Measurements (row 1).

type Box = { x: number; y: number; width: number; height: number } | null;

async function measureRegions(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const box = (element: Element | null): Box => {
      if (element === null) return null;
      const r = element.getBoundingClientRect();
      const round = (v: number) => Math.round(v * 10) / 10;
      return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) };
    };
    const one = (selector: string) => box(document.querySelector(selector));
    const body = document.querySelector(".floor-body");
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dataSize: document.documentElement.dataset.size ?? null,
      scroll: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      header: one(".header"),
      strip: one(".strip"),
      banners: [...document.querySelectorAll(".banners > .banner")].map((b) => ({
        tone: b.getAttribute("data-tone"),
        ...box(b),
      })),
      body: one(".floor-body"),
      bodyPadding: body === null ? null : getComputedStyle(body).padding,
      bodyGap: body === null ? null : getComputedStyle(body).columnGap,
      poolColumn: one(".pool-column"),
      caption: one(".pf-caption"),
      frame: one(".pf-body"),
      tiles: one(".tiles"),
      tileCells: document.querySelectorAll(".tiles-grid > .tile").length,
      rail: one(".rail"),
      replayBar: one(".replay-bar"),
      sheet: one(".card-sheet, .why-sheet, .who-sheet, .undo-sheet, .about-sheet, .sheet"),
      sheetFrames: [...document.querySelectorAll(".sheet-frame__body")].map(box),
      gitDrawer: one(".git-drawer"),
    };
  });
}

/** Every visible control smaller than 44×44 (LY5), and every visible text under `minPx` (VD15). */
async function auditTargetsAndType(page: Page, minPx: number): Promise<Record<string, unknown>> {
  return page.evaluate((min) => {
    const visible = (element: Element) => {
      const r = element.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none") return false;
      if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return false;
      if (element.closest(".sr-only, [aria-hidden='true'] .sr-only")) return false;
      return true;
    };
    const describe = (element: Element) => {
      const text = (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      const label = element.getAttribute("aria-label") ?? "";
      return `${element.tagName.toLowerCase()}.${String((element as HTMLElement).className).split(" ")[0]} "${text || label}"`;
    };
    const small: Array<{ what: string; width: number; height: number }> = [];
    for (const element of document.querySelectorAll(
      "button, a[href], input, select, textarea, summary, [role='button'], [role='tab'], [role='menuitem'], [tabindex='0']",
    )) {
      if (!visible(element)) continue;
      const r = element.getBoundingClientRect();
      if (element.classList.contains("skip-link")) continue;
      if (r.width < 43.5 || r.height < 43.5) {
        small.push({ what: describe(element), width: Math.round(r.width), height: Math.round(r.height) });
      }
    }
    const tiny = new Map<string, number>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if ((node.textContent ?? "").trim() === "") continue;
      const parent = node.parentElement;
      if (parent === null || !visible(parent) || parent.closest(".sr-only") !== null) continue;
      const px = Number.parseFloat(getComputedStyle(parent).fontSize);
      if (px < min) {
        const key = `${px}px ${describe(parent)}`;
        tiny.set(key, (tiny.get(key) ?? 0) + 1);
      }
    }
    return { smallTargets: small, smallText: [...tiny.keys()] };
  }, minPx);
}

/** The computed size of the things VD15 says the voiceover points at (22 or larger at stage). */
async function voiceoverSizes(page: Page): Promise<Record<string, number[]>> {
  return page.evaluate(() => {
    const sizes = (selector: string) =>
      [...document.querySelectorAll(selector)]
        .filter((element) => element.getBoundingClientRect().height > 0)
        .slice(0, 4)
        .map((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    return {
      intentText: sizes(".attempt-card__intent"),
      statusWords: sizes(".attempt-card__word"),
      counters: sizes(".strip-cell .strip-value:not(.strip-value--text)"),
      bannerWords: sizes(".banner-word"),
      cardSheetTitle: sizes(".card-sheet__title"),
      sheetTitle: sizes(".sheet-title"),
      headsupBeforeAfter: sizes(".headsup-code__text"),
      swarmNumbers: sizes(".swarm-cell .strip-value"),
      frameCaption: sizes(".pf-caption"),
      thesis: sizes(".cmp-thesis"),
    };
  });
}

// =============================================================================================
// Row 1 (sizes and regions) and the beats: stage and laptop size, dark and light, on the fixture
// of each beat at its key moment.

for (const size of SIZES) {
  test.describe(`beats at ${size.name} size`, () => {
    test(`beat 0 and beat 4: Compare view (${size.name})`, async ({ page }) => {
      await prepare(page, size);
      await serveLive(page, DEMO.upTo("beat4-compare"), { owner: true });
      await page.goto("/");
      await dismissStart(page);
      await page.getByRole("button", { name: "Compare", exact: true }).click();
      await expect(page.locator(".floor-compare .cmp")).toBeVisible();
      await expect(page.locator(".cmp")).toContainText("Constructed for comparison");
      await page.waitForTimeout(1200);
      await snap(page, "sizes", "beat00-compare", size.name, "live-after-race");
      writeJson(`sizes-measure_${size.name}_compare`, {
        frames: await page.locator(".cmp .pf-body, .cmp iframe").evaluateAll((elements) =>
          elements.map((element) => {
            const r = element.getBoundingClientRect();
            return { tag: element.tagName.toLowerCase(), width: Math.round(r.width), height: Math.round(r.height) };
          }),
        ),
        voiceover: await voiceoverSizes(page),
        toastsOverThesis: await page.evaluate(() => {
          const thesis = document.querySelector(".cmp-thesis");
          if (thesis === null) return null;
          const r = thesis.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + 40, r.y + r.height / 2);
          return hit === null ? null : String((hit as HTMLElement).className);
        }),
      });
    });

    test(`beat 1, before: the owner's page on a quiet pool (${size.name})`, async ({ page }) => {
      await prepare(page, size);
      await serveLive(page, DEMO.upTo("quiet"), { owner: true });
      await page.goto("/");
      await expect(page.locator(".intent-box")).toBeVisible();
      await expect(page.locator(".tiles-grid .tile").first()).toBeVisible();
      await page.waitForTimeout(600);
      writeJson(`sizes-owner-quiet_${size.name}`, {
        owner: await page.locator(".owner-button").innerText(),
        startCard: await page.locator(".start-card").isVisible(),
        intentRow: await page.locator(".intent-box button").evaluateAll((buttons) =>
          buttons.map((button) => {
            const r = button.getBoundingClientRect();
            return { text: button.textContent, width: Math.round(r.width), height: Math.round(r.height) };
          }),
        ),
      });
      await snap(page, "sizes", "beat01-floor", size.name, "owner-before-start", { stageOnly: true });
    });

    test(`beat 0 in Replay: Compare view of hero-canned (${size.name})`, async ({ page }) => {
      await prepare(page, size);
      await openReplayAt(page, "hero-canned", "end");
      await page.keyboard.press("c");
      await expect(page.locator(".floor-compare .cmp")).toBeVisible();
      await page.waitForTimeout(800);
      await snap(page, "sizes", "beat00-compare", size.name, "replay-hero-canned-end", {
        stageOnly: true,
        themes: ["dark"],
      });
    });

    test(`beat 1: the starter set and the crab race (${size.name})`, async ({ page }) => {
      await prepare(page, size);
      await serveLive(page, DEMO.upTo("beat1"), { owner: true });
      await page.goto("/");
      await expect(page.locator(".attempt-card").first()).toBeVisible();
      await page.waitForTimeout(600);
      await snap(page, "sizes", "beat01-floor", size.name, "starter-landing");
      writeJson(`sizes-measure_${size.name}_beat01`, {
        regions: await measureRegions(page),
        audit: await auditTargetsAndType(page, size.name === "stage" ? 16 : 14),
        voiceover: await voiceoverSizes(page),
        // CO38: the badge counts the race card only once a candidate can be chosen; none can here.
        needsBadge:
          (await page.locator(".needs-badge").count()) > 0 ? await page.locator(".needs-badge").innerText() : null,
        trayRows: await page.locator(".tray-row").count(),
        // Known item (b): the strip's Landed counter and the Landed tab, one landing accepted not landed.
        landedStrip: await page.locator(".strip-cell[data-cell='strip.landed'] .strip-value").innerText(),
        landedTab: await page.getByRole("tab", { name: /Landed/ }).innerText(),
        // VD17 / CO10: attempt cards on screen, full and compact.
        cards: await page.locator(".rail-list .attempt-card").evaluateAll((cards) => ({
          full: cards.filter((card) => !card.classList.contains("attempt-card--compact")).length,
          compact: cards.filter((card) => card.classList.contains("attempt-card--compact")).length,
          prewrittenTags: cards.filter((card) => (card.textContent ?? "").includes("Pre-written")).length,
        })),
      });
    });

    test(`beat 1, end: three crab attempts wait (${size.name})`, async ({ page }) => {
      await prepare(page, size);
      await serveLive(page, DEMO.upTo("beat1-end"), { owner: true });
      await page.goto("/");
      await expect(page.getByText("Waiting for you").first()).toBeVisible();
      await page.waitForTimeout(1500); // the 1.2 s landed dwell of CO12 has passed
      await snap(page, "sizes", "beat01-floor", size.name, "crabs-waiting", { stageOnly: true, themes: ["dark"] });
    });

    test(`beat 2: Who relies on ENERGY_MAX (${size.name})`, async ({ page }) => {
      await prepare(page, size);
      await serveLive(page, DEMO.upTo("beat2"), { owner: true });
      await page.goto("/");
      await expect(page.locator(".attempt-card").first()).toBeVisible();
      await page.waitForTimeout(1500);
      await snap(page, "sizes", "beat02-floor", size.name, "shared-rule-working", {
        stageOnly: true,
        themes: ["dark"],
      });
      // The tile `energy` sits behind tiles.more in this layout: open the full list first.
      const more = page.locator(".tile-more");
      if ((await more.count()) > 0) {
        await more.click();
        await page.waitForTimeout(300);
        await snap(page, "sizes", "beat02-tiles", size.name, "full-list-open", { stageOnly: true, themes: ["dark"] });
      }
      await page.locator('.tiles-grid .tile[title="world/energy.js"]').click();
      await page.getByRole("menuitem", { name: "Who relies on this" }).click();
      const who = page.locator(".who-sheet");
      await expect(who).toBeVisible();
      await snap(page, "sizes", "beat02-who", size.name, "file-picked", { stageOnly: true, themes: ["dark"] });
      const part = who.getByRole("button", { name: /ENERGY_MAX/ }).first();
      if ((await part.count()) > 0) await part.click();
      await page.waitForTimeout(300);
      await snap(page, "sizes", "beat02-who", size.name, "energy-max");
      writeJson(`sizes-measure_${size.name}_who`, { regions: await measureRegions(page) });
    });

    test(`beat 3: the held card names the three crab attempts (${size.name})`, async ({ page }) => {
      await prepare(page, size);
      await serveLive(page, DEMO.upTo("beat3-card"), { owner: true });
      await page.goto("/");
      await expect(page.locator(".tray-row", { hasText: "shared rules" })).toBeVisible();
      await page.waitForTimeout(1500);
      await snap(page, "sizes", "beat03-floor", size.name, "tray", { stageOnly: true, themes: ["dark"] });
      await page.locator(".tray-row", { hasText: "shared rules" }).getByRole("button", { name: "Open" }).click();
      await expect(page.locator(".card-sheet")).toBeVisible();
      await snap(page, "sizes", "beat03-held-sheet", size.name, "owner");
      writeJson(`sizes-measure_${size.name}_held-sheet`, {
        regions: await measureRegions(page),
        voiceover: await voiceoverSizes(page),
        // LY4: what a tap on the header's kill switch and on a strip cell would reach with the sheet open.
        onTop: await page.evaluate(() => {
          const at = (element: Element | null) => {
            if (element === null) return null;
            const r = element.getBoundingClientRect();
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return hit === null
              ? null
              : `${hit.tagName.toLowerCase()}.${String((hit as HTMLElement).className).split(" ")[0]}`;
          };
          return {
            killSwitch: at(document.querySelector(".kill-open")),
            stripLanded: at(document.querySelector(".strip-cell[data-cell='strip.landed']")),
          };
        }),
        // The reason field with a typed reason (3.13 held.reason): its text and background colours.
        reasonField: await page.locator(".card-sheet__reason input").evaluate(async (input) => {
          const field = input as HTMLInputElement;
          field.focus();
          return {
            color: getComputedStyle(field).color,
            background: getComputedStyle(field).backgroundColor,
          };
        }),
      });
      await page.locator(".card-sheet__reason input").fill("it is small");
      await snap(page, "sizes", "beat03-held-reason", size.name, "typed-reason", {
        stageOnly: true,
        themes: ["dark"],
        clip: page.locator(".card-sheet__reason"),
      });
    });

    test(`beat 3: the three crab attempts go around (${size.name})`, async ({ page }) => {
      await prepare(page, size);
      await serveLive(page, DEMO.upTo("beat3-goaround"), { owner: true });
      await page.goto("/");
      await expect(page.getByText("Going around").first()).toBeVisible();
      await page.waitForTimeout(1500);
      await snap(page, "sizes", "beat03-floor", size.name, "going-around", { stageOnly: true });
      writeJson(`sizes-measure_${size.name}_going-around`, {
        openHeadsUps: await page.locator(".headsup__body").count(),
        voiceover: await voiceoverSizes(page),
        codeOverflow: await page
          .locator(".headsup-code__text")
          .evaluateAll((elements) =>
            elements.map((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth })),
          ),
      });
    });

    test(`beat 4: the race sheet (${size.name})`, async ({ page }) => {
      await prepare(page, size);
      await serveLive(page, DEMO.upTo("beat4-race"), { owner: true });
      await page.goto("/");
      await expect(page.getByRole("button", { name: "Needs you 1" })).toBeVisible();
      await page.keyboard.press("n");
      await expect(page.locator(".card-sheet")).toBeVisible();
      await page.waitForTimeout(600);
      await snap(page, "sizes", "beat04-race-sheet", size.name, "three-ready");
      writeJson(`sizes-measure_${size.name}_race-sheet`, { regions: await measureRegions(page) });
    });

    test(`beat 5: the sweep's search gains a match (${size.name})`, async ({ page }) => {
      await prepare(page, size);
      await serveLive(page, DEMO.upTo("beat5"), { owner: true });
      await page.goto("/");
      await expect(page.locator(".attempt-card", { hasText: "percent" }).first()).toBeVisible();
      await page.waitForTimeout(1500);
      await snap(page, "sizes", "beat05-floor", size.name, "search-light-changed");
    });

    test(`beat 6: the Why card of the crab and the git drawer (${size.name})`, async ({ page }) => {
      await prepare(page, size);
      await serveLive(page, DEMO.upTo("beat6"), { owner: true });
      await page.goto("/");
      await dismissStart(page);
      await page.getByRole("tab", { name: /Landed/ }).click();
      await page.locator(".landed-row", { hasText: "crab" }).first().click();
      const why = page.locator(".why-sheet");
      await expect(why).toBeVisible();
      await snap(page, "sizes", "beat06-why", size.name, "crab");
      await why.getByRole("button", { name: "Show the git" }).click();
      await expect(page.locator(".git-drawer")).toBeVisible();
      await snap(page, "sizes", "beat06-git", size.name, "crab", { stageOnly: true, themes: ["dark"] });
      writeJson(`sizes-measure_${size.name}_why`, {
        regions: await measureRegions(page),
        audit: await auditTargetsAndType(page, size.name === "stage" ? 16 : 14),
      });
    });

    test(`beat 7: the undo sheet (${size.name})`, async ({ page }) => {
      await prepare(page, size);
      await serveLive(page, DEMO.upTo("beat6"), { owner: true });
      await page.goto("/");
      await dismissStart(page);
      await page.getByRole("tab", { name: /Landed/ }).click();
      await page.locator(".landed-row", { hasText: "make energy" }).first().click();
      await page.locator(".why-sheet").getByRole("button", { name: "Undo" }).click();
      const undo = page.locator(".undo-sheet");
      await expect(undo).toContainText("Undo it");
      await snap(page, "sizes", "beat07-undo-sheet", size.name, "plan");
    });

    test(`beat 7: the reopened crab (${size.name})`, async ({ page }) => {
      await prepare(page, size);
      await serveLive(page, afterUndo(), { owner: true });
      await page.goto("/");
      await dismissStart(page);
      // CO13 asks for the tag "Reopened by undo" and "Same agent, same conversation." here; the
      // record says whether they are on screen. The state itself is "Going around" again.
      await expect(page.getByText("Going around").first()).toBeVisible();
      writeJson(`sizes-reopened_${size.name}`, {
        sameAgentLine: await page.getByText("Same agent, same conversation.").count(),
        reopenedTag: await page.getByText("Reopened by undo").count(),
        raceGroups: await page.locator(".race-group").count(),
      });
      await page.waitForTimeout(1500);
      await snap(page, "sizes", "beat07-floor", size.name, "reopened-by-undo", { stageOnly: true, themes: ["dark"] });
    });

    test(`beat 9: About (${size.name})`, async ({ page }) => {
      await prepare(page, size);
      await serveLive(page, DEMO.upTo("beat6"), { owner: true });
      await page.goto("/");
      await dismissStart(page);
      await page.keyboard.press("a");
      await expect(page.locator(".about-sheet")).toBeVisible();
      await snap(page, "sizes", "beat09-about", size.name, "live");
      await page.locator(".about-sheet").evaluate((element) => element.scrollTo(0, 99999));
      await snap(page, "sizes", "beat09-about", size.name, "live-scrolled", { stageOnly: true, themes: ["dark"] });
    });

    test(`beat 10: the visitor's start card, then Replay (${size.name})`, async ({ page }) => {
      await prepare(page, size);
      await serveLive(page, DEMO.upTo("quiet-later"), { owner: false });
      await page.goto("/");
      await expect(page.locator(".start-card")).toBeVisible();
      await snap(page, "sizes", "beat10-start-card", size.name, "visitor-quiet-pool");
      await page
        .locator(".start-card")
        .getByRole("button", { name: /Play the Replay/ })
        .click();
      await expect(page.locator(".replay-bar")).toBeVisible();
      await page.waitForTimeout(2500);
      await snap(page, "sizes", "beat10-replay", size.name, "hero-canned-playing", { stageOnly: true });
      writeJson(`sizes-measure_${size.name}_replay`, {
        regions: await measureRegions(page),
        audit: await auditTargetsAndType(page, size.name === "stage" ? 16 : 14),
        voiceover: await voiceoverSizes(page),
      });
    });
  });
}

// Beat 8 is its own block: the Swarm view reads one stream, and the record needs both what a live
// run shows (the main pool's stream) and what the wall looks like when scripted attempts are on it.
const SWARM_DEFAULTS = { pools: ["tidepool-swarm"], synthetic: true, collision_dial: 0.4 };

function swarmStream(opts: { running: boolean; agents: number; wall: number; limits?: boolean }): Ev[] {
  const s = new Script(POOL);
  s.at(0, "pool.state", poolStateFields());
  s.at(0.01, "pool.files", filesEvent());
  // FR33 injects its fault into Number.prototype.toFixed: the strip (outside every view boundary)
  // formats spend with it, so that stream carries no limits event (test/e2e/shell/view-failed.spec.ts).
  if (opts.limits !== false) s.at(0.5, "limits", limitsFields(3.12), "gate");
  s.at(1, "swarm.state", { ...SWARM_DEFAULTS, running: opts.running, agents: opts.agents }, "swarm");
  const states = ["working", "working", "working", "going_around", "landed", "working", "accepted", "stopped"];
  for (let i = 0; i < opts.wall; i += 1) {
    const id = `a_s${i}`;
    s.at(2 + i * 0.001, "intent.created", {
      intent_id: `i_s${i}`,
      text: `scripted change ${i}`,
      requester: "swarm",
      race: false,
      prewritten: false,
    });
    s.at(2 + i * 0.001, "attempt.opened", {
      attempt_id: id,
      intent_id: `i_s${i}`,
      change_id: `c_${id}`,
      agent: "synthetic",
      model: null,
      race: false,
    });
    const to = states[i % states.length]!;
    s.at(
      2.5 + i * 0.001,
      "attempt.state",
      stateFields(id, "opened", to === "landed" || to === "accepted" ? "working" : to, "T1"),
    );
  }
  s.at(
    30,
    "metrics",
    metricsFields({
      window_ms: 10_000,
      landings_per_second: 41.2,
      time_to_land_ms: { p50: 180, p99: 640 },
      go_around_rate: 0.12,
      false_abort_rate: 0.03,
      escape_rate: null,
      waiting_behind: 0,
      push_backlog: 0,
    }),
    "floor",
  );
  return s.events;
}

for (const size of SIZES) {
  test(`beat 8: the Swarm view as a live run shows it (${size.name})`, async ({ page }) => {
    const sockets: string[] = [];
    await prepare(page, size);
    await serveLive(page, swarmStream({ running: true, agents: 1024, wall: 0 }), { owner: true, sockets });
    await page.goto("/");
    await dismissStart(page);
    await page.getByRole("button", { name: "Swarm", exact: true }).first().click();
    await expect(page.locator(".swarm-view")).toBeVisible();
    await page.waitForTimeout(400);
    await snap(page, "sizes", "beat08-swarm", size.name, "main-pool-stream");
    writeJson(`sizes-measure_${size.name}_swarm`, {
      sockets,
      regions: await measureRegions(page),
      voiceover: await voiceoverSizes(page),
    });
  });

  test(`beat 8: the Swarm wall with 256 scripted attempts on the stream (${size.name})`, async ({ page }) => {
    await prepare(page, size);
    await serveLive(page, swarmStream({ running: true, agents: 256, wall: 256 }), { owner: true });
    await page.goto("/");
    await page.getByRole("button", { name: "Swarm", exact: true }).first().click();
    await expect(page.locator(".swarm-tile").first()).toBeVisible();
    await page.waitForTimeout(400);
    await snap(page, "sizes", "beat08-swarm", size.name, "wall-256", { stageOnly: true, themes: ["dark"] });
    writeJson(`sizes-measure_${size.name}_swarm-wall`, {
      wall: await page.locator(".swarm-wall").evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        tiles: element.children.length,
        firstTile: element.firstElementChild?.getBoundingClientRect().width ?? null,
      })),
      view: await page.locator(".floor-swarm").evaluate((element) => ({
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      })),
    });
  });
}

// AC13 / LY3: the seven widths, both themes, on the busiest Floor view (beat 1) and on Replay.
const WIDTHS = [
  { width: 320, height: 640 },
  { width: 768, height: 1024 },
  { width: 1100, height: 800 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
] as const;

for (const w of WIDTHS) {
  test(`AC13 width ${w.width}: the Floor view (beat 1) and Replay`, async ({ page }) => {
    await prepare(page, w);
    await serveLive(page, DEMO.upTo("beat1"), { owner: true });
    await page.goto("/");
    await expect(page.locator(".attempt-card").first()).toBeVisible();
    await page.waitForTimeout(800);
    const narrow = w.width < 1100;
    await snap(page, "sizes", "width", `w${w.width}`, "beat01-live", { fullPage: w.width === 320 });
    const live = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
      dataSize: document.documentElement.dataset.size,
      wider: [...document.querySelectorAll("body *")]
        .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
        .slice(0, 8)
        .map(
          (element) => `${element.tagName.toLowerCase()}.${String((element as HTMLElement).className).split(" ")[0]}`,
        ),
    }));
    await openReplayAt(page, "hero-canned", positionAfter(HERO_CANNED, 118));
    if (narrow) {
      await snap(page, "sizes", "width", `w${w.width}`, "replay-going-around", {
        fullPage: w.width === 320,
        themes: ["dark"],
      });
    }
    const replay = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    writeJson(`sizes-widths_w${w.width}`, { live, replay });
  });
}

test("VD19: key Z switches to stage type on a laptop window and the choice is kept", async ({ page }) => {
  await prepare(page, LAPTOP);
  await serveLive(page, DEMO.upTo("beat1"), { owner: true });
  await page.goto("/");
  await expect(page.locator(".attempt-card").first()).toBeVisible();
  const before = await page.evaluate(() => document.documentElement.dataset.size);
  await focusRoot(page);
  await page.keyboard.press("z");
  const after = await page.evaluate(() => document.documentElement.dataset.size);
  await page.waitForTimeout(400);
  await snap(page, "sizes", "vd19-key-z", "laptop", "stage-type", { themes: ["dark"] });
  await page.reload();
  await expect(page.locator(".attempt-card").first()).toBeVisible();
  const kept = await page.evaluate(() => document.documentElement.dataset.size);
  writeJson("sizes-vd19", { before, after, keptAfterReload: kept });
});

// =============================================================================================
// Row 2 (signals): the five light shapes at 28 px and at one quarter (7 px), and the status shapes.

function lightsStream(): Ev[] {
  const s = new Script(POOL);
  s.at(0, "pool.state", poolStateFields());
  s.at(0.01, "pool.files", filesEvent());
  s.at(1, "intent.created", {
    intent_id: "i_L",
    text: "a crab that hides in its shell when its energy drops below 30",
    requester: "owner",
    race: false,
    prewritten: false,
  });
  s.at(1.1, "attempt.opened", {
    attempt_id: "a_L",
    intent_id: "i_L",
    change_id: "c_a_L",
    agent: "real",
    model: MODELS[1],
    race: false,
  });
  s.at(1.2, "attempt.state", stateFields("a_L", "opened", "working", "T1"));
  const keys: Array<[string, string, string | null, string]> = [
    ["world/energy.js#ENERGY_MAX", "E2", "repair", "referenced_entity_changed"], // changed (diamond)
    ["world/bounds.js#FLOOR_Y", "B1", "confirm", "blind_spot"], // blind spot (ring)
    ["world/movement.js#step", "E2m", "confirm", "module_reference_changed"], // confirm (triangle)
    ["world/time.js#seconds", "E3", "pending", "read_not_referenced"], // checking (half circle)
    ["world/food.js#PELLET", "", null, ""], // holds (circle)
  ];
  keys.forEach(([key], index) => {
    s.at(2 + index, "premise.recorded", {
      attempt_id: "a_L",
      tool: "read",
      premise: premise("entity", key, { read: true }),
    });
  });
  keys.forEach(([key, rule, result, reason], index) => {
    if (result === null) return;
    s.at(10 + index, "premise.judged", {
      attempt_id: "a_L",
      kind: "entity",
      key,
      old_hash: "h0",
      new_hash: "h1",
      cause: "landing",
      cause_seq: 1,
      rule,
      class: result === "pending" ? "triage" : "rule",
      result,
      reason,
      clef: null,
    });
  });
  return s.events;
}

test("VD2/VD16: the five light shapes at 28 px and at 7 px (a quarter)", async ({ page }) => {
  await prepare(page, STAGE);
  await serveLive(page, lightsStream(), { owner: true });
  await page.goto("/");
  const lights = page.locator(".attempt-card .attempt-card__lights").first();
  await expect(lights.locator(".light")).toHaveCount(5);
  const sizes = await lights.locator(".light").evaluateAll((elements) =>
    elements.map((element) => {
      const r = element.getBoundingClientRect();
      const shape = element.querySelector("svg")!.getBoundingClientRect();
      return {
        state: element.className,
        box: Math.round(r.width),
        svg: Math.round(shape.width),
        label: element.getAttribute("aria-label"),
      };
    }),
  );
  writeJson("signals-lights_stage", { sizes });
  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    const buffer = await lights.screenshot({ path: `${OUT}/signals-lights_stage_${theme}_28px.png` });
    // VD16: the screenshot scaled to one quarter (each light 7 px across), then enlarged 8x with
    // no smoothing so the 7-pixel shapes can be judged.
    const scaled = await page.evaluate(async (data) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const quarter = document.createElement("canvas");
      quarter.width = Math.round(image.width / 4);
      quarter.height = Math.round(image.height / 4);
      const q = quarter.getContext("2d")!;
      q.imageSmoothingEnabled = true;
      q.imageSmoothingQuality = "high";
      q.drawImage(image, 0, 0, quarter.width, quarter.height);
      const zoom = document.createElement("canvas");
      zoom.width = quarter.width * 8;
      zoom.height = quarter.height * 8;
      const z = zoom.getContext("2d")!;
      z.imageSmoothingEnabled = false;
      z.drawImage(quarter, 0, 0, zoom.width, zoom.height);
      return {
        quarter: quarter.toDataURL("image/png").split(",")[1]!,
        zoom: zoom.toDataURL("image/png").split(",")[1]!,
      };
    }, buffer.toString("base64"));
    writeFileSync(`${OUT}/signals-lights_stage_${theme}_7px-actual.png`, Buffer.from(scaled.quarter, "base64"));
    writeFileSync(`${OUT}/signals-lights_stage_${theme}_7px-zoom8x.png`, Buffer.from(scaled.zoom, "base64"));
  }
  await setTheme(page, "dark");
  await snap(page, "signals", "lights-card", "stage", "five-states", { clip: page.locator(".attempt-card").first() });
  // The expanded list (CO17): each light with its word.
  await page.locator(".attempt-card").first().click();
  await page.waitForTimeout(300);
  await snap(page, "signals", "lights-expanded", "stage", "five-states", {
    clip: page.locator(".attempt-card").first(),
  });
});

function statusStream(): Ev[] {
  const s = new Script(POOL);
  s.at(0, "pool.state", poolStateFields({ real_agents: 12, max_real_agents: 12 }));
  s.at(0.01, "pool.files", filesEvent());
  const rows: Array<[string, string[]]> = [
    ["queued", []],
    ["working", ["working"]],
    ["going_around", ["working", "going_around"]],
    ["needs_confirm", ["working", "needs_confirm"]],
    ["submitted", ["working", "submitted"]],
    ["validated", ["working", "validated"]],
    ["held", ["working", "held"]],
    ["accepted", ["working", "validated", "accepted"]],
  ];
  rows.forEach(([name, path], index) => {
    const id = `a_${name}`;
    s.at(1 + index, "intent.created", {
      intent_id: `i_${name}`,
      text: `status ${name.replace("_", " ")}`,
      requester: "owner",
      race: false,
      prewritten: false,
    });
    s.at(1.1 + index, "attempt.opened", {
      attempt_id: id,
      intent_id: `i_${name}`,
      change_id: `c_${id}`,
      agent: "real",
      model: MODELS[index % 3],
      race: false,
    });
    let from = "opened";
    path.forEach((to, k) => {
      s.at(
        1.2 + index + k * 0.01,
        "attempt.state",
        stateFields(id, from, to, "T", { go_arounds: to === "going_around" ? 1 : 0 }),
      );
      from = to;
    });
    if (name === "accepted") {
      s.at(1.5 + index, "landing.accepted", {
        seq: 1,
        batch_id: 1,
        kind: "change",
        attempt_id: id,
        change_id: `c_${id}`,
        intent_id: `i_${name}`,
        request_id: null,
        paths: [],
        writes: [],
      });
    }
  });
  const stops: Array<[string, string]> = [
    ["stopped", "budget"],
    ["undone", "undone"],
    ["not_chosen", "not_chosen"],
    ["declined", "declined"],
  ];
  stops.forEach(([name, reason], index) => {
    const id = `a_${name}`;
    s.at(20 + index, "intent.created", {
      intent_id: `i_${name}`,
      text: `status ${name.replace("_", " ")}`,
      requester: "owner",
      race: false,
      prewritten: false,
    });
    s.at(20.1 + index, "attempt.opened", {
      attempt_id: id,
      intent_id: `i_${name}`,
      change_id: `c_${id}`,
      agent: "real",
      model: MODELS[index % 3],
      race: false,
    });
    s.at(20.2 + index, "attempt.state", stateFields(id, "opened", "working", "T1"));
    s.at(20.3 + index, "attempt.state", { ...stateFields(id, "working", "stopped", "T20"), reason });
  });
  return s.events;
}

test("VD2/VD10: the status shapes of 5.3 on attempt cards", async ({ page }) => {
  await prepare(page, STAGE);
  await serveLive(page, statusStream(), { owner: true });
  await page.goto("/");
  await expect(page.locator(".attempt-card").first()).toBeVisible();
  await page.waitForTimeout(800);
  await snap(page, "signals", "status-shapes", "stage", "working-tab", { clip: page.locator(".rail") });
  await page.getByRole("tab", { name: /Stopped/ }).click();
  await page.waitForTimeout(300);
  await snap(page, "signals", "status-shapes", "stage", "stopped-tab", { clip: page.locator(".rail") });
});

// =============================================================================================
// Row 3 (labels): SYNTHETIC, REPLAY and "constructed" on every view and sheet. The recording
// hero-canned is synthetic and plays under both banners; the sheets Replay has no door to (race,
// undo) are shown in a live synthetic pool, which must carry SYNTHETIC (FL4).

async function bannerFlags(page: Page): Promise<{ synthetic: boolean; replay: boolean }> {
  return {
    synthetic: await page.locator(".banner[data-tone='synthetic']").isVisible(),
    replay: await page.locator(".banner[data-tone='replay']").isVisible(),
  };
}

test("labels: every view and sheet of a synthetic recording (hero-canned)", async ({ page }) => {
  test.setTimeout(120_000);
  await prepare(page, STAGE);
  const seen: Record<string, unknown> = {};
  await openReplayAt(page, "hero-canned", positionAfter(HERO_CANNED, 118));
  seen["floor"] = await bannerFlags(page);
  // The held card's sheet (Replay: the visitor form).
  await openReplayAt(page, "hero-canned", positionAfter(HERO_CANNED, 103));
  await page.locator(".tray-row").getByRole("button", { name: "Open" }).click();
  await expect(page.locator(".card-sheet")).toBeVisible();
  seen["held-sheet"] = await bannerFlags(page);
  await snap(page, "labels", "held-sheet", "stage", "replay-synthetic", { themes: ["dark"] });
  await page.keyboard.press("Escape");
  // Compare view.
  await openReplayAt(page, "hero-canned", "end");
  await page.keyboard.press("c");
  await expect(page.locator(".cmp")).toBeVisible();
  seen["compare"] = { ...(await bannerFlags(page)), constructed: await page.locator(".cmp").innerText() };
  await page.keyboard.press("Escape");
  // The Why card, its git drawer and Who relies.
  await page.getByRole("tab", { name: /Landed/ }).click();
  await page.locator(".landed-row").first().click();
  await expect(page.locator(".why-sheet")).toBeVisible();
  seen["why"] = await bannerFlags(page);
  await snap(page, "labels", "why-card", "stage", "replay-synthetic", { themes: ["dark"] });
  await page.keyboard.press("g");
  await expect(page.locator(".git-drawer")).toBeVisible();
  seen["git"] = await bannerFlags(page);
  await snap(page, "labels", "git-drawer", "stage", "replay-synthetic", { themes: ["dark"] });
  await page.keyboard.press("g");
  const who = page.locator(".why-sheet").getByRole("button", { name: "Who relies on this" }).first();
  await who.click();
  await expect(page.locator(".who-sheet")).toBeVisible();
  seen["who"] = await bannerFlags(page);
  await snap(page, "labels", "who-relies", "stage", "replay-synthetic", { themes: ["dark"] });
  await page.keyboard.press("Escape");
  await expect(page.locator(".who-sheet")).toHaveCount(0);
  // About.
  await page.locator(".header").getByRole("button", { name: "About", exact: true }).first().click();
  await expect(page.locator(".about-sheet")).toBeVisible();
  seen["about"] = { ...(await bannerFlags(page)), text: await page.locator(".about-sheet").innerText() };
  await snap(page, "labels", "about", "stage", "replay-synthetic", { themes: ["dark"] });
  await page.keyboard.press("Escape");
  // Swarm view.
  await page.locator(".header").getByRole("button", { name: "Swarm", exact: true }).first().click();
  await expect(page.locator(".swarm-view")).toBeVisible();
  seen["swarm"] = await bannerFlags(page);
  await snap(page, "labels", "swarm-view", "stage", "replay-synthetic", { themes: ["dark"] });
  await page.locator(".header").getByRole("button", { name: "Floor", exact: true }).first().click();
  // The Replay menu and the Replay bar's controls.
  await page.locator(".header").getByRole("button", { name: "Replay", exact: true }).first().click();
  await expect(page.locator(".replay-menu")).toBeVisible();
  seen["replay-menu"] = await bannerFlags(page);
  await snap(page, "labels", "replay-menu", "stage", "replay-synthetic", { themes: ["dark"] });
  await page.keyboard.press("Escape");
  await snap(page, "labels", "replay-bar", "stage", "replay-synthetic", {
    clip: page.locator(".replay-bar"),
    themes: ["dark"],
  });
  writeJson("labels-banners", seen);
});

function syntheticLive(): Ev[] {
  // The demo pool, marked synthetic from its first event (EM1a): the race sheet and the undo
  // sheet of a synthetic pool, which Replay cannot open.
  return DEMO.upTo("beat6").map((event) => (event["type"] === "pool.state" ? { ...event, synthetic: true } : event));
}

test("labels: the race sheet and the undo sheet of a live synthetic pool", async ({ page }) => {
  await prepare(page, STAGE);
  const race = DEMO.upTo("beat4-race").map((event) =>
    event["type"] === "pool.state" ? { ...event, synthetic: true } : event,
  );
  await serveLive(page, race, { owner: true });
  await page.goto("/");
  await page.locator(".tray-row").getByRole("button", { name: "Open" }).first().click();
  await expect(page.locator(".card-sheet")).toBeVisible();
  const raceFlags = await bannerFlags(page);
  await snap(page, "labels", "race-sheet", "stage", "live-synthetic", { themes: ["dark"] });
  await page.keyboard.press("Escape");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await prepare(page, STAGE);
  await serveLive(page, syntheticLive(), { owner: true });
  await page.goto("/");
  await dismissStart(page);
  await page.getByRole("tab", { name: /Landed/ }).click();
  await page.locator(".landed-row", { hasText: "make energy" }).first().click();
  await page.locator(".why-sheet").getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".undo-sheet")).toContainText("Undo it");
  const undoFlags = await bannerFlags(page);
  await snap(page, "labels", "undo-sheet", "stage", "live-synthetic", { themes: ["dark"] });
  writeJson("labels-live-synthetic", { race: raceFlags, undo: undoFlags });
});

// =============================================================================================
// Row 5 (motion): what moves by itself, and the reduced-motion run of AC11.

test("VD1/VD13: the animations running on the beat-1 screen", async ({ page }) => {
  await prepare(page, STAGE);
  await serveLive(page, DEMO.upTo("beat1"), { owner: true });
  await page.goto("/");
  await expect(page.locator(".attempt-card").first()).toBeVisible();
  await page.waitForTimeout(2500);
  const running = await page.evaluate(() =>
    document.getAnimations().map((animation) => {
      const effect = animation.effect as KeyframeEffect | null;
      const timing = effect?.getComputedTiming();
      const target = effect?.target as Element | null;
      return {
        name: (animation as CSSAnimation).animationName ?? "",
        target:
          target === null || target === undefined
            ? ""
            : `${target.tagName.toLowerCase()}.${String((target as HTMLElement).className).split(" ")[0]}`,
        duration: timing?.duration ?? null,
        iterations: timing?.iterations ?? null,
      };
    }),
  );
  writeJson("motion-animations_beat01", { running });
});

test("AC11: reduced motion — frames and Replay start paused, nothing moves", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await prepare(page, STAGE);
  await serveLive(page, DEMO.upTo("beat3-goaround"), { owner: true });
  await page.goto("/");
  await expect(page.getByText("Going around").first()).toBeVisible();
  await page.waitForTimeout(800);
  const live = await page.evaluate(() => ({
    running: document.getAnimations().map((animation) => (animation as CSSAnimation).animationName ?? "transition"),
    framePaused: document.querySelector(".pf")?.textContent?.includes("Paused.") ?? false,
  }));
  await snap(page, "motion", "reduced", "stage", "live-going-around", { themes: ["dark"] });
  await page.goto("/replay/hero-canned");
  await expect(page.locator(".replay-bar")).toBeVisible();
  await page.waitForTimeout(800);
  const replay = await page.evaluate(() => ({
    running: document.getAnimations().map((animation) => (animation as CSSAnimation).animationName ?? "transition"),
    playButton: document.querySelector(".replay-bar .replay-button")?.textContent ?? null,
  }));
  await snap(page, "motion", "reduced", "stage", "replay-start", { themes: ["dark"] });
  writeJson("motion-reduced", { live, replay });
});

test("VD14: a new attempt card does not move the focused attempt card", async ({ page }) => {
  await prepare(page, STAGE);
  let socket: WebSocketRoute | undefined;
  const base = DEMO.upTo("beat1");
  await serveLive(page, base, { owner: true, onSocket: (ws) => (socket = ws) });
  await page.goto("/");
  const target = page.locator(".attempt-card").nth(2);
  await expect(target).toBeVisible();
  await target.focus();
  const before = await page.evaluate(() => document.activeElement?.getBoundingClientRect().top ?? null);
  const n = base.length;
  const ts = T0 + 71_000;
  socket!.send(
    JSON.stringify({
      events: [
        {
          n: n + 1,
          t: ts,
          ts,
          src: "trunk",
          pool: POOL,
          type: "intent.created",
          intent_id: "i_new",
          text: "a seahorse that bobs up and down",
          requester: "owner",
          race: false,
          prewritten: true,
        },
        {
          n: n + 2,
          t: ts,
          ts,
          src: "trunk",
          pool: POOL,
          type: "attempt.opened",
          attempt_id: "a_new",
          intent_id: "i_new",
          change_id: "c_a_new",
          agent: "real",
          model: MODELS[0],
          race: false,
        },
      ],
    }),
  );
  await expect(page.locator(".attempt-card__intent", { hasText: "seahorse" })).toBeVisible();
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({
    top: document.activeElement?.getBoundingClientRect().top ?? null,
    focused: document.activeElement?.textContent?.slice(0, 60) ?? null,
  }));
  writeJson("motion-vd14", { before, after });
});

// =============================================================================================
// Row 6 (keyboard): beats 1 to 7 and 10 with keys only (AX2, AC10), on the demo pool. Each step
// records whether the keys reached the control; a screenshot shows the focus ring where it stood.

type Focused = { text: string; label: string; cls: string; context: string };

/** Presses Tab until the focused element matches; `context` is the text of the row it sits in. */
async function tabTo(page: Page, match: (info: Focused) => boolean, limit = 120) {
  for (let i = 0; i < limit; i += 1) {
    await page.keyboard.press("Tab");
    const info: Focused = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      const row = element?.closest(".tray-row, .landed-row, .attempt-card, .card-sheet__candidate") ?? null;
      return {
        text: (element?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80),
        label: element?.getAttribute("aria-label") ?? "",
        cls: String(element?.className ?? ""),
        context: (row?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 120),
      };
    });
    if (match(info)) return { found: true, presses: i + 1, ...info };
  }
  return { found: false, presses: limit, text: "", label: "", cls: "", context: "" };
}

test("AC10: beats 1 to 7 and 10 with keys only", async ({ page }) => {
  test.setTimeout(180_000);
  await prepare(page, STAGE);
  const posts: Array<{ url: string; body: unknown }> = [];
  let socket: WebSocketRoute | undefined;
  await serveLive(page, DEMO.upTo("quiet"), { owner: true, onSocket: (ws) => (socket = ws) });
  // Trunk answers a create with the id its intent.created will carry (CO8 clears the draft on it).
  const intentIds = new Map(
    DEMO.events
      .filter((event) => event["type"] === "intent.created")
      .map((event) => [event["text"], event["intent_id"]]),
  );
  await page.route("**/api/pools/*/intents", async (route) => {
    const body = route.request().postDataJSON() as { text?: string };
    posts.push({ url: route.request().url(), body });
    const id = intentIds.get(body.text) ?? "i_unknown";
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, intent_id: id }) });
  });
  await page.route("**/api/pools/*/cards/*", async (route) => {
    posts.push({ url: route.request().url(), body: route.request().postDataJSON() });
    await route.fulfill({ contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/pools/*/undo", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    posts.push({ url: route.request().url(), body });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, request_id: body["request_id"] }),
    });
  });
  const steps: Record<string, unknown> = {};
  const feed = (mark: string, from: string) => {
    const all = DEMO.upTo(mark);
    const start = DEMO.upTo(from).length;
    socket!.send(JSON.stringify({ events: all.slice(start) }));
  };
  await page.goto("/");
  await expect(page.locator(".intent-box")).toBeVisible();
  await page.locator("body").click({ position: { x: 1, y: 1 } }); // the page root, as keyboard.spec.ts does
  steps["skip-link-first"] = await tabTo(page, () => true, 1);

  // Beat 1: the starter set from the pre-written menu, then the crab request raced.
  steps["start-card"] = await page.locator(".start-card").isVisible();
  steps["prewritten-menu"] = await tabTo(page, (f) => /Pre-written requests/.test(f.text + f.label));
  await page.keyboard.press("Enter");
  steps["starter-button"] = await tabTo(page, (f) => /Send the starter set/.test(f.text), 20);
  await snap(page, "keyboard", "beat01-starter", "stage", "focus", {
    themes: ["dark"],
    clip: page.locator(".intent-box"),
  });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  steps["starter-posts"] = posts.length;
  steps["focus-after-starter"] = await page.evaluate(() => document.activeElement?.tagName ?? null);
  // The pool answers: the starter set's intents and attempts arrive (the box waits for them, CO8).
  feed("beat1", "quiet");
  await expect(page.locator(".attempt-card").first()).toBeVisible();
  // What the box shows once the six intents are on the stream (CO8: the box should be ready again).
  await page.waitForTimeout(1000);
  steps["box-1s-after-intents"] = await page.locator(".intent-box").evaluate((box) => ({
    note: box.querySelector(".intent-note")?.textContent ?? null,
    readOnly: (box.querySelector("textarea") as HTMLTextAreaElement).readOnly,
  }));
  await page.waitForTimeout(5000);
  steps["box-6s-after-intents"] = await page.locator(".intent-box").evaluate((box) => ({
    note: box.querySelector(".intent-note")?.textContent ?? null,
    readOnly: (box.querySelector("textarea") as HTMLTextAreaElement).readOnly,
    buttons: [...box.querySelectorAll("button")].map(
      (b) => `${b.textContent}:${(b as HTMLButtonElement).disabled ? "off" : "on"}`,
    ),
  }));
  await snap(page, "keyboard", "beat01-box-after-starter", "stage", "6s", {
    themes: ["dark"],
    clip: page.locator(".rail"),
  });
  await focusRoot(page);
  await page.keyboard.press("/");
  await page.keyboard.type(CRAB_TEXT);
  steps["race-button"] = await tabTo(page, (f) => /^Race 3$/.test(f.text), 10);
  await snap(page, "keyboard", "beat01-race", "stage", "focus", {
    themes: ["dark"],
    clip: page.locator(".intent-box"),
  });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  steps["posts-after-race"] = posts.map((p) => p.body);
  feed("beat1-end", "beat1");
  await expect(page.getByText("Waiting for you").first()).toBeVisible();

  // Beat 2: the shared-rule request, then Who relies from the tile, by keys.
  await focusRoot(page);
  await page.keyboard.press("/");
  await page.keyboard.type(SHARED_TEXT);
  await page.keyboard.press("Enter");
  feed("beat2", "beat1-end");
  await expect(page.locator(".attempt-card__intent", { hasText: SHARED_TEXT }).first()).toBeVisible();
  await focusRoot(page);
  steps["tiles-more"] = await tabTo(page, (f) => /more/.test(f.text) && f.cls.includes("tile"));
  if ((steps["tiles-more"] as { found: boolean }).found) await page.keyboard.press("Enter");
  steps["tile-energy-forward"] = await tabTo(page, (f) => f.label.startsWith("world/energy.js"), 6);
  // The tiles the more-cell revealed sit before it in the tab order: back with Shift+Tab.
  await page.keyboard.down("Shift");
  steps["tile-energy"] = await tabTo(page, (f) => f.label.startsWith("world/energy.js"), 60);
  await page.keyboard.up("Shift");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  steps["tile-menu-focus"] = await page.evaluate(() => document.activeElement?.textContent ?? null);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  steps["who-open"] = await page.locator(".who-sheet").isVisible();
  steps["who-energy"] = await tabTo(page, (f) => /ENERGY_MAX/.test(f.text), 30);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await snap(page, "keyboard", "beat02-who", "stage", "focus", { themes: ["dark"], clip: page.locator(".who-sheet") });
  await page.keyboard.press("Escape");

  // Beat 3: the held card waits below the race card in the tray (N opens the oldest card, the
  // race): Tab to its Open, then Land by keys.
  feed("beat3-card", "beat2");
  await expect(page.getByRole("button", { name: /Needs you/ })).toBeVisible();
  await focusRoot(page);
  steps["held-open"] = await tabTo(page, (f) => f.text === "Open" && f.context.includes("shared rules"), 80);
  await page.keyboard.press("Enter");
  await expect(page.locator(".card-sheet")).toBeVisible();
  steps["held-sheet-focus"] = await page.evaluate(() => document.activeElement?.className ?? null);
  steps["land-button"] = await tabTo(page, (f) => f.text === "Land", 30);
  await snap(page, "keyboard", "beat03-held-sheet", "stage", "focus-land", {
    themes: ["dark"],
    clip: page.locator(".card-sheet"),
  });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  steps["posts-after-land"] = posts.length;
  feed("beat4-race", "beat3-card");

  // Beat 4: N opens the race card; Choose by keys; C for Compare, Esc back.
  await page.waitForTimeout(1600);
  await focusRoot(page);
  await page.keyboard.press("n");
  await expect(page.locator(".card-sheet")).toBeVisible();
  steps["choose-button"] = await tabTo(page, (f) => f.text === "Choose this one", 40);
  await snap(page, "keyboard", "beat04-race-sheet", "stage", "focus-choose", {
    themes: ["dark"],
    clip: page.locator(".card-sheet"),
  });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  steps["posts-after-choose"] = posts.length;
  feed("beat4-compare", "beat4-race");
  await page.waitForTimeout(1600);
  await focusRoot(page);
  await page.keyboard.press("c");
  steps["compare"] = await page.locator(".cmp").isVisible();
  await page.keyboard.press("Escape");

  // Beat 5: the sweep's card by N and Land.
  feed("beat5", "beat4-compare");
  await page.waitForTimeout(1600);
  steps["beat5-card-open"] = await page.locator(".tray-row").count();
  await focusRoot(page);
  await page.keyboard.press("n");
  steps["beat5-sheet"] = await page.locator(".card-sheet").isVisible();
  await page.keyboard.press("Escape");
  feed("beat6", "beat5");
  await page.waitForTimeout(1600);

  // Beat 6: L, then the crab's row, Enter; G for the git drawer.
  await focusRoot(page);
  await page.keyboard.press("l");
  steps["landed-row"] = await tabTo(page, (f) => f.cls.includes("landed-row") && f.text.includes("crab"), 80);
  await page.keyboard.press("Enter");
  steps["why-open"] = await page.locator(".why-sheet").isVisible();
  await page.keyboard.press("g");
  steps["git-open"] = await page.locator(".git-drawer").isVisible();
  await snap(page, "keyboard", "beat06-why-git", "stage", "keys", {
    themes: ["dark"],
    clip: page.locator(".git-drawer"),
  });
  await page.keyboard.press("Escape");
  steps["focus-after-esc"] = await page.evaluate(
    () => (document.activeElement as HTMLElement | null)?.className ?? null,
  );

  // Beat 7: the shared rule's row, Undo, Undo it.
  steps["landed-row-shared"] = await tabTo(
    page,
    (f) => f.cls.includes("landed-row") && f.text.includes("make energy"),
    40,
  );
  await page.keyboard.press("Enter");
  steps["undo-button"] = await tabTo(page, (f) => f.text === "Undo", 60);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  steps["undo-sheet"] = await page.locator(".undo-sheet").isVisible();
  steps["undo-confirm"] = await tabTo(page, (f) => f.text === "Undo it", 20);
  await snap(page, "keyboard", "beat07-undo", "stage", "focus-undo-it", {
    themes: ["dark"],
    clip: page.locator(".undo-sheet"),
  });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  steps["posts-after-undo"] = posts.length;
  await page.keyboard.press("Escape");

  // Beat 10: the owner locks the page by keys, then R plays the default recording.
  await focusRoot(page);
  steps["owner-button"] = await tabTo(page, (f) => f.text === "Owner", 20);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  steps["lock-button"] = await tabTo(page, (f) => f.text === "Lock", 10);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  steps["visitor"] = await page.locator(".owner-button").innerText();
  await focusRoot(page);
  await page.keyboard.press("r");
  await expect(page.locator(".replay-bar")).toBeVisible({ timeout: 10_000 });
  steps["replay-opened-paused"] = await page.locator(".replay-bar .replay-button").first().innerText();
  await snap(page, "keyboard", "beat10-replay", "stage", "key-r", {
    themes: ["dark"],
    clip: page.locator(".replay-bar"),
  });
  writeJson("keyboard-beats", { steps, posts: posts.map((p) => p.url) });
});

test("AX3: the focus ring on a strip cell, a tile, a light and an attempt card", async ({ page }) => {
  await prepare(page, STAGE);
  await serveLive(page, DEMO.upTo("beat3-goaround"), { owner: true });
  await page.goto("/");
  await expect(page.getByText("Going around").first()).toBeVisible();
  await focusRoot(page);
  const rings: Record<string, unknown> = {};
  for (const name of ["strip-cell", "tile", "light", "attempt-card"]) {
    const found = await tabTo(page, (f) => f.cls.split(" ").includes(name), 160);
    if (!found.found) continue;
    // The ring (AX3: 3 wide in `focus`, 2 away) and a clip of the focused control with room around it.
    rings[name] = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement!);
      return {
        outline: `${style.outlineWidth} ${style.outlineStyle} ${style.outlineColor}`,
        offset: style.outlineOffset,
      };
    });
    const box = await page.evaluate(() => {
      const r = document.activeElement!.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const clip = {
      x: Math.max(0, box.x - 24),
      y: Math.max(0, box.y - 24),
      width: Math.min(STAGE.width - Math.max(0, box.x - 24), box.width + 48),
      height: Math.min(STAGE.height - Math.max(0, box.y - 24), box.height + 48),
    };
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      await page.screenshot({ path: `${OUT}/keyboard-ax3-${name}_stage_${theme}_focus.png`, clip });
    }
    await setTheme(page, "dark");
  }
  writeJson("keyboard-ax3-rings", rings);
});

// =============================================================================================
// Row 7 (failures): one screenshot per row of section 7 the build can show. FR18 (Clef) and FR19
// (green line) belong to switched-off features. Where an e2e test already produces a row, the set-up
// here is that test's.

const FR_SIZE = LAPTOP;

async function frLive(page: Page, events: Ev[], owner = true): Promise<void> {
  await prepare(page, FR_SIZE);
  await serveLive(page, events, { owner });
  await page.goto("/");
}

function baseLive(extra: (s: Script) => void, poolExtra: Ev = {}): Ev[] {
  const s = new Script(POOL);
  s.at(0, "pool.state", poolStateFields(poolExtra));
  s.at(0.01, "pool.files", filesEvent());
  s.at(0.5, "limits", limitsFields(2.4), "gate");
  extra(s);
  return s.events;
}

/** The events of a fixture stream, renumbered onto the main pool so the live page plays them. */
function liveFixture(name: string): Ev[] {
  return fixtureEvents(name).map((event) => ({ ...event, pool: POOL }));
}

async function frShot(page: Page, row: string, state: string): Promise<void> {
  await snap(page, "failures", row, FR_SIZE.name, state, { themes: ["dark"] });
}

test.describe("failures", () => {
  test("FR1: the model is slow", async ({ page }) => {
    await frLive(page, liveFixture("fr01-model-slow.ndjson"));
    await page.waitForTimeout(1200);
    await frShot(page, "fr01", "model-slow");
  });

  test("FR2: a tool step failed", async ({ page }) => {
    await frLive(page, liveFixture("fr02-step-failed.ndjson"));
    await page.waitForTimeout(1200);
    await frShot(page, "fr02", "step-failed");
  });

  test("FR3: the checks sent a change back", async ({ page }) => {
    await frLive(page, liveFixture("fr03-submit-rejected.ndjson"));
    await page.waitForTimeout(1200);
    await frShot(page, "fr03", "submit-rejected");
  });

  test("FR4: an attempt stopped", async ({ page }) => {
    await frLive(page, liveFixture("fr04-attempt-stopped.ndjson"));
    await expect(page.locator(".toast").first()).toBeVisible();
    await frShot(page, "fr04", "toast");
    await page.getByRole("tab", { name: /Stopped/ }).click();
    await page.waitForTimeout(300);
    await frShot(page, "fr04", "stopped-tab");
  });

  test("FR5: a push is being retried — and the Landed tab against the strip", async ({ page }) => {
    const now = Date.now();
    const events = baseLive((s) => {
      s.at(1, "intent.created", {
        intent_id: "i_1",
        text: "a tracer fish",
        requester: "owner",
        race: false,
        prewritten: false,
      });
      s.at(1.1, "attempt.opened", {
        attempt_id: "a_1",
        intent_id: "i_1",
        change_id: "c_a_1",
        agent: "real",
        model: MODELS[0],
        race: false,
      });
      s.at(1.2, "attempt.state", stateFields("a_1", "opened", "working", "T1"));
      s.at(2, "attempt.state", stateFields("a_1", "working", "validated", "T12"));
    });
    const n = events.length;
    events.push(
      {
        n: n + 1,
        t: now,
        ts: now,
        src: "trunk",
        pool: POOL,
        type: "landing.accepted",
        seq: 1,
        batch_id: 1,
        kind: "change",
        attempt_id: "a_1",
        change_id: "c_a_1",
        intent_id: "i_1",
        request_id: null,
        paths: ["creatures/fish.js"],
        writes: [],
      },
      {
        n: n + 2,
        t: now,
        ts: now,
        src: "trunk",
        pool: POOL,
        ...stateFields("a_1", "validated", "accepted", "T15"),
        type: "attempt.state",
      },
      {
        n: n + 3,
        t: now,
        ts: now,
        src: "trunk",
        pool: POOL,
        type: "push.retry",
        batch_id: 1,
        tries: 1,
        error: "timeout",
        next_try_ms: 5000,
      },
    );
    await frLive(page, events);
    await expect(page.getByText("Landing…").first()).toBeVisible();
    const counts = {
      strip: await page.locator(".strip-cell[data-cell='strip.landed'] .strip-value").innerText(),
      tab: await page.getByRole("tab", { name: /Landed/ }).innerText(),
    };
    writeJson("failures-fr05-landed-counts", counts);
    await frShot(page, "fr05", "push-retry");
  });

  test("FR6: a push is pending for long", async ({ page }) => {
    await frLive(page, liveFixture("fr06-push-stalled.ndjson"));
    await page.waitForTimeout(1200);
    await frShot(page, "fr06", "push-stalled");
  });

  test("FR7: spend near the cap", async ({ page }) => {
    await frLive(
      page,
      baseLive((s) => s.at(2, "limits", limitsFields(33), "gate")),
    );
    await page.waitForTimeout(800);
    await frShot(page, "fr07", "spend-near");
  });

  test("FR8: the spend cap is reached", async ({ page }) => {
    await frLive(page, liveFixture("fr08-spend-cap.ndjson"));
    await page.waitForTimeout(1200);
    await frShot(page, "fr08", "spend-cap");
  });

  test("FR9: the kill switch is on", async ({ page }) => {
    await frLive(page, liveFixture("fr09-kill-switch.ndjson"));
    await page.waitForTimeout(1200);
    await frShot(page, "fr09", "kill-switch");
  });

  test("FR10: the connection is lost — and key R (FA4)", async ({ page }) => {
    await prepare(page, FR_SIZE);
    await serveSession(page, true);
    let first = true;
    const events = DEMO.upTo("beat1");
    await page.routeWebSocket(/\/api\/pools\/[^/]+\/stream/, (ws) => {
      ws.onMessage((message) => {
        const request = JSON.parse(message.toString()) as { hello?: number };
        if (request.hello !== 1) return;
        if (first) {
          first = false;
          ws.send(JSON.stringify({ events }));
          setTimeout(() => ws.close(), 600);
        } else {
          ws.close();
        }
      });
    });
    await page.goto("/");
    await expect(page.locator(".banner", { hasText: "CONNECTION" })).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(400);
    await frShot(page, "fr10", "offline");
    await focusRoot(page);
    await page.keyboard.press("r");
    await expect(page.locator(".replay-bar")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(600);
    await frShot(page, "fa4", "key-r-while-offline");
  });

  test("FR11: the pool diverged (owner: Rebuild)", async ({ page }) => {
    await frLive(page, liveFixture("fr11-push-rejected.ndjson"));
    await page.waitForTimeout(1200);
    await frShot(page, "fr11", "push-rejected");
  });

  test("FR12: a note does not match its commit", async ({ page }) => {
    await frLive(page, liveFixture("fr12-note-seq-mismatch.ndjson"));
    await page.waitForTimeout(1200);
    await frShot(page, "fr12", "note-mismatch");
  });

  test("FR13: the owner paused landings", async ({ page }) => {
    await frLive(page, liveFixture("fr13-owner-paused.ndjson"));
    await page.waitForTimeout(1200);
    await frShot(page, "fr13", "owner-paused");
  });

  test("FR14: the pool is rebuilding", async ({ page }) => {
    await frLive(page, liveFixture("fr14-rebuilding.ndjson"));
    await page.waitForTimeout(1200);
    await frShot(page, "fr14", "rebuilding");
  });

  test("FR15: a held card went out of date", async ({ page }) => {
    let socket: WebSocketRoute | undefined;
    await prepare(page, FR_SIZE);
    const events = DEMO.upTo("beat3-card");
    await serveLive(page, events, { owner: true, onSocket: (ws) => (socket = ws) });
    await page.goto("/");
    await page.locator(".tray-row", { hasText: "shared rules" }).getByRole("button", { name: "Open" }).click();
    await expect(page.locator(".card-sheet")).toBeVisible();
    const ts = T0 + 150_000;
    socket!.send(
      JSON.stringify({
        events: [
          {
            n: events.length + 1,
            t: ts,
            ts,
            src: "trunk",
            pool: POOL,
            type: "card.closed",
            card_id: "k_R01",
            action: "stale",
            by: "system",
            attempt_id: null,
            reason: null,
          },
        ],
      }),
    );
    await expect(page.locator(".card-sheet")).toContainText("out of date");
    await frShot(page, "fr15", "stale-sheet");
  });

  test("FR16: a change was sent back too often", async ({ page }) => {
    await frLive(page, liveFixture("fr16-go-around-limit.ndjson"));
    await page.waitForTimeout(1200);
    await frShot(page, "fr16", "tray");
    await focusRoot(page);
    await page.keyboard.press("n");
    await page.waitForTimeout(400);
    await frShot(page, "fr16", "sheet");
  });

  test("FR17: two requests contradict", async ({ page }) => {
    await frLive(page, liveFixture("fr17-contradiction.ndjson"));
    await page.waitForTimeout(1200);
    await focusRoot(page);
    await page.keyboard.press("n");
    await page.waitForTimeout(400);
    await frShot(page, "fr17", "sheet");
  });

  test("FR20: a pool frame did not load", async ({ page }) => {
    await page.setViewportSize({ width: FR_SIZE.width, height: FR_SIZE.height });
    await page.addInitScript(() => window.localStorage.setItem("premise.theme", "dark"));
    await page.route("**/pool/**", (route) => route.abort());
    await serveLive(page, DEMO.upTo("beat1"), { owner: true });
    await page.goto("/");
    await expect(page.locator(".pf-overlay")).toContainText("The pool did not load", { timeout: 20_000 });
    await frShot(page, "fr20", "frame-error");
  });

  test("FR21: the owner session ended", async ({ page }) => {
    await prepare(page, FR_SIZE);
    await serveLive(page, DEMO.upTo("beat1"), { owner: true });
    await page.route("**/api/kill", (route) => route.fulfill({ status: 401, body: "{}" }));
    await page.goto("/");
    await page.getByRole("button", { name: "Stop all agents" }).click();
    await page.locator(".kill-sheet").getByRole("button", { name: "Stop all agents" }).click();
    await expect(page.locator(".toast", { hasText: "Your owner session has ended." })).toBeVisible();
    await frShot(page, "fr21", "session-ended");
  });

  test("FR22: a request was refused", async ({ page }) => {
    await prepare(page, FR_SIZE);
    await serveLive(page, DEMO.upTo("beat1"), { owner: true });
    await page.route("**/api/kill", (route) => route.fulfill({ status: 429, body: "{}" }));
    await page.goto("/");
    await page.getByRole("button", { name: "Stop all agents" }).click();
    await page.locator(".kill-sheet").getByRole("button", { name: "Stop all agents" }).click();
    await expect(page.locator(".toast", { hasText: "Too many requests." })).toBeVisible();
    await frShot(page, "fr22", "refused");
  });

  test("FR23: a reopened change cannot go on with its author", async ({ page }) => {
    await frLive(page, liveFixture("card-choice-reopen-failed.ndjson"));
    await page.waitForTimeout(1200);
    await focusRoot(page);
    await page.keyboard.press("n");
    await page.waitForTimeout(400);
    await frShot(page, "fr23", "reopen-failed-sheet");
  });

  test("FR24: the Swarm did not start — the request fails", async ({ page }) => {
    await prepare(page, FR_SIZE);
    await serveLive(page, swarmStream({ running: false, agents: 64, wall: 0 }), { owner: true });
    await page.route("**/api/swarm", (route) => route.fulfill({ status: 500, body: "{}" }));
    await page.goto("/");
    await page.getByRole("button", { name: "Swarm", exact: true }).first().click();
    await page.locator(".swarm-controls").getByRole("button", { name: "Start" }).click();
    await expect(page.locator(".swarm-controls .field-error")).toBeVisible();
    await frShot(page, "fr24", "start-failed");
  });

  test("FR25: a recording cannot be played", async ({ page }) => {
    await prepare(page, FR_SIZE);
    await page.goto("/replay/no-such-recording");
    await expect(page.locator(".missing-pool")).toBeVisible();
    await frShot(page, "fr25", "replay-error");
  });

  test("FR26: all agent slots are busy", async ({ page }) => {
    await frLive(page, liveFixture("fr26-slots-busy.ndjson"));
    await page.waitForTimeout(1200);
    await frShot(page, "fr26", "slots-busy");
  });

  test("FR27: the page met an event it does not know", async ({ page }) => {
    await frLive(page, liveFixture("fr27-unknown-event.ndjson"));
    await page.waitForTimeout(800);
    await focusRoot(page);
    await page.keyboard.press("a");
    await expect(page.locator(".about-sheet")).toBeVisible();
    await page.locator(".about-sheet").evaluate((element) => element.scrollTo(0, 99999));
    await frShot(page, "fr27", "about-unknown-events");
  });

  test("FR28: a pool frame stopped answering", async ({ page }) => {
    test.setTimeout(60_000);
    await prepare(page, FR_SIZE);
    await serveLive(page, DEMO.upTo("beat1"), { owner: true });
    await page.goto("/");
    await expect(page.locator(".pf-body iframe")).toBeVisible();
    await page.waitForTimeout(1500);
    const frame = page.frames().find((f) => f.url().includes("/pool/"));
    await frame!.evaluate(() => {
      (window as unknown as { __silent: boolean }).__silent = true;
    });
    await expect(page.locator(".pf")).toContainText("stopped answering", { timeout: 20_000 });
    await frShot(page, "fr28", "reloaded-on-main");
    await page.waitForTimeout(1500);
    const again = page.frames().find((f) => f.url().includes("/pool/"));
    await again!.evaluate(() => {
      (window as unknown as { __silent: boolean }).__silent = true;
    });
    await expect(page.locator(".pf-overlay")).toContainText("The pool stopped answering", { timeout: 20_000 });
    await frShot(page, "fr28", "stalled");
  });

  test("FR29: a change was taken back too often", async ({ page }) => {
    const events = baseLive((s) => {
      s.at(1, "intent.created", {
        intent_id: "i_1",
        text: "a crab that hides in its shell when its energy drops below 30",
        requester: "owner",
        race: false,
        prewritten: false,
      });
      s.at(1.1, "attempt.opened", {
        attempt_id: "a_1",
        intent_id: "i_1",
        change_id: "c_a_1",
        agent: "real",
        model: MODELS[1],
        race: false,
      });
      s.at(1.2, "attempt.state", stateFields("a_1", "opened", "working", "T1"));
      s.at(30, "attempt.state", { ...stateFields("a_1", "working", "stopped", "T19s"), reason: "revert_limit" });
      s.at(30.1, "card.opened", {
        card: {
          card_id: "k_rl",
          kind: "choice",
          attempt_ids: ["a_1"],
          intent_ids: ["i_1"],
          submit_ids: {},
          title: "This change was taken back 3 times. Try again?",
          body: ["The crab change landed and was taken back 3 times. Let its agent try once more, or stop?"],
          options: [
            { id: "retry", label: "Try again" },
            { id: "stop", label: "Stop" },
          ],
          paths: [],
          blast_radius: {},
          preview: null,
          candidates: null,
          risk: null,
          reason: "revert_limit",
        },
      });
    });
    await frLive(page, events);
    await page.waitForTimeout(800);
    await focusRoot(page);
    await page.keyboard.press("n");
    await page.waitForTimeout(400);
    await frShot(page, "fr29", "revert-limit-sheet");
  });

  test("FR30: the address names no pool", async ({ page }) => {
    await prepare(page, FR_SIZE);
    await page.route("**/api/pools/ghost/stream", (route) =>
      route.fulfill({ status: 404, contentType: "application/json", body: '{"error":{"code":"not_found"}}' }),
    );
    await page.goto("/p/ghost");
    await expect(page.getByTestId("pool-missing")).toBeVisible();
    await frShot(page, "fr30", "pool-missing");
  });

  test("FR31: the undo plan changed", async ({ page }) => {
    await prepare(page, FR_SIZE);
    await serveLive(page, DEMO.upTo("beat6"), { owner: true });
    const next = {
      target_seq: 7,
      reverted: [7, 8, 10],
      reopened: [CRABS[1]!.attempt, "a_P9a"],
      kept_readers: [],
      repairs: [],
    };
    await page.route("**/api/pools/*/undo", (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, reason: "plan_changed", plan: next }),
      }),
    );
    await page.goto("/");
    await dismissStart(page);
    await page.getByRole("tab", { name: /Landed/ }).click();
    await page.locator(".landed-row", { hasText: "make energy" }).first().click();
    await page.locator(".why-sheet").getByRole("button", { name: "Undo" }).click();
    await page.locator(".undo-sheet").getByRole("button", { name: "Undo it" }).click();
    await page.waitForTimeout(600);
    await frShot(page, "fr31", "plan-changed");
  });

  test("FR32: a card's preview could not be built", async ({ page }) => {
    const events = DEMO.upTo("beat3-card").map((event) => {
      if (event["type"] !== "card.opened") return event;
      const card = event["card"] as Ev;
      return {
        ...event,
        card: { ...card, preview: { before: { repo: "main", commit: hex(6) }, after: {}, error: "build_failed" } },
      };
    });
    await frLive(page, events);
    await page.locator(".tray-row", { hasText: "shared rules" }).getByRole("button", { name: "Open" }).click();
    await expect(page.locator(".card-sheet")).toBeVisible();
    await page.waitForTimeout(500);
    await frShot(page, "fr32", "no-preview");
  });

  test("FR33: a view fails while it draws", async ({ page }) => {
    await prepare(page, FR_SIZE);
    await serveLive(page, swarmStream({ running: true, agents: 64, wall: 8, limits: false }), { owner: true });
    await page.goto("/");
    await expect(page.locator(".rail")).toBeVisible();
    await page.evaluate(() => {
      Number.prototype.toFixed = () => {
        throw new Error("injected render fault");
      };
    });
    await page.getByRole("button", { name: "Swarm", exact: true }).first().click();
    await expect(page.locator(".view-failed")).toBeVisible();
    await frShot(page, "fr33", "view-failed");
  });
});

// =============================================================================================
// The three items the lead noticed on the live page.

test("known item (a): the root folder's tile", async ({ page }) => {
  await prepare(page, STAGE);
  await serveLive(page, DEMO.upTo("beat1"), { owner: true });
  await page.goto("/");
  await page.locator(".tile-more").click();
  await page.waitForTimeout(300);
  const labels = await page.locator(".tiles-grid .tile-label .tile-name").allInnerTexts();
  writeJson("known-a-tile-labels", { labels });
  await snap(page, "known", "a-root-tile", "stage", "full-list", { clip: page.locator(".tiles") });
});

test("known item (b): the Landed counter against the Landed tab after an undo", async ({ page }) => {
  await prepare(page, STAGE);
  await serveLive(page, afterUndo(), { owner: true });
  await page.goto("/");
  await dismissStart(page);
  await page.getByRole("tab", { name: /Landed/ }).click();
  await page.waitForTimeout(400);
  const counts = {
    strip: await page.locator(".strip-cell[data-cell='strip.landed'] .strip-value").innerText(),
    tab: await page.getByRole("tab", { name: /Landed/ }).innerText(),
    rows: await page.locator(".landed-row").count(),
  };
  writeJson("known-b-landed-counts", counts);
  await snap(page, "known", "b-landed-counts", "stage", "after-undo", { themes: ["dark"] });
});

test("known item (c): the Swarm Start button while the Swarm's events arrive late", async ({ page }) => {
  test.setTimeout(60_000);
  await prepare(page, STAGE);
  let socket: WebSocketRoute | undefined;
  const events = swarmStream({ running: false, agents: 64, wall: 0 });
  await serveLive(page, events, { owner: true, onSocket: (ws) => (socket = ws) });
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/swarm", async (route) => {
    await held;
    await route.fulfill({ contentType: "application/json", body: '{"ok":true}' });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Swarm", exact: true }).first().click();
  await page.locator(".swarm-controls").getByRole("button", { name: "Start" }).click();
  await page.waitForTimeout(300);
  const timeline: Array<{ at: string; button: string; notes: string }> = [];
  const look = async (at: string) => {
    timeline.push({
      at,
      button: await page.locator(".swarm-controls button").innerText(),
      notes: (await page.locator(".swarm-view").innerText()).split("\n").slice(0, 3).join(" | "),
    });
  };
  await look("request in flight");
  await snap(page, "known", "c-swarm-start", "stage", "1-request-in-flight", { themes: ["dark"] });
  release!();
  await page.waitForTimeout(600);
  await look("request answered, no swarm.state yet");
  await snap(page, "known", "c-swarm-start", "stage", "2-answered-no-event", { themes: ["dark"] });
  const ts = T0 + 40_000;
  socket!.send(
    JSON.stringify({
      events: [
        {
          n: events.length + 1,
          t: ts,
          ts,
          src: "swarm",
          pool: POOL,
          type: "swarm.state",
          ...SWARM_DEFAULTS,
          running: true,
          agents: 64,
        },
      ],
    }),
  );
  await page.waitForTimeout(800);
  await look("swarm.state running, no scripted attempt on this stream");
  await snap(page, "known", "c-swarm-start", "stage", "3-running-no-attempt", { themes: ["dark"] });
  await page.waitForTimeout(11_000);
  await look("11 s later (FR24 says swarm.no_agents after 10 s)");
  await snap(page, "known", "c-swarm-start", "stage", "4-after-10s", { themes: ["dark"] });
  writeJson("known-c-swarm-start", { timeline });
});

test("CO8/FL10: the intent box after a typed send whose intent.created arrives after the reply", async ({ page }) => {
  await prepare(page, STAGE);
  let socket: WebSocketRoute | undefined;
  const base = DEMO.upTo("beat1-end");
  await serveLive(page, base, { owner: true, onSocket: (ws) => (socket = ws) });
  await page.route("**/api/pools/*/intents", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, intent_id: "i_R01" }) }),
  );
  await page.goto("/");
  await expect(page.locator(".attempt-card").first()).toBeVisible();
  await page.locator(".intent-field").fill(SHARED_TEXT);
  await page.locator(".intent-box").getByRole("button", { name: "Send", exact: true }).click();
  // The pool's intent.created reaches the socket 300 ms after the create request answered.
  await page.waitForTimeout(300);
  const created = DEMO.events.find((event) => event["type"] === "intent.created" && event["intent_id"] === "i_R01")!;
  socket!.send(JSON.stringify({ events: [{ ...created, n: base.length + 1 }] }));
  const look = () =>
    page.locator(".intent-box").evaluate((box) => ({
      draft: (box.querySelector("textarea") as HTMLTextAreaElement).value,
      readOnly: (box.querySelector("textarea") as HTMLTextAreaElement).readOnly,
      note: box.querySelector(".intent-note")?.textContent ?? null,
      buttons: [...box.querySelectorAll("button")].map(
        (button) => `${button.textContent}:${(button as HTMLButtonElement).disabled ? "off" : "on"}`,
      ),
    }));
  await page.waitForTimeout(1000);
  const after1s = await look();
  await page.waitForTimeout(5000);
  const after6s = await look();
  writeJson("copy-intent-box-after-send", { intentCreatedSentMsAfterReply: 300, after1s, after6s });
  await snap(page, "copy", "intent-box", "stage", "sent-waiting-6s", {
    themes: ["dark"],
    clip: page.locator(".intent-box"),
  });
});

test("AX13/FA4/CO38: single-key shortcuts while a button has focus; N while no candidate can be chosen", async ({
  page,
}) => {
  await prepare(page, STAGE);
  await serveLive(page, DEMO.upTo("beat1"), { owner: true });
  await page.goto("/");
  await expect(page.locator(".attempt-card").first()).toBeVisible();
  // N with the race card open and no candidate that can be chosen (CO38).
  await focusRoot(page);
  await page.keyboard.press("n");
  await page.waitForTimeout(400);
  const nOpens = {
    sheet: await page.locator(".card-sheet").count(),
    chooseButtons: await page.locator(".card-sheet").getByRole("button", { name: "Choose this one" }).count(),
    title:
      (await page.locator(".card-sheet__title").count()) > 0
        ? await page.locator(".card-sheet__title").innerText()
        : null,
  };
  await page.keyboard.press("Escape");
  // A, then R, while a header button holds focus (as after any click on it), then with nothing focused.
  await page.locator(".owner-button").focus();
  await page.keyboard.press("a");
  await page.waitForTimeout(300);
  const aWithButtonFocus = await page.locator(".about-sheet").count();
  await page.keyboard.press("r");
  await page.waitForTimeout(1500);
  const rWithButtonFocus = new URL(page.url()).pathname;
  await focusRoot(page);
  await page.keyboard.press("r");
  await page.waitForTimeout(1500);
  const rWithoutFocus = new URL(page.url()).pathname;
  writeJson("keyboard-shortcuts-on-buttons", { nOpens, aWithButtonFocus, rWithButtonFocus, rWithoutFocus });
});
