// The rules of 03-floor 5.1 that the copy module itself satisfies: CP5 placeholders, CP6 quoting,
// CP7 owner/visitor forms, CP2 word limits, CP8 glossary. Expected values are the spec's text.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fill, placeholders } from "./fill.ts";
import {
  ATTEMPT_TIMEOUT_MS,
  AGENT_WATCHDOG_MS,
  GO_AROUND_LIMIT,
  MAX_BATCH,
  MAX_INTENT_CHARS,
  MAX_REAL_AGENTS,
  MAX_REVISIONS,
  MODEL_RETRIES,
  PUSH_REJECT_LIMIT,
  RACE_SIZE,
  UNDO_WINDOW,
  FLOOR_KEEP_LANDINGS,
  CHANGE_NAME_CHARS,
  MAX_FILE_BYTES,
} from "../protocol/constants.ts";
import { STRINGS, template, text } from "./strings.ts";
import { CARD_TEMPLATES } from "./cards.ts";
import { STOP_SENTENCES } from "./stops.ts";
import { JUDGMENT_SENTENCES, SCRIPTED_SENTENCES } from "./sentences.ts";
import { REQUEST_ERRORS, UNDO_REFUSAL_REASONS } from "./errors.ts";

describe("CP5 placeholders", () => {
  it("CP5: constant placeholders fill from constants.ts values, never typed into a string", () => {
    expect(fill("{GO_AROUND_LIMIT}")).toBe(`${GO_AROUND_LIMIT}`);
    expect(fill("{MAX_REVISIONS}")).toBe(`${MAX_REVISIONS}`);
    expect(fill("{MODEL_RETRIES + 1}")).toBe(`${MODEL_RETRIES + 1}`);
    expect(fill("{ATTEMPT_TIMEOUT_MS as duration}")).toBe("10 min 0 s");
    expect(fill("{AGENT_WATCHDOG_MS as duration}")).toBe("30 s");
    expect(fill("{RACE_SIZE}")).toBe(`${RACE_SIZE}`);
    expect(fill("{UNDO_WINDOW}")).toBe(`${UNDO_WINDOW}`);
    expect(fill("{FLOOR_KEEP_LANDINGS}")).toBe(`${FLOOR_KEEP_LANDINGS}`);
    expect(fill("{MAX_BATCH}")).toBe(`${MAX_BATCH}`);
    expect(fill("{PUSH_REJECT_LIMIT}")).toBe(`${PUSH_REJECT_LIMIT}`);
    expect(fill("{MAX_INTENT_CHARS}")).toBe(`${MAX_INTENT_CHARS}`);
    // No constant value may be baked into a string that names the placeholder.
    for (const [id, entry] of Object.entries(STRINGS)) {
      for (const ph of placeholders(entry.text)) {
        if (/^[A-Z_]+( \+ \d+)?( as duration)?$/.test(ph)) {
          const value = fill(`{${ph}}`);
          expect(entry.text, `${id} bakes a constant value`).not.toContain(` ${value} `);
        }
      }
    }
  });

  it("CP5: a placeholder with no value and no constant is a bug and throws", () => {
    expect(() => fill("{nonsense}")).toThrow();
    expect(() => text("card.open", {})).not.toThrow();
  });

  it("CP5: an array fills a repeated placeholder in order (about.build, undo.done, replay.position)", () => {
    expect(text("about.build", { build: [12, 9] })).toBe("Page build 12. Recording made by build 9.");
    // `{landing}` takes the 5.2 Landing form, "landing {seq}".
    expect(text("undo.done", { landing: ["landing 4", "landing 7"], n: 2 })).toBe(
      "Undo of landing 4 landed as landing 7. It took back 2 changes.",
    );
    expect(text("replay.position", { clock: ["00:01:00", "00:03:00"] })).toBe("00:01:00 of 00:03:00");
  });

  it("CP5: strings with {n} that the spec gives a 1-form for carry it in `one`", () => {
    // Representative 1-forms from section 5; review-numbers.test.ts covers the other counted phrases.
    expect(text("selftest.fail", { n: 1 })).toBe("Self-test, run in this page: failed · 1 check");
    expect(text("selftest.fail", { n: 3 })).toBe("Self-test, run in this page: failed · 3 checks");
    expect(text("undo.also", { n: 1, names: '"x"' })).toBe(
      'This also takes back 1 later change that was built on it: "x". Its agent reopens and adapts.',
    );
    expect(text("undo.also", { n: 2, names: '"a", "b"' })).toBe(
      'This also takes back 2 later changes that were built on it: "a", "b". Their agents reopen and adapt.',
    );
  });
});

