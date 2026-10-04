// The window/document surface the host touches, as an injectable value (HO3 keeps DOM objects out of
// pool code; keeping them out of the host's own signatures lets the same host run in a Node harness).
// `browserEnv` reads the real frame; tests pass a fake.

import type { PoolToFloor } from "../protocol/channel.ts";

/** The 2D context members the surface uses (PN6: no text, image or pixel operation). */
export interface Canvas2dLike {
  save(): void;
  restore(): void;
  beginPath(): void;
  clip(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, from: number, to: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  ellipse(x: number, y: number, rx: number, ry: number, angle: number, from: number, to: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  stroke(): void;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
}

/** The canvas element members the host uses (`canvas#pool` of index.html). */
export interface CanvasLike {
  width: number;
  height: number;
  /** CSS size, for the letterboxed fit of HO5. */
  clientWidth: number;
  clientHeight: number;
  getContext(kind: "2d"): Canvas2dLike | null;
  /** `getBoundingClientRect()`: the element's box in CSS pixels, for tap conversion (HO6). */
  rect(): { left: number; top: number; width: number; height: number };
}

export type TimerHandle = number;

/** Everything the host needs from its frame. Nothing pool-facing is reachable through it. */
export type HostEnv = {
  /** `location.href` of the pool page: the base for `./~head.js` and the page params of 4.5. */
  readonly pageUrl: string;
  /** `canvas#pool`, or null when the page has none. */
  readonly canvas: CanvasLike | null;
  /** The object `event.source` must equal for a message to count (HO17). */
  readonly parentWindow: unknown;
  /** Wall clock (`performance.now()`): drives the fixed-step accumulator of HO4. */
  now(): number;
  /** `document.visibilityState === "hidden"` (HO4: a hidden page does not tick). */
  hidden(): boolean;
  /** `window.devicePixelRatio`: backing store pixels per CSS pixel, for the fit of HO5. */
  pixelRatio(): number;
  /** `setInterval`/`setTimeout`/`clearInterval`/`clearTimeout`; handles are numbers so fakes stay trivial. */
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  /** `requestAnimationFrame`: call `fn(now)` on the next frame. */
  requestFrame(fn: (now: number) => void): void;
  /** `window.addEventListener("message", …)`: `handler` gets the message data and `event.source`. */
  onMessage(handler: (data: unknown, event: { source: unknown }) => void): void;
  /** A pointer press on the canvas, in CSS pixels relative to the viewport (`pointerdown`, HO6). */
  onPointerDown(handler: (clientX: number, clientY: number) => void): void;
  /** `parent.postMessage(message, "*")`: the frame is opaque, so no narrower target exists. */
  postMessage(message: PoolToFloor): void;
  /** `location.href = url`: a commit frame's restart (HO14). */
  navigate(url: string): void;
  /** `location.reload()`: a live frame's restart (4.7). */
  reload(): void;
  /**
   * `import(specifier)`: supplied by generated code (`~boot.js`) or by the test harness, never written
   * in `src/`: the repository's import allow-list refuses a computed `import()` in checked files.
   */
  importModule(specifier: string): Promise<unknown>;
};

/** The pool page's own surface: query string, canvas, frame channel. */
export function browserEnv(importModule: HostEnv["importModule"]): HostEnv {
  const g = globalThis as {
    document?: {
      querySelector(selector: string): unknown;
      visibilityState?: string;
    };
    window?: {
      location?: { href?: string; reload?: () => void };
      parent?: { postMessage?: (data: unknown, origin: string) => void };
      addEventListener?: (type: string, handler: (event: unknown) => void) => void;
      requestAnimationFrame?: (fn: (now: number) => void) => number;
      setInterval?: (fn: () => void, ms: number) => number;
      clearInterval?: (handle: number) => void;
      setTimeout?: (fn: () => void, ms: number) => number;
      clearTimeout?: (handle: number) => void;
      devicePixelRatio?: number;
      performance?: { now(): number };
    };
  };
  const win = (g.window ?? {}) as NonNullable<typeof g.window>;
  const doc = (g.document ?? {}) as NonNullable<typeof g.document>;
  const canvas = (doc.querySelector?.("canvas#pool") ?? null) as CanvasLike | null;
  const canvasEvents = canvas as unknown as {
    addEventListener?(type: string, handler: (event: { clientX: number; clientY: number }) => void): void;
    getBoundingClientRect?(): { left: number; top: number; width: number; height: number };
  } | null;
  return {
    pageUrl: win.location?.href ?? "",
    canvas,
    parentWindow: win.parent,
    now: () => win.performance?.now() ?? Date.now(),
    hidden: () => doc.visibilityState === "hidden",
    pixelRatio: () => win.devicePixelRatio ?? 1,
    // `window.` forms return `number` under both the DOM and the Node typings (tsconfig note).
    setInterval: (fn, ms) => (win.setInterval ?? ((f, m) => Number(setInterval(f, m))))(fn, ms),
    clearInterval: (handle) => (win.clearInterval ?? clearInterval)(handle),
    setTimeout: (fn, ms) => (win.setTimeout ?? ((f, m) => Number(setTimeout(f, m))))(fn, ms),
    clearTimeout: (handle) => (win.clearTimeout ?? clearTimeout)(handle),
    requestFrame: (fn) =>
      void (win.requestAnimationFrame ?? ((f: (now: number) => void) => setTimeout(() => f(Date.now()), 16)))(fn),
    onMessage: (handler) =>
      win.addEventListener?.("message", (event) => {
        const message = event as { data: unknown; source: unknown };
        handler(message.data, { source: message.source });
      }),
    onPointerDown: (handler) =>
      canvasEvents?.addEventListener?.("pointerdown", (event) => handler(event.clientX, event.clientY)),
    postMessage: (message) => win.parent?.postMessage?.(message, "*"),
    navigate: (url) => {
      if (win.location) win.location.href = url;
    },
    reload: () => win.location?.reload?.(),
    importModule,
  };
}
