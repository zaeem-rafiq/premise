// The surface of 02-tidepool 3.3: the platform-owned drawing object that `pen.js` is built on. It
// enforces PN6 (exactly the members of table 3.3) and PN7 (a call that fails a listed check is
// ignored; depth 2, HOST_MAX_REACH, HOST_MAX_OPS between one push and its pop).

import { HOST_MAX_OPS, HOST_MAX_REACH } from "../protocol/constants.ts";
import type { Canvas2dLike, CanvasLike } from "./env.ts";

/** `style(fill, stroke, width, alpha)`: hex colour strings or `null`, per 3.1. */
export type PoolStyle = { fill: string | null; stroke: string | null; width: number; alpha: number };

/** The twelve members of table 3.3 — and nothing else (PN6). */
export type Surface = {
  reset(): void;
  push(x: number, y: number, clipRadius: number): void;
  pop(): void;
  turn(angle: number): void;
  flip(): void;
  style(fill: string | null, stroke: string | null, width: number, alpha: number): void;
  line(x1: number, y1: number, x2: number, y2: number): void;
  rect(x: number, y: number, w: number, h: number, corner?: number): void;
  circle(x: number, y: number, r: number): void;
  ellipse(x: number, y: number, rx: number, ry: number, angle: number): void;
  poly(points: readonly number[]): void;
  arc(x: number, y: number, r: number, from: number, to: number): void;
};

const HEX = /^#[0-9a-f]{6}$/;
const MAX_DEPTH = 2;
const DEFAULT_STYLE: PoolStyle = { fill: null, stroke: "#e8f4f8", width: 2, alpha: 1 };

function finite(...values: Array<number | null | undefined>): boolean {
  return values.every((value) => typeof value === "number" && Number.isFinite(value));
}

function hexOrNull(value: string | null): boolean {
  return value === null || (typeof value === "string" && HEX.test(value));
}

/**
 * The surface over `canvas`'s 2D context. `fit(width, height)` is host-side plumbing (the letterboxed
 * transform of HO5) and stays outside the object given to `createPen`, so that object carries exactly
 * the twelve members of table 3.3 (PN6).
 */
