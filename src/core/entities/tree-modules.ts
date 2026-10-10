// Python and Go modules (06-repos.md LG4, LG6 to LG8): the entities, regions, canonical forms and
// hashes of a tree-sitter syntax tree, and the names each entity uses (LG9 resolves them in
// `src/core/refs/by-name.ts`). The tree comes through the port of `./syntax.ts` and is turned into
// plain data before the port frees it.

import { H } from "../sync/h.ts";
import type { EntityKind } from "../../protocol/premise.ts";
import { withSyntaxTree, type SyntaxLanguage, type SyntaxNode } from "./syntax.ts";
import type { AstNode, Entity, ModuleInfo, Region } from "./entities.ts";
import { canon } from "./entities.ts";

/** The names one entity's nodes use (LG9): bare identifiers, and `object.attribute` pairs. */
export type NameUses = Readonly<{
  names: readonly string[];
  /** `[object, attribute]`: `object` is a name or a dotted chain of names (`a.b` in `a.b.c`). */
  attributes: ReadonlyArray<readonly [string, string]>;
}>;

/** What an import binds (LG9): a local name to a whole module (`imported` null) or to one name of it. */
export type ImportBinding = Readonly<{ module: string; imported: string | null }>;

/** The by-name data of a Python or Go module (LG4, LG9). */
export type SyntaxInfo = Readonly<{
  language: SyntaxLanguage;
  /** entity name -> the names its nodes use. */
  uses: ReadonlyMap<string, NameUses>;
  /** Python: local name -> what the module's top-level imports bind it to. */
  bindings: ReadonlyMap<string, ImportBinding>;
  /** import entity name -> what that statement imports (Python), for the entity's own references. */
  importTargets: ReadonlyMap<string, readonly ImportBinding[]>;
  /** Go: the top-level imports, path and alias (`null` without one). */
  goImports: ReadonlyArray<Readonly<{ path: string; alias: string | null }>>;
  /** Go: the name of the package clause, or null. */
  packageName: string | null;
  /** entity name -> the display form of `outline` (4.3). */
  signatures: ReadonlyMap<string, string>;
}>;

/** A Python or Go module that does not parse (2.1: opaque), with the first error's place (acorn's form). */
export class TreeSyntaxError extends Error {
  readonly loc: { line: number; column: number };
  constructor(message: string, loc: { line: number; column: number }) {
    super(message);
    this.name = "SyntaxError";
    this.loc = loc;
  }
}

// ---- LG8: the canonical form ----

/** The first `ERROR` or `MISSING` node, in source order, of a tree whose root has an error. */
function firstError(node: SyntaxNode): SyntaxNode | null {
  if (node.type === "ERROR" || node.isMissing) return node;
  if (!node.hasError) return null;
  for (const child of node.children) {
    const found = firstError(child);
    if (found !== null) return found;
  }
  return node;
}

/**
 * LG8: a node with children is `{type, children}`, a node without children is `{type, text}`;
 * comments are dropped. A node whose children leave source text other than whitespace uncovered,
 * and a Python `string_content` with an escape sequence inside, also keep their `text`, so that
 * every character that counts is in the form.
 */
function canonical(node: SyntaxNode, source: string): AstNode {
  const children = node.children;
  if (children.length === 0) return { type: node.type, text: node.text };
  // Inside a string every character counts, whitespace included.
  let covered = node.type !== "string_content";
  let at = node.startIndex;
  for (const child of children) {
    if (source.slice(at, child.startIndex).trim() !== "") covered = false;
    at = Math.max(at, child.endIndex);
  }
  if (source.slice(at, node.endIndex).trim() !== "") covered = false;
  const out = children.filter((child) => child.type !== "comment").map((child) => canonical(child, source));
  return covered ? { type: node.type, children: out } : { type: node.type, text: node.text, children: out };
}

// ---- the walk shared by both languages ----

type Working = { name: string; kind: EntityKind; nodes: AstNode[]; arity: number | null };

