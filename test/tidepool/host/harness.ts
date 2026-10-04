// The frame harness for the pool host's Node tests: a fake HostEnv (clock, timers, canvas, channel)
// plus helpers that lay a pool version down on disk. The host under test runs real dynamic imports
// against the fixture files — `import()` reaches `file:` URLs through a Function-constructed loader
// because the repository's import checker refuses a computed `import()` in checked files.

import { promises as fs } from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Canvas2dLike, CanvasLike, HostEnv, TimerHandle } from "../../../src/host/env.ts";
import type { PoolToFloor } from "../../../src/protocol/channel.ts";
import type { Landed } from "../../../src/host/main.ts";

/** A 2D context that records every call — enough to prove what the surface drew. */
export class RecordingContext implements Canvas2dLike {
  ops: Array<readonly unknown[]> = [];
  fillStyle = "";
  strokeStyle = "";
  lineWidth = 0;
  globalAlpha = 1;
  private rec(op: string, ...args: unknown[]) {
    this.ops.push([op, ...args]);
  }
  save() {
    this.rec("save");
  }
  restore() {
    this.rec("restore");
  }
  beginPath() {
    this.rec("beginPath");
  }
  clip() {
    this.rec("clip");
  }
  closePath() {
    this.rec("closePath");
  }
  moveTo(x: number, y: number) {
    this.rec("moveTo", x, y);
  }
  lineTo(x: number, y: number) {
    this.rec("lineTo", x, y);
  }
  arc(x: number, y: number, r: number, from: number, to: number) {
    this.rec("arc", x, y, r, from, to);
  }
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number) {
    this.rec("arcTo", x1, y1, x2, y2, r);
  }
  ellipse(x: number, y: number, rx: number, ry: number, angle: number, from: number, to: number) {
    this.rec("ellipse", x, y, rx, ry, angle, from, to);
  }
  rect(x: number, y: number, w: number, h: number) {
    this.rec("rect", x, y, w, h);
  }
  translate(x: number, y: number) {
    this.rec("translate", x, y);
  }
  rotate(angle: number) {
    this.rec("rotate", angle);
  }
  scale(x: number, y: number) {
    this.rec("scale", x, y);
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.rec("setTransform", a, b, c, d, e, f);
  }
  clearRect(x: number, y: number, w: number, h: number) {
    this.rec("clearRect", x, y, w, h);
  }
  fill() {
    this.rec("fill");
  }
  stroke() {
    this.rec("stroke");
  }
  /** Ops recorded since the mark. */
  since(mark: number): Array<readonly unknown[]> {
    return this.ops.slice(mark);
  }
  mark(): number {
    return this.ops.length;
  }
}

export class FakeCanvas implements CanvasLike {
  width = 0;
  height = 0;
  clientWidth = 400;
  clientHeight = 300;
  ctx = new RecordingContext();
  private down: Array<(x: number, y: number) => void> = [];
  getContext(kind: "2d"): Canvas2dLike | null {
    return kind === "2d" ? this.ctx : null;
  }
  rect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
  tap(x: number, y: number) {
    for (const handler of this.down) handler(x, y);
  }
  _onDown(handler: (x: number, y: number) => void) {
    this.down.push(handler);
  }
}

type Timer = { id: TimerHandle; at: number; every: number | null; fn: () => void; dead: boolean };

/** A fake frame: the HostEnv the harness hands `runHost`, plus test-only affordances. */
export class FakeFrame {
  readonly canvas = new FakeCanvas();
  readonly parentWindow = {};
  readonly posted: PoolToFloor[] = [];
  readonly navigations: string[] = [];
  readonly imports: string[] = [];
  reloads = 0;
  hiddenNow = false;
  now = 0;
  private timers: Timer[] = [];
  private raf: Array<(now: number) => void> = [];
  private messages: Array<(data: unknown, event: { source: unknown }) => void> = [];
  private nextId = 1;

