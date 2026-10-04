// Track 1I tests. Every expected value is read out of `docs/spec/03-floor.md` itself (the tables
// of section 5, 8.3 and 8.5) or out of `01-core.md` (the constants table, GL1), never out of the
// module's own output.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_BY_TOOL,
  ACTIVITY_MODEL_TURN,
  activityError,
  activityLine,
  quietSuffix,
  STEP_ERROR_REASONS,
  stepErrorReason,
} from "./activity.ts";
import {
  blastSentence,
  CARD_TEMPLATES,
  CHAPTERS,
  CHAPTER_CONFLICT_COMPARE,
  HELD_BODY_MINIMAL,
  raceTitle,
  RISK_FOOTER,
  RISK_LINES,
  riskSentence,
} from "./cards.ts";
import {
  greenCheckLabel,
  GREEN_CHECK_LABELS,
  SELFTEST_CODE_LABELS,
  submitCheckLabel,
  SUBMIT_CHECK_LABELS,
  SUBMIT_ERROR_SENTENCES,
  submitErrorSentence,
  submitResultLine,
} from "./checks.ts";
import {
  errorSentence,
  REQUEST_ERROR_KILLED,
  REQUEST_ERROR_NETWORK,
  REQUEST_ERROR_OTHER,
  REQUEST_ERROR_POOL_NOT_READY,
  REQUEST_ERROR_SPEND_CAP,
  REQUEST_ERRORS,
  UNDO_REFUSAL_REASONS,
  undoRefusalReason,
} from "./errors.ts";
import { fill, placeholders } from "./fill.ts";
import { basename, clock, count, DASH, duration, landingLabel, money, share, timeOfDay } from "./format.ts";
import { changeName, keyLabel, keyShort, modelName } from "./names.ts";
import { replayError, REPLAY_ERRORS } from "./replay.ts";
import {
  headsupOneLine,
  HEADSUP_ONE_LINE,
  JUDGMENT_SENTENCES,
  judgmentSentence,
  SCRIPTED_SENTENCES,
  TICK_SKIPPED,
  tickSkipped,
} from "./sentences.ts";
import { STOP_FALLBACK, STOP_KEPT_SUFFIX, STOP_NO_KEPT_SUFFIX, STOP_SENTENCES, stopSentence } from "./stops.ts";
import { ABOUT_HOW_BOXES, SHORTCUT_ROWS, STRINGS, template, text } from "./strings.ts";

const SPEC = readFileSync("docs/spec/03-floor.md", "utf8");
const CORE = readFileSync("docs/spec/01-core.md", "utf8");

/** Rows of a spec table section: `[id, cells-after-the-id]` for every `| \`id\` | … |` line. */
function specRows(sectionStart: string, sectionEnd: string): Array<[string, string[]]> {
  const a = SPEC.indexOf(sectionStart);
  const b = SPEC.indexOf(sectionEnd);
  if (a < 0 || b < 0) throw new Error(`spec section not found: ${sectionStart}`);
  const out: Array<[string, string[]]> = [];
  for (const line of SPEC.slice(a, b).split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    const m = /^`([a-z][a-z0-9_.]*)`$/.exec(cells[0] ?? "");
    if (m) out.push([m[1]!, cells.slice(1)]);
  }
  return out;
}

/** The spec's variant notations inside a text cell: "(visitor and Replay: X)", "(for 1: X)", "a · b". */
function specCell(cell: string): { text: string; visitor?: string; one?: string } {
  let visitor: string | undefined;
  let one: string | undefined;
  const vm = /\(visitor and Replay: (.*?)\)\s*$/.exec(cell);
  if (vm) {
    visitor = vm[1]!;
    cell = cell.slice(0, vm.index).trim();
  }
  const om = /\(for 1: (.*?)\)\s*$/.exec(cell);
  if (om) {
    one = om[1]!;
    cell = cell.slice(0, om.index).trim();
  }
  return { text: cell, visitor, one };
}

/** The section-5 ids and the text the spec's own tables give them. */
const TABLE_SECTIONS: Array<[string, string]> = [
  ["### 5.3", "### 5.4"],
  ["### 5.4", "### 5.5"],
  ["### 5.11", "### 5.12"],
  ["### 5.13", "## 6."],
];

