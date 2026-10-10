// The limits list of 03-floor 5.12: one file, shown in About and in the README from the same source.
// A line whose condition is false for the build is left out. The README generator and the Floor read
// this file.

import { IMPORT_MAX_ENTRIES, IMPORT_MAX_TEXT_BYTES, MAX_FILE_BYTES, MAX_REAL_AGENTS } from "../protocol/constants.ts";
import type { Features } from "../protocol/floor-json.ts";

/** The names line 15 uses for a switched-off feature (03-floor 5.12). Green and Clef have their own
 * lines (7 and 8) and are never in it. */
export const FEATURE_OFF_NAMES: Readonly<Record<"held" | "race" | "undo" | "attempt_repos" | "mcp", string>> = {
  held: "the held card with previews",
  race: "comparing attempts",
  undo: "Undo",
  attempt_repos: "attempt repositories",
  mcp: "outside agents over MCP",
};

/** Line 7's `{runtime sentence}` by `features.green`. */
const GREEN_SENTENCE: Record<Features["green"], string> = {
  full: "every landing by running the pool's self-test in a sandboxed isolate",
  static: "every landing with static checks only",
  none: "",
};

/** Digits with a comma every three places, as the page writes counts. */
const thousands = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The limits list of 03-floor 5.12 for this build's `features`, lines whose condition is false left out. */
export function limitsList(features: Features): string[] {
  const off = (Object.keys(FEATURE_OFF_NAMES) as Array<keyof typeof FEATURE_OFF_NAMES>).filter(
    (key) => features[key] === false,
  );
  const lines = [
    "Premise understands JavaScript and TypeScript modules: .js and .mjs in the tide pool, and .js, .mjs, .cjs, .jsx, .ts, .mts, .cts and .tsx in a pool imported from a repository. Other files are tracked as whole files.",
    `One Trunk serves one pool. Agents read and write files of at most ${thousands(MAX_FILE_BYTES)} bytes. A repository with more than ${thousands(IMPORT_MAX_ENTRIES)} entries or ${thousands(IMPORT_MAX_TEXT_BYTES)} bytes of text is not imported, and a larger file in an imported repository is kept but cannot be read.`,
    `Real agents are limited by the Workers AI rate limits. This build runs at most ${MAX_REAL_AGENTS} at once.`,
    "Numbers in the Swarm view come from scripted agents. They make no model calls.",
    "The plain-merge pool is constructed by Trunk from the same changes. It is a comparison, not a second product, and its count of text conflicts is approximated.",
    "A premise across two pools is not built.",
    features.green === "none"
      ? "The green line is not in this build."
      : `The green line checks ${GREEN_SENTENCE[features.green]}.`,
    `Clef judgments are ${features.clef ? "on" : "off"} in this build.`,
    "Not built: text merge, Python and Go modules, audience input.",
    "References are direct. Code that depends on a shared value only through another function it calls holds no premise on that value. A package import or a tsconfig path alias is external and gives no premise.",
    "A number written with no reference to the shared quantity is not caught by rule. If its agent read the quantity, Clef judges it, or the agent takes one confirm turn. If it did not, only the self-test could notice, and that test checks the pool's health, not what a creature was asked to do.",
    "Premise shows an agent every piece of code that uses what it changes. It does not prove that the agent adapted all of it.",
    "A sweep is recognised from the edits an agent makes, not from the words of the request.",
    "After a rebuild from Artifacts, open cards close and agents in flight register again. Landed history is rebuilt in full.",
  ];
  if (off.length > 0) {
    lines.push(`Switched off in this build: ${off.map((key) => FEATURE_OFF_NAMES[key]).join(", ")}.`);
  }
  if (features.mcp) {
    // Line 16: the blind spot of outside agents (07-mcp).
    lines.push(
      "An outside agent over MCP counts as a real agent. Premise sees only its calls of the seven tools: not what it read elsewhere, and not what its own model cost.",
    );
  }
  return lines;
}
