// CK6b (01-core 9.5, added 2026-10-11): a colour name the pool's pen does not know. The pen of
// the tide pool turns a name into a colour only through its `PALETTE` (`pen.js`, `toHex`); any
// other name fails PN2 at run time, so the self-test's `pen_rules` fails (S4b) and the isolate
// green line takes the landing back, while the page silently drops the call. Submit sees it
// first: a string literal in a touched module that names a colour outside the palette rejects
// the submit, and its detail lists the palette so the agent can repair it.

/** The 148 CSS named colours and `transparent`: names an agent writes for a colour. */
const CSS_COLOURS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown " +
    "burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan " +
    "darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid " +
    "darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet " +
    "deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro " +
    "ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow " +
    "lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
    "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine " +
    "mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen " +
    "mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace " +
    "olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred " +
    "papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue " +
    "saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey " +
    "snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow " +
    "yellowgreen transparent"
  ).split(" "),
);

/** A shade prefix on a colour word ("darkpurple", "lightsand"): not CSS, still meant as a colour. */
const SHADE = /^(light|dark|pale|deep|bright|medium|hot|neon|pastel)([a-z]+)$/;

/** The names of `export const PALETTE = { name: "#rrggbb", … }` in the pool's `pen.js`, or null. */
export function paletteOf(penSource: string | undefined): string[] | null {
  if (penSource === undefined) return null;
  const block = /export\s+const\s+PALETTE\s*=\s*\{([^}]*)\}/.exec(penSource);
  if (block === null) return null;
  const names = [...block[1]!.matchAll(/^\s*([a-z]+)\s*:/gm)].map((m) => m[1]!);
  return names.length === 0 ? null : names;
}

/** The colour names in `source`'s string literals that the palette does not have, sorted, once each. */
export function unknownColours(source: string, palette: readonly string[]): string[] {
  const known = new Set(palette);
  const found = new Set<string>();
  for (const m of source.matchAll(/(["'`])([a-z]+)\1/g)) {
    const name = m[2]!;
    if (known.has(name)) continue;
    const shade = SHADE.exec(name);
    if (CSS_COLOURS.has(name) || (shade !== null && (known.has(shade[2]!) || CSS_COLOURS.has(shade[2]!)))) {
      found.add(name);
    }
  }
  return [...found].sort();
}

/** CK6d (01-core 9.5, added 2026-10-11): a creature changes its energy only through the shared
 * rules of `world/energy.js` (`drain`, `feed`), so a change to what an amount means reaches it and
 * a search for `drain(` finds it. Assignments to `.energy` in a creature module (outside the
 * `energy: …` of `spawn`'s object) are named here, once per line. */
export function directEnergyWrites(source: string): number[] {
  const lines: number[] = [];
  source.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    if (/\.energy\s*(?:[-+*/]?=(?!=)|\+\+|--)/.test(code) || /(?:\+\+|--)\s*[A-Za-z_$][\w$]*\.energy\b/.test(code)) {
      lines.push(i + 1);
    }
  });
  return lines;
}
