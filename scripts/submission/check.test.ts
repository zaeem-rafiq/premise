// Slice 10 (2.11, SC2, SC3, BP11, AC19, RY24, SE14b): the rules `check:submission` enforces over
// README.md and docs/submission/. Expected failures come from the spec, not from the checker's
// own output.

import { describe, expect, it } from "vitest";
import { checkSubmission } from "./check.ts";
import type { SubmissionFiles } from "./check.ts";

const LIMIT_A = "Each file of a pool is small.";
const LIMIT_B = "A premise across two pools is not built.";
const LIMITS = [LIMIT_A, LIMIT_B];

const REPLAY_LINE = "Open https://premise.example.com/replay/hero.";
const RUN = ["npm ci", "npm run dev:floor", REPLAY_LINE].join("\n");
const VISION = "A change replaces a branch, a pull request and a merge queue entry.";
const CLOUDFLARE = "One Worker, four Durable Objects and Artifacts.";
const MEASURED_PATH = "docs/measurements/soak/400.json";

const exists = (path: string): boolean => path === MEASURED_PATH;

function files(): SubmissionFiles {
  const readme = [
    "# Premise",
    "",
    "Premise records what an agent read.",
    "",
    "The deployment does not use a separate app host.",
    "",
    "## The idea",
    "",
    "A change replaces a branch, a pull request and a merge queue entry.",
    "",
    "## Run it",
    "",
    RUN,
    "",
    "## Limits",
    "",
    `- ${LIMIT_A}`,
    `- ${LIMIT_B}`,
    "",
    "## Measured",
    "",
    `- 400 runs replayed (\`${MEASURED_PATH}\`)`,
    "",
    "## Related work",
    "",
    "STORM, CoAgent and the entry dibs.",
    "",
  ].join("\n");
  return { readme, run: RUN, vision: VISION, cloudflare: CLOUDFLARE };
}

function check(f: SubmissionFiles) {
  return checkSubmission(f, LIMITS, exists);
}

/** The 1-based line number of the fixture line that holds `needle`. */
function lineOf(text: string, needle: string): number {
  const index = text.split("\n").findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`fixture line not found: ${needle}`);
  return index + 1;
}

/** `readme` without the `## ` section `heading` and its body. */
function dropSection(readme: string, heading: string): string {
  const lines = readme.split("\n");
  const i = lines.findIndex((line) => line === `## ${heading}`);
  if (i < 0) throw new Error(`fixture section not found: ${heading}`);
  let j = i + 1;
  while (j < lines.length && !lines[j]!.startsWith("## ")) j += 1;
  return [...lines.slice(0, i), ...lines.slice(j)].join("\n");
}

