// The function tables of 03-floor section 5 (5.2, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10) plus 8.3, 8.5 and
// 5.12/6.6. Expected values are parsed out of the spec's own tables where the format allows, and
// quoted verbatim from the spec text where it does not.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_BY_TOOL,
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
import { greenCheckLabel, submitCheckLabel, submitErrorSentence, submitResultLine } from "./checks.ts";
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
import { fill } from "./fill.ts";
import { clock, count, DASH, duration, landingLabel, money, share } from "./format.ts";
import { changeName, keyLabel, keyShort, modelName } from "./names.ts";
import { replayError, REPLAY_ERRORS } from "./replay.ts";
import { headsupOneLine, judgmentSentence, SCRIPTED_SENTENCES, tickSkipped } from "./sentences.ts";
import { STOP_FALLBACK, STOP_KEPT_SUFFIX, STOP_NO_KEPT_SUFFIX, STOP_SENTENCES, stopSentence } from "./stops.ts";
import { ABOUT_HOW_BOXES, SHORTCUT_ROWS, STRINGS, aboutHowBoxes, text } from "./strings.ts";
import { ABSENT } from "../protocol/premise.ts";

const SPEC = readFileSync("docs/spec/03-floor.md", "utf8");
const CORE = readFileSync("docs/spec/01-core.md", "utf8");

function section(start: string, end: string): string {
  const a = SPEC.indexOf(start);
  const b = SPEC.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`spec section not found: ${start}`);
  return SPEC.slice(a, b);
}

/** Every `| cell | cell | … |` line of a slice, split into cells. */
function tableRows(slice: string): string[][] {
  return slice
    .split("\n")
    .filter((l) => l.startsWith("|") && !/^\|[ |:-]*-/.test(l))
    .map((l) =>
      l
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim()),
    );
}