describe("CP7 owner / visitor forms", () => {
  it("CP7: the owner-waiting strings the rule names switch to the 'the owner' form for a visitor", () => {
    // CP7 names: status.held, needs.badge, needs.title, the held line of 5.7.
    expect(text("status.held")).toBe("Waiting for you");
    expect(text("status.held", { visitor: true })).toBe("Waiting for the owner");
    expect(text("needs.badge", { n: 2 })).toBe("Needs you 2");
    expect(text("needs.badge", { n: 2, visitor: true })).toBe("Needs the owner 2");
    expect(text("needs.title", { n: 2 })).toBe("Needs you (2)");
    expect(text("needs.title", { n: 2, visitor: true })).toBe("Needs the owner (2)");
    // A recorded fact always says "the owner" — no "you" in the closing sentences.
    for (const id of [
      "held.closed.land",
      "held.closed.land_now",
      "held.closed.decline",
      "race.closed",
      "choice.closed",
    ]) {
      expect(template(id), id).not.toMatch(/\byou\b|\byour\b/i);
    }
  });
});

describe("CP2 plain words", () => {
  it("CP2: no explanatory sentence in copy is longer than 25 words", () => {
    const offenders: string[] = [];
    const check = (id: string, s: string): void => {
      // A " · " separates short fragments (banners, counters), not a sentence's words.
      for (const sentence of s.split(/(?<=[.?!])\s+|\s+·\s+/)) {
        const words = sentence
          .replace(/\{[^{}]*\}/g, "x")
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        if (words.length > 25) offenders.push(`${id}: ${sentence} (${words.length} words)`);
      }
    };
    for (const [id, e] of Object.entries(STRINGS)) {
      for (const variant of [e.text, e.visitor, e.one, e.alt]) if (variant) check(id, variant);
    }
    for (const [id, t] of Object.entries(CARD_TEMPLATES)) {
      check(`${id}.title`, t.title);
      check(`${id}.body`, t.body);
      for (const o of t.options) check(`${id}.${o.id}`, o.label);
    }
    for (const t of [
      ...Object.values(STOP_SENTENCES),
      ...Object.values(REQUEST_ERRORS),
      ...Object.values(UNDO_REFUSAL_REASONS),
      ...JUDGMENT_SENTENCES.map((r) => r.text),
      ...Object.values(SCRIPTED_SENTENCES),
    ]) {
      check("table", t);
    }
    expect(offenders).toEqual([]);
  });
});

describe("CP6 outside text", () => {
  it("CP6: templates that quote intent text, statements and landings keep the {braces} inside double quotes", () => {
    // The quoting is part of the template: the value inserted is never edited by fill.
    const raw = 'we "quote" this <b>and</b> {braces} stay';
    expect(fill('"{intent text}"', { "intent text": raw })).toBe(`"${raw}"`);
    expect(text("why.asked.line", { requester: "the owner", "intent text": raw })).toBe(`the owner: "${raw}"`);
  });
});

describe("CP8 one name per thing", () => {
  it("CP8: copy uses the glossary names and no second word for them", () => {
    const all = Object.values(STRINGS)
      .flatMap((e) => [e.text, e.visitor, e.one, e.alt])
      .filter((s): s is string => typeof s === "string")
      .join("\n");
    // An undo or a revert "takes back" a landed change — the word "revert" is never page text.
    expect(all).not.toMatch(/\brevert(s|ed|ing)?\b/i);
    // A repair is a "go-around": the word appears, and "backwards"/"rework" never stand in for it.
    expect(STRINGS["headsup.title.repair"]?.text).toContain("go-around");
    expect(all).not.toMatch(/\brework\b|\bredo(es)?\b/i);
    // An agent without a model is a "scripted agent"; its pool's banner word is SYNTHETIC.
    expect(STRINGS["banner.synthetic"]?.word).toBe("SYNTHETIC");
    expect(all).toMatch(/scripted agents/);
    // The pool's own test is the "self-test"; the platform's check is the "green line".
    expect(STRINGS["selftest.pass"]?.text).toContain("Self-test");
    expect(STRINGS["strip.green"]?.text).toBe("Green line");
    // The second pool of Compare view is the "plain-merge pool"; "merge pool" alone never appears.
    expect(STRINGS["plain.label"]?.text).toBe("Same changes, merged by plain git");
    expect(all.match(/(?<!plain-)merge pool/gi) ?? []).toEqual([]);
    // "card" alone is a decision that waits for the owner; the rail item is an "attempt card".
    expect(STRINGS["sr.card"]?.text).toBe("A card is waiting for the owner: {title}");
    expect(STRINGS["nav.skip"]?.text).toBe("Skip to the attempt cards");
  });
});
