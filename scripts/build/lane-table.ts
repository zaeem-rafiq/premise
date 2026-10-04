// The lane table of AGENTS.md, built from scripts/ops/lanes.json (plan 2.1, acceptance item 6).

import { LEAD } from "../ops/lanes.ts";
import type { Lanes } from "../ops/lanes.ts";

export const TABLE_START = "<!-- lanes:start -->";
export const TABLE_END = "<!-- lanes:end -->";

function code(globs: readonly string[]): string {
  return globs.map((glob) => `\`${glob}\``).join(", ");
}

/** The generated block: the two markers and everything between them. */
export function renderLaneTable(lanes: Lanes): string {
  const rows = [
    `| \`${LEAD}\` | Every path that no other lane lists. The plan names: ${code(lanes.leadNamed)} | |`,
    ...lanes.lanes.map((lane) => {
      const paths = lane.note === undefined ? code(lane.paths) : `${code(lane.paths)}. ${lane.note}`;
      return `| \`${lane.lane}\` | ${paths} | ${code(lane.except)} |`;
    }),
  ];
  return [
    TABLE_START,
    "<!-- Generated from scripts/ops/lanes.json by `npm run agents-md`. Do not edit by hand. -->",
    "<!-- prettier-ignore-start -->",
    "| Lane | Paths | Except |",
    "| --- | --- | --- |",
    ...rows,
    "<!-- prettier-ignore-end -->",
    TABLE_END,
  ].join("\n");
}

/** `markdown` with the block between the two markers replaced by `table`. Throws when a marker is missing. */
export function withLaneTable(markdown: string, table: string): string {
  const start = markdown.indexOf(TABLE_START);
  const end = markdown.indexOf(TABLE_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`AGENTS.md must hold the markers ${TABLE_START} and ${TABLE_END}, in that order.`);
  }
  return markdown.slice(0, start) + table + markdown.slice(end + TABLE_END.length);
}