const uncode = (s: string): string => s.replace(/`([^`]*)`/g, "$1");

// ---------- 5.2 ----------

describe("5.2 naming", () => {
  it("5.2: keyLabel and keyShort give the spec's words for every row of its table", () => {
    const rows = tableRows(section("### 5.2", "### 5.3")).filter(
      (r) => r.length === 3 && /^`(entity|file|listing|query|check)/.test(r[0] ?? ""),
    );
    expect(rows.length).toBeGreaterThanOrEqual(13);
    for (const [keyCell, labelCell, shortCell] of rows) {
      const m = /^`(entity|file|listing|query|check)`\s+`([^`]+)`/.exec(keyCell!);
      expect(m, `row "${keyCell}"`).not.toBeNull();
      const kind = m![1]! as "entity" | "file" | "listing" | "query" | "check";
      const key = m![2]!;
      // The check row's cell carries a spec note: the quoted label is the expectation.
      const want = kind === "check" ? /^the check "(.*?)" \((.*)\)$/.exec(labelCell!)![1]! : uncode(labelCell!);
      const gotLabel = keyLabel(kind, key);
      if (kind === "check") {
        expect(gotLabel).toBe(`the check "${want}"`);
      } else {
        expect(gotLabel, `keyLabel ${key}`).toBe(want);
      }
      expect(keyShort(kind, key), `keyShort ${key}`).toBe(uncode(shortCell!));
    }
  });

  it("5.2: changeName names a file-created change by its file, else the quoted intent cut at a word end to CHANGE_NAME_CHARS", () => {
    // The spec's own example row: `crab` · `"make energy a fraction…"` · `"add day and night" (glm-5.3-flash)`.
    expect(
      changeName({
        intentText: "make a crab",
        premises: [{ kind: "file", key: "creatures/crab.js", edit: true, hash: ABSENT }],
      }),
    ).toBe("crab");
    // The intent is longer than CHANGE_NAME_CHARS (28); the cut lands on the last word end ≤ 28.
    expect(changeName({ intentText: "make energy a fraction instead of a fixed value" })).toBe(
      '"make energy a fraction…"',
    );
    expect(changeName({ intentText: "add day and night", race: true, model: "provider/glm-5.3-flash" })).toBe(
      '"add day and night" (glm-5.3-flash)',
    );
  });

  it("5.2: modelName is the last segment of the model id", () => {
    expect(modelName("provider/gpt-oss-120b")).toBe("gpt-oss-120b");
    expect(modelName("gpt-oss-120b")).toBe("gpt-oss-120b");
  });

  it("5.2: count, share, money, duration, clock, landing formats match the spec examples", () => {
    expect(count(1024)).toBe("1,024");
    expect(share(0.12)).toBe("12%");
    expect(share(null)).toBe(DASH);
    expect(money(3.12)).toBe("$3.12");
    expect(money(0.004)).toBe("less than $0.01");
    expect(duration(640)).toBe("640 ms");
    expect(duration(42_000)).toBe("42 s");
    expect(duration(72_000)).toBe("1 min 12 s");
    expect(clock(221_000)).toBe("00:03:41");
    expect(landingLabel(9)).toBe("landing 9");
  });
});

// ---------- 5.5 ----------

describe("5.5 activity line", () => {
  it("5.5: each tool has the spec's activity line", () => {
    expect(activityLine({ tool: null, target: null })).toBe("Thinking");
    const want: Record<string, [string, string]> = {
      outline: ["world/energy.js", "Looking at the outline of {target}"],
      read: ["world/energy.js#ENERGY_MAX", "Reading {target}"],
      list: ["creatures/", "Listing {target}"],
      search: ["drain(", 'Searching for "{target}"'],
      write: ["creatures/crab.js", "Writing {target}"],
      replace: ["creatures/crab.js", "Editing {target}"],
      submit: ["", "Submitting"],
    };
    for (const [tool, [target, template]] of Object.entries(want)) {
      const filled = fill(template, {
        target: target.includes("#") ? `ENERGY_MAX in world/energy.js` : target,
      });
      expect(activityLine({ tool, target }), tool).toBe(filled);
    }
  });

  it("5.5: an entity key in {target} goes through keyLabel, a path stays as given", () => {
    expect(activityLine({ tool: "read", target: "world/energy.js#ENERGY_MAX" })).toBe(
      "Reading ENERGY_MAX in world/energy.js",
    );
    expect(activityLine({ tool: "write", target: "creatures/crab.js" })).toBe("Writing creatures/crab.js");
  });

  it("5.5: the quiet line adds ' · {seconds} s'", () => {
    expect(quietSuffix(12)).toBe(" · 12 s");
  });

  it("5.5: a failed step reads '{line} did not work: {reason}. The agent tries another way.' with the spec's reasons", () => {
    const specReasons: Record<string, string> = {
      not_found: "it does not exist",
      not_a_module: "it is not a JavaScript module",
      read_first: "the agent must read the file first",
      no_match: "the text to replace was not found",
      ambiguous: "the text to replace appears more than once",
      no_change: "it changes nothing",
      parse_error: "the result does not parse",
      heads_up_first: "the agent must read its heads-up first",
      too_large: "it is over a size limit",
      limit_reached: "it is over a size limit",
      pool_not_ready: "the pool is paused",
      timeout: "Trunk did not answer in time",
    };
    for (const [code, reason] of Object.entries(specReasons)) {
      expect(stepErrorReason(code), code).toBe(reason);
    }
    for (const code of ["invalid_path", "invalid_args", "binary", "attempt_unknown", "attempt_closed"]) {
      expect(stepErrorReason(code), code).toBe("the call was not valid (" + code + ")");
    }
    expect(activityError("Reading x", "not_found")).toBe(
      "Reading x did not work: it does not exist. The agent tries another way.",
    );
  });
});

// ---------- 5.6 ----------

describe("5.6 judgment sentences", () => {
  it("5.6: every (rule, reason) row of the spec table gives its sentence verbatim", () => {
    const rows = tableRows(section("### 5.6", "### 5.7")).filter((r) => r.length === 3 && r[0] !== "Rule");
    const checked: string[] = [];
    for (const [ruleCell, reasonCell, sentenceCell] of rows) {
      const sentence = uncode(sentenceCell!);
      const reasonM = /^`([^`]+)`/.exec(reasonCell ?? "");
      const reason = reasonM ? reasonM[1]! : null; // "" / "pending"-only cells have no code
      const pending = /pending/.test(reasonCell ?? "");
      const pm = /`([a-z_]+)`(?:[^`]*`([a-z_]+)`)?/.exec(reasonCell ?? "");
      const reasons: (string | null)[] = reason
        ? [reason]
        : pending
          ? (reasonCell!.match(/`([a-z_]+)`/g) ?? []).map((s) => s.slice(1, -1))
          : [null];
      const rules =
        ruleCell === "any" || ruleCell === "any other"
          ? null // tested separately below
          : (ruleCell!.match(/`([A-Z0-9m]+)`/g) ?? []).map((s) => s.slice(1, -1));
      for (const r of reasons) {
        if (rules === null) continue;
        for (const rule of rules) {
          checked.push(`${rule}/${r}`);
          expect(judgmentSentence(rule, r), `${rule} ${r}`).toBe(sentence);
        }
      }
    }
    expect(checked.length).toBeGreaterThanOrEqual(35);
  });

  it("5.6: 'any' and 'any other' rows cover the pairs the table does not name", () => {
    expect(judgmentSentence("E1", "premise_gone")).toBe("This change no longer relies on {thing}.");
    expect(judgmentSentence("L1", "push_lost")).toBe(
      "The push for this landing was lost when the pool was rebuilt. The change lands again.",
    );
    expect(judgmentSentence("QT3", "something_else")).toBe("{thing} changed ({rule}, {reason}).");
  });

  it('5.6: a synthetic attempt (clef.model "scripted", 01-core TR8) uses the scripted sentences and no share', () => {
    expect(judgmentSentence("E3", "triage_depends", true)).toBe(SCRIPTED_SENTENCES["triage_depends"]);
    expect(judgmentSentence("E3", "triage_depends", true)).toBe(
      "{thing} changed. The script lists it as something this change depends on. The agent must adapt.",
    );
    expect(judgmentSentence("QT2", "reaffirmed", true)).toBe(
      "{thing} changed. The script does not list it as something this change depends on. The agent was told.",
    );
    expect(judgmentSentence("F6", "triage_unavailable", true)).toBe(
      "{thing} changed. No answer was available, so the agent must confirm.",
    );
    // a reason without a scripted form falls back to the table sentence
    expect(judgmentSentence("E1", "edited_entity_changed", true)).toContain("{thing}");
  });

  it("5.6: the collapsed one-line forms use keyShort", () => {
    expect(headsupOneLine("repair", "ENERGY_MAX")).toBe("ENERGY_MAX changed. The diff was sent to the agent.");
    expect(headsupOneLine("confirm", "energy.js")).toBe("energy.js changed. The agent must confirm.");
    expect(headsupOneLine("info", "energy.js")).toBe("energy.js changed. The agent was told.");
  });

  it("5.6: the tick.skipped sentences are the spec's four", () => {
    expect(tickSkipped("not_disjoint")).toBe(
      "It overlaps a change in this batch. Trunk checks it against the new code next.",
    );
    expect(tickSkipped("right_of_way", '"add a crab"')).toBe('Waiting behind "add a crab", which has right of way.');
    expect(tickSkipped("checks_failed")).toBe(
      "The checks failed on the newest code. The agent gets the reason and adapts.",
    );
    expect(tickSkipped("held")).toBe("Under the newest policy this change touches a held path. A card asks the owner.");
  });
});

// ---------- 5.7 ----------

describe("5.7 checks and submit results", () => {
  it("5.7: every submit check has the spec's label; 'policy' shows its detail; any other shows the name", () => {
    const want: Record<string, string> = {
      replay: "The edits apply to the newest code",
      non_empty: "The change is not empty",
      fits: "The pool stays within its size limits",
      parse: "The code parses",
      imports_resolve: "Every import points at something",
      globals_allowed: "Only allowed globals are used",
      premises_hold: "Everything it relied on is still true",
    };
    for (const [name, label] of Object.entries(want)) expect(submitCheckLabel(name), name).toBe(label);
    expect(submitCheckLabel("policy", "no network")).toBe("Policy: no network");
    expect(submitCheckLabel("anything_else")).toBe("anything_else");
  });

  it("5.7: each submit.result status has the spec's line; accepted, landed and stopped have none", () => {
    expect(submitResultLine("validated")).toBe(text("attempt.next_batch"));
    expect(submitResultLine("submitted")).toBe(text("attempt.waiting_clef"));
    expect(submitResultLine("held")).toBe("All checks passed. Waiting for you.");
    // CP7: the visitor and Replay form says "the owner".
    expect(submitResultLine("held", { visitor: true })).toBe("All checks passed. Waiting for the owner.");
    expect(submitResultLine("needs_confirm")).toBe("The agent must confirm one thing before this can land.");
    expect(submitResultLine("go_around")).toBe("Something it relied on changed. The agent is adapting.");
    expect(submitResultLine("rejected", { error: "the code does not parse" })).toBe(
      "The checks sent it back: the code does not parse. The agent is fixing it.",
    );
    for (const s of ["accepted", "landed", "stopped"]) expect(submitResultLine(s)).toBeNull();
  });

  it("5.7: a rejected submit's error sentence is the spec's for the first failed check", () => {
    const want: Record<string, string> = {
      non_empty: "the change does nothing",
      fits: "the change is too large",
      parse: "the code does not parse",
      imports_resolve: "an import points at nothing, or at something outside the pool",
      globals_allowed: "it uses something the policy does not allow",
    };
    for (const [name, sentence] of Object.entries(want)) {
      expect(submitErrorSentence({ name }), name).toBe(sentence);
    }
    expect(submitErrorSentence({ name: "premises_hold" })).toBe(
      'the check "Everything it relied on is still true" failed',
    );
  });

  it("5.7: green-line and self-test checks have the spec's labels, selftest_ran by its code", () => {
    const want: Record<string, string> = {
      files: "Every creature file has its three parts",
      no_errors: "No creature causes an error",
      in_bounds: "Every creature stays in the water",
      energy_range: "Energy stays between empty and full",
      population: "The number of creatures is right",
      not_exhausted: "No kind of creature rests too much of the time",
      state_is_data: "The pool's state is plain data",
      pen_rules: "Drawing follows the rules of the pen",
      visible: "Every creature can be seen",
      within_reach: "Every creature draws near its own place",
      draw_is_pure: "Drawing changes nothing in the pool",
      deterministic: "The same start gives the same result",
      parse: "The code parses",
      imports_resolve: "Every import points at something",
      policy_invariants: "The rules of the policy file hold",
    };
    for (const [name, label] of Object.entries(want)) expect(greenCheckLabel(name), name).toBe(label);
    expect(greenCheckLabel("selftest_ran", "no_verdict")).toBe("The self-test did not finish in time");
    expect(greenCheckLabel("selftest_ran", "bad_verdict")).toBe("The self-test gave no readable result");
    expect(greenCheckLabel("selftest_ran", "harness_error")).toBe(
      "The pool's code did not load, or the test stopped with an error",
    );
    expect(greenCheckLabel("selftest_ran")).toBe("selftest_ran");
  });
});

// ---------- 5.8 ----------

describe("5.8 stop sentences", () => {
  it("5.8: each of the 17 stop reasons of 01-core 9.1 has the spec's sentence verbatim", () => {
    const rows = tableRows(section("### 5.8", "### 5.9")).filter(
      (r) => r.length === 2 && /^`/.test(r[0] ?? "") && uncode(r[0]!) !== "stop_reason",
    );
    expect(rows.length).toBe(17);
    for (const [reasonCell, sentenceCell] of rows) {
      const reason = uncode(reasonCell!);
      const sentence = uncode(sentenceCell!);
      expect(STOP_SENTENCES[reason], reason).toBe(sentence);
    }
    expect(STOP_FALLBACK).toBe("Stopped ({stop_reason}).");
    expect(stopSentence("some_future_reason")).toBe(`Stopped (some_future_reason). ${STOP_KEPT_SUFFIX}`);
  });

  it("5.8: every stop sentence is followed by 'Its work so far is kept.' except the five the spec names", () => {
    for (const reason of Object.keys(STOP_SENTENCES)) {
      const line = stopSentence(reason);
      if (STOP_NO_KEPT_SUFFIX.has(reason)) {
        expect(line.endsWith(STOP_KEPT_SUFFIX), reason).toBe(false);
      } else {
        expect(line.endsWith(` ${STOP_KEPT_SUFFIX}`), reason).toBe(true);
      }
    }
    expect([...STOP_NO_KEPT_SUFFIX].sort()).toEqual(["declined", "lost", "not_chosen", "undone", "withdrawn"]);
  });

  it("CP5: the constant placeholders of 5.8 fill from constants.ts, never typed into the string", () => {
    // GL1: GO_AROUND_LIMIT is 3; constants table: MAX_REVISIONS 3, MODEL_RETRIES 2,
    // ATTEMPT_TIMEOUT_MS 600,000, AGENT_WATCHDOG_MS 30,000.
    expect(stopSentence("go_around_limit")).toContain("sent back 3 times");
    expect(stopSentence("revert_limit")).toContain("taken back 3 times");
    expect(stopSentence("timeout")).toContain("longer than 10 min 0 s");
    expect(stopSentence("model_error")).toContain("the model failed 3 times in a row");
    expect(stopSentence("stalled")).toContain("no progress for 30 s");
  });
});