  readonly pageUrl: string;
  /** The disk root that stands in for `file:///pool/` — `/pool/<p>/v/<v>/<path>` maps under it. */
  private poolRoot: string | null = null;

  constructor(pageUrl: string) {
    this.pageUrl = pageUrl;
    this.env = this.buildEnv();
  }

  /** Mount the version tree `root` (holding `<pool>/<version>/…`) at the `/pool/` path. */
  mount(root: string): this {
    this.poolRoot = pathToFileURL(root).href;
    return this;
  }

  /** The env's module loader: `/pool/<p>/v/<v>/<path>` → `<root>/<p>/<v>/<path>` on disk. */
  private load(specifier: string): Promise<unknown> {
    let target = specifier;
    const pooled = /^file:\/\/\/pool\/([^/]+)\/v\/([^/]+)\/(.+)$/.exec(specifier);
    if (pooled !== null && this.poolRoot !== null) {
      target = `${this.poolRoot}/${pooled[1]}/${pooled[2]}/${pooled[3]}`;
    }
    return importModule(target);
  }

  readonly env: HostEnv;

  private buildEnv(): HostEnv {
    return {
      pageUrl: this.pageUrl,
      canvas: this.canvas,
      parentWindow: this.parentWindow,
      now: () => this.now,
      hidden: () => this.hiddenNow,
      pixelRatio: () => 1,
      setInterval: (fn, ms) => this.addTimer(fn, ms),
      clearInterval: (id) => this.kill(id),
      setTimeout: (fn, ms) => this.addTimer(fn, ms, true),
      clearTimeout: (id) => this.kill(id),
      requestFrame: (fn) => void this.raf.push(fn),
      onMessage: (handler) => void this.messages.push(handler),
      onPointerDown: (handler) => void this.canvas._onDown(handler),
      postMessage: (message) => void this.posted.push(message),
      navigate: (url) => void this.navigations.push(url),
      reload: () => {
        this.reloads += 1;
      },
      importModule: async (specifier) => {
        this.imports.push(specifier);
        return this.load(specifier);
      },
    };
  }

  private addTimer(fn: () => void, ms: number, once = false): TimerHandle {
    const timer: Timer = { id: this.nextId++, at: this.now + ms, every: once ? null : ms, fn, dead: false };
    this.timers.push(timer);
    return timer.id;
  }
  private kill(id: TimerHandle) {
    const timer = this.timers.find((t) => t.id === id);
    if (timer) timer.dead = true;
  }

  /** Advance the fake clock; fires due timers (intervals reschedule). */
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => !t.dead && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.now = due.at;
      if (due.every !== null) due.at = this.now + due.every;
      else due.dead = true;
      due.fn();
    }
    this.now = end;
  }

  /** Deliver one animation frame `ms` after the last. */
  frame(ms = 17) {
    this.now += ms;
    const callbacks = this.raf.splice(0);
    for (const fn of callbacks) fn(this.now);
  }

  /** Post a message as if from the parent window (or any source, for the HO17 negative test). */
  message(data: unknown, source: unknown = this.parentWindow) {
    for (const handler of this.messages) handler(data, { source });
  }

  tap(x: number, y: number) {
    this.canvas.tap(x, y);
  }

  stats(): Extract<PoolToFloor, { type: "stats" }>[] {
    return this.posted.filter((m): m is Extract<PoolToFloor, { type: "stats" }> => m.type === "stats");
  }
  lastStats() {
    return this.stats()[this.stats().length - 1];
  }
}

/**
 * A real dynamic import for the frame: `vm.compileFunction` carries Node's default module loader
 * (`importModuleDynamically`), so `file:` URLs — cache-busting query included — resolve exactly as a
 * page's modules do. A literal `import(specifier)` may not appear in a checked file (the repository's
 * import allow list refuses a specifier it cannot read), so the call lives inside compiled code.
 */
const importExpression = vm.compileFunction("return import(specifier)", ["specifier"], {
  importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
});
const importModule = (specifier: string) => importExpression(specifier) as Promise<unknown>;

