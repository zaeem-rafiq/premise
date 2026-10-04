// Module specifiers (6.1), the derived references of 6.2, the name lookup of 6.3, the referrers
// set of a `refs:` query (2.5) and the negative lookups of D1. Works over the entities of 2.3.

import { REEXPORT_DEPTH } from "../../protocol/constants.ts";
import { isModulePath, isPath } from "../keys/paths.ts";
import { moduleHash, parseModule } from "../entities/entities.ts";
import type { AstNode, ModuleInfo } from "../entities/entities.ts";

/** A specifier that does not start `./` or `../` is a bare or URL specifier (CK5 banned_import). */
export function isExternalSpecifier(specifier: string): boolean {
  return !(specifier.startsWith("./") || specifier.startsWith("../"));
}

/**
 * The path a relative specifier resolves to (6.1): joined on the directory of `fromPath`, with
 * `.` and `..` collapsed; null when the specifier is not relative, escapes the root, or resolves
 * to a string that is not a path.
 */
export function resolveSpecifier(fromPath: string, specifier: string): string | null {
  if (isExternalSpecifier(specifier)) return null;
  const base = fromPath.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") {
      if (base.length === 0) return null;
      base.pop();
    } else {
      base.push(segment);
    }
  }
  const path = base.join("/");
  return isPath(path) ? path : null;
}

/** One identifier in reference position (6.3): `member` is the `ns` in `ns.member`, else null. */
export type Reference = { name: string; member: string | null };

// ---- 6.3: names an entity refers to ----

const SKIP_KEYS = new Set(["loc", "range", "regex", "bigint"]);

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function isFunction(node: AstNode): boolean {
  return (
    node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression"
  );
}

function nameOf(node: AstNode | null | undefined): string {
  if (node === null || node === undefined) return "";
  if (node.type === "Identifier") return node.name as string;
  if (node.type === "Literal") return String(node.value);
  return "";
}

/** A scope: the names bound at this level plus, transitively, every enclosing level's. */
type Scope = Set<string>;

/** The names a pattern binds (declaration ids, destructuring patterns). */
function patternNames(pattern: AstNode | null | undefined, out: Scope): void {
  if (pattern === null || pattern === undefined) return;
  const node =
    pattern.type === "RestElement" || pattern.type === "AssignmentPattern"
      ? ((pattern.argument ?? pattern.left) as AstNode)
      : pattern;
  switch (node.type) {
    case "Identifier":
      out.add(node.name as string);
      return;
    case "ObjectPattern":
      for (const property of node.properties as AstNode[]) {
        patternNames(
          property.type === "RestElement" ? (property.argument as AstNode) : (property.value as AstNode),
          out,
        );
      }
      return;
    case "ArrayPattern":
      for (const element of node.elements as Array<AstNode | null>) patternNames(element, out);
      return;
    default:
      return;
  }
}

/**
 * The names one statement binds in its own statement list's scope (6.3): `let`, `const`, `class`,
 * `import` specifiers, and a function declaration directly inside.
 */
function blockBindings(node: AstNode, out: Scope): void {
  switch (node.type) {
    case "VariableDeclaration":
      if (node.kind !== "var") {
        for (const declarator of node.declarations as AstNode[]) patternNames(declarator.id as AstNode, out);
      }
      return;
    case "ClassDeclaration":
    case "FunctionDeclaration":
      patternNames(node.id as AstNode, out);
      return;
    case "ImportDeclaration":
      for (const specifier of node.specifiers as AstNode[]) patternNames(specifier.local as AstNode, out);
      return;
    default:
      return;
  }
}

/**
 * The `var` names a statement contributes to the enclosing var scope (6.3): every `var`
 * declaration inside, at any depth of blocks and statements, without crossing a nested function
 * boundary. Function declarations are block scope and are not collected here.
 */
function varNames(node: AstNode | null | undefined, out: Scope): void {
  if (node === null || node === undefined || isFunction(node)) return;
  if (node.type === "VariableDeclaration" && node.kind === "var") {
    for (const declarator of node.declarations as AstNode[]) patternNames(declarator.id as AstNode, out);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) continue;
    if (Array.isArray(value)) for (const item of value) varNames(isNode(item) ? item : null, out);
    else if (isNode(value)) varNames(value, out);
  }
}