// ---------- 5.9 ----------

describe("5.9 request errors", () => {
  it("5.9: every status case has the spec's sentence", () => {
    expect(errorSentence(401)).toBe("The owner key is needed for this. Unlock, then try again.");
    expect(errorSentence(403)).toBe("The server refused this request. Reload the page and try again.");
    expect(errorSentence(404, "feature_off")).toBe("This build does not have that feature.");
    expect(errorSentence(404)).toBe("That no longer exists. The page shows the newest state.");
    expect(errorSentence(409)).toBe("This was already answered. The page shows the newest state.");
    expect(errorSentence(413)).toBe("Use 500 characters or fewer."); // MAX_INTENT_CHARS, constants table
    expect(errorSentence(429)).toBe("Too many requests. Wait a moment, then try again.");
    expect(errorSentence(503, "owner_not_configured")).toBe(text("owner.not_configured"));
    expect(errorSentence(503)).toBe("The pool is paused. Nothing new can start.");
    expect(errorSentence(503, "killed")).toBe("All agents are stopped. Allow agents again first.");
    expect(errorSentence(503, "spend_cap")).toBe("The spend cap is reached. No model call can start.");
    expect(errorSentence(null)).toBe("The request did not reach the server. Check the connection and try again.");
    expect(errorSentence(599)).toBe("Something went wrong (status 599). Nothing was changed. Try again.");
  });

  it("5.9: the five UndoRefusal values of 01-core 11.3 fill the {reason} of undo.refused", () => {
    const want: Record<string, string> = {
      not_a_change: "that landing is an undo or a revert, and those cannot be undone",
      already_undone: "that landing is already undone",
      too_old: "that landing is too far back",
      too_many: "it would take back more than 64 changes at once", // MAX_BATCH, constants table
      plan_changed: "the pool changed while the plan was open (the sheet then shows the new plan, 3.12)",
    };
    for (const [reason, sentence] of Object.entries(want)) {
      expect(undoRefusalReason(reason), reason).toBe(sentence);
    }
    expect(fill(STRINGS["undo.refused"]!.text, { reason: undoRefusalReason("too_old") })).toBe(
      "Trunk refused the undo: that landing is too far back. Nothing changed.",
    );
  });
});

