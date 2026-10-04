// Acorn-based checks the tidepool tests run on every seed module: TP5 export counts, TP6 text form,
// and the used-globals check of Appendix A row A8 (CK5, CK6). Parsed with `acorn` (a dependency),
// never executed and never guessed from text.

import { parse } from "acorn";

/** A syntax node. Every node has a `type`, character offsets, and (with `locations`) lines. */
export type Node = {
  type: string;
  start: number;
  end: number;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
  [key: string]: unknown;
};

/** The module's syntax tree. Throws, naming the file, when acorn reports an error. */
export function parseModule(path: string, text: string): Node {
  try {
    return parse(text, { ecmaVersion: "latest", sourceType: "module", locations: true }) as unknown as Node;
  } catch (error) {
    throw new Error(`${path}: does not parse: ${(error as Error).message}`);
  }
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

/** `visit` sees every child node of `node`, children first in field order. */
function childrenOf(node: Node): Node[] {
  const found: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "range") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) found.push(item);
    } else if (isNode(value)) {
      found.push(value);
    }
  }
  return found;
}

/** Calls `visit` for `node` and every descendant, parents before children. */
export function walk(node: Node, visit: (node: Node, parent: Node | null) => void): void {
  const descend = (current: Node, parent: Node | null): void => {
    visit(current, parent);
    for (const child of childrenOf(current)) descend(child, current);
  };
  descend(node, null);
}

/** The names a `VariableDeclaration` binds (its declarators' patterns). */
function patternNames(pattern: Node, into: string[]): void {
  switch (pattern.type) {
    case "Identifier":
      into.push(pattern.name as string);
      break;
    case "RestElement":
      patternNames(pattern.argument as Node, into);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left as Node, into);
      break;
    case "ArrayPattern":
      for (const item of (pattern.elements ?? []) as Array<Node | null>) {
        if (item !== null) patternNames(item, into);
      }
      break;
    case "ObjectPattern":
      for (const item of pattern.properties as Node[]) {
        if (item.type === "Property") patternNames(item.value as Node, into);
        else if (item.type === "RestElement") patternNames(item.argument as Node, into);
      }
      break;
    default:
      break;
  }
}

/** The names one declaration binds at its own level (`const`, `let`, `var`, function, class). */
export function declarationNames(declaration: Node): string[] {
  const names: string[] = [];
  switch (declaration.type) {
    case "VariableDeclaration":
      for (const declarator of declaration.declarations as Node[]) {
        patternNames(declarator.id as Node, names);
      }
      break;
    case "FunctionDeclaration":
    case "ClassDeclaration": {
      const id = declaration.id as Node | null;
      if (id !== null) names.push(id.name as string);
      break;
    }
    default:
      break;
  }
  return names;
}

/** Every name the module exports (TP5's "at most 12 exported names"). */
export function exportedNames(program: Node): string[] {
  const names: string[] = [];
  for (const statement of program.body as Node[]) {
    if (statement.type === "ExportNamedDeclaration") {
      if (isNode(statement.declaration)) names.push(...declarationNames(statement.declaration));
      for (const specifier of (statement.specifiers ?? []) as Node[]) {
        const exported = specifier.exported as Node;
        names.push((exported.name ?? exported.value) as string);
      }
    } else if (statement.type === "ExportDefaultDeclaration") {
      names.push("default");
    }
  }
  return names;
}

/** The import source strings of the module, each with its 1-based line. */
export function importSpecifiers(program: Node): Array<{ specifier: string; line: number }> {
  const found: Array<{ specifier: string; line: number }> = [];
  walk(program, (node) => {
    if (node.type === "ImportDeclaration" || node.type === "ImportExpression") {
      const source = node.source as Node;
      if (typeof source.value === "string") {
        found.push({ specifier: source.value, line: node.loc?.start.line ?? 0 });
      }
    }
  });
  return found;
}