/** The names `nodes`' identifiers in reference position produce (6.3). */
export function referencesIn(nodes: readonly AstNode[]): { names: Reference[]; importSpecifiers: string[] } {
  const names: Reference[] = [];
  const importSpecifiers: string[] = [];
  const bound = new WeakSet<AstNode>(); // nodes in binding or name position: never references

  const add = (node: AstNode, member: string | null): void => {
    names.push({ name: nameOf(node), member });
  };

  /**
   * The scope of a statement list that opens a var scope (a module's statements, a function
   * body): every `var` inside collected first, then the bindings declared directly in the list.
   */
  const varScopeOf = (statements: readonly AstNode[], outer: Scope): Scope => {
    const scope = new Set(outer);
    for (const statement of statements) varNames(statement, scope);
    for (const statement of statements) blockBindings(statement, scope);
    return scope;
  };

  /** A binding pattern: ids bind; computed keys and default values are reference position. */
  const visitPattern = (node: AstNode | null | undefined, scope: Scope): void => {
    if (node === null || node === undefined || bound.has(node)) return;
    if (node.type === "Identifier") {
      bound.add(node);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (SKIP_KEYS.has(key)) continue;
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visitPattern(item, scope);
        continue;
      }
      if (!isNode(value)) continue;
      if ((key === "key" && node.computed === true) || key === "right" || key === "init") {
        visit(value, scope);
      } else {
        visitPattern(value, scope);
      }
    }
  };

  /**
   * The left side of an assignment (6.3: a reference). A pattern here does not declare: every
   * name it holds is a reference; member expressions and computed/default expressions are too.
   */
  const visitAssignTarget = (node: AstNode | null | undefined, scope: Scope): void => {
    if (node === null || node === undefined || bound.has(node)) return;
    switch (node.type) {
      case "Identifier":
      case "MemberExpression":
        visit(node, scope);
        return;
      case "ObjectPattern":
        for (const property of node.properties as AstNode[]) {
          if (property.type === "RestElement") {
            visitAssignTarget(property.argument as AstNode, scope);
          } else {
            if (property.computed === true && isNode(property.key)) visit(property.key as AstNode, scope);
            visitAssignTarget(property.value as AstNode, scope);
          }
        }
        return;
      case "ArrayPattern":
        for (const element of node.elements as Array<AstNode | null>) visitAssignTarget(element, scope);
        return;
      case "RestElement":
        visitAssignTarget(node.argument as AstNode, scope);
        return;
      case "AssignmentPattern":
        visitAssignTarget(node.left as AstNode, scope);
        visit(node.right as AstNode, scope);
        return;
      default:
        visit(node, scope);
        return;
    }
  };

  const visit = (node: AstNode, scope: Scope): void => {
    if (bound.has(node)) return;
    bound.add(node);
    switch (node.type) {
      case "Identifier":
        if (!scope.has(node.name as string)) add(node, null);
        return;
      case "Literal":
      case "MetaProperty":
      case "ThisExpression":
      case "Super":
      case "DebuggerStatement":
      case "EmptyStatement":
      case "BreakStatement":
      case "ContinueStatement":
      case "ImportDeclaration":
      case "ImportSpecifier":
      case "ImportDefaultSpecifier":
      case "ImportNamespaceSpecifier":
      case "ExportAllDeclaration":
      case "ExportSpecifier":
        return;
      case "PrivateIdentifier":
        return;
      case "LabeledStatement":
        visit(node.body as AstNode, scope);
        return;
      case "ImportExpression": {
        const source = node.source as AstNode | undefined;
        if (source !== undefined && source.type === "Literal" && typeof source.value === "string") {
          importSpecifiers.push(source.value);
        } else if (source !== undefined) {
          visit(source, scope);
        }
        const options = node.options as AstNode | null | undefined;
        if (isNode(options)) visit(options, scope);
        return;
      }
      case "VariableDeclaration":
        for (const declarator of node.declarations as AstNode[]) {
          visitPattern(declarator.id as AstNode, scope);
          if (isNode(declarator.init)) visit(declarator.init as AstNode, scope);
        }
        return;
      case "VariableDeclarator": // the synthetic node of 2.3, inside a var entity's nodes
        visitPattern(node.id as AstNode, scope);
        if (isNode(node.init)) visit(node.init as AstNode, scope);
        return;
      case "ClassDeclaration":
      case "ClassExpression": {
        if (isNode(node.id)) bound.add(node.id as AstNode);
        if (isNode(node.superClass)) visit(node.superClass as AstNode, scope);
        const inner = new Set(scope);
        if (isNode(node.id)) patternNames(node.id as AstNode, inner); // a class binds its own name
        if (isNode(node.body)) visit(node.body as AstNode, inner);
        return;
      }
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration": {
        for (const specifier of (node.specifiers as AstNode[]) ?? []) bound.add(specifier);
        if (isNode(node.source)) bound.add(node.source as AstNode);
        if (isNode(node.declaration)) visit(node.declaration as AstNode, scope);
        return;
      }
      case "MemberExpression": {
        const object = node.object as AstNode;
        if (object.type === "Identifier" && node.computed !== true) {
          // `ns.member` or `a.b.c`: the member named is the one read directly on the object (6.3).
          let member: string | null = nameOf(node.property as AstNode);
          let inner = object;
          while (inner.type === "MemberExpression" && inner.computed !== true) {
            member = nameOf(inner.property as AstNode);
            inner = inner.object as AstNode;
          }
          if (inner.type === "Identifier") {
            bound.add(inner);
            bound.add(object);
            if (!scope.has(inner.name as string)) add(inner, member);
            return;
          }
          visit(inner, scope);
        } else {
          visit(object, scope);
        }
        if (node.computed === true && isNode(node.property)) visit(node.property as AstNode, scope);
        return;
      }
      case "AssignmentExpression": {
        // "The left side of an assignment is a reference" (6.3): a destructuring pattern here
        // does not declare; every name it holds is a reference.
        visitAssignTarget(node.left as AstNode, scope);
        visit(node.right as AstNode, scope);
        return;
      }
      case "BlockStatement":
      case "StaticBlock": {
        // Hoisted `var`s were collected when the enclosing var scope opened; a block's own
        // `let`/`const`/`class` and direct function declarations bind here (6.3).
        const inner = new Set(scope);
        for (const statement of node.body as AstNode[]) blockBindings(statement, inner);
        for (const statement of node.body as AstNode[]) visit(statement, inner);
        return;
      }
      case "ForStatement": {
        const inner = new Set(scope);
        const init = node.init as AstNode | null | undefined;
        if (isNode(init) && init.type === "VariableDeclaration" && init.kind !== "var") {
          for (const declarator of init.declarations as AstNode[]) {
            patternNames(declarator.id as AstNode, inner);
          }
        }
        if (isNode(init)) visit(init, inner);
        if (isNode(node.test)) visit(node.test as AstNode, inner);
        if (isNode(node.update)) visit(node.update as AstNode, inner);
        if (isNode(node.body)) visit(node.body as AstNode, inner);
        return;
      }
      case "ForInStatement":
      case "ForOfStatement": {
        const inner = new Set(scope);
        const left = node.left as AstNode;
        if (left.type === "VariableDeclaration") {
          if (left.kind !== "var") {
            for (const declarator of left.declarations as AstNode[]) {
              patternNames(declarator.id as AstNode, inner);
            }
          }
        } else {
          visitAssignTarget(left, scope); // a for-of on an existing name or pattern references it
        }
        visit(node.right as AstNode, scope);
        visit(node.body as AstNode, inner);
        return;
      }
      case "CatchClause": {
        const inner = new Set(scope);
        patternNames(node.param as AstNode | null, inner);
        visit(node.body as AstNode, inner);
        return;
      }
      case "SwitchStatement": {
        visit(node.discriminant as AstNode, scope);
        const cases = node.cases as AstNode[];
        const inner = new Set(scope);
        for (const switchCase of cases) {
          for (const statement of switchCase.consequent as AstNode[]) blockBindings(statement, inner);
        }
        for (const switchCase of cases) {
          if (isNode(switchCase.test)) visit(switchCase.test as AstNode, inner);
          for (const statement of switchCase.consequent as AstNode[]) visit(statement, inner);
        }
        return;
      }
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        const vars = new Set(scope);
        for (const param of node.params as AstNode[]) patternNames(param, vars);
        if (node.type === "FunctionExpression") patternNames(node.id as AstNode | null, vars); // named expression (6.3)
        if (node.type !== "ArrowFunctionExpression") vars.add("arguments"); // 6.3
        const body = node.body as AstNode;
        if (body.type === "BlockStatement") {
          const fnScope = varScopeOf(body.body as AstNode[], vars);
          for (const statement of body.body as AstNode[]) visit(statement, fnScope);
        } else {
          visit(body, vars); // an arrow's expression body
        }
        return;
      }
      case "ObjectExpression": {
        for (const property of node.properties as AstNode[]) {
          if (property.type === "SpreadElement") {
            visit(property.argument as AstNode, scope);
            continue;
          }
          if (property.computed === true && isNode(property.key)) visit(property.key as AstNode, scope);
          const value = property.value as AstNode;
          if (property.shorthand === true && !scope.has(value.name as string)) add(value, null);
          else visit(value, scope);
        }
        return;
      }
      case "MethodDefinition":
      case "PropertyDefinition":
      case "AccessorProperty": {
        if (node.computed === true && isNode(node.key)) visit(node.key as AstNode, scope);
        if (isNode(node.value)) visit(node.value as AstNode, scope);
        return;
      }
      case "ParenthesizedExpression":
        visit(node.expression as AstNode, scope);
        return;
      default:
        break;
    }
    for (const [key, value] of Object.entries(node)) {
      if (SKIP_KEYS.has(key)) continue;
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item, scope);
      } else if (isNode(value)) {
        visit(value, scope);
      }
    }
  };

  const topScope = varScopeOf(nodes, new Set());
  for (const node of nodes) visit(node, topScope);
  return { names, importSpecifiers };
}