// ---------- 5.10 (CD5) ----------

describe("5.10 card texts (CD5: Trunk fills Card.title, Card.body and Card.options[].label from here)", () => {
  it("5.10: every (kind, reason) row has the spec's title, body and option labels verbatim", () => {
    const rows = tableRows(section("### 5.10 Card texts", "Notes on the options")).filter(
      (r) => r.length === 4 && /^`/.test(r[0] ?? ""),
    );
    expect(rows.length).toBe(7);
    for (const [kr, title, body, optionsCell] of rows) {
      const [kind, reason] = uncode(kr!).split(", ");
      const t = CARD_TEMPLATES[`${kind}:${reason}` as keyof typeof CARD_TEMPLATES];
      expect(t, `${kind}:${reason}`).toBeDefined();
      expect(t.title, `${kind}:${reason} title`).toBe(uncode(title!));
      expect(t.body, `${kind}:${reason} body`).toBe(uncode(body!));
      const want = optionsCell!.split("·").map((part) => {
        const m = /`([a-z_]+)`:\s*(.+)/.exec(part.trim());
        return { id: m![1]!, label: m![2]!.trim() };
      });
      expect(
        t.options.map((o) => ({ id: o.id, label: o.label })),
        `${kind}:${reason} options`,
      ).toEqual(want);
    }
  });

  it("5.10/CD4: no option id exists that CARD_OPTIONS does not list, and the order is the spec's", () => {
    for (const t of Object.values(CARD_TEMPLATES))
      for (const o of t.options) {
        expect(["land", "land_now", "decline", "retry", "stop", "keep_landed", "new_attempt", "choose"]).toContain(
          o.id,
        );
      }
    expect(CARD_TEMPLATES["held:held_path"].options.map((o) => o.id)).toEqual(["land", "land_now", "decline"]);
    expect(CARD_TEMPLATES["race:race"].options.map((o) => o.id)).toEqual(["choose"]);
    expect(CARD_TEMPLATES["choice:contradiction"].options.map((o) => o.id)).toEqual(["keep_landed", "retry"]);
    expect(CARD_TEMPLATES["choice:reopen_failed"].options.map((o) => o.id)).toEqual(["new_attempt", "stop"]);
  });

  it("5.10: the race title covers 0, 1 and more ready candidates as the spec's note gives", () => {
    expect(raceTitle(0, 3, "add a crab")).toBe('3 attempts at "add a crab" are still working.');
    expect(raceTitle(1, 3, "add a crab")).toBe(
      '1 of 3 attempts at "add a crab" is ready. Choose it, or wait for the others.',
    );
    expect(raceTitle(2, 3, "add a crab")).toBe('2 of 3 attempts at "add a crab" are ready. Choose one.');
  });

  it("5.10: the minimal held card (features.held false, HD1) has the one-sentence body", () => {
    expect(HELD_BODY_MINIMAL).toBe("It changes {paths}.");
  });

  it("5.10: the blast sentences are the spec's, by blast-radius content", () => {
    const r = { repair: [] as string[], confirm: [] as string[], triage: [] as string[], right_of_way: [] as string[] };
    expect(blastSentence(r, { repair: [], confirm: [], triage: [] })).toBe(
      "No change in flight relies on what this changes.",
    );
    expect(blastSentence({ ...r, repair: ["a1"] }, { repair: ['"add a crab"'], confirm: [], triage: [] })).toBe(
      'Landing this sends 1 change back to its agent: "add a crab".',
    );
    expect(blastSentence({ ...r, repair: ["a1", "a2"] }, { repair: ["A", "B"], confirm: [], triage: [] })).toBe(
      "Landing this sends 2 changes back to their agents: A, B.",
    );
    expect(blastSentence({ ...r, confirm: ["a1", "a2"] }, { repair: [], confirm: ["A", "B"], triage: [] })).toBe(
      "2 changes must confirm: A, B.",
    );
    expect(blastSentence({ ...r, triage: ["a1"] }, { repair: [], confirm: [], triage: ["A"] })).toBe(
      "Clef will judge 1 changes that read it: A.",
    );
    expect(
      blastSentence(
        { ...r, repair: ["a1"], right_of_way: ["a1"] },
        { repair: ["A"], confirm: [], triage: [], rightOfWay: '"fix energy"' },
      ),
    ).toBe('Landing this sends "fix energy" around again. It will wait until that change has landed.');
  });

  it("5.10: the risk sentences and the held-card risk lines are the spec's", () => {
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    expect(riskSentence(null, pct)).toBe("Clef's answers were not available, so this waits for you.");
    expect(
      riskSentence({ model: "m", does_what_asked: 0.2, changes_shared_meaning: null, unrelated_edits: null }, pct),
    ).toBe("Clef doubts that it does what was asked (20%).");
    expect(
      riskSentence({ model: "m", does_what_asked: 0.9, changes_shared_meaning: null, unrelated_edits: 0.8 }, pct),
    ).toBe("Clef sees edits that nobody asked for (80%).");
    expect(
      riskSentence({ model: "m", does_what_asked: 0.9, changes_shared_meaning: 0.7, unrelated_edits: null }, pct),
    ).toBe("Clef sees a change to the meaning of shared code (70%).");
    expect(RISK_LINES.does_what_asked).toBe("Does what was asked: {share}");
    expect(RISK_LINES.changes_shared_meaning).toBe("Changes the meaning of shared code: {share}");
    expect(RISK_LINES.unrelated_edits).toBe("Includes edits nobody asked for: {share}");
    expect(RISK_FOOTER).toBe(
      "Judged by Clef ({model}). These numbers inform you. They never land or decline a change.",
    );
  });
});

// ---------- 8.3 / 8.5 / 5.12 / 6.6 ----------

describe("8.3 replay checks", () => {
  it("8.3/AC30: each failed recording check has the spec's replay.error sentence", () => {
    expect(replayError("download")).toBe("This recording could not be downloaded. Check the connection and try again.");
    expect(replayError("too_large")).toBe("This recording is too large to play here.");
    expect(replayError("not_a_recording")).toBe("This file is not a Premise recording that this page can play.");
    expect(replayError("incomplete", { a: 4, b: 9 })).toBe(
      "This recording is incomplete: it has 4 events and should have 9.",
    );
    expect(replayError("damaged_line", { line: 7 })).toBe("This recording is damaged at line 7.");
    expect(replayError("damaged_gap", { n: 12 })).toBe("This recording is damaged: event 12 is missing.");
    expect(replayError("damaged_time", { n: 12 })).toBe(
      "This recording is damaged: its times go backwards at event 12.",
    );
  });
});

describe("8.5 chapters", () => {
  it("8.5: chapter names and captions are the spec's table verbatim", () => {
    const rows = tableRows(section("### 8.5", "### 8.6")).filter((r) => r.length === 3 && r[0] !== "Chapter name");
    expect(rows.length).toBe(9);
    expect(CHAPTERS.length).toBe(9);
    for (let i = 0; i < rows.length; i++) {
      const [name, , captionCell] = rows[i]!;
      const caption = uncode(captionCell!).replace(/of kind `([a-z]+)`/g, "of kind $1");
      expect(CHAPTERS[i]!.name).toBe(uncode(name!));
      expect(CHAPTERS[i]!.caption, name).toBe(caption);
    }
  });

  it("8.5: the Conflict caption gains the compare suffix when the recording has a plain-merge pool", () => {
    expect(CHAPTER_CONFLICT_COMPARE).toBe("Press C to compare with a plain git merge.");
  });
});

describe("5.12 About", () => {
  it("5.12: the about.how diagram has the spec's seven box labels verbatim and nothing else", () => {
    const rows = tableRows(section("### 5.12", "### 5.13")).filter((r) => r.length === 2 && /^\d+$/.test(r[0] ?? ""));
    expect(rows.length).toBe(7);
    for (let i = 0; i < 7; i++) {
      expect(ABOUT_HOW_BOXES[i], `box ${i + 1}`).toBe(uncode(rows[i]![1]!));
    }
    expect(ABOUT_HOW_BOXES.length).toBe(7);
  });

  // 5.12 (amended 2026-10-07): a box names a part only when the build has it.
  it("5.12: with the green line, Clef and attempt repositories off, boxes 5 to 7 name none of them", () => {
    const boxes = aboutHowBoxes({ green: "none", clef: false, attempt_repos: false });
    expect(boxes.slice(0, 4)).toEqual(ABOUT_HOW_BOXES.slice(0, 4));
    expect(boxes.slice(4)).toEqual([
      "Workflows: the Swarm",
      "Workers AI: the coding models",
      "Artifacts: main and the notes",
    ]);
  });

  it("5.12: each part is named exactly when its feature is on", () => {
    expect(aboutHowBoxes({ green: "static", clef: false, attempt_repos: true }).slice(4)).toEqual([
      "Workflows: the green line and the Swarm",
      "Workers AI: the coding models",
      "Artifacts: main, the green line, and the notes; one repository per attempt for its conversation",
    ]);
    expect(aboutHowBoxes({ green: "none", clef: true, attempt_repos: true }).slice(4)).toEqual([
      "Workflows: the Swarm",
      "Workers AI: the coding models, and Clef for judgments",
      "Artifacts: main and the notes; one repository per attempt for its conversation",
    ]);
  });
});

describe("6.6 keys", () => {
  it("6.6: the shortcut list shows the spec's key rows verbatim", () => {
    const rows = tableRows(section("### 6.6", "### 6.7")).filter((r) => r.length === 2 && r[0] !== "Key");
    expect(rows.length).toBe(SHORTCUT_ROWS.length);
    for (let i = 0; i < rows.length; i++) {
      const wantKey = uncode(rows[i]![0]!).replace(/^Replay: /, "Replay: ");
      expect(SHORTCUT_ROWS[i]!.does, `row ${i}`).toBe(uncode(rows[i]![1]!));
      // The spec writes `Space`, `Esc`, `←, →` in code type; the list shows the same characters.
      expect(uncode(SHORTCUT_ROWS[i]!.key.replace(/^Replay: /, "")).replace("`", "")).toBe(
        uncode(rows[i]![0]!).replace(/^Replay: /, ""),
      );
    }
  });
});