type Builder = {
  source: string;
  entities: Map<string, Working>;
  regions: Region[];
  uses: Map<string, { names: string[]; attributes: Array<readonly [string, string]> }>;
  signatures: Map<string, string>;
};

function contribute(
  b: Builder,
  names: string[],
  name: string,
  kind: EntityKind,
  node: AstNode,
  arity: number | null,
  usesOf: SyntaxNode | null,
  usesInto: (node: SyntaxNode, out: { names: string[]; attributes: Array<readonly [string, string]> }) => void,
  signature: string,
): void {
  let entity = b.entities.get(name);
  if (entity === undefined) {
    entity = { name, kind, nodes: [], arity };
    b.entities.set(name, entity);
    b.signatures.set(name, signature);
  }
  entity.nodes.push(node);
  if (!names.includes(name)) names.push(name);
  let uses = b.uses.get(name);
  if (uses === undefined) {
    uses = { names: [], attributes: [] };
    b.uses.set(name, uses);
  }
  if (usesOf !== null) usesInto(usesOf, uses);
}

function finish(b: Builder, extra: Omit<SyntaxInfo, "uses" | "signatures">, empty: boolean): ModuleInfo {
  if (empty) {
    // EN5: a module with no statements has exactly `(top)`, with no nodes.
    b.entities.set("(top)", { name: "(top)", kind: "top", nodes: [], arity: null });
    b.signatures.set("(top)", "(top)");
    b.uses.set("(top)", { names: [], attributes: [] });
    b.regions.push({ start: 0, end: b.source.length, names: ["(top)"] });
  }
  const entities: Entity[] = [...b.entities.values()].map((entity) => {
    const exports: string[] = []; // LG6, LG7: `exports` is [] for Python and Go
    const canonicalForm = canon({ exports, nodes: entity.nodes });
    return {
      name: entity.name,
      kind: entity.kind,
      exports,
      nodes: entity.nodes,
      canonical: canonicalForm,
      hash: H(canonicalForm),
      arity: entity.arity,
    };
  });
  const syntax: SyntaxInfo = { ...extra, uses: b.uses, signatures: b.signatures };
  return { entities, regions: b.regions, imports: new Map(), syntax };
}

/** The top-level statements of a module (comments are not statements; EN6 regions run between statements). */
function statementsOf(root: SyntaxNode): SyntaxNode[] {
  return root.children.filter((child) => child.type !== "comment");
}

function walkStatements(b: Builder, statements: SyntaxNode[], each: (statement: SyntaxNode, names: string[]) => void) {
  let previousEnd = 0;
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index]!;
    const names: string[] = [];
    each(statement, names);
    b.regions.push({
      start: previousEnd,
      end: index === statements.length - 1 ? b.source.length : statement.endIndex,
      names,
    });
    previousEnd = statement.endIndex;
  }
}

function newBuilder(source: string): Builder {
  return { source, entities: new Map(), regions: [], uses: new Map(), signatures: new Map() };
}

function parseTree(language: SyntaxLanguage, source: string, build: (root: SyntaxNode) => ModuleInfo): ModuleInfo {
  return withSyntaxTree(language, source, (root) => {
    if (root.hasError) {
      const error = firstError(root) ?? root;
      const what = error.isMissing ? `missing ${error.type}` : "unexpected token";
      const loc = { line: error.startPosition.row + 1, column: error.startPosition.column };
      throw new TreeSyntaxError(`${what} (${loc.line}:${loc.column})`, loc);
    }
    return build(root);
  });
}

// ---- LG6: Python ----

/** A dotted name (`a.b.c`) or a name, as written. */
function dottedText(node: SyntaxNode): string {
  return node.text.replace(/\s+/g, "");
}

/** The names an assignment target binds; attributes and subscripts bind none (LG6). */
function pythonTargetNames(node: SyntaxNode | null, out: string[]): void {
  if (node === null) return;
  switch (node.type) {
    case "identifier":
      out.push(node.text);
      return;
    case "pattern_list":
    case "tuple_pattern":
    case "list_pattern":
    case "list_splat_pattern":
    case "parenthesized_expression":
    case "tuple":
    case "list":
      for (const child of node.children) if (child.isNamed) pythonTargetNames(child, out);
      return;
    default:
      return;
  }
}

