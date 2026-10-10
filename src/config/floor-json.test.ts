// `/floor.json` against the specification (03-floor 4.5): the fields the type fixes, the thirty-six
// pre-written requests of 02-tidepool section 9 parsed out of its tables, the model short names of
// MG2, the limits list of 5.12, and the verbatim `about.related.body`.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../test/support/source.ts";
import { FEATURES } from "./features.ts";
import { floorJson } from "./floor-json.ts";
import { MODEL_OPTIONS, MODEL_PLAN } from "./model-plan.ts";
import { IMPORT_MAX_ENTRIES, IMPORT_MAX_TEXT_BYTES, MAX_FILE_BYTES, MAX_REAL_AGENTS } from "../protocol/constants.ts";

const floor = readFileSync(`${REPO_ROOT}/docs/spec/03-floor.md`, "utf8");
const tidepool = readFileSync(`${REPO_ROOT}/docs/spec/02-tidepool.md`, "utf8");
const agent = readFileSync(`${REPO_ROOT}/docs/spec/05-agent.md`, "utf8");

/** The rows of the table under `### <heading>` in `text` (header and `---` excluded). */
function tableRows(text: string, heading: string): string[][] {
  const start = text.indexOf(heading);
  if (start < 0) throw new Error(`heading "${heading}" not found`);
  const lines = text.slice(start).split("\n");
  const firstTable = lines.findIndex((line) => line.startsWith("|"));
  const rows: string[][] = [];
  for (const line of lines.slice(firstTable)) {
    if (!line.startsWith("|")) break;
    rows.push(
      line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    );
  }
  return rows.slice(2); // header and separator
}

/** The 36 `{ id, text, group, race }` of 02-tidepool section 9, in the order of its tables. */
function specPrewritten(): Array<{ id: string; text: string; group: "starter" | null; race: boolean }> {
  const rows: Array<{ id: string; text: string; group: "starter" | null; race: boolean }> = [];
  for (const heading of ["### 9.1", "### 9.2", "### 9.3"]) {
    for (const cells of tableRows(tidepool, heading)) {
      const id = cells[0] ?? "";
      const quoted = /^"(.*)"$/.exec(cells[1] ?? "");
      if (id === "" || quoted === null) continue;
      rows.push({
        id,
        text: quoted[1] ?? "",
        group: cells[2] === "`starter`" ? "starter" : null,
        race: id === "P1a",
      });
    }
  }
  return rows;
}

/** The `about.related.body` row of the copy table of 03-floor section 5. */
function specRelated(): string {
  const match = /`about\.related\.body`\s*\|\s*([^|]+?)\s*\|/.exec(floor);
  if (match === null) throw new Error("about.related.body not found in 03-floor.md");
  return match[1] ?? "";
}

