// "No patterns built from input": docs/spec/04-build-plan.md 1.3, mechanism 4 (SQ1).
//
// No SQL text under src/core/trunk/ contains LIKE or GLOB. SQL text lives in string literals and in the
// text parts of template literals, so those are what is read. The words are matched in any letter case,
// because SQL keywords are. Test files are left out: their strings are test titles and expected values.

import { codeFilesUnder, isTestFile, lineOf, parse, readText, walk } from "../support/source.ts";

/** Where the rule holds. */
export const SQL_DIRECTORY = "src/core/trunk";

export type Finding = { file: string; line: number; word: string };

const PATTERN_WORD = /\b(LIKE|GLOB)\b/i;

/** The LIKE and GLOB words in the strings of one file's source text. `file` is its path from the repository root. */
export function findingsIn(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  walk(parse(file, text), (node) => {
    let content: string | null = null;
    if (node.type === "Literal" && typeof node.value === "string") {
      content = node.value;
    } else if (node.type === "TemplateElement") {
      content = (node.value as { raw: string }).raw;
    }
    const word = content === null ? null : PATTERN_WORD.exec(content);
    if (word !== null) {
      findings.push({ file, line: lineOf(text, node.start), word: word[0].toUpperCase() });
    }
  });
  return findings;
}

export function findingsUnder(root: string): Finding[] {
  return codeFilesUnder(root, SQL_DIRECTORY)
    .filter((file) => !isTestFile(file))
    .flatMap((file) => findingsIn(file, readText(root, file)));
}

export function format(findings: readonly Finding[]): string {
  return findings
    .map((finding) => `${finding.file}:${finding.line}  SQL text contains ${finding.word} (SQ1).`)
    .join("\n");
}