/** Every name an assignment statement binds: `a, b = …`, `a = b = …`, `a: T = …`, `a += …`. */
function pythonAssignedNames(expression: SyntaxNode): string[] {
  const names: string[] = [];
  let node: SyntaxNode | null = expression;
  while (node !== null && (node.type === "assignment" || node.type === "augmented_assignment")) {
    pythonTargetNames(node.childForFieldName("left"), names);
    const right: SyntaxNode | null = node.childForFieldName("right");
    node = right !== null && right.type === "assignment" ? right : null;
  }
  return [...new Set(names)];
}

const PYTHON_NOT_PARAMETERS = new Set(["keyword_separator", "positional_separator", "comment"]);

function pythonParameters(definition: SyntaxNode): string[] {
  const parameters = definition.childForFieldName("parameters");
  if (parameters === null) return [];
  const out: string[] = [];
  for (const child of parameters.children) {
    if (!child.isNamed || PYTHON_NOT_PARAMETERS.has(child.type)) continue;
    const name = child.type === "identifier" ? child : (firstIdentifier(child) ?? child);
    out.push(
      child.type === "list_splat_pattern"
        ? `*${name.text}`
        : child.type === "dictionary_splat_pattern"
          ? `**${name.text}`
          : name.text,
    );
  }
  return out;
}

function firstIdentifier(node: SyntaxNode): SyntaxNode | null {
  if (node.type === "identifier") return node;
  for (const child of node.children) {
    const found = firstIdentifier(child);
    if (found !== null) return found;
  }
  return null;
}

/** LG9's uses in Python: identifiers, except an attribute's name and a keyword argument's name. */
function pythonUses(node: SyntaxNode, out: { names: string[]; attributes: Array<readonly [string, string]> }): void {
  switch (node.type) {
    case "comment":
      return;
    case "identifier":
      out.names.push(node.text);
      return;
    case "attribute": {
      const object = node.childForFieldName("object");
      const attribute = node.childForFieldName("attribute");
      if (object !== null && attribute !== null && isNameChain(object)) {
        out.attributes.push([dottedText(object), attribute.text]);
      }
      if (object !== null) pythonUses(object, out);
      return;
    }
    case "keyword_argument": {
      const value = node.childForFieldName("value");
      if (value !== null) pythonUses(value, out);
      return;
    }
    default:
      for (const child of node.children) pythonUses(child, out);
  }
}

function isNameChain(node: SyntaxNode): boolean {
  if (node.type === "identifier") return true;
  if (node.type !== "attribute") return false;
  const object = node.childForFieldName("object");
  return object !== null && isNameChain(object);
}

/** The module an import statement names, as written: `a.b`, `.`, `.m`, `..p.q`. */
function pythonModuleName(node: SyntaxNode): string {
  return dottedText(node);
}