/** Evaluate a generated `~*.js` module's text in the tests (a `data:` URL import). */
export const importText = (source: string): Promise<Record<string, unknown>> =>
  importModule(`data:text/javascript,${encodeURIComponent(source)}`) as Promise<Record<string, unknown>>;

// ---- Fixture pools on disk ----

export function sha1Hex(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
/** The git blob id of a byte string (01-core 2.5): sha1 of "blob <size>\0" + content. */
export function blobId(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** A valid version token of the shape `c-<40 hex>`/`p-<40 hex>` for fixture commits. */
export function versionOf(name: string, kind: "c" | "p" = "c"): string {
  return `${kind}-${sha1Hex(`fixture:${name}`)}`;
}

const INDEX_HTML = `<!doctype html>\n<meta charset="utf-8">\n<canvas id="pool"></canvas>\n<script type="module" src="./~boot.js"></script>\n`;

const MAIN_JS = `export const TAP_RADIUS = 30;
export function poolSize() { return { width: 200, height: 100 }; }
function populate(world, kinds) {
  for (const kind of Object.keys(kinds)) {
    const count = Math.max(1, kinds[kind].count ?? 1);
    for (let i = 0; i < count; i += 1) {
      const spawned = kinds[kind].spawn(world);
      world.creatures.push({ ...spawned, kind, id: world.nextId });
      world.nextId += 1;
    }
  }
}
export function createPool(kinds) {
  const world = { tick: 0, nextId: 1, creatures: [], errors: {}, benched: {} };
  populate(world, kinds);
  return { world, kinds };
}
export function adoptPool(pool, kinds, changed) {
  const world = pool.world;
  world.creatures = world.creatures.filter((c) => kinds[c.kind] && !changed.includes(c.kind));
  world.errors = {};
  world.benched = {};
  populate(world, kinds);
  return { world, kinds };
}
export function tick(pool) {
  pool.world.tick += 1;
  for (const creature of pool.world.creatures) pool.kinds[creature.kind].update(creature, pool.world);
}
export function draw(pool, control) {
  control.clear();
  control.begin(0, 0, "scene");
  control.end();
  for (const creature of pool.world.creatures) {
    control.begin(creature.x, creature.y, "creature");
    pool.kinds[creature.kind].draw(creature, control.pen, pool.world);
    control.end();
  }
}
export function creatureAt(pool, x, y) {
  let best = null;
  let bestFar = TAP_RADIUS;
  for (const creature of pool.world.creatures) {
    const far = Math.hypot(creature.x - x, creature.y - y);
    if (far <= bestFar) {
      best = { kind: creature.kind, id: creature.id };
      bestFar = far;
    }
  }
  return best;
}
export function stats(pool) {
  const kinds = {};
  for (const kind of Object.keys(pool.kinds).sort()) {
    kinds[kind] = { count: 0, resting: 0, errors: pool.world.errors[kind] || 0, benched: Boolean(pool.world.benched[kind]) };
  }
  for (const creature of pool.world.creatures) {
    if (kinds[creature.kind]) kinds[creature.kind].count += 1;
  }
  return { tick: pool.world.tick, food: 0, kinds };
}
`;

const PEN_JS = `export const MAX_SHAPES = 40;
export const MAX_REACH = 60;
export const PALETTE = {};
export function toHex(colour) { return colour; }
export function toGrey(hex) { return "#8a97a0"; }
export function createPen(surface) {
  let fill = "#ffffff", stroke = "#10222e", width = 2, alpha = 1;
  const apply = () => surface.style(fill, stroke, width, alpha);
  const pen = {
    fill(c) { fill = c; apply(); },
    stroke(c, w = 2) { stroke = c; width = w; apply(); },
    alpha(a) { alpha = a; apply(); },
    circle(x, y, r) { surface.circle(x, y, r); },
    ellipse(x, y, rx, ry, a = 0) { surface.ellipse(x, y, rx, ry, a); },
    rect(x, y, w, h, c = 0) { surface.rect(x, y, w, h, c); },
    line(x1, y1, x2, y2) { surface.line(x1, y1, x2, y2); },
    poly(points) { surface.poly(points); },
    arc(x, y, r, from, to) { surface.arc(x, y, r, from, to); },
    turn(a) { surface.turn(a); },
    flip() { surface.flip(); },
  };
  return {
    pen: Object.freeze(pen),
    clear() { surface.reset(); },
    begin(x, y, mode) { surface.push(x, y, mode === "scene" ? 0 : 60); },
    end() { surface.pop(); },
  };
}
`;

const TIME_JS = `export const TICKS_PER_SECOND = 60;\n`;

const SELFTEST_JS = `export function runSelfTest({ kinds, reseed }) {
  reseed(7);
  return { ok: true, failed: [], saw: Object.keys(kinds).sort() };
}
`;

/** One creature file the tests mutate freely. */
export function creatureJs(kind: string, variant = 0): string {
  return `export function spawn() {
  return { x: ${10 + variant * 5} + Math.random() * 20, y: 30 };
}
export function update(c) { c.x += 1; }
export function draw(c, pen) { pen.fill("#e5484d"); pen.circle(0, 0, ${5 + variant}); }
`;
}

export type FixtureFile = { path: string; content: string };

/**
 * Lay a pool version down under `<root>/<pool>/<version>/`. `creatures` maps kind → source. Extra
 * shared files (any path outside `creatures/`) come from `shared`. The generated `~registry.js` is
 * written too, computed the way AS9/AS10 define it — independent of the app server's own generator.
 */
export async function writeVersion(
  root: string,
  pool: string,
  version: string,
  options: { creatures: Record<string, string>; shared?: Record<string, string>; selftest?: string },
): Promise<{ base: string; registry: unknown }> {
  const dir = join(root, pool, version);
  const files: FixtureFile[] = [
    { path: "index.html", content: INDEX_HTML },
    { path: "main.js", content: MAIN_JS },
    { path: "pen.js", content: PEN_JS },
    { path: "world/time.js", content: TIME_JS },
    { path: "selftest/run.js", content: options.selftest ?? SELFTEST_JS },
  ];
  for (const [path, content] of Object.entries(options.shared ?? {})) files.push({ path, content });
  for (const [kind, content] of Object.entries(options.creatures)) {
    files.push({ path: `creatures/${kind}.js`, content });
  }
  for (const file of files) {
    await fs.mkdir(dirname(join(dir, file.path)), { recursive: true });
    await fs.writeFile(join(dir, file.path), file.content);
  }
  const kinds = Object.keys(options.creatures)
    .sort()
    .map((kind) => ({ kind, path: `creatures/${kind}.js`, oid: blobId(options.creatures[kind]!) }));
  const shared = files
    .filter((file) => !file.path.startsWith("creatures/"))
    .map((file) => `${file.path} ${blobId(file.content)}`)
    .sort();
  const registry = {
    version,
    shared: sha256Hex(shared.join("\n")).slice(0, 32),
    kinds,
    total: kinds.length,
    skipped: [],
  };
  await fs.writeFile(join(dir, "~registry.js"), `export const registry = ${JSON.stringify(registry, null, 2)};\n`);
  const base = pathToFileURL(dir + "/").href;
  return { base, registry };
}

/** The page directory the host's `./~head.js` polls resolve against; `writeHead` mutates it. */
export async function writeHead(pageDir: string, landed: Landed): Promise<void> {
  await fs.mkdir(pageDir, { recursive: true });
  await fs.writeFile(join(pageDir, "~head.js"), `export const landed = ${JSON.stringify(landed, null, 2)};\n`);
}

export function landedFor(pool: string, source: string, version: string, base: string, seq: number | null = 0): Landed {
  return { pool, source, version, base, seq };
}