export function createSurface(
  canvas: CanvasLike,
  pixelRatio: () => number,
): { surface: Surface; fit(poolW: number, poolH: number): void } {
  const ctx = canvas.getContext("2d");
  let poolW = 0;
  let poolH = 0;
  // Per-level drawing state: a `push` starts a fresh ops count and a saved context; a `dropped`
  // push is still popped so `pop` stays balanced when a creature oversteps PN7.
  const levels: Array<{ ops: number; dropped: boolean }> = [];
  let style: PoolStyle = { ...DEFAULT_STYLE };

  const paint = () => {
    const { fill, stroke, width, alpha } = style;
    if (fill !== null) {
      ctx!.fillStyle = fill;
      ctx!.globalAlpha = alpha;
      ctx!.fill();
    }
    if (stroke !== null) {
      ctx!.strokeStyle = stroke;
      ctx!.lineWidth = width;
      ctx!.globalAlpha = alpha;
      ctx!.stroke();
    }
  };

  /** PN7: a shape call counts only inside its innermost `push`; over HOST_MAX_OPS it is ignored. */
  const shape = (draw: () => void) => {
    if (!ctx) return;
    const level = levels[levels.length - 1];
    if (level) {
      if (level.ops >= HOST_MAX_OPS) return;
      level.ops += 1;
    }
    draw();
  };

  const surface: Surface = {
    reset() {
      if (!ctx) return;
      levels.length = 0;
      style = { ...DEFAULT_STYLE };
      // HO5: the backing store tracks the element's box at the device pixel ratio.
      const dpr = pixelRatio();
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#000000";
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 1;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (poolW > 0 && poolH > 0) {
        const scale = Math.min(canvas.clientWidth / poolW, canvas.clientHeight / poolH);
        ctx.setTransform(scale * dpr, 0, 0, scale * dpr, (w - poolW * scale * dpr) / 2, (h - poolH * scale * dpr) / 2);
      }
    },
    push(x, y, clipRadius) {
      if (!finite(x, y) || !finite(clipRadius) || clipRadius < 0 || clipRadius > HOST_MAX_REACH) return;
      if (levels.length >= MAX_DEPTH) {
        levels.push({ ops: 0, dropped: true });
        return;
      }
      if (!ctx) {
        levels.push({ ops: 0, dropped: true });
        return;
      }
      levels.push({ ops: 0, dropped: false });
      ctx.save();
      ctx.translate(x, y);
      if (clipRadius > 0) {
        ctx.beginPath();
        ctx.arc(0, 0, clipRadius, 0, Math.PI * 2);
        ctx.clip();
      }
    },
    pop() {
      const level = levels.pop();
      if (!level || level.dropped || !ctx) return;
      ctx.restore();
    },
    turn(angle) {
      if (!finite(angle) || !ctx) return;
      ctx.rotate(angle);
    },
    flip() {
      ctx?.scale(-1, 1);
    },
    style(fill, stroke, width, alpha) {
      if (!hexOrNull(fill) || !hexOrNull(stroke) || !finite(width) || !finite(alpha)) return;
      style = { fill, stroke, width, alpha };
    },
    line(x1, y1, x2, y2) {
      if (!finite(x1, y1, x2, y2)) return;
      shape(() => {
        ctx!.beginPath();
        ctx!.moveTo(x1, y1);
        ctx!.lineTo(x2, y2);
        paint();
      });
    },
    rect(x, y, w, h, corner = 0) {
      if (!finite(x, y, w, h, corner) || corner < 0) return;
      shape(() => {
        ctx!.beginPath();
        if (corner === 0) {
          ctx!.rect(x, y, w, h);
        } else {
          const r = Math.min(corner, Math.abs(w) / 2, Math.abs(h) / 2);
          ctx!.moveTo(x + r, y);
          ctx!.lineTo(x + w - r, y);
          ctx!.arcTo(x + w, y, x + w, y + r, r);
          ctx!.lineTo(x + w, y + h - r);
          ctx!.arcTo(x + w, y + h, x + w - r, y + h, r);
          ctx!.lineTo(x + r, y + h);
          ctx!.arcTo(x, y + h, x, y + h - r, r);
          ctx!.lineTo(x, y + r);
          ctx!.arcTo(x, y, x + r, y, r);
          ctx!.closePath();
        }
        paint();
      });
    },
    circle(x, y, r) {
      if (!finite(x, y, r) || r < 0) return;
      shape(() => {
        ctx!.beginPath();
        ctx!.arc(x, y, r, 0, Math.PI * 2);
        paint();
      });
    },
    ellipse(x, y, rx, ry, angle) {
      if (!finite(x, y, rx, ry, angle) || rx < 0 || ry < 0) return;
      shape(() => {
        ctx!.beginPath();
        ctx!.ellipse(x, y, rx, ry, angle, 0, Math.PI * 2);
        paint();
      });
    },
    poly(points) {
      if (points.length === 0 || points.length % 2 !== 0 || !points.every(Number.isFinite)) return;
      shape(() => {
        ctx!.beginPath();
        ctx!.moveTo(points[0]!, points[1]!);
        for (let i = 2; i < points.length; i += 2) ctx!.lineTo(points[i]!, points[i + 1]!);
        ctx!.closePath();
        paint();
      });
    },
    arc(x, y, r, from, to) {
      if (!finite(x, y, r, from, to) || r < 0) return;
      shape(() => {
        ctx!.beginPath();
        ctx!.arc(x, y, r, from, to);
        paint();
      });
    },
  };
  return {
    surface: Object.freeze(surface),
    fit(width, height) {
      poolW = width;
      poolH = height;
    },
  };
}
