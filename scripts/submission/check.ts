// npm run check:submission
//
// Slice 10 (docs/spec/04-build-plan.md 2.11) with BP11, SC2, SC3, AC19, RY24 and SE14b: reads
// README.md and the three submission texts under docs/submission/ and prints one line per failure,
// naming the file, the line and the rule.
//
// Exit 0: no failure. Exit 1: at least one failure. Exit 2: the check could not run.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURES } from "../../src/config/features.ts";
import { limitsList } from "../../src/config/limits.ts";

export type Failure = { file: string; line: number | null; rule: string; detail: string };

export type SubmissionFiles = { readme: string; run: string; vision: string; cloudflare: string };

const FILE_NAME: Record<keyof SubmissionFiles, string> = {
  readme: "README.md",
  run: "docs/submission/run.txt",
  vision: "docs/submission/vision.txt",
  cloudflare: "docs/submission/cloudflare.txt",
};

const TEXT_KEYS = ["run", "vision", "cloudflare"] as const;
const ALL_KEYS = ["readme", ...TEXT_KEYS] as const;

// 2.11 item 1: Unicode code points of the whole file, line breaks included.
const TEXT_LIMIT: Record<(typeof TEXT_KEYS)[number], number> = {
  run: 4000,
  vision: 2000,
  cloudflare: 2000,
};

// Between the words of a phrase: horizontal whitespace, or one line break with any padding.
const BREAK = String.raw`[ \t]+|[ \t]*\r?\n[ \t]*`;

// FL6 (03-floor 0): the lint list of priority claims.
const PRIORITY_PHRASES = [
  "the first",
  "first to",
  "no one else",
  "nobody else",
  "the only system",
  "the only tool",
  "the only product",
];

function phrasePattern(phrase: string): RegExp {
  return new RegExp(`\\b${phrase.split(" ").join(`(?:${BREAK})`)}\\b`, "gi");
}

// BP11 (c): what a change replaces. These words belong in vision.txt and in the README's
// "## The idea" only; anywhere else in the README or the other two texts is a failure.
const REPLACED_PATTERNS: ReadonlyArray<{ word: string; pattern: RegExp }> = [
  { word: "branch", pattern: /\bbranches?\b/gi },
  { word: "pull request", pattern: new RegExp(`\\bpull(?:${BREAK})requests?\\b`, "gi") },
  { word: "merge queue", pattern: new RegExp(`\\bmerge(?:${BREAK})queues?\\b`, "gi") },
];

// RY24 / 8.7 way 3: an https:// address ending in /replay/hero, optionally followed by punctuation.
const REPLAY_LINE = /https:\/\/[^\s"'<>]*\/replay\/hero[.,;:!?)\]}>"'`]*(?:\s|$)/;

const SECTION_TITLES = ["The idea", "Run it", "Limits", "Measured", "Related work"] as const;

type Section = {
  /** Line index of the `## ` heading. */
  heading: number;
  /** Line index of the first body line. */
  start: number;
  /** Line index one past the last body line (the next `## ` heading, or the end of the file). */
  end: number;
};

/** The `## ` section titled `title`, or null. A `## ` line inside a fenced block is not a heading. */
function findSection(lines: string[], title: string): Section | null {
  let section: Section | null = null;
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    const marker = trimmed.startsWith("```") ? "```" : trimmed.startsWith("~~~") ? "~~~" : null;
    if (marker !== null) {
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (section === null) {
      if (trimmed === `## ${title}`) section = { heading: i, start: i + 1, end: lines.length };
    } else if (trimmed === "##" || trimmed.startsWith("## ")) {
      section.end = i;
      break;
    }
  }
  return section;
}

/** Lines with leading and trailing blank lines removed; `offset` is the index of `lines[0]`'s
 * first kept line, so the line number of `lines[i]` is `offset + i + 1`. */
function trimBlank(lines: string[], from = 0): { lines: string[]; offset: number } {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a]!.trim() === "") a += 1;
  while (b > a && lines[b - 1]!.trim() === "") b -= 1;
  return { lines: lines.slice(a, b), offset: from + a };
}

function sectionBody(readmeLines: string[], section: Section): { lines: string[]; offset: number } {
  return trimBlank(readmeLines.slice(section.start, section.end), section.start);
}

