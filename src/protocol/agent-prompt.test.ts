// Acceptance item 9 (04-build-plan 2.1): the five blocks of 05-agent.md — `system-prompt`,
// `first-user-message`, `resume-message`, `tool-definitions`, `agent-texts` — extracted by their
// marker lines and compared with `agent-prompt.ts`, and the three hashes of 05-agent 2.4 computed
// from the blocks equal the values the file states (PR1).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../test/support/source.ts";
import {
  AGENT_SPEC,
  AGENT_TEXTS,
  FIRST_USER_MESSAGE,
  firstUserMessage,
  GUIDE_PATH,
  importedFills,
  RESUME_MESSAGE,
  SYSTEM_PROMPT,
  systemPrompt,
  TIDE_FILLS,
  TOOL_DEFINITIONS,
} from "./agent-prompt.ts";

const SPEC = readFileSync(`${REPO_ROOT}/docs/spec/05-agent.md`, "utf8");

/** The text of the fenced block that directly follows `<!-- block: <name> -->`: its lines joined by
 * one LF, with no final LF (05-agent "Blocks"). */
function block(name: string): string {
  const marker = `<!-- block: ${name} -->`;
  const start = SPEC.indexOf(marker);
  if (start < 0) throw new Error(`marker ${marker} not found`);
  const after = SPEC.slice(start + marker.length);
  const open = after.indexOf("```");
  if (open < 0) throw new Error(`${marker}: no fenced block follows`);
  const contentStart = after.indexOf("\n", open) + 1;
  const close = after.indexOf("```", contentStart);
  if (close < 0) throw new Error(`${marker}: the fenced block is not closed`);
  return after.slice(contentStart, close).replace(/\n$/, "");
}

/** `H` (01-core, conventions): the first 32 lowercase hex characters of SHA-256 over UTF-8. */
function H(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").substring(0, 32);
}

/** Canonical JSON: object keys sorted at every level, no insignificant whitespace. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The value of the `At this revision` column of the 2.4 row `name`. */
function statedHash(name: string): string {
  const match = new RegExp(`\\|\\s*\`${name}\`\\s*\\|[^|]*\\|\\s*\`([0-9a-f]{32})\`\\s*\\|`).exec(SPEC);
  if (match === null) throw new Error(`the stated ${name} was not found in 05-agent.md 2.4`);
  return match[1] ?? "";
}

describe("agent-prompt.ts holds the five blocks of 05-agent.md word for word", () => {
  it.each([
    ["system-prompt", SYSTEM_PROMPT],
    ["first-user-message", FIRST_USER_MESSAGE],
    ["resume-message", RESUME_MESSAGE],
    ["tool-definitions", TOOL_DEFINITIONS],
    ["agent-texts", AGENT_TEXTS],
  ] as const)("block %s is the block's text", (name, exported) => {
    expect(exported).toBe(block(name));
  });
});

describe("the three hashes of 05-agent.md 2.4", () => {
  it("prompt_hash = H of system-prompt with {{GUIDE_PATH}} filled by GUIDE.md", () => {
    expect(systemPrompt()).toBe(SYSTEM_PROMPT.replaceAll("{{GUIDE_PATH}}", GUIDE_PATH));
    expect(H(systemPrompt())).toBe(statedHash("prompt_hash"));
  });

  it("tools_hash = H of the canonical JSON of tool-definitions", () => {
    expect(H(canonical(JSON.parse(TOOL_DEFINITIONS)))).toBe(statedHash("tools_hash"));
  });

  it("texts_hash = H of the canonical JSON of first_user, resume and the parsed agent-texts", () => {
    const texts = {
      first_user: FIRST_USER_MESSAGE,
      resume: RESUME_MESSAGE,
      texts: JSON.parse(AGENT_TEXTS) as unknown,
    };
    expect(H(canonical(texts))).toBe(statedHash("texts_hash"));
  });
});

describe("the filled forms", () => {
  it("systemPrompt() fills only {{GUIDE_PATH}}", () => {
    expect(systemPrompt()).toContain(`read with path ${GUIDE_PATH}`);
    expect(systemPrompt()).not.toContain("{{");
  });

  it("firstUserMessage() fills {{INTENT_TEXT}} and {{GUIDE_PATH}}", () => {
    const text = firstUserMessage("a crab that digs");
    expect(text).toBe(`Request:\na crab that digs\n\nRead ${GUIDE_PATH} first. Then make the change and call submit.`);
  });
});