/** True when `node` is an expression that always evaluates to a number (literal or arithmetic). */
export function isNumericExpression(node: Node): boolean {
  switch (node.type) {
    case "Literal":
      return typeof node.value === "number";
    case "Identifier":
      // A named constant stands for a number here (`ENERGY_MAX / 4`): what it holds is the name's business.
      return true;
    case "UnaryExpression":
      return (node.operator === "-" || node.operator === "+") && isNumericExpression(node.argument as Node);
    case "BinaryExpression":
      return isNumericExpression(node.left as Node) && isNumericExpression(node.right as Node);
    default:
      return false;
  }
}

/**
 * Every `export const NAME = <number>` of the module: name and 1-based start and end lines.
 * Only single-declarator const exports count as exported numbers.
 */
export function numericExports(program: Node): Array<{ name: string; startLine: number; endLine: number }> {
  const found: Array<{ name: string; startLine: number; endLine: number }> = [];
  for (const statement of program.body as Node[]) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = statement.declaration as Node | null;
    if (declaration === null || declaration.type !== "VariableDeclaration" || declaration.kind !== "const") {
      continue;
    }
    const declarators = declaration.declarations as Node[];
    const [declarator] = declarators;
    if (declarators.length !== 1 || declarator === undefined) continue;
    const init = declarator.init as Node | null;
    if ((declarator.id as Node).type !== "Identifier" || init === null || !isNumericExpression(init)) {
      continue;
    }
    found.push({
      name: (declarator.id as Node).name as string,
      startLine: statement.loc?.start.line ?? 0,
      endLine: statement.loc?.end.line ?? 0,
    });
  }
  return found;
}

// The statement types whose start-of-line position TP6's "one statement per line" applies to.
// A `BlockStatement` is not one: `{ a(); b(); }` is judged by the statements inside it.
const STATEMENTS = new Set([
  "ExpressionStatement",
  "VariableDeclaration",
  "FunctionDeclaration",
  "ClassDeclaration",
  "ReturnStatement",
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "TryStatement",
  "ThrowStatement",
  "SwitchStatement",
  "LabeledStatement",
  "BreakStatement",
  "ContinueStatement",
  "ImportDeclaration",
  "ExportNamedDeclaration",
  "ExportDefaultDeclaration",
  "ExportAllDeclaration",
]);

/**
 * Lines on which a statement begins only after another statement has already ended (TP6).
 * `if (x) return;` is one line holding one statement: the `return` starts before the `if` ends.
 */
export function crowdedLines(program: Node): number[] {
  const statements: Node[] = [];
  walk(program, (node) => {
    if (STATEMENTS.has(node.type)) statements.push(node);
  });
  statements.sort((a, b) => a.start - b.start);
  const crowded: number[] = [];
  let lastEnd = -1;
  let lastEndLine = -1;
  for (const statement of statements) {
    const line = statement.loc?.start.line ?? 0;
    if (statement.start > lastEnd && line === lastEndLine) crowded.push(line);
    if (statement.end > lastEnd) {
      lastEnd = statement.end;
      lastEndLine = statement.loc?.end.line ?? 0;
    }
  }
  return crowded;
}

type Scope = { names: Set<string>; parent: Scope | null; fn: boolean };

function childScope(parent: Scope, fn: boolean): Scope {
  return { names: new Set(), parent, fn };
}

function bind(scope: Scope, name: string, kind: string): void {
  let target = scope;
  if (kind === "var" || kind === "param") {
    while (!target.fn && target.parent !== null) target = target.parent;
  }
  target.names.add(name);
}

/** Binds only the names of a pattern: hoists use this; the declaration is visited again later. */
function bindPattern(scope: Scope, pattern: Node, kind: string): void {
  const names: string[] = [];
  patternNames(pattern, names);
  for (const name of names) bind(scope, name, kind);
}

/**
 * Binds the names declared directly in `statements` at `scope`: `let`, `const`, class and function
 * declarations (`var` is handled by `hoistVars`).
 */