function parsePython(source: string): ModuleInfo {
  return parseTree("python", source, (root) => {
    const b = newBuilder(source);
    const bindings = new Map<string, ImportBinding>();
    const importTargets = new Map<string, ImportBinding[]>();
    const statements = statementsOf(root);
    const top = (statement: SyntaxNode, names: string[]) =>
      contribute(b, names, "(top)", "top", canonical(statement, source), null, statement, pythonUses, "(top)");
    const addImport = (statement: SyntaxNode, names: string[], module: string, target: ImportBinding) => {
      const name = `(import ${module})`;
      contribute(b, names, name, "import", canonical(statement, source), null, null, pythonUses, `import ${module}`);
      const targets = importTargets.get(name) ?? [];
      if (!targets.some((t) => t.module === target.module && t.imported === target.imported)) targets.push(target);
      importTargets.set(name, targets);
    };
    walkStatements(b, statements, (statement, names) => {
      switch (statement.type) {
        case "import_statement": {
          for (const child of statement.children) {
            if (child.type === "dotted_name") {
              const module = pythonModuleName(child);
              addImport(statement, names, module, { module, imported: null });
              // `import a.b` binds `a` (the package) and the chain `a.b`.
              const parts = module.split(".");
              for (let i = 1; i <= parts.length; i += 1) {
                const prefix = parts.slice(0, i).join(".");
                bindings.set(prefix, { module: prefix, imported: null });
              }
            } else if (child.type === "aliased_import") {
              const nameNode = child.childForFieldName("name");
              const alias = child.childForFieldName("alias");
              if (nameNode === null) continue;
              const module = pythonModuleName(nameNode);
              addImport(statement, names, module, { module, imported: null });
              if (alias !== null) bindings.set(alias.text, { module, imported: null });
            }
          }
          break;
        }
        case "import_from_statement":
        case "future_import_statement": {
          const moduleNode = statement.childForFieldName("module_name");
          const module =
            statement.type === "future_import_statement"
              ? "__future__"
              : moduleNode === null
                ? ""
                : pythonModuleName(moduleNode);
          let any = false;
          for (const child of statement.children) {
            if (moduleNode !== null && child.startIndex === moduleNode.startIndex) continue;
            if (child.type === "dotted_name") {
              const imported = child.text;
              addImport(statement, names, module, { module, imported });
              bindings.set(imported, { module, imported });
              any = true;
            } else if (child.type === "aliased_import") {
              const nameNode = child.childForFieldName("name");
              const alias = child.childForFieldName("alias");
              if (nameNode === null) continue;
              addImport(statement, names, module, { module, imported: nameNode.text });
              bindings.set(alias === null ? nameNode.text : alias.text, { module, imported: nameNode.text });
              any = true;
            }
          }
          // `from m import *` binds no name LG9 can follow; the statement is still m's import entity.
          if (!any) {
            const name = `(import ${module})`;
            contribute(
              b,
              names,
              name,
              "import",
              canonical(statement, source),
              null,
              null,
              pythonUses,
              `import ${module}`,
            );
            if (!importTargets.has(name)) importTargets.set(name, []);
          }
          break;
        }
        case "function_definition":
        case "class_definition":
        case "decorated_definition": {
          const definition =
            statement.type === "decorated_definition" ? statement.childForFieldName("definition") : statement;
          const nameNode = definition?.childForFieldName("name") ?? null;
          if (definition === null || nameNode === null) {
            top(statement, names);
            break;
          }
          const isFunction = definition.type === "function_definition";
          const parameters = isFunction ? pythonParameters(definition) : [];
          const isAsync = isFunction && definition.children[0]?.type === "async";
          contribute(
            b,
            names,
            nameNode.text,
            isFunction ? "function" : "class",
            canonical(statement, source),
            isFunction ? parameters.length : null,
            statement,
            pythonUses,
            isFunction
              ? `${isAsync ? "async " : ""}def ${nameNode.text}(${parameters.join(", ")})`
              : `class ${nameNode.text}`,
          );
          break;
        }
        case "type_alias_statement": {
          const left = statement.childForFieldName("left");
          const nameNode = left === null ? null : firstIdentifier(left);
          if (nameNode === null) top(statement, names);
          else
            contribute(
              b,
              names,
              nameNode.text,
              "type" as EntityKind,
              canonical(statement, source),
              null,
              statement,
              pythonUses,
              `type ${nameNode.text}`,
            );
          break;
        }
        case "expression_statement": {
          const expression = statement.children[0];
          const bound =
            expression !== undefined && (expression.type === "assignment" || expression.type === "augmented_assignment")
              ? pythonAssignedNames(expression)
              : [];
          if (bound.length === 0) top(statement, names);
          const node = bound.length === 0 ? null : canonical(statement, source);
          for (const name of bound) {
            contribute(b, names, name, "var", node!, null, statement, pythonUses, `${name} = …`);
          }
          break;
        }
        default:
          top(statement, names);
      }
    });
    return finish(
      b,
      { language: "python", bindings, importTargets, goImports: [], packageName: null },
      statements.length === 0,
    );
  });
}