describe("checkSubmission", () => {
  it("passes a README and texts that satisfy every rule", () => {
    expect(check(files())).toEqual([]);
  });

  it("length: a text over its limit fails", () => {
    const f = files();
    f.vision = "x".repeat(2001);
    expect(check(f)).toEqual([
      {
        file: "docs/submission/vision.txt",
        line: null,
        rule: "length",
        detail: expect.stringContaining("2001"),
      },
    ]);
  });

  it("length: a missing or empty text fails", () => {
    const f = files();
    f.cloudflare = "";
    expect(check(f)).toEqual([
      {
        file: "docs/submission/cloudflare.txt",
        line: null,
        rule: "length",
        detail: expect.stringContaining("missing"),
      },
    ]);
  });

  it("FL6: a priority claim in the README fails", () => {
    const f = files();
    f.readme = f.readme.replace("Premise records what an agent read.", "Premise is the first recorder of reads.");
    expect(check(f)).toEqual([
      {
        file: "README.md",
        line: lineOf(f.readme, "the first"),
        rule: "FL6",
        detail: expect.stringContaining("the first"),
      },
    ]);
  });

  it("FL6: a claim wrapped over one line break still fails", () => {
    const f = files();
    f.readme = f.readme.replace("Premise records what an agent read.", "Premise is the\nfirst of its kind.");
    expect(check(f)).toEqual([
      {
        file: "README.md",
        line: lineOf(f.readme, "Premise is the"),
        rule: "FL6",
        detail: expect.stringContaining("the first"),
      },
    ]);
  });

  it("FL6: a claim in a submission text fails with that file", () => {
    const f = files();
    f.vision = "What no one else built: a branch replaced.";
    expect(check(f)).toEqual([
      {
        file: "docs/submission/vision.txt",
        line: 1,
        rule: "FL6",
        detail: expect.stringContaining("no one else"),
      },
    ]);
  });

  it("BP11: a replaced word outside ## The idea fails", () => {
    const f = files();
    f.readme = f.readme.replace("Premise records what an agent read.", "It watches branches.");
    expect(check(f)).toEqual([
      {
        file: "README.md",
        line: lineOf(f.readme, "branches"),
        rule: "BP11",
        detail: expect.stringContaining("branch"),
      },
    ]);
  });

  it("BP11: a replaced word in cloudflare.txt fails", () => {
    const f = files();
    f.cloudflare = "Artifacts holds merge queues.";
    expect(check(f)).toEqual([
      {
        file: "docs/submission/cloudflare.txt",
        line: 1,
        rule: "BP11",
        detail: expect.stringContaining("merge queue"),
      },
    ]);
  });

  it("SC3: a Run it section that differs from run.txt fails", () => {
    const f = files();
    f.readme = f.readme.replace("npm ci", "npm install");
    expect(check(f)).toEqual([
      {
        file: "README.md",
        line: lineOf(f.readme, "npm install"),
        rule: "SC3",
        detail: expect.stringContaining("run.txt"),
      },
    ]);
  });

  it("RY24: run.txt without the Replay line fails", () => {
    const f = files();
    f.run = f.run.replace(REPLAY_LINE, "");
    f.readme = f.readme.replace(REPLAY_LINE, "");
    expect(check(f)).toEqual([
      {
        file: "docs/submission/run.txt",
        line: null,
        rule: "RY24",
        detail: expect.stringContaining("/replay/hero"),
      },
    ]);
  });

  it("RY24: run.txt with two Replay lines fails", () => {
    const f = files();
    const second = `Then https://premise.example.com/replay/hero again.`;
    f.run = `${RUN}\n${second}`;
    f.readme = f.readme.replace(REPLAY_LINE, `${REPLAY_LINE}\n${second}`);
    const failures = check(f);
    expect(failures).toEqual([
      {
        file: "docs/submission/run.txt",
        line: lineOf(f.run, "again"),
        rule: "RY24",
        detail: expect.stringContaining("exactly one"),
      },
    ]);
  });

  it("AC19: a Limits item that differs from limitsList(FEATURES) fails", () => {
    const f = files();
    f.readme = f.readme.replace(`- ${LIMIT_B}`, "- something else entirely");
    expect(check(f)).toEqual([
      {
        file: "README.md",
        line: lineOf(f.readme, "something else"),
        rule: "AC19",
        detail: expect.stringContaining("differs"),
      },
    ]);
  });

  it("measured: a number with no existing measurements path fails", () => {
    const f = files();
    f.readme = f.readme.replace(`- 400 runs replayed (\`${MEASURED_PATH}\`)`, "- 400 runs replayed");
    expect(check(f)).toEqual([
      {
        file: "README.md",
        line: lineOf(f.readme, "400 runs"),
        rule: "measured",
        detail: expect.stringContaining("docs/measurements/"),
      },
    ]);
  });

  it("measured: a path that does not exist fails", () => {
    const f = files();
    f.readme = f.readme.replace(MEASURED_PATH, "docs/measurements/soak/none.json");
    expect(check(f)).toEqual([
      {
        file: "README.md",
        line: lineOf(f.readme, "none.json"),
        rule: "measured",
        detail: expect.stringContaining("docs/measurements/"),
      },
    ]);
  });

  it("SC2: related work that does not name dibs fails", () => {
    const f = files();
    f.readme = f.readme.replace(" and the entry dibs", "");
    expect(check(f)).toEqual([
      {
        file: "README.md",
        line: lineOf(f.readme, "## Related work"),
        rule: "SC2",
        detail: expect.stringContaining("dibs"),
      },
    ]);
  });

  it("SE14b: no app-host statement fails", () => {
    const f = files();
    f.readme = f.readme.replace("The deployment does not use a separate app host.\n", "");
    expect(check(f)).toEqual([
      {
        file: "README.md",
        line: null,
        rule: "SE14b",
        detail: expect.stringContaining("separate app host"),
      },
    ]);
  });

  it("a missing ## section fails with the rule that owns it", () => {
    const cases: Array<[string, string]> = [
      ["The idea", "BP11"],
      ["Run it", "SC3"],
      ["Limits", "AC19"],
      ["Measured", "measured"],
      ["Related work", "SC2"],
    ];
    for (const [heading, rule] of cases) {
      const f = files();
      f.readme = dropSection(f.readme, heading);
      expect(check(f), `## ${heading}`).toEqual([
        { file: "README.md", line: null, rule, detail: expect.stringContaining(`## ${heading}`) },
      ]);
    }
  });
});