function hoistBlockScope(statements: Node[], scope: Scope): void {
  const hoistOne = (declaration: Node | null): void => {
    if (declaration === null) return;
    switch (declaration.type) {
      case "VariableDeclaration": {
        const kind = declaration.kind as string;
        if (kind !== "var") {
          for (const declarator of declaration.declarations as Node[]) {
            bindPattern(scope, declarator.id as Node, kind);
          }
        }
        break;
      }
      case "FunctionDeclaration":
      case "ClassDeclaration":
        for (const name of declarationNames(declaration)) bind(scope, name, "block");
        break;
      default:
        break;
    }
  };
  for (const statement of statements) {
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers as Node[]) {
        bind(scope, (specifier.local as Node).name as string, "block");
      }
    } else if (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration") {
      hoistOne(statement.declaration as Node | null);
    } else {
      hoistOne(statement);
    }
  }
}

/** Descends `statements` for `var` declarations, without crossing a nested function boundary. */
function hoistVars(statements: Node[], scope: Scope): void {
  const descend = (node: Node): void => {
    // A `var` binds to its own function: a nested function's declarations stay inside it.
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      return;
    }
    if (node.type === "VariableDeclaration" && node.kind === "var") {
      for (const declarator of node.declarations as Node[]) {
        bindPattern(scope, declarator.id as Node, "var");
      }
      return;
    }
    for (const child of childrenOf(node)) descend(child);
  };
  for (const statement of statements) descend(statement);
}

/** The statement list of a function body (a block body, or the single expression of an arrow). */
function bodyStatements(body: Node): Node[] {
  return body.type === "BlockStatement" ? (body.body as Node[]) : [];
}

/**
 * The global names `program` uses free: identifiers bound by nothing in the module.
 * Lexical scope, hoisting and labels are modeled; property names and labels are not uses.
 */
