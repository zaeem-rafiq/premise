// `wrap-a` — attempt A of 02-tidepool.md 8.6: `search` for `wrap(` in `creatures/`; then for
// each container the search found: `replace` the `wrap(<name>)` call with `bounce(<name>)` and
// `replace` the file's `import { wrap }` with `import { bounce }` (the canned import line of the
// seed's creatures). Then `submit`.
//
// A `repair` (QT1, `sweep_incomplete`) means a match landed while the sweep was in flight —
// `added` carries the gained container with its source, so the ray is changed too, without a
// read (8.6). A `repair` or `info` that arrived before the first edit only extends the sweep.
// A second `repair` gives up (SW7): `stop` `withdrawn`.

import type { HeadsUpItem } from "../../protocol/headsup.ts";
import { cannedCast, type CastCall, type CastState } from "./runner.ts";

const IMPORT_OLD = 'import { wrap } from "../world/bounds.js";';
const IMPORT_NEW = 'import { bounce } from "../world/bounds.js";';

/** A `wrap(<name>)` call in a source or a result line, capture = the call's text and the name. */
const WRAP_CALL = /\bwrap\(\s*([A-Za-z_]\w*)\s*\)\s*;?/;

/** Queue the two canned replaces for one file that calls `wrap(<name>)`. */
function queueWrapFixes(s: CastState, path: string, name: string): void {
  const done = (s.data.fixed ??= []) as string[];
  if (done.includes(path)) return;
  done.push(path);
  s.queue.push({ tool: "replace", args: { path, old: `wrap(${name})`, new: `bounce(${name})` }, why: "repair" });
  s.queue.push({ tool: "replace", args: { path, old: IMPORT_OLD, new: IMPORT_NEW }, why: "repair" });
}

/** The containers a `search` result or a query diff names, as `wrap` calls found in sources. */
function fromSources(s: CastState, entries: Array<{ key: string; source: string | null }>): void {
  for (const entry of entries) {
    const path = entry.key.split("#")[0] ?? "";
    if (!path.startsWith("creatures/") || entry.source === null) continue;
    const match = WRAP_CALL.exec(entry.source);
    if (match !== null) queueWrapFixes(s, path, match[1] as string);
  }
}

export const WRAP_A = cannedCast({
  id: "wrap-a",
  intent: "make every creature that swims out one side and back in the other turn around at the walls instead",
  truth: ["query:text:creatures/:wrap(", "entity:world/bounds.js#bounce"],
  secondRepairWithdraws: true,
  script: [
    { tool: "search", args: { query: "wrap(", path: "creatures/" }, why: "search" },
    (s) => {
      // For each container the search found: the two replaces of 8.6. The `added`/`context`
      // sources a QT1 item carries are handled the same way (below), without a read.
      const lines = (s.data.lines ?? []) as Array<{ path: string; text: string }>;
      const calls: CastCall[] = [];
      const files = new Set<string>();
      for (const line of lines) {
        const match = WRAP_CALL.exec(line.text);
        if (match === null) continue;
        calls.push({
          tool: "replace",
          args: { path: line.path, old: match[0], new: match[0].replace("wrap(", "bounce(") },
          why: "repair",
        });
        files.add(line.path);
      }
      for (const path of files) {
        calls.push({ tool: "replace", args: { path, old: IMPORT_OLD, new: IMPORT_NEW }, why: "repair" });
      }
      const done = (s.data.fixed ??= []) as string[];
      done.push(...files);
      return calls;
    },
  ],

  onResult(s, call, result) {
    if (call.why === "search") {
      const lines = (result as { lines?: unknown }).lines;
      s.data.lines = Array.isArray(lines)
        ? lines
            .filter((l): l is { path: string; text: string } => typeof (l as { path?: unknown }).path === "string")
            .map((l) => ({ path: l.path, text: l.text }))
        : [];
      return;
    }
  },

  onHeadsUp(s, hu, ack) {
    for (const item of hu.items as HeadsUpItem[]) {
      if (item.diff.kind !== "query") continue;
      const before = s.queue.length;
      fromSources(s, item.diff.added);
      if (s.queue.length > before) ack.statement = "the sweep gained a match; changed it too";
    }
  },
});
