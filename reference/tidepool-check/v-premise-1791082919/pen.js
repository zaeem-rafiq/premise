// The pen is the only way pool code can draw.
// It has no text, no pictures, and no way to reach the page or the network.

// The most shapes one creature may draw in one frame.
export const MAX_SHAPES = 40;

// A creature can draw this far from its own centre, in pool units.
export const MAX_REACH = 60;

// Colour names the pen knows. A colour may also be written as "#rgb" or "#rrggbb".
export const PALETTE = {
  white: "#ffffff",
  black: "#10222e",
  grey: "#8a97a0",
  silver: "#c9d3da",
  red: "#e5484d",
  orange: "#ff8a1f",
  yellow: "#ffd23f",
  gold: "#d4a017",
  green: "#3fb950",
  teal: "#12a594",
  blue: "#3b82f6",
  purple: "#8e4ec6",
  pink: "#ff6fae",
  brown: "#8b5a2b",
  sand: "#e8d9a8",
};

// Turn a colour name or hex colour into "#rrggbb". Returns null for anything else.
export function toHex(colour) {
  if (typeof colour !== "string") return null;
  const value = Object.hasOwn(PALETTE, colour) ? PALETTE[colour] : colour;
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    return ("#" + value[1] + value[1] + value[2] + value[2] + value[3] + value[3]).toLowerCase();
  }
  return null;
}

// The grey with the same brightness as a "#rrggbb" colour. Resting creatures are drawn in grey.
export function toGrey(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const level = Math.round(0.3 * r + 0.59 * g + 0.11 * b).toString(16).padStart(2, "0");
  return "#" + level + level + level;
}

// Make a pen on a surface. Returns the control used by the world: { pen, clear, begin, end }.
// `pen` is the object creature files draw with.
export function createPen(surface) {
  let mode = "idle";
  let shapes = 0;
  let rejected = 0;
  let box = null;
  let fill = PALETTE.white;
  let stroke = PALETTE.black;
  let width = 2;
  let alpha = 1;

  function shade(hex) {
    if (hex === null) return null;
    return mode === "resting" ? toGrey(hex) : hex;
  }

  function grow(x1, y1, x2, y2) {
    const next = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
    box = box === null
      ? next
      : [Math.min(box[0], next[0]), Math.min(box[1], next[1]), Math.max(box[2], next[2]), Math.max(box[3], next[3])];
  }

  // Check one shape, count it, set the style. Returns true when the shape may be drawn.
  function allow(numbers) {
    if (mode === "idle" || !numbers.every(Number.isFinite)) {
      rejected += 1;
      return false;
    }
    if (mode !== "scene") {
      if (shapes >= MAX_SHAPES) {
        rejected += 1;
        return false;
      }
      shapes += 1;
    }
    surface.style(shade(fill), shade(stroke), width, alpha);
    return true;
  }

  const pen = Object.freeze({
    fill(colour) {
      const hex = colour === null ? null : toHex(colour);
      if (mode === "idle" || (colour !== null && hex === null)) rejected += 1;
      else fill = hex;
    },
    stroke(colour, lineWidth = 2) {
      const hex = colour === null ? null : toHex(colour);
      if (mode === "idle" || (colour !== null && hex === null) || !Number.isFinite(lineWidth)) rejected += 1;
      else {
        stroke = hex;
        width = Math.min(8, Math.max(0.5, lineWidth));
      }
    },
    alpha(value) {
      if (mode === "idle" || !Number.isFinite(value)) rejected += 1;
      else alpha = Math.min(1, Math.max(0, value));
    },
    circle(x, y, r) {
      if (!allow([x, y, r])) return;
      surface.circle(x, y, Math.abs(r));
      grow(x - Math.abs(r), y - Math.abs(r), x + Math.abs(r), y + Math.abs(r));
    },
    ellipse(x, y, rx, ry, angle = 0) {
      if (!allow([x, y, rx, ry, angle])) return;
      surface.ellipse(x, y, Math.abs(rx), Math.abs(ry), angle);
      const r = Math.max(Math.abs(rx), Math.abs(ry));
      grow(x - r, y - r, x + r, y + r);
    },
    rect(x, y, w, h, corner = 0) {
      if (!allow([x, y, w, h, corner])) return;
      surface.rect(x, y, w, h, Math.max(0, corner));
      grow(x, y, x + w, y + h);
    },
    line(x1, y1, x2, y2) {
      if (!allow([x1, y1, x2, y2])) return;
      surface.line(x1, y1, x2, y2);
      grow(x1, y1, x2, y2);
    },
    poly(points) {
      const fine = Array.isArray(points) && points.length >= 6 && points.length <= 24 && points.length % 2 === 0;
      if (!allow(fine ? points : [NaN])) return;
      surface.poly(points.slice());
      for (let i = 0; i < points.length; i += 2) grow(points[i], points[i + 1], points[i], points[i + 1]);
    },
    arc(x, y, r, from, to) {
      if (!allow([x, y, r, from, to])) return;
      surface.arc(x, y, Math.abs(r), from, to);
      grow(x - Math.abs(r), y - Math.abs(r), x + Math.abs(r), y + Math.abs(r));
    },
    turn(angle) {
      if (mode === "idle" || !Number.isFinite(angle)) rejected += 1;
      else surface.turn(angle);
    },
    flip() {
      if (mode === "idle") rejected += 1;
      else surface.flip();
    },
  });

  return Object.freeze({
    pen,
    // Wipe the whole picture.
    clear() {
      surface.reset();
    },
    // Start drawing one thing centred on (x, y). `kind` is "scene", "creature" or "resting".
    begin(x, y, kind) {
      mode = kind;
      shapes = 0;
      rejected = 0;
      box = null;
      fill = PALETTE.white;
      stroke = PALETTE.black;
      width = 2;
      alpha = 1;
      surface.push(x, y, kind === "scene" ? 0 : MAX_REACH);
      if (kind === "resting") surface.turn(Math.PI);
    },
    // Finish. Returns what was drawn: { shapes, rejected, box }. `box` is [left, top, right, bottom] or null.
    end() {
      surface.pop();
      mode = "idle";
      return { shapes, rejected, box };
    },
  });
}
