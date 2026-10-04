// `sweep-a` — attempt P9a of 02-tidepool.md 9.5: `read GUIDE.md`; `read` the entities
// `energy#ENERGY_MAX`, `#LIVING_COST`, `#drain`, `#liveOneTick` (the `ENERGY_MAX` read is what
// keeps its first submit free of a B1 blind spot: the new `drain` references it); `search` for
// `drain(` in `creatures/`; then the three `replace` calls of 9.5 — the `drain` body and the
// `liveOneTick` line of `world/energy.js`, verbatim, and `drain(<name>, <n>)` ->
// `drain(<name>, <n x 100>)` in every file the search found. Then `submit` with summary "Write
// energy costs in percent".
//
// The `repair` of beat 5 (one heads-up holding QT1 on `text:creatures/:drain(` and QR1 on
// `refs:world/energy.js#drain`) names the gained containers with their sources: the new
// creature's `drain` call is rewritten `x 100` with no read (R1). A second `repair` gives up
// (SW7): `stop` `withdrawn`.

import { cannedCast, type CastCall, type CastState } from "./runner.ts";

const DRAIN_OLD = `// Take energy away. \`amount\` is in the same unit as ENERGY_MAX.
export function drain(creature, amount) {
  creature.energy = Math.max(0, creature.energy - amount);
}`;
const DRAIN_NEW = `// Take energy away. \`percent\` is a share of a full tank in percent: 5 takes five percent of ENERGY_MAX.
export function drain(creature, percent) {
  creature.energy = Math.max(0, creature.energy - (percent / 100) * ENERGY_MAX);
}`;
const TICK_OLD = "  drain(creature, LIVING_COST);";
const TICK_NEW = "  drain(creature, (LIVING_COST / ENERGY_MAX) * 100);";

/** A `drain(<name>, <number>)` call, captures = the call's text, the name, the number. */
const DRAIN_CALL = /\bdrain\(\s*([A-Za-z_]\w*)\s*,\s*(\d+(?:\.\d+)?)\s*\)/g;

/** `<n> x 100` as clean literal text (`0.05` -> `5`, `0.1` -> `10`). */
function percentText(n: number): string {
  return String(Number((n * 100).toPrecision(12)));
}

/** The replaces that turn every `drain` call a text holds into percent. */
function drainToPercent(s: CastState, path: string, text: string): void {
  for (const match of text.matchAll(DRAIN_CALL)) {
    const next = `drain(${match[1]}, ${percentText(Number(match[2]))})`;
    if (next === match[0]) continue;
    s.queue.push({ tool: "replace", args: { path, old: match[0], new: next }, why: "repair" });
  }
}

export const SWEEP_A = cannedCast({
  id: "sweep-a",
  intent:
    "write every energy cost in percent of a full tank: change the drain rule so that 5 means five percent, and update every creature that drains energy",
  summary: "Write energy costs in percent",
  truth: [
    "query:text:creatures/:drain(",
    "query:refs:world/energy.js#drain",
    "entity:world/energy.js#ENERGY_MAX",
    "entity:world/energy.js#LIVING_COST",
  ],
  secondRepairWithdraws: true,
  script: [
    { tool: "read", args: { path: "GUIDE.md" }, why: "guide" },
    { tool: "read", args: { path: "world/energy.js", entity: "ENERGY_MAX" }, why: "read" },
    { tool: "read", args: { path: "world/energy.js", entity: "LIVING_COST" }, why: "read" },
    { tool: "read", args: { path: "world/energy.js", entity: "drain" }, why: "read" },
    { tool: "read", args: { path: "world/energy.js", entity: "liveOneTick" }, why: "read" },
    { tool: "search", args: { query: "drain(", path: "creatures/" }, why: "search" },
    (s) => {
      const calls: CastCall[] = [
        { tool: "replace", args: { path: "world/energy.js", old: DRAIN_OLD, new: DRAIN_NEW }, why: "edit" },
        { tool: "replace", args: { path: "world/energy.js", old: TICK_OLD, new: TICK_NEW }, why: "edit" },
      ];
      // "update every creature that drains energy": each search line's number becomes percent.
      const lines = (s.data.lines ?? []) as Array<{ path: string; text: string }>;
      const staged: CastCall[] = [];
      for (const line of lines) {
        for (const match of line.text.matchAll(DRAIN_CALL)) {
          staged.push({
            tool: "replace",
            args: {
              path: line.path,
              old: match[0],
              new: `drain(${match[1]}, ${percentText(Number(match[2]))})`,
            },
            why: "edit",
          });
        }
      }
      return [...calls, ...staged];
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
    // QT1 (`text:` gained a container) and QR1 (`refs:` gained referrers) both carry the new
    // sources: every `drain` call they show on a creature module is rewritten to percent.
    for (const item of hu.items) {
      if (item.diff.kind !== "query") continue;
      const before = s.queue.length;
      for (const entry of [...item.diff.added, ...item.diff.context]) {
        const path = entry.key.split("#")[0] ?? "";
        if (!path.startsWith("creatures/") || entry.source === null) continue;
        drainToPercent(s, path, entry.source);
      }
      if (s.queue.length > before) {
        ack.statement = "a new creature calls drain; rewrote its number to percent";
      }
    }
  },
});