// ---- 6.2: module-level resolution ----

type ResolveOut = { hops: Set<string>; negatives: Set<string> };

/**
 * `resolveExport(T, x)` (6.2): the entity of module `T` whose export names contain `x`, following
 * re-export hops (bounded by `REEXPORT_DEPTH`) and `export *` modules. Records hop keys in
 * `out.hops` and intermediate `T#x` misses in `out.negatives`.
 */
function resolveExport(
  T: string,
  x: string,
  modules: ReadonlyMap<string, ModuleInfo>,
  depth: number,
  seen: Set<string>,
  out: ResolveOut,
): string | null {
  if (depth > REEXPORT_DEPTH) return null;
  const key = `${T}#${x}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const info = modules.get(T);
  if (info === undefined) return null;
  for (const entity of info.entities) {
    if (!entity.exports.includes(x)) continue;
    if (entity.kind === "reexport") {
      out.hops.add(key);
      const node = entity.nodes[0]!;
      const T2 = resolveSpecifier(T, String(node.source));
      if (T2 === null) return null;
      if (node.imported === "*") return T2; // `export * as ns`: the whole module
      return resolveExport(T2, String(node.imported), modules, depth + 1, seen, out);
    }
    return key;
  }
  if (x !== "default") {
    for (const entity of info.entities) {
      if (entity.kind !== "reexport-all") continue;
      const T2 = resolveSpecifier(T, String(entity.nodes[0]!.source));
      if (T2 === null) continue;
      const found = resolveExport(T2, x, modules, depth + 1, seen, out);
      if (found !== null) {
        out.hops.add(`${T}#${entity.name}`);
        out.negatives.add(key);
        return found;
      }
    }
  }
  return null;
}