// ---- LG7: Go ----

/** The receiver's type name of a method: `T` of `(r T)`, `(r *T)`, `(r T[K])`, `(T)`. */
function goReceiverType(receiver: SyntaxNode | null): string | null {
  if (receiver === null) return null;
  const find = (node: SyntaxNode): string | null => {
    if (node.type === "type_identifier") return node.text;
    if (node.type === "identifier" && node.isNamed) return null;
    for (const child of node.children) {
      if (child.type === "type_arguments" || child.type === "type_parameter_list") continue;
      const found = find(child);
      if (found !== null) return found;
    }
    return null;
  };
  for (const declaration of receiver.children) {
    if (declaration.type !== "parameter_declaration") continue;
    const type = declaration.childForFieldName("type");
    return type === null ? null : find(type);
  }
  return null;
}

/** Parameter names as written, `a, b int` counting two; an unnamed parameter is written `_`. */
function goParameters(list: SyntaxNode | null): string[] {
  if (list === null) return [];
  const out: string[] = [];
  for (const declaration of list.children) {
    if (declaration.type !== "parameter_declaration" && declaration.type !== "variadic_parameter_declaration") continue;
    const named = declaration.children.filter((child) => child.type === "identifier");
    if (named.length === 0) out.push("_");
    for (const name of named)
      out.push(declaration.type === "variadic_parameter_declaration" ? `...${name.text}` : name.text);
  }
  return out;
}

/** LG9's uses in Go: identifiers and type names; `package.Name` pairs from selectors and qualified types. */
function goUses(node: SyntaxNode, out: { names: string[]; attributes: Array<readonly [string, string]> }): void {
  switch (node.type) {
    case "comment":
      return;
    case "identifier":
    case "type_identifier":
      out.names.push(node.text);
      return;
    case "selector_expression": {
      const operand = node.childForFieldName("operand");
      const field = node.childForFieldName("field");
      if (operand !== null && field !== null && operand.type === "identifier") {
        out.attributes.push([operand.text, field.text]);
      }
      if (operand !== null) goUses(operand, out);
      return;
    }
    case "qualified_type": {
      const pkg = node.childForFieldName("package");
      const name = node.childForFieldName("name");
      if (pkg !== null && name !== null) out.attributes.push([pkg.text, name.text]);
      return;
    }
    default:
      for (const child of node.children) goUses(child, out);
  }
}

function goStringValue(literal: SyntaxNode): string {
  const text = literal.text;
  return text.length >= 2 ? text.slice(1, -1) : text;
}

