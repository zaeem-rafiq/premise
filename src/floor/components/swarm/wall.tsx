import { useContext, useEffect, useRef, useState } from "react";
import type { AttemptView, FloorState } from "../../../protocol/reducer/state.ts";
import { WALL_FPS } from "../../../protocol/constants.ts";
import { ShellContext } from "../../app/context.ts";
import { count } from "../../../copy/format.ts";
import "./swarm.css";
import { inFlight } from "../../state/derive.ts";

export type WallShape = "outline" | "diamond" | "half" | "fill" | "cross" | "tick";
export function wallShape(attempt: AttemptView, floor: FloorState, clock: number, reduced = false): WallShape {
  if (attempt.state === "going_around") return "diamond";
  if (["stopped", "declined", "superseded"].includes(attempt.state)) return "cross";
  if (attempt.landed_seq !== null) {
    const landing = floor.landings[attempt.landed_seq];
    const ts = landing?.digest === true ? landing.landed_ts : landing?.landed?.ts;
    if (ts == null) return "half";
    if (clock - ts < 1_000) return reduced ? "tick" : "fill";
    return "outline";
  }
  return attempt.state === "accepted" ? "half" : "outline";
}

/** CO41: square cells always fit, including a partial last row. */
export function wallLayout(n: number, width: number, height: number) {
  let columns = 1;
  let size = 0;
  for (let candidate = 1; candidate <= Math.max(1, n); candidate += 1) {
    const fit = Math.min(width / candidate, height / Math.max(1, Math.ceil(n / candidate)));
    if (fit > size) {
      columns = candidate;
      size = fit;
    }
  }
  return { columns, size, rows: Math.ceil(n / columns) };
}

/** AX9: counts describe attempts, not the temporary landed flash. */
export function wallSummary(floor: FloorState, clock: number): { n: number; a: number; b: number; c: number } {
  const attempts = Object.values(floor.attempts).filter((a) => a.agent === "synthetic");
  return {
    n: attempts.length,
    a: attempts.filter((a) => inFlight(a) && a.state !== "going_around" && wallShape(a, floor, clock) !== "half")
      .length,
    b: attempts.filter((a) => a.state === "going_around").length,
    c: attempts.filter((a) => wallShape(a, floor, clock) === "half").length,
  };
}

export function SwarmWall({ floor, clock, readClock }: { floor: FloorState; clock: number; readClock?: () => number }) {
  const { t } = useContext(ShellContext)!;
  const ref = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ floor, clock, readClock });
  latest.current = { floor, clock, readClock };
  const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [counts, setCounts] = useState(() => wallSummary(floor, clock));
  const summary = t("swarm.wall.summary", {
    n: count(counts.n),
    a: count(counts.a),
    b: count(counts.b),
    c: count(counts.c),
  });
  useEffect(() => {
    const timer = window.setInterval(
      () => setCounts(wallSummary(latest.current.floor, latest.current.readClock?.() ?? latest.current.clock)),
      5_000,
    );
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const draw = () => {
      const canvas = ref.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) return;
      const { width, height } = canvas.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.scale(ratio, ratio);
      const { floor } = latest.current;
      const clock = latest.current.readClock?.() ?? latest.current.clock;
      const agents = Object.values(floor.attempts).filter((a) => a.agent === "synthetic");
      const { columns, size } = wallLayout(agents.length, width, height);
      const colors = getComputedStyle(canvas);
      for (let i = 0; i < agents.length; i += 1) {
        const shape = wallShape(agents[i]!, floor, clock, reduced);
        const x = ((i % columns) + 0.5) * size;
        const y = (Math.floor(i / columns) + 0.5) * size;
        const r = Math.max(0, size * 0.32);
        context.strokeStyle = colors.getPropertyValue(
          shape === "diamond" ? "--changed" : shape === "fill" || shape === "tick" ? "--holds" : "--text",
        );
        context.fillStyle = context.strokeStyle;
        context.lineWidth = Math.max(1, Math.min(3, size / 10));
        context.beginPath();
        if (shape === "diamond") {
          context.moveTo(x, y - r);
          context.lineTo(x + r, y);
          context.lineTo(x, y + r);
          context.lineTo(x - r, y);
          context.closePath();
          context.fill();
        } else if (shape === "cross") {
          context.moveTo(x - r, y - r);
          context.lineTo(x + r, y + r);
          context.moveTo(x + r, y - r);
          context.lineTo(x - r, y + r);
          context.stroke();
        } else if (shape === "tick") {
          context.moveTo(x - r, y);
          context.lineTo(x, y + r);
          context.lineTo(x + r, y - r);
          context.stroke();
        } else {
          context.arc(x, y, r, 0, Math.PI * 2);
          if (shape === "fill") context.fill();
          else {
            context.stroke();
            if (shape === "half") {
              context.beginPath();
              context.arc(x, y, r, Math.PI / 2, Math.PI * 1.5);
              context.closePath();
              context.fill();
            }
          }
        }
      }
    };
    draw();
    const timer = window.setInterval(draw, 1_000 / (reduced ? 2 : WALL_FPS));
    return () => window.clearInterval(timer);
  }, [reduced]);

  return (
    <canvas ref={ref} className="swarm-wall" role="img" aria-label={summary}>
      {summary}
    </canvas>
  );
}