/** The entity keys a referring entity's reference to `T` produces (named or `default`). */
export type Analysis = {
  /** path -> parsed module, for every module that parses; an opaque module is absent (2.1). */
  modules: Map<string, ModuleInfo>;
  /** entity key -> every key it refers to (R of 6.2). */
  refs: Map<string, Set<string>>;
  /** entity key -> the free global names it uses (G of 6.2; CK6 and CK7 read it). */
  globals: Map<string, Set<string>>;
  /** entity key -> every `T#x` recorded as a negative lookup on its path to a result (D1). */
  negatives: Map<string, Set<string>>;
  /** `{ from, to }`: a `T#x` that nothing resolved (D1). */
  unresolved: Array<{ from: string; to: string }>;
  /** `{ from, specifier }`: a bare or URL specifier (CK5 banned_import). */
  banned: Array<{ from: string; specifier: string }>;
};

const TOP_LEVEL = new Set(["function", "class", "const", "let", "var", "value"]);

/**
 * The reference tables of 6.2 for `files` (path -> content): R(E), G(E), the unresolved and
 * banned lists, and the negative lookups. Only files that are modules and parse take part.
 */
export function analyse(files: ReadonlyMap<string, string>): Analysis {
  const modules = new Map<string, ModuleInfo>();
  for (const [path, content] of files) {
    if (!isModulePath(path)) continue;
    try {
      modules.set(path, parseModule(content));
    } catch {
      // a module that does not parse is opaque (2.1): it has no entities and exports nothing
    }
  }
  const refs = new Map<string, Set<string>>();
  const globals = new Map<string, Set<string>>();
  const negatives = new Map<string, Set<string>>();
  const unresolved: Array<{ from: string; to: string }> = [];
  const banned: Array<{ from: string; specifier: string }> = [];

  for (const [path, info] of modules) {
    const topLevel = new Set(info.entities.filter((entity) => TOP_LEVEL.has(entity.kind)).map((e) => e.name));
    const addNamed = (from: string, specifier: string, imported: string): void => {
      const T = resolveSpecifier(path, specifier);
      if (T === null) {
        if (isExternalSpecifier(specifier)) banned.push({ from, specifier });
        else unresolved.push({ from, to: `${specifier}#${imported}` });
        return;
      }
      const out: ResolveOut = { hops: new Set(), negatives: new Set() };
      const found = resolveExport(T, imported, modules, 0, new Set(), out);
      for (const hop of out.hops) refs.get(from)!.add(hop);
      for (const negative of out.negatives) negatives.get(from)!.add(negative);
      if (found === null) unresolved.push({ from, to: `${T}#${imported}` });
      else refs.get(from)!.add(found);
    };
    const addModule = (from: string, specifier: string): void => {
      const T = resolveSpecifier(path, specifier);
      if (T === null) {
        if (isExternalSpecifier(specifier)) banned.push({ from, specifier });
        else unresolved.push({ from, to: specifier });
        return;
      }
      refs.get(from)!.add(T);
    };

    for (const entity of info.entities) {
      const from = `${path}#${entity.name}`;
      refs.set(from, new Set());
      globals.set(from, new Set());
      negatives.set(from, new Set());
      if (entity.kind === "import") {
        for (const node of entity.nodes) {
          const specifier = nameOf(node.source as AstNode);
          for (const specifierNode of node.specifiers as AstNode[]) {
            if (specifierNode.type === "ImportSpecifier") {
              addNamed(from, specifier, nameOf(specifierNode.imported as AstNode));
            } else if (specifierNode.type === "ImportDefaultSpecifier") {
              addNamed(from, specifier, "default");
            } else {
              addModule(from, specifier); // a namespace import references the whole module
            }
          }
        }
      } else if (entity.kind === "reexport" || entity.kind === "reexport-all") {
        const node = entity.nodes[0]!;
        if (entity.kind === "reexport-all" || node.imported === "*") addModule(from, String(node.source));
        else addNamed(from, String(node.source), String(node.imported));
      } else {
        const { names, importSpecifiers } = referencesIn(entity.nodes);
        for (const specifier of importSpecifiers) addModule(from, specifier);
        for (const { name, member } of names) {
          if (topLevel.has(name)) {
            if (name !== entity.name) refs.get(from)!.add(`${path}#${name}`); // never refers to itself (6.3)
            continue;
          }
          const binding = info.imports.get(name);
          if (binding === undefined) {
            globals.get(from)!.add(name);
          } else if (binding.imported === "*") {
            if (member === null) addModule(from, binding.source);
            else addNamed(from, binding.source, member);
          } else {
            addNamed(from, binding.source, binding.imported);
          }
        }
      }
    }
  }
  return { modules, refs, globals, negatives, unresolved, banned };
}

/**
 * The referrers of a `refs:` query (2.5): every entity key `F` such that `key` or its module's
 * path is in R(F), excluding the entity itself, sorted.
 */
export function referrersOf(key: string, refs: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const path = key.slice(0, key.indexOf("#"));
  const out: string[] = [];
  for (const [from, targets] of refs) {
    if (from === key) continue;
    if (targets.has(key) || targets.has(path)) out.push(from);
  }
  return out.sort();
}

/**
 * The members of a `refs:` query (2.5): the sorted referrer keys plus one `<path>@<module hash>`
 * per module that holds at least one referrer.
 */
export function refsMembers(key: string, analysis: Analysis): string[] {
  const referrers = referrersOf(key, analysis.refs);
  const modules = new Map<string, string>();
  for (const referrer of referrers) {
    const path = referrer.slice(0, referrer.indexOf("#"));
    if (!modules.has(path)) {
      const info = analysis.modules.get(path);
      if (info !== undefined) modules.set(path, moduleHash(info));
    }
  }
  return [...referrers, ...[...modules.entries()].map(([path, hash]) => `${path}@${hash}`)].sort();
}