export function usedGlobals(program: Node): string[] {
  const globals = new Set<string>();
  const labels = new Set<string>();

  /** `pattern` is a binding site: bind its names, visit its computed keys and default values. */
  const bindAndVisitPattern = (scope: Scope, pattern: Node, kind: string): void => {
    switch (pattern.type) {
      case "Identifier":
        bind(scope, pattern.name as string, kind);
        return;
      case "RestElement":
        bindAndVisitPattern(scope, pattern.argument as Node, kind);
        return;
      case "AssignmentPattern":
        bindAndVisitPattern(scope, pattern.left as Node, kind);
        visit(pattern.right as Node, scope);
        return;
      case "ArrayPattern":
        for (const item of (pattern.elements ?? []) as Array<Node | null>) {
          if (item !== null) bindAndVisitPattern(scope, item, kind);
        }
        return;
      case "ObjectPattern":
        for (const item of pattern.properties as Node[]) {
          if (item.type === "Property") {
            if (item.computed === true) visit(item.key as Node, scope);
            bindAndVisitPattern(scope, item.value as Node, kind);
          } else if (item.type === "RestElement") {
            bindAndVisitPattern(scope, item.argument as Node, kind);
          }
        }
        return;
      default:
        break;
    }
  };

  const visit = (node: Node, scope: Scope): void => {
    switch (node.type) {
      case "Program": {
        const inner = childScope(scope, true);
        hoistBlockScope(node.body as Node[], inner);
        hoistVars(node.body as Node[], inner);
        for (const statement of node.body as Node[]) visit(statement, inner);
        return;
      }
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        const inner = childScope(scope, true);
        bind(inner, "arguments", "param");
        if (node.type === "FunctionExpression" && isNode(node.id)) {
          bind(inner, (node.id as Node).name as string, "param");
        }
        hoistBlockScope(bodyStatements(node.body as Node), inner);
        hoistVars(bodyStatements(node.body as Node), inner);
        for (const param of node.params as Node[]) bindAndVisitPattern(inner, param, "param");
        if ((node.body as Node).type === "BlockStatement") {
          for (const statement of (node.body as Node).body as Node[]) visit(statement, inner);
        } else {
          visit(node.body as Node, inner);
        }
        return;
      }
      case "VariableDeclaration": {
        const kind = node.kind as string;
        for (const declarator of node.declarations as Node[]) {
          bindAndVisitPattern(scope, declarator.id as Node, kind);
          if (isNode(declarator.init)) visit(declarator.init as Node, scope);
        }
        return;
      }
      case "VariableDeclarator":
        if (isNode(node.init)) visit(node.init as Node, scope);
        return;
      case "BlockStatement": {
        const inner = childScope(scope, false);
        hoistBlockScope(node.body as Node[], inner);
        for (const statement of node.body as Node[]) visit(statement, inner);
        return;
      }
      case "SwitchStatement": {
        const inner = childScope(scope, false);
        const consequents = (node.cases as Node[]).flatMap((entry) => entry.consequent as Node[]);
        hoistBlockScope(consequents, inner);
        visit(node.discriminant as Node, inner);
        for (const entry of node.cases as Node[]) {
          if (isNode(entry.test)) visit(entry.test as Node, inner);
          for (const statement of entry.consequent as Node[]) visit(statement, inner);
        }
        return;
      }
      case "TryStatement":
        visit(node.block as Node, scope);
        if (isNode(node.handler)) visit(node.handler as Node, scope);
        if (isNode(node.finalizer)) visit(node.finalizer as Node, scope);
        return;
      case "CatchClause": {
        const inner = childScope(scope, false);
        if (isNode(node.param)) bindAndVisitPattern(inner, node.param as Node, "param");
        visit(node.body as Node, inner);
        return;
      }
      case "ForStatement": {
        const inner = childScope(scope, false);
        if (isNode(node.init)) {
          if ((node.init as Node).type === "VariableDeclaration") {
            const declaration = node.init as Node;
            for (const declarator of declaration.declarations as Node[]) {
              bindAndVisitPattern(inner, declarator.id as Node, declaration.kind as string);
              if (isNode(declarator.init)) visit(declarator.init as Node, inner);
            }
          } else {
            visit(node.init as Node, inner);
          }
        }
        if (isNode(node.test)) visit(node.test as Node, inner);
        if (isNode(node.update)) visit(node.update as Node, inner);
        visit(node.body as Node, inner);
        return;
      }
      case "ForInStatement":
      case "ForOfStatement": {
        const inner = childScope(scope, false);
        const left = node.left as Node;
        if (left.type === "VariableDeclaration") {
          for (const declarator of left.declarations as Node[]) {
            bindAndVisitPattern(inner, declarator.id as Node, left.kind as string);
          }
        } else {
          visit(left, inner);
        }
        visit(node.right as Node, inner);
        visit(node.body as Node, inner);
        return;
      }
      case "MemberExpression":
        visit(node.object as Node, scope);
        if (node.computed === true) visit(node.property as Node, scope);
        return;
      case "Property":
        if (node.computed === true) visit(node.key as Node, scope);
        visit(node.value as Node, scope);
        return;
      case "MethodDefinition":
      case "PropertyDefinition":
        if (node.computed === true) visit(node.key as Node, scope);
        if (isNode(node.value)) visit(node.value as Node, scope);
        return;
      case "LabeledStatement": {
        const name = (node.label as Node).name as string;
        labels.add(name);
        visit(node.body as Node, scope);
        labels.delete(name);
        return;
      }
      case "BreakStatement":
      case "ContinueStatement":
      case "ImportDeclaration":
      case "ExportAllDeclaration":
        return;
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration": {
        if (isNode(node.declaration)) visit(node.declaration as Node, scope);
        for (const specifier of (node.specifiers ?? []) as Node[]) {
          const local = specifier.local as Node;
          if (isNode(local) && local.type === "Identifier") {
            use(scope, local.name as string);
          }
        }
        return;
      }
      case "Identifier":
        use(scope, node.name as string);
        return;
      case "ThisExpression":
      case "Super":
      case "MetaProperty":
      case "Literal":
        return;
      default:
        for (const child of childrenOf(node)) visit(child, scope);
        return;
    }
  };

  function use(scope: Scope, name: string): void {
    let current: Scope | null = scope;
    while (current !== null) {
      if (current.names.has(name)) return;
      current = current.parent;
    }
    globals.add(name);
  }

  const root: Scope = { names: new Set(), parent: null, fn: true };
  visit(program, root);
  return [...globals].sort();
}
