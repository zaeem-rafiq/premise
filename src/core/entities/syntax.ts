// The syntax-tree port of the Python and Go modules (06-repos.md LG1: tree-sitter). The parser
// runs as WebAssembly and loads asynchronously, which the pure core may not do, so the shell loads
// it and installs one synchronous parse function here, once per isolate: the Worker in
// `src/worker/parsers/tree-sitter.ts`, the Node tests in `test/support/tree-sitter.ts`.
//
// Core sees only this structural type, never web-tree-sitter's own. It turns the tree into plain
// data inside `use`; the shell frees the tree when `use` returns.

/** The languages of LG1 that tree-sitter parses. */
export type SyntaxLanguage = "python" | "go";

/** A position in the source: `row` 0-based, `column` 0-based. */
export type SyntaxPoint = { readonly row: number; readonly column: number };

/** One node of a tree-sitter syntax tree, as much of it as core reads. */
export type SyntaxNode = {
  readonly type: string;
  readonly text: string;
  readonly isNamed: boolean;
  readonly isMissing: boolean;
  readonly hasError: boolean;
  readonly children: readonly SyntaxNode[];
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: SyntaxPoint;
  childForFieldName(name: string): SyntaxNode | null;
};

/** Parses `source` and hands the root to `use`; the tree lives only while `use` runs. */
export type SyntaxParser = <T>(language: SyntaxLanguage, source: string, use: (root: SyntaxNode) => T) => T;

let installed: SyntaxParser | null = null;

/** Installs the isolate's parser (`null` removes it). The shell calls it once, after loading tree-sitter. */
export function setSyntaxParser(parser: SyntaxParser | null): void {
  installed = parser;
}

/** True when a parser is installed. */
export function hasSyntaxParser(): boolean {
  return installed !== null;
}

/**
 * Parses with the installed parser. Throws when none is installed: the caller treats a module
 * that does not parse as opaque (2.1), so a shell that forgot to install one fails its tests.
 */
export function withSyntaxTree<T>(language: SyntaxLanguage, source: string, use: (root: SyntaxNode) => T): T {
  if (installed === null) throw new Error(`no syntax parser is installed for ${language}`);
  return installed(language, source, use);
}
