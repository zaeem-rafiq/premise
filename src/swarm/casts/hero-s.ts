// `hero-s` — attempt S of 02-tidepool.md 7.3: `read GUIDE.md`; `read world/energy.js`; one
// `replace` on `world/energy.js` (`ENERGY_MAX = 100` becomes `= 1`, comment reworded); `submit`
// with summary "Make energy a fraction from 0 to 1".
//
// After its `replace` the pattern rewrites the canned old texts (`crab.energy < 30`,
// `drain(shrimp, 5)`) in any landed creature file `relied_on_by` names (order 2b of 7.6: a
// creature that landed before the replace is a referrer already — no heads-up is due and the
// sweep is S's own work). It `read`s each named creature module's `update` and `replace`s the
// canned old text it finds there.
//
// On `repair` (QR1) — creatures landed referencing `ENERGY_MAX` while S was in flight — it
// applies the two repair operations of 7.3 to every module the item names (the referrers in
// `added` name the modules; the module's `update` arrives in `added` or `context`), no read
// needed (R1), and acknowledges with the statement of 7.6 step 6.

import type { HeadsUpItem } from "../../protocol/headsup.ts";
import { cannedCast, type CastCall, type CastState } from "./runner.ts";

const ENERGY_KEY = "world/energy.js#ENERGY_MAX";

/** The two canned edits of 7.3 (C's and H's repair operations), applied by S itself (7.6, 10.5). */
const CANNED_FIXES: ReadonlyArray<{ old: string; new: string }> = [
  { old: "crab.energy < 30", new: "crab.energy < 0.3" },
  { old: "drain(shrimp, 5)", new: "drain(shrimp, 0.05)" },
];

const ENERGY_OLD = `// Energy is counted in points, from 0 (empty) to ENERGY_MAX (full).
export const ENERGY_MAX = 100;`;
const ENERGY_NEW = `// Energy is a fraction, from 0 (empty) to ENERGY_MAX (full).
export const ENERGY_MAX = 1;`;

const QR1_STATEMENT =
  "Two new creatures used point values. Changed the crab's 30 to 0.3 and the shrimp's 5 to 0.05 in the same change.";

const CREATURE_MODULE = /^creatures\/[^/]+\.js$/;

/** The path part of an entity key (`creatures/crab.js#update` -> `creatures/crab.js`). */
function pathOf(key: string): string {
  const cut = key.indexOf("#");
  return cut < 0 ? key : key.slice(0, cut);
}

/** Queue the canned fixes a creature module's `update` source still holds, once per module. */
function fixFromSource(s: CastState, path: string, source: string | null): void {
  if (!CREATURE_MODULE.test(path)) return;
  const done = (s.data.fixed ??= []) as string[];
  if (done.includes(path)) return;
  if (source === null) return;
  let queued = false;
  for (const fix of CANNED_FIXES) {
    if (!source.includes(fix.old)) continue;
    s.queue.push({ tool: "replace", args: { path, old: fix.old, new: fix.new }, why: "canned-fix" });
    queued = true;
  }
  if (queued) done.push(path);
}

/** The referrer keys a `write`/`replace` result names for `ENERGY_MAX` (D2 `relied_on_by`). */
function reliedOnBy(result: object): string[] {
  const map = (result as { relied_on_by?: unknown }).relied_on_by;
  if (typeof map !== "object" || map === null) return [];
  const keys = (map as Record<string, unknown>)[ENERGY_KEY];
  return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : [];
}

/** The QR1 repair of 7.6 step 5: for each module that gained a referrer, its `update` from the
 * item's `added` or `context`; each canned old text it still holds is replaced. */
function qr1Repairs(s: CastState, item: HeadsUpItem): void {
  if (item.diff.kind !== "query") return;
  const members = [...item.diff.added, ...item.diff.context];
  for (const module of new Set(item.diff.added.map((m) => pathOf(m.key)))) {
    const update = members.find((m) => m.key === `${module}#update`);
    fixFromSource(s, module, update === undefined ? null : (update.source ?? null));
  }
}

export const HERO_S = cannedCast({
  id: "hero-s",
  intent: "make energy a fraction from 0 to 1",
  summary: "Make energy a fraction from 0 to 1",
  truth: [`entity:${ENERGY_KEY}`, `query:refs:${ENERGY_KEY}`],
  script: [
    { tool: "read", args: { path: "GUIDE.md" }, why: "guide" },
    { tool: "read", args: { path: "world/energy.js" }, why: "energy" },
    { tool: "replace", args: { path: "world/energy.js", old: ENERGY_OLD, new: ENERGY_NEW }, why: "rescale" },
  ],

  onResult(s, call, result) {
    if (call.why === "rescale") {
      // Order 2b (D2): every landed creature module the replace names is visited once — its
      // `update` read decides whether a canned old text is still there to fix.
      for (const key of reliedOnBy(result)) {
        const path = pathOf(key);
        if (!CREATURE_MODULE.test(path)) continue;
        const done = (s.data.fixed ??= []) as string[];
        const seen = (s.data.visiting ??= []) as string[];
        const updateKey = `${path}#update`;
        if (done.includes(path) || seen.includes(updateKey)) continue;
        seen.push(updateKey);
        s.queue.push({ tool: "read", args: { path, entity: "update" }, why: "visit" });
      }
      return;
    }
    if (call.why === "visit") {
      const source = (result as { source?: unknown }).source;
      fixFromSource(s, (call.args as { path: string }).path, typeof source === "string" ? source : null);
      return;
    }
  },

  onHeadsUp(s, hu, ack) {
    if (hu.result !== "repair") return;
    for (const item of hu.items) {
      if (item.rule === "QR1" && item.result === "repair") {
        qr1Repairs(s, item);
        ack.statement = QR1_STATEMENT;
      }
    }
  },
});