/** The numbered limit lines of 03-floor 5.12 for this build's features. */
function specLimits(): string[] {
  const content = /The limits list is one file[\s\S]*?Content:\s*\n([\s\S]*?)\n\n/.exec(floor);
  if (content === null) throw new Error("the limits list of 5.12 was not found");
  const names: Record<"held" | "race" | "undo" | "attempt_repos" | "mcp", string> = {
    held: "the held card with previews",
    race: "comparing attempts",
    undo: "Undo",
    attempt_repos: "attempt repositories",
    mcp: "outside agents over MCP",
  };
  const off = (Object.keys(names) as Array<keyof typeof names>).filter((key) => FEATURES[key] === false);
  const lines: string[] = [];
  for (const raw of (content[1] ?? "").split("\n")) {
    const numbered = /^\d+\.\s+(.*)$/.exec(raw.trim());
    if (numbered === null) continue;
    let line = numbered[1] ?? "";
    if (line.includes("{runtime sentence}")) {
      if (FEATURES.green === "none") line = "The green line is not in this build.";
      else line = line.replace("{runtime sentence}", "RUNTIME");
    }
    if (line.includes("{on or off}")) {
      line = line.replace("{on or off}", FEATURES.clef ? "on" : "off");
    }
    if (line.includes("{the names of the features that are off}")) {
      if (off.length === 0) continue; // left out when none is off
      line = line.replace("{the names of the features that are off}", off.map((key) => names[key]).join(", "));
    }
    // Line 17 is shown only while its feature is on (07-mcp).
    if (line.endsWith("(Only when `features.mcp` is true.)") && !FEATURES.mcp) continue;
    // The parenthetical notes of lines 7, 16 and 17 are the conditions, not part of the shown line.
    line = line
      .replace(/ \(Or:.*\)$/, "")
      .replace(/ \(Left out.*\)$/, "")
      .replace(/ \(Only when .*\)$/, "");
    // 5.12: a number in a line is written with a comma every three places.
    const n = (value: number) => value.toLocaleString("en-US");
    lines.push(
      line
        .replace("{MAX_FILE_BYTES}", n(MAX_FILE_BYTES))
        .replace("{IMPORT_MAX_ENTRIES}", n(IMPORT_MAX_ENTRIES))
        .replace("{IMPORT_MAX_TEXT_BYTES}", n(IMPORT_MAX_TEXT_BYTES))
        .replace("{max}", n(MAX_REAL_AGENTS)),
    );
  }
  return lines;
}

/** The rows of the MG2 table (its cells are indented inside the bullet). */
function specModelRows(): string[][] {
  const table = /Starting `per_minute`[^\n]*\n([\s\S]*?)\n\n/.exec(agent);
  if (table === null) throw new Error("the MG2 table was not found");
  return (table[1] ?? "")
    .split("\n")
    .filter((line) => /^\s*\|/.test(line))
    .map((line) =>
      line
        .split("|")
        .map((cell) => cell.trim())
        .slice(1, -1),
    )
    .slice(1); // the header row
}