function parseGo(source: string): ModuleInfo {
  return parseTree("go", source, (root) => {
    const b = newBuilder(source);
    const goImports: Array<{ path: string; alias: string | null }> = [];
    let packageName: string | null = null;
    const statements = statementsOf(root);
    const top = (node: SyntaxNode, names: string[]) =>
      contribute(b, names, "(top)", "top", canonical(node, source), null, node, goUses, "(top)");
    walkStatements(b, statements, (statement, names) => {
      switch (statement.type) {
        case "package_clause": {
          const name = statement.children.find((child) => child.type === "package_identifier");
          if (name !== undefined) packageName = name.text;
          top(statement, names);
          break;
        }
        case "import_declaration": {
          const specs: SyntaxNode[] = [];
          for (const child of statement.children) {
            if (child.type === "import_spec") specs.push(child);
            if (child.type === "import_spec_list")
              specs.push(...child.children.filter((c) => c.type === "import_spec"));
          }
          for (const spec of specs) {
            const pathNode = spec.childForFieldName("path");
            if (pathNode === null) continue;
            const path = goStringValue(pathNode);
            const aliasNode = spec.childForFieldName("name");
            goImports.push({ path, alias: aliasNode === null ? null : aliasNode.text });
            contribute(
              b,
              names,
              `(import ${path})`,
              "import",
              canonical(spec, source),
              null,
              null,
              goUses,
              `import "${path}"`,
            );
          }
          if (names.length === 0) top(statement, names);
          break;
        }
        case "function_declaration": {
          const name = statement.childForFieldName("name");
          if (name === null || name.text === "init") {
            top(statement, names); // LG7: `init` cannot be referred to, and a file may have several
            break;
          }
          const parameters = goParameters(statement.childForFieldName("parameters"));
          contribute(
            b,
            names,
            name.text,
            "function",
            canonical(statement, source),
            parameters.length,
            statement,
            goUses,
            `func ${name.text}(${parameters.join(", ")})`,
          );
          break;
        }
        case "method_declaration": {
          const name = statement.childForFieldName("name");
          const receiver = goReceiverType(statement.childForFieldName("receiver"));
          if (name === null || receiver === null) {
            top(statement, names);
            break;
          }
          const parameters = goParameters(statement.childForFieldName("parameters"));
          contribute(
            b,
            names,
            `${receiver}.${name.text}`,
            "method" as EntityKind,
            canonical(statement, source),
            parameters.length,
            statement,
            goUses,
            `func (${receiver}) ${name.text}(${parameters.join(", ")})`,
          );
          break;
        }
        case "type_declaration": {
          for (const spec of statement.children) {
            if (spec.type !== "type_spec" && spec.type !== "type_alias") continue;
            const name = spec.childForFieldName("name");
            if (name === null) continue;
            contribute(
              b,
              names,
              name.text,
              "type" as EntityKind,
              canonical(spec, source),
              null,
              spec,
              goUses,
              `type ${name.text}`,
            );
          }
          if (names.length === 0) top(statement, names);
          break;
        }
        case "const_declaration":
        case "var_declaration": {
          const kind: EntityKind = statement.type === "const_declaration" ? "const" : "var";
          const specType = kind === "const" ? "const_spec" : "var_spec";
          const specs: SyntaxNode[] = [];
          for (const child of statement.children) {
            if (child.type === specType) specs.push(child);
            if (child.type === "var_spec_list") specs.push(...child.children.filter((c) => c.type === specType));
          }
          // LG7: in a grouped `const`, a spec with no value repeats the last explicit type and value;
          // its canonical form carries them and its index in the group (the value of `iota`).
          let lastType: AstNode | null = null;
          let lastValue: AstNode | null = null;
          specs.forEach((spec, index) => {
            const typeNode = spec.childForFieldName("type");
            const valueNode = spec.childForFieldName("value");
            let node = canonical(spec, source);
            if (kind === "const") {
              if (valueNode !== null) {
                lastType = typeNode === null ? null : canonical(typeNode, source);
                lastValue = canonical(valueNode, source);
              } else {
                node = { ...node, repeated: { type: lastType, value: lastValue } };
              }
              node = { ...node, iota: index };
            }
            // The names come before the spec's type and value: `A, B T = …`.
            const before = (typeNode ?? valueNode)?.startIndex ?? Number.POSITIVE_INFINITY;
            const bound = spec.children
              .filter((child) => child.type === "identifier" && child.endIndex <= before)
              .map((child) => child.text)
              .filter((name) => name !== "_");
            if (bound.length === 0) {
              contribute(b, names, "(top)", "top", node, null, spec, goUses, "(top)");
              return;
            }
            for (const name of new Set(bound)) {
              contribute(b, names, name, kind, node, null, spec, goUses, `${kind} ${name}`);
            }
          });
          if (names.length === 0) top(statement, names);
          break;
        }
        default:
          top(statement, names);
      }
    });
    return finish(
      b,
      { language: "go", bindings: new Map(), importTargets: new Map(), goImports, packageName },
      statements.length === 0,
    );
  });
}

/** Parses a Python or Go module (LG6, LG7). Throws `TreeSyntaxError` when it does not parse. */
export function parseTreeModule(source: string, language: SyntaxLanguage): ModuleInfo {
  return language === "python" ? parsePython(source) : parseGo(source);
}
