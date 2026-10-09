// "Components contain no text of their own": docs/spec/03-floor.md AC7 and CP1. Every string the
// Floor shows lives in the `copy` module; a component only asks for it by id.
//
// The rule reads the syntax tree of every component file (`.tsx` under src/floor, tests aside) and
// reports text a person would see or hear that the file wrote itself:
//   - JSX text with a letter in it;
//   - a string with a letter in it in an attribute that is shown or spoken: aria-label,
//     aria-description, aria-placeholder, aria-roledescription, aria-valuetext, alt, title,
//     placeholder and label;
//   - a string with a letter in it that a JSX expression renders as it stands: `{"text"}`, a branch
//     of `a ? "x" : "y"`, the right side of `a && "x"`, or the fixed part of a template literal.
// Left out on purpose: text without a letter (separators such as " · ", `&ldquo;` or brackets);
// every other attribute (class names, ids, keys, roles, types, data-* and test ids, href and src,
// ARIA states and references such as aria-hidden, aria-current or aria-labelledby, dir, tabIndex,
// SVG geometry); strings passed as arguments (`t("nav.about")` names a copy id, it does not show
// it); and `.ts` files, which build no markup.

import { codeFilesUnder, isTestFile, lineOf, parse, readText, walk } from "../support/source.ts";
import type { Node } from "../support/source.ts";

/** Where the rule holds. */
export const COMPONENT_DIRECTORY = "src/floor";

/** The attributes whose value is shown or spoken. */
export const VISIBLE_ATTRIBUTES = new Set([
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "alt",
  "title",
  "placeholder",
  "label",
]);

export type Finding = { file: string; line: number; text: string; where: string };

const LETTER = /\p{L}/u;

function hasLetter(text: string): boolean {
  return LETTER.test(text);
}

/** The characters of the HTML entities JSX text uses for punctuation. An entity not listed here
 * stays as written, so its name counts as letters and the text is reported. */
const ENTITY_CHARACTERS: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  bull: "\u2022",
  gt: ">",
  hellip: "\u2026",
  laquo: "\u00ab",
  ldquo: "\u201c",
  lsquo: "\u2018",
  lt: "<",
  mdash: "\u2014",
  middot: "\u00b7",
  nbsp: "\u00a0",
  ndash: "\u2013",
  quot: '"',
  raquo: "\u00bb",
  rdquo: "\u201d",
  rsquo: "\u2019",
  times: "\u00d7",
};

/** JSX text as the reader gets it: `&middot;` is "·", `&#8230;` is "…". */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (written, body: string) => {
    if (body.startsWith("#")) {
      const code = /^#x/i.test(body) ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : written;
    }
    return ENTITY_CHARACTERS[body.toLowerCase()] ?? written;
  });
}

/** The strings with a letter that an expression renders as it stands, with their nodes. */
function renderedStrings(node: Node | null | undefined): Array<{ node: Node; text: string }> {
  if (node === null || node === undefined) return [];
  switch (node.type) {
    case "Literal":
      return typeof node.value === "string" && hasLetter(node.value) ? [{ node, text: node.value }] : [];
    case "TemplateLiteral":
      return (node.quasis as Array<Node & { value: { cooked: string | null } }>)
        .filter((quasi) => hasLetter(quasi.value.cooked ?? ""))
        .map((quasi) => ({ node: quasi, text: quasi.value.cooked ?? "" }));
    case "ConditionalExpression":
      return [...renderedStrings(node.consequent as Node), ...renderedStrings(node.alternate as Node)];
    case "LogicalExpression":
      return renderedStrings(node.right as Node);
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
      return renderedStrings(node.expression as Node);
    default:
      return [];
  }
}

function attributeName(node: Node): string | null {
  const name = node.name as Node | undefined;
  if (name === undefined) return null;
  if (name.type === "JSXIdentifier" && typeof name.name === "string") return name.name;
  return null;
}

/** The text a component file holds of its own. `file` is its path from the repository root. */
export function findingsIn(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const add = (node: Node, value: string, where: string) =>
    findings.push({ file, line: lineOf(text, node.start), text: value.trim(), where });
  walk(parse(file, text), (node, parent) => {
    if (node.type === "JSXText") {
      const value = typeof node.value === "string" ? node.value : "";
      if (hasLetter(decodeEntities(value))) add(node, value, "JSX text");
      return;
    }
    if (node.type === "JSXAttribute") {
      const name = attributeName(node);
      if (name === null || !VISIBLE_ATTRIBUTES.has(name)) return;
      const value = node.value as Node | null;
      if (value === null) return;
      const strings =
        value.type === "JSXExpressionContainer" ? renderedStrings(value.expression as Node) : renderedStrings(value);
      for (const found of strings) add(found.node, found.text, `the ${name} attribute`);
      return;
    }
    if (node.type === "JSXExpressionContainer" && parent !== null && parent.type !== "JSXAttribute") {
      for (const found of renderedStrings(node.expression as Node)) add(found.node, found.text, "a JSX expression");
    }
  });
  return findings;
}

/** Every component file under src/floor: the `.tsx` files that are not tests. */
export function componentFiles(root: string): string[] {
  return codeFilesUnder(root, COMPONENT_DIRECTORY).filter((file) => file.endsWith(".tsx") && !isTestFile(file));
}

export function findingsUnder(root: string): Finding[] {
  return componentFiles(root).flatMap((file) => findingsIn(file, readText(root, file)));
}

export function format(findings: readonly Finding[]): string {
  return findings
    .map(
      (finding) =>
        `${finding.file}:${finding.line}  ${finding.where} holds its own text "${finding.text}"; move it to src/copy (AC7, CP1).`,
    )
    .join("\n");
}