/** The 1-based line number of `index` in `text`. */
function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** `docs/measurements/…` paths inside one backtick span or one Markdown link target. */
function measurementPaths(segment: string, out: Set<string>): void {
  for (const match of segment.matchAll(/docs\/measurements\/[^\s'"`)]+/g)) {
    out.add(match[0].replace(/[.,;:!?]+$/, ""));
  }
}

export function checkSubmission(
  files: SubmissionFiles,
  limits: string[],
  exists: (path: string) => boolean,
): Failure[] {
  const failures: Failure[] = [];
  const fail = (file: string, line: number | null, rule: string, detail: string): void => {
    failures.push({ file, line, rule, detail });
  };
  const readmeLines = files.readme.split("\n");

  // 2.11 item 1: the three texts exist, are not empty and are within their limits.
  for (const key of TEXT_KEYS) {
    const text = files[key];
    if (text.trim() === "") {
      fail(FILE_NAME[key], null, "length", "the file is missing or holds no text");
      continue;
    }
    const count = [...text].length;
    if (count > TEXT_LIMIT[key]) {
      fail(FILE_NAME[key], null, "length", `${count} characters; the limit is ${TEXT_LIMIT[key]}`);
    }
  }

  // FL6: no priority claim in the README or any of the three texts.
  for (const key of ALL_KEYS) {
    const text = files[key];
    for (const phrase of PRIORITY_PHRASES) {
      for (const match of text.matchAll(phrasePattern(phrase))) {
        fail(FILE_NAME[key], lineAt(text, match.index), "FL6", `priority claim: "${phrase}"`);
      }
    }
  }

  // BP11 (c): "branch", "pull request" and "merge queue" only in vision.txt and in "## The idea".
  const idea = findSection(readmeLines, "The idea");
  if (idea === null) fail("README.md", null, "BP11", "missing section: ## The idea");
  for (const { word, pattern } of REPLACED_PATTERNS) {
    for (const match of files.readme.matchAll(pattern)) {
      const line = lineAt(files.readme, match.index);
      const insideIdea = idea !== null && line - 1 >= idea.heading && line - 1 < idea.end;
      if (!insideIdea) {
        fail(
          "README.md",
          line,
          "BP11",
          `"${word}" names what a change replaces: it belongs in ## The idea and docs/submission/vision.txt only`,
        );
      }
    }
    for (const key of ["run", "cloudflare"] as const) {
      for (const match of files[key].matchAll(pattern)) {
        fail(
          FILE_NAME[key],
          lineAt(files[key], match.index),
          "BP11",
          `"${word}" names what a change replaces: it belongs in ## The idea and docs/submission/vision.txt only`,
        );
      }
    }
  }

  // SC3: the body of "## Run it" is exactly run.txt, blank edges removed. A difference names the
  // first differing line.
  const runIt = findSection(readmeLines, "Run it");
  if (runIt === null) {
    fail("README.md", null, "SC3", "missing section: ## Run it");
  } else {
    const body = sectionBody(readmeLines, runIt);
    const expected = trimBlank(files.run.split("\n"));
    for (let i = 0; i < Math.max(body.lines.length, expected.lines.length); i += 1) {
      const actual = body.lines[i];
      const wanted = expected.lines[i];
      if (actual === wanted) continue;
      if (actual === undefined) {
        fail(
          FILE_NAME.run,
          expected.offset + i + 1,
          "SC3",
          `run.txt has a line that ## Run it does not: ${JSON.stringify(wanted)}`,
        );
      } else if (wanted === undefined) {
        fail(
          "README.md",
          body.offset + i + 1,
          "SC3",
          `## Run it has a line that run.txt does not: ${JSON.stringify(actual)}`,
        );
      } else {
        fail(
          "README.md",
          body.offset + i + 1,
          "SC3",
          `## Run it differs from run.txt (line ${expected.offset + i + 1}): ${JSON.stringify(actual)}`,
        );
      }
      break;
    }
  }

  // RY24 (8.7 way 3): run.txt holds exactly one line with an https:// address ending in /replay/hero.
  const replayLines = files.run.split("\n").flatMap((line, i) => (REPLAY_LINE.test(line) ? [i + 1] : []));
  if (replayLines.length === 0) {
    fail(FILE_NAME.run, null, "RY24", "no line holds an https:// address ending in /replay/hero");
  } else if (replayLines.length > 1) {
    fail(
      FILE_NAME.run,
      replayLines[1]!,
      "RY24",
      `${replayLines.length} lines hold an https:// address ending in /replay/hero; exactly one is required`,
    );
  }

  // AC19: "## Limits" is a bulleted list equal, item for item and in order, to limitsList(FEATURES).
  const limitsSection = findSection(readmeLines, "Limits");
  if (limitsSection === null) {
    fail("README.md", null, "AC19", "missing section: ## Limits");
  } else {
    const body = sectionBody(readmeLines, limitsSection);
    for (let i = 0; i < Math.max(body.lines.length, limits.length); i += 1) {
      const actual = body.lines[i];
      const wanted = limits[i];
      const line = body.offset + i + 1;
      if (actual === undefined) {
        fail("README.md", null, "AC19", `the list ends after ${i} item(s); limitsList(FEATURES) has ${limits.length}`);
        break;
      }
      if (wanted === undefined) {
        fail(
          "README.md",
          line,
          "AC19",
          `an item that limitsList(FEATURES) does not have: ${JSON.stringify(actual.trimEnd())}`,
        );
        break;
      }
      if (actual.trimEnd() !== `- ${wanted}`) {
        fail(
          "README.md",
          line,
          "AC19",
          actual.trimStart().startsWith("- ")
            ? `item ${i + 1} differs from limitsList(FEATURES): ${JSON.stringify(actual.trimEnd())}`
            : `not a "- " item: ${JSON.stringify(actual.trimEnd())}`,
        );
        break;
      }
    }
  }

  // 2.11 item 3: in "## Measured", a list item or table row that contains a digit names an existing
  // path under docs/measurements/ (a Markdown link target or backticks).
  const measured = findSection(readmeLines, "Measured");
  if (measured === null) {
    fail("README.md", null, "measured", "missing section: ## Measured");
  } else {
    for (let i = measured.start; i < measured.end; i += 1) {
      const line = readmeLines[i]!;
      const trimmed = line.trimStart();
      const isItem = /^[-*+] /.test(trimmed) || /^\d+\. /.test(trimmed);
      if (!/\d/.test(line) || (!isItem && !trimmed.startsWith("|"))) continue;
      const paths = new Set<string>();
      for (const match of line.matchAll(/`([^`]*)`/g)) measurementPaths(match[1]!, paths);
      for (const match of line.matchAll(/\]\(\s*([^)\s]+)/g)) measurementPaths(match[1]!, paths);
      if (![...paths].some(exists)) {
        fail(
          "README.md",
          i + 1,
          "measured",
          "a line with a number names no existing path under docs/measurements/ (2.11 item 3)",
        );
      }
    }
  }

  // SC2: "## Related work" names STORM, CoAgent and dibs.
  const related = findSection(readmeLines, "Related work");
  if (related === null) {
    fail("README.md", null, "SC2", "missing section: ## Related work");
  } else {
    const body = readmeLines.slice(related.start, related.end).join("\n");
    for (const name of ["STORM", "CoAgent", "dibs"]) {
      if (!new RegExp(`\\b${name}\\b`, "i").test(body)) {
        fail("README.md", related.heading + 1, "SC2", `## Related work does not name "${name}"`);
      }
    }
  }

  // SE14b: the README says whether the deployment uses a separate app host.
  if (!readmeLines.some((line) => line.toLowerCase().includes("separate app host"))) {
    fail("README.md", null, "SE14b", 'no line says whether the deployment uses a "separate app host"');
  }

  return failures;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function main(): number {
  const read = (name: keyof SubmissionFiles): string => {
    try {
      return readFileSync(join(repoRoot, FILE_NAME[name]), "utf8");
    } catch {
      return "";
    }
  };
  const files: SubmissionFiles = {
    readme: read("readme"),
    run: read("run"),
    vision: read("vision"),
    cloudflare: read("cloudflare"),
  };
  const failures = checkSubmission(files, limitsList(FEATURES), (path) => existsSync(join(repoRoot, path)));
  for (const failure of failures) {
    console.error(`${failure.file}:${failure.line ?? "-"}  ${failure.rule}  ${failure.detail}`);
  }
  if (failures.length > 0) {
    console.error(`check:submission: ${failures.length} failure(s).`);
    return 1;
  }
  console.log("check:submission: README.md and the three submission texts pass.");
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`check:submission: could not run: ${(error as Error).message}`);
    process.exitCode = 2;
  }
}
