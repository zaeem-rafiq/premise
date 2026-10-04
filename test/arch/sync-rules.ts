// "No waits, no clock, no chance": docs/spec/04-build-plan.md 1.3, mechanism 3 (SY1, SY2, FE2).
//
// The engine, the swarm patterns and the reducer are synchronous and deterministic. Time, ids and random
// numbers are arguments. The forbidden tokens are found in the syntax tree, so a word in a comment or in a
// string is not a finding, and a token cannot hide behind unusual spacing.

import { codeFilesUnder, identifierName, lineOf, memberName, parse, readText, walk } from "../support/source.ts";
import type { Node } from "../support/source.ts";

/** Where the rule holds. Test files in these directories are included. */
export const SYNC_DIRECTORIES = ["src/core", "src/swarm", "src/protocol/reducer"] as const;

export type Finding = { file: string; line: number; token: string };

const FORBIDDEN_NAMES = new Set(["Promise", "CompressionStream", "DecompressionStream", "setTimeout"]);

function isCallOf(callee: Node, object: string, property: string): boolean {
  return (
    callee.type === "MemberExpression" && identifierName(callee.object) === object && memberName(callee) === property
  );
}

/** The forbidden token a node stands for, or null. */
function tokenOf(node: Node): string | null {
  switch (node.type) {
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return node.async === true ? "async" : null;
    case "AwaitExpression":
      return "await";
    case "ForOfStatement":
      return node.await === true ? "await" : null;
    case "VariableDeclaration":
      return node.kind === "await using" ? "await" : null;
    case "Identifier":
      return typeof node.name === "string" && FORBIDDEN_NAMES.has(node.name) ? node.name : null;
    case "MemberExpression": {
      if (memberName(node) !== "subtle") return null;
      const object = node.object as Node;
      const onCrypto = identifierName(object) === "crypto" || memberName(object) === "crypto";
      return onCrypto ? "crypto.subtle" : null;
    }
    case "CallExpression": {
      const callee = node.callee as Node;
      if (identifierName(callee) === "fetch" || memberName(callee) === "fetch") return "fetch(";
      if (memberName(callee) === "then") return ".then(";
      if (isCallOf(callee, "Date", "now")) return "Date.now(";
      if (isCallOf(callee, "Math", "random")) return "Math.random(";
      return null;
    }
    case "NewExpression": {
      const bare = identifierName(node.callee) === "Date" && (node.arguments as unknown[]).length === 0;
      return bare ? "new Date()" : null;
    }
    default:
      return null;
  }
}

/** The forbidden tokens in one file's source text. `file` is its path from the repository root. */
export function findingsIn(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  walk(parse(file, text), (node) => {
    const token = tokenOf(node);
    if (token !== null) findings.push({ file, line: lineOf(text, node.start), token });
  });
  return findings;
}

export function findingsUnder(root: string): Finding[] {
  return SYNC_DIRECTORIES.flatMap((directory) => codeFilesUnder(root, directory)).flatMap((file) =>
    findingsIn(file, readText(root, file)),
  );
}

export function format(findings: readonly Finding[]): string {
  return findings
    .map((finding) => `${finding.file}:${finding.line}  \`${finding.token}\` is forbidden here (SY1, SY2, FE2).`)
    .join("\n");
}