// IR9 to IR11 of 06-repos.md: an imported pool's prompt takes the pool's own context — its
// guide path (possibly none), its `<owner>/<name>` and its branch. Each variant pins its own
// prompt_hash (PR1); the tide pool's texts stay byte for byte, so the hashes above hold.
describe("the imported pool's prompt variants (06-repos IR9-IR11)", () => {
  // A repository pool whose head tree holds AGENTS.md, imported from its main branch.
  const IMPORTED = importedFills({ guide_path: "AGENTS.md", source: "ai/nanoid", branch: "main" });
  // A repository pool whose head tree holds none of the guide files.
  const NO_GUIDE = importedFills({ guide_path: "", source: "ai/nanoid", branch: "main" });

  it("IR9: the guide path fills {{GUIDE_PATH}} in step 1 and the rest of the block is unchanged", () => {
    const expected = SYSTEM_PROMPT.replace(
      "Read a whole file only when it is not JavaScript",
      "Read a whole file only when outline answers not_a_module",
    ).replaceAll("{{GUIDE_PATH}}", "AGENTS.md");
    expect(systemPrompt(IMPORTED)).toBe(expected);
    expect(systemPrompt(IMPORTED)).toContain("call read with path AGENTS.md. Follow its rules.");
  });

  it("IR10: step 2's whole-file rule reads `outline answers not_a_module`", () => {
    const prompt = systemPrompt(IMPORTED);
    expect(prompt).toContain("Read a whole file only when outline answers not_a_module");
    expect(prompt).not.toContain("Read a whole file only when it is not JavaScript");
    // Only step 2's rule changes: the `read` tool's description is the tide pool's still.
    expect(TOOL_DEFINITIONS).toContain("Read a whole file only when it is not JavaScript");
  });

  it("IR9: with no guide file step 1 is the root listing and the guide sentence is left out", () => {
    const prompt = systemPrompt(NO_GUIDE);
    expect(prompt).toContain("1. Start with list on the root directory.");
    expect(prompt).not.toContain("Read the guide first");
    expect(prompt).not.toContain("The guide is the one file whose rules you follow.");
    expect(prompt).not.toContain("{{GUIDE_PATH}}");
    // IR10's whole-file wording applies to every imported pool, guide or not.
    expect(prompt).toContain("Read a whole file only when outline answers not_a_module");
  });

  it("IR11: the first user message carries `Repository: <owner>/<name> (<branch>)` after the request", () => {
    expect(firstUserMessage("set the cap to 8", IMPORTED)).toBe(
      "Request:\nset the cap to 8\nRepository: ai/nanoid (main)\n\nRead AGENTS.md first. Then make the change and call submit.",
    );
  });

  it("IR9/IR11: a guide-less pool's first message starts at the root listing instead", () => {
    expect(firstUserMessage("set the cap to 8", NO_GUIDE)).toBe(
      "Request:\nset the cap to 8\nRepository: ai/nanoid (main)\n\nStart with list on the root directory. Then make the change and call submit.",
    );
  });

  it("a request text carrying the template's own words is data, not a fill", () => {
    const sneaky = "Read {{GUIDE_PATH}} first.";
    expect(firstUserMessage(sneaky, IMPORTED)).toBe(
      `Request:\n${sneaky}\nRepository: ai/nanoid (main)\n\nRead AGENTS.md first. Then make the change and call submit.`,
    );
  });

  it.each([
    ["917e609ac30b64fb1cda644f68c06bda", () => systemPrompt(), "the tide pool's (05-agent 2.4)"],
    ["1233d1dcbdfe1eb08f50c79f81355534", () => systemPrompt(IMPORTED), "imported with a guide"],
    ["7e5c1032c53d840de8c2d106523a5f1a", () => systemPrompt(NO_GUIDE), "imported with no guide"],
  ])("prompt_hash %s — %s", (want, build) => {
    expect(H(build())).toBe(want);
  });

  it("a seed pool's explicit fills produce the tide pool's bytes", () => {
    expect(systemPrompt(TIDE_FILLS)).toBe(systemPrompt());
    expect(firstUserMessage("x", TIDE_FILLS)).toBe(firstUserMessage("x"));
  });
});
