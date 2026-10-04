// Acceptance item 2 (04-build-plan 2.1): this test parses the constants tables out of the
// specification files — 01-core.md Appendix C, 02-tidepool.md Appendix B, 03-floor.md Appendix A and
// 05-agent.md Appendix A, 06-repos.md Appendix A — and compares every name and value with `constants.ts`. A difference
// fails, in either direction: a name the table has and the module does not, or a constant the module
// exports and no table names.
//
// Expected values come only from the specification text, never from the implementation.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../test/support/source.ts";
import * as constants from "./constants.ts";
import { AGENT_SPEC, GUIDE_PATH } from "./agent-prompt.ts";

const SPEC = "docs/spec";

function specText(file: string): string {
  return readFileSync(`${REPO_ROOT}/${SPEC}/${file}`, "utf8");
}

/** The text of the `## <heading>` section, up to the next `## ` heading. */
function section(file: string, heading: string): string {
  const text = specText(file);
  const match = new RegExp(`^## ${heading}[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m").exec(text);
  if (match === null) throw new Error(`${file}: section "${heading}" not found`);
  return match[1] ?? "";
}

type ParsedValue = number | string | readonly (number | string | null)[];

/** A value cell part: `300,000`, `0.7`, `25 MiB`, a backticked string. */
function parsePart(part: string): number | string | null {
  const backticked = /^`(.*)`$/.exec(part);
  if (backticked !== null) return backticked[1] ?? "";
  const mib = /^([\d,]+(?:\.\d+)?) MiB$/.exec(part);
  if (mib !== null) return Number(mib[1]?.replaceAll(",", "")) * 1024 * 1024;
  if (/^[\d,]+(\.\d+)?$/.test(part)) return Number(part.replaceAll(",", ""));
  return null; // prose
}

/** The constants of one appendix table: name -> parsed value (null marks a prose cell). */
function parseTable(file: string, heading: string): Map<string, ParsedValue | null> {
  const out = new Map<string, ParsedValue | null>();
  for (const line of section(file, heading).split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    const first = cells[0] ?? "";
    const valueCell = cells[1] ?? "";
    if (first.startsWith("---") || first === "Constant" || first === "Name") continue;
    const names = [...first.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)]
      .map((match) => match[1] ?? "")
      .filter((name) => /^[A-Z]/.test(name));
    if (names.length === 0) continue;
    const parts = valueCell
      .split(", ")
      .map((part) => part.trim())
      .filter((part) => part !== "");
    const assign = (name: string, value: ParsedValue | null): void => {
      const seen = out.get(name);
      if (seen !== undefined) {
        throw new Error(`${file}: ${name} is named twice in the constants tables`);
      }
      out.set(name, value);
    };
    if (names.length === parts.length) {
      names.forEach((name, index) => assign(name, parsePart(parts[index] ?? "")));
    } else if (names.length > 1 && parts.length === 1) {
      names.forEach((name) => assign(name, parsePart(parts[0] ?? "")));
    } else if (names.length === 1 && parts.length > 1) {
      assign(names[0] ?? "", parts.map(parsePart));
    } else {
      throw new Error(`${file}: cannot pair names ${names.join(",")} with values "${valueCell}"`);
    }
  }
  return out;
}

/** The 16 names of the `globals` list of 01-core 10.1, for the prose cell of `DEFAULT_GLOBALS`. */
function globalsFromSpec(): readonly string[] {
  const match = /"globals":\s*\[([\s\S]*?)\]/.exec(specText("01-core.md"));
  if (match === null) throw new Error("01-core.md: the globals list of 10.1 was not found");
  return [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((name) => name[1] ?? "");
}

/** `max_real_agents` "starts at N" (05-agent.md MG2), for the prose cell of `MAX_REAL_AGENTS` ("from S5"). */
function maxRealAgentsFromSpec(): number {
  const match = /`?max_real_agents`? starts at (\d+)/.exec(specText("05-agent.md"));
  if (match === null) throw new Error("05-agent.md: `max_real_agents` start value not found");
  return Number(match[1]);
}

/** Every exported constant, wherever Slice 0b placed it. `MODEL_OPTIONS` is data of
 * `src/config/model-plan.ts` (its table cell is prose); floor-json.test.ts checks it against MG2. */
const MODULE: Record<string, unknown> = {
  ...constants,
  AGENT_SPEC,
  GUIDE_PATH,
};

/** The expected value of the cells whose table entry is prose. */
const PROSE: Record<string, () => unknown> = {
  DEFAULT_GLOBALS: globalsFromSpec,
  MAX_REAL_AGENTS: maxRealAgentsFromSpec,
};

/** Table names that live outside constants.ts, checked by another test. */
const CHECKED_ELSEWHERE = new Set(["MODEL_OPTIONS"]);

describe("constants.ts against the constants tables of the specification", () => {
  const tables = new Map<string, ParsedValue | null>();
  const collisions: Array<[string, ParsedValue | null, ParsedValue | null]> = [];
  for (const [file, heading] of [
    ["01-core.md", "Appendix C"],
    ["02-tidepool.md", "Appendix B"],
    ["03-floor.md", "Appendix A"],
    ["05-agent.md", "Appendix A"],
    ["06-repos.md", "Appendix A"],
  ] as const) {
    for (const [name, value] of parseTable(file, heading)) {
      if (tables.has(name)) {
        collisions.push([name, tables.get(name) ?? null, value]);
      } else {
        tables.set(name, value);
      }
    }
  }

  it("a constant named by two tables carries the same value in both", () => {
    for (const [name, first, second] of collisions) {
      expect(second, `${name} is named by two constants tables with different values`).toEqual(first);
    }
  });

  it("the tables name every exported constant and no name is missing", () => {
    const specNames = [...tables.keys()].filter((name) => !CHECKED_ELSEWHERE.has(name)).sort();
    const moduleNames = Object.keys(MODULE)
      .filter((name) => /^[A-Z]/.test(name))
      .sort();
    expect(moduleNames).toEqual(specNames);
  });

  it.each([...tables.entries()].filter(([name]) => !CHECKED_ELSEWHERE.has(name)))(
    "%s has the value the table states",
    (name, expected) => {
      const wanted = expected === null ? PROSE[name]?.() : expected;
      if (wanted === undefined && !(name in PROSE)) {
        throw new Error(`no expected value for ${name}: the table cell is prose and PROSE has none`);
      }
      expect(MODULE[name]).toEqual(wanted);
    },
  );
});