describe("AC7: copy ids", () => {
  it("AC7: every copy id of 03-floor section 5 exists in the module with the spec's exact text", () => {
    const missing: string[] = [];
    const wrong: string[] = [];
    for (const [start, end] of TABLE_SECTIONS) {
      const isBanner = start === "### 5.11";
      for (const [id, cells] of specRows(start, end)) {
        const entry = STRINGS[id];
        if (entry === undefined) {
          missing.push(id);
          continue;
        }
        if (isBanner) {
          if (entry.word !== cells[0])
            wrong.push(`${id} word: spec ${JSON.stringify(cells[0])} vs ${JSON.stringify(entry.word)}`);
          if (entry.text !== cells[1])
            wrong.push(`${id} text: spec ${JSON.stringify(cells[1])} vs ${JSON.stringify(entry.text)}`);
          continue;
        }
        if (id === "replay.error") continue; // the cell describes, the sentence is 8.3's (REPLAY_ERRORS)
        const cell = specCell(cells[0] ?? "");
        let specText = cell.text;
        let specAlt: string | undefined;
        if ((id === "sr.killed" || id === "sr.swarm") && specText.includes(" · ")) {
          [specText, specAlt] = specText.split(" · ", 2) as [string, string];
        }
        if (entry.text !== specText) {
          wrong.push(`${id} text: spec ${JSON.stringify(specText)} vs ${JSON.stringify(entry.text)}`);
        }
        if (cell.visitor !== undefined && entry.visitor !== cell.visitor) {
          wrong.push(`${id} visitor: spec ${JSON.stringify(cell.visitor)} vs ${JSON.stringify(entry.visitor)}`);
        }
        if (cell.one !== undefined) {
          // "(for 1: failed · 1 check)" rewrites the fragment after the first " · " for n = 1.
          const want = `${specText.split(" · ")[0]} · ${cell.one.split(" · ").pop()}`;
          if (entry.one !== want)
            wrong.push(`${id} one: spec implies ${JSON.stringify(want)} vs ${JSON.stringify(entry.one)}`);
        }
        if (specAlt !== undefined && entry.alt !== specAlt) {
          wrong.push(`${id} alt: spec ${JSON.stringify(specAlt)} vs ${JSON.stringify(entry.alt)}`);
        }
      }
    }
    expect(missing, "ids of section 5 missing from the copy module").toEqual([]);
    expect(wrong, "entries whose text differs from the spec cell").toEqual([]);
  });

  it("AC7: the module holds no copy id that section 5 does not name", () => {
    const specIds = new Set<string>();
    for (const [start, end] of TABLE_SECTIONS) for (const [id] of specRows(start, end)) specIds.add(id);
    const extra = Object.keys(STRINGS).filter((id) => !specIds.has(id));
    expect(extra).toEqual([]);
  });

  it("AC7: every section-5 id resolves through text()", () => {
    // text() is the component-facing accessor; an unknown id throws. Placeholder values are filled
    // by the caller, so only the lookup is asserted here.
    for (const [start, end] of TABLE_SECTIONS) {
      for (const [id] of specRows(start, end)) {
        expect(template(id), `template("${id}")`).toBeTypeOf("string");
      }
    }
  });
});

describe("AC20: phrase lint", () => {
  /** Every string the module exports, wherever it lives. */
  function allCopyText(): string[] {
    const out: string[] = [];
    const seen = new Set<unknown>();
    const walk = (v: unknown): void => {
      if (typeof v === "string") out.push(v);
      else if (typeof v === "function" || v === null || v === undefined) return;
      else if (typeof v === "object") {
        if (seen.has(v)) return;
        seen.add(v);
        for (const item of Array.isArray(v) ? v : Object.values(v)) walk(item);
      }
    };
    for (const mod of [
      STRINGS,
      CARD_TEMPLATES,
      JUDGMENT_SENTENCES,
      SCRIPTED_SENTENCES,
      HEADSUP_ONE_LINE,
      TICK_SKIPPED,
      ACTIVITY_BY_TOOL,
      STEP_ERROR_REASONS,
      STOP_SENTENCES,
      REQUEST_ERRORS,
      UNDO_REFUSAL_REASONS,
      REPLAY_ERRORS,
      SUBMIT_CHECK_LABELS,
      SUBMIT_ERROR_SENTENCES,
      GREEN_CHECK_LABELS,
      SELFTEST_CODE_LABELS,
      ABOUT_HOW_BOXES,
      SHORTCUT_ROWS,
      RISK_LINES,
      CHAPTERS,
    ])
      walk(mod);
    return out;
  }

  it("AC20: no phrase of FL6 occurs in the copy module", () => {
    // FL6 (03 0): "the first", "first to", "no one else", "nobody else", "the only system",
    // "the only tool", "the only product".
    const fl6 = [
      "the first",
      "first to",
      "no one else",
      "nobody else",
      "the only system",
      "the only tool",
      "the only product",
    ];
    const hits = allCopyText().filter((s) => fl6.some((p) => s.toLowerCase().includes(p)));
    expect(hits).toEqual([]);
  });

  it("AC20: no word of CP4 occurs in the copy module", () => {
    // CP4 (03 5.1): "branch", "pull request", "merge queue", "claim", "reviewer".
    const cp4 = [/\bbranch\b/i, /pull request/i, /merge queue/i, /\bclaim\b/i, /\breviewer\b/i];
    const hits = allCopyText().filter((s) => cp4.some((p) => p.test(s)));
    expect(hits).toEqual([]);
  });
});