/** `MODEL_OPTIONS` (05-agent Appendix A): the last column of MG2, per model id. */
function specModelOptions(): Record<string, { reasoning_effort?: string }> {
  const out: Record<string, { reasoning_effort?: string }> = {};
  for (const cells of specModelRows()) {
    const id = /^`(@cf\/[^`]+)`$/.exec(cells[0] ?? "")?.[1];
    const options = /^`(\{.*\})`$/.exec(cells[cells.length - 1] ?? "")?.[1];
    if (id === undefined || options === undefined) continue;
    const effort = /reasoning_effort:\s*"([^"]+)"/.exec(options)?.[1];
    out[id] = effort === undefined ? {} : { reasoning_effort: effort };
  }
  return out;
}

/** The model ids of the MG2 table (first column). */
function specModelIds(): string[] {
  const ids: string[] = [];
  for (const cells of specModelRows()) {
    const id = /^`(@cf\/[^`]+)`$/.exec(cells[0] ?? "")?.[1];
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

describe("floorJson() (03-floor 4.5)", () => {
  const json = floorJson();

  it("carries the fields of the FloorJson type", () => {
    expect(Object.keys(json).sort()).toEqual(
      ["default_pool", "swarm_pool", "features", "prewritten", "swarm_defaults", "models", "limits", "related"].sort(),
    );
    expect(json.swarm_defaults).toEqual({
      seed: expect.any(Number),
      launch_per_second: expect.any(Number),
      think_ms: [expect.any(Number), expect.any(Number)],
      rescale_every_s: expect.any(Number),
    });
  });

  it("names the main pool and the Swarm pool by their seeds (PL1)", () => {
    expect(json.default_pool).toBe("tidepool");
    expect(json.swarm_pool).toBe("tidepool-swarm");
  });

  it("prewritten is the 36 intents of 02-tidepool section 9 in table order", () => {
    const spec = specPrewritten();
    expect(spec).toHaveLength(36);
    expect(json.prewritten).toEqual(spec);
    expect(spec.filter((row) => row.group === "starter").map((row) => row.id)).toEqual([
      "A01",
      "A03",
      "A04",
      "A06",
      "A11",
      "P1b",
    ]);
    expect(spec.filter((row) => row.race).map((row) => row.id)).toEqual(["P1a"]);
  });

  it("models maps every model of MG2 to its short name (the id's last segment)", () => {
    const ids = specModelIds();
    expect(ids.length).toBeGreaterThan(0);
    expect(json.models).toEqual(Object.fromEntries(ids.map((id) => [id, id.split("/").pop() ?? id])));
    expect(MODEL_PLAN.workhorse).toBe(ids[0]);
    expect(MODEL_PLAN.race.slice(1).sort()).toEqual(ids.slice(1).sort());
  });

  it("GR5: limits and the green runtime describe this build's features", () => {
    const spec = specLimits();
    expect(spec.length).toBeGreaterThanOrEqual(14);
    expect(json.limits).toEqual(spec);
    expect(json.features.green).toBe(FEATURES.green);
    if (FEATURES.green === "none") {
      expect(json.limits).toContain("The green line is not in this build.");
    }
  });

  it("related is the verbatim text of `about.related.body`", () => {
    expect(json.related).toBe(specRelated());
  });

  it("MODEL_OPTIONS is the last column of MG2, per model id", () => {
    const spec = specModelOptions();
    expect(Object.keys(spec).length).toBeGreaterThan(0);
    expect(MODEL_OPTIONS).toEqual(spec);
  });

  it("the model plan's rates and prices are the MG2 columns", () => {
    for (const cells of specModelRows()) {
      const id = /^`(@cf\/[^`]+)`$/.exec(cells[0] ?? "")?.[1] ?? "";
      const perMinute = Number(cells[4]);
      const price = /^\$(\d+\.\d+) \/ \$(\d+\.\d+)$/.exec(cells[5] ?? "");
      expect(MODEL_PLAN.per_minute[id], `per_minute of ${id}`).toBe(perMinute);
      expect(MODEL_PLAN.prices_usd_per_mtok[id], `price of ${id}`).toEqual({
        in: Number(price?.[1]),
        out: Number(price?.[2]),
      });
    }
  });

  it("ME11: the model plan follows the recorded lead decision, including the six-agent override", () => {
    const record = readFileSync(`${REPO_ROOT}/docs/measurements/models/2026-10-06-engine.md`, "utf8");
    const decision = record.split("## Decision\n")[1];
    expect(decision).toBeDefined();
    const workhorse = /^- Workhorse: `([^`]+)`/m.exec(decision ?? "")?.[1];
    const maxAgents = /^- `max_real_agents` stays (\d+)\./m.exec(decision ?? "")?.[1];
    expect(workhorse).toBe("@cf/openai/gpt-oss-120b");
    expect(maxAgents).toBe("6");
    expect(decision).toContain("240 / 7.6 = 31; 6 keeps the spend and the");
    expect(decision).toContain("(`gpt-oss-120b`, `kimi-k2.7-code`, `glm-5.3-flash`)");
    expect(decision).toContain("keeps `per_minute` at 16 for the two race models");

    // ME11 permits the lead to override its default reading, provided the decision is recorded.
    expect(MODEL_PLAN.workhorse).toBe(workhorse);
    expect(MODEL_PLAN.max_real_agents).toBe(Number(maxAgents));
    expect(MODEL_PLAN.race).toEqual([
      "@cf/openai/gpt-oss-120b",
      "@cf/moonshotai/kimi-k2.7-code",
      "@cf/zai-org/glm-5.3-flash",
    ]);
    expect(MODEL_PLAN.per_minute).toEqual({
      "@cf/openai/gpt-oss-120b": 240,
      "@cf/moonshotai/kimi-k2.7-code": 16,
      "@cf/zai-org/glm-5.3-flash": 16,
    });
  });

  it("features carries the seven keys of Features (FJ1, with 07-mcp's mcp) and no other", () => {
    expect(Object.keys(json.features).sort()).toEqual(
      ["attempt_repos", "clef", "green", "held", "mcp", "race", "undo"].sort(),
    );
  });
});
