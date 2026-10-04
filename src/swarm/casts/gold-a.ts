// `gold-a` — attempt A of 02-tidepool.md 8.2: `list creatures/`; then for each creature file it
// found: `read` it and `replace` each colour constant — the first one becomes `"gold"`, every
// later one `"#b8860b"` (the table's two shades: on the seed this is the nine `replace` calls
// the row lists, verbatim). Then `submit`.
//
// A `repair` (L1, `sweep_incomplete`) means the directory gained a member while the repaint was
// in flight: for each `added` name, `read` the file and repaint it the same way — on the canned
// seahorse that is `read creatures/seahorse.js`; `replace` `const BODY = "pink";` with
// `const BODY = "gold";` (8.2's repair operations). It acknowledges with the statement of 8.3
// step 4. A second `repair` gives up (SW7): `stop` `withdrawn`.

import { fileNamesOf } from "../scripted.ts";
import { cannedCast, type CastState } from "./runner.ts";

const L1_STATEMENT = "A seahorse arrived during the repaint. Painted it gold too.";

/** A colour constant line of a creature file (`const BODY = "pink";`), capture = the value. */
const COLOUR_CONST = /^const [A-Z_]+ = "([^"]*)";$/gm;

/** The repaint of one creature file's source: first constant `"gold"`, the rest `"#b8860b"`. */
function repaint(s: CastState, path: string, content: string | null): void {
  if (content === null) return;
  let first = true;
  for (const match of content.matchAll(COLOUR_CONST)) {
    const line = match[0];
    const next = line.replace(match[1] as string, first ? "gold" : "#b8860b");
    first = false;
    if (next === line) continue; // already repainted: a same-text replace would fail `no_change`
    s.queue.push({ tool: "replace", args: { path, old: line, new: next }, why: "repaint" });
  }
}

export const GOLD_A = cannedCast({
  id: "gold-a",
  intent: "repaint every creature in gold",
  truth: ["listing:creatures/"],
  secondRepairWithdraws: true,
  script: [
    { tool: "list", args: { path: "creatures/" }, why: "list" },
    (s) => {
      // For each creature file the listing showed: `read` it. Its `replace`s are queued from
      // the read's answer (the row's "for each file: read it, and replace each colour constant").
      const names = (s.data.entries ?? []) as string[];
      return names
        .filter((name) => name.endsWith(".js"))
        .map((name) => ({ tool: "read" as const, args: { path: `creatures/${name}` }, why: "repaint" }));
    },
  ],

  onResult(s, call, result) {
    if (call.why === "list") {
      s.data.entries = fileNamesOf(result);
      return;
    }
    if (call.why === "repaint") {
      const content = (result as { content?: unknown }).content;
      repaint(s, (call.args as { path: string }).path, typeof content === "string" ? content : null);
      return;
    }
  },

  onHeadsUp(s, hu, ack) {
    if (hu.result !== "repair") return;
    for (const item of hu.items) {
      if (item.rule !== "L1" || item.result !== "repair" || item.diff.kind !== "listing") continue;
      for (const name of item.diff.added) {
        s.queue.push({ tool: "read", args: { path: `creatures/${name}` }, why: "repaint" });
      }
      ack.statement = L1_STATEMENT;
    }
    for (const dropped of hu.dropped_ops) {
      // A repaint `replace` that no longer applies is read again and re-derived (SW6).
      s.queue.push({ tool: "read", args: { path: dropped.path }, why: "repaint" });
      ack.statement = L1_STATEMENT;
      ack.dropped = "handled";
    }
  },
});
