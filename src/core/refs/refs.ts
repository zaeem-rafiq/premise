// Module specifiers (6.1 and LG3), the derived references of 6.2, the name lookup of 6.3, the
// referrers set of a `refs:` query (2.5) and the negative lookups of D1. Works over the entities
// of 2.3 and the TypeScript rows of LG2.

import { REEXPORT_DEPTH } from "../../protocol/constants.ts";
import { isPath, languageOfPath, TIDEPOOL_LANGUAGES } from "../keys/paths.ts";
import type { LanguageSet } from "../keys/paths.ts";
import { moduleHash, parseModule } from "../entities/entities.ts";
import type { AstNode, ModuleInfo } from "../entities/entities.ts";
import { addByNameRefs } from "./by-name.ts";

/** A specifier that does not start `./` or `../` is a bare or URL specifier (CK5 banned_import). */
export function isExternalSpecifier(specifier: string): boolean {
  return !(specifier.startsWith("./") || specifier.startsWith("../"));
}

/**
 * The path a relative specifier resolves to (6.1, LG3): joined on the directory of `fromPath`,
 * with `.` and `..` collapsed; null when the specifier is not relative, escapes the root, or
 * resolves to a string that is not a path.
 *
 * Under the tide-pool set no extension is added, as in 6.1. Under `IMPORT_LANGUAGES` the steps of
 * LG3 run in order against `files` (the paths that exist): the exact path; the path with
 * `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.mjs` appended; a `.js`/`.mjs`/`.cjs` ending replaced by
 * `.ts`, `.mts`, `.cts`; the path as a directory with `index.ts`, `index.tsx`, `index.js`.
 * When no candidate exists, or `files` is not given, the joined path is the answer, as before.
 */
export function resolveSpecifier(
  fromPath: string,
  specifier: string,
  languages: LanguageSet = TIDEPOOL_LANGUAGES,
  files?: ReadonlySet<string>,
): string | null {
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
  if (!isPath(path)) return null;
  if (files === undefined) return path;
  if (files.has(path)) return path;
  const candidates: string[] = [];
  for (const extension of languages.resolveAppend) candidates.push(`${path}${extension}`);
  for (const [ending, replacements] of Object.entries(languages.resolveReplace)) {
    if (!path.endsWith(ending)) continue;
    for (const replacement of replacements) {
      candidates.push(`${path.slice(0, -ending.length)}${replacement}`);
    }
  }
  for (const index of languages.resolveIndex) candidates.push(`${path}/${index}`);
  for (const candidate of candidates) {
    if (files.has(candidate)) return candidate;
  }
  return path;
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
  if (node.type === "Identifier" || node.type === "JSXIdentifier") return node.name as string;
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
    case "TSDeclareFunction":
    case "TSTypeAliasDeclaration":
    case "TSInterfaceDeclaration":
    case "TSEnumDeclaration":
    case "TSModuleDeclaration":
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
export function referencesIn(nodes: readonly AstNode[]): {
  names: Reference[];
  importSpecifiers: string[];
  typeImports: { specifier: string; imported: string | null }[];
} {
  const names: Reference[] = [];
  const importSpecifiers: string[] = [];
  const typeImports: { specifier: string; imported: string | null }[] = [];
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

  /**
   * The type parameters of a declaration (`<A extends B, C = D>`): the names bind in the
   * declaration's scope; constraints and defaults are type positions (LG3 references).
   */
  const withTypeParams = (node: AstNode, scope: Scope): Scope => {
    const tp = node.typeParameters as AstNode | undefined;
    if (!isNode(tp) || !Array.isArray(tp.params)) return scope;
    const inner = new Set(scope);
    for (const param of tp.params as AstNode[]) {
      const paramName = param.name;
      if (typeof paramName === "string") inner.add(paramName);
      else if (isNode(paramName)) inner.add(nameOf(paramName));
    }
    for (const param of tp.params as AstNode[]) {
      if (isNode(param.constraint)) visit(param.constraint as AstNode, inner);
      if (isNode(param.default)) visit(param.default as AstNode, inner);
    }
    return inner;
  };

  /**
   * The type annotations inside a binding pattern (LG3): `x: T`, `{ a }: T`, `...rest: T[]`.
   * Names bind and default values stay unsearched, exactly as for JavaScript parameters.
   */
  const visitPatternTypes = (node: AstNode | null | undefined, scope: Scope): void => {
    if (node === null || node === undefined || bound.has(node)) return;
    if (node.type.startsWith("TS")) {
      visit(node, scope);
      return;
    }
    if (isNode(node.typeAnnotation)) visit(node.typeAnnotation as AstNode, scope);
    switch (node.type) {
      case "Identifier":
        bound.add(node);
        return;
      case "ObjectPattern":
        for (const property of node.properties as AstNode[]) {
          visitPatternTypes(
            property.type === "RestElement" ? (property.argument as AstNode) : (property.value as AstNode),
            scope,
          );
        }
        return;
      case "ArrayPattern":
        for (const element of node.elements as Array<AstNode | null>) visitPatternTypes(element, scope);
        return;
      case "RestElement":
      case "AssignmentPattern":
        visitPatternTypes((node.argument ?? node.left) as AstNode, scope);
        return;
      default:
        return;
    }
  };

  /** A binding pattern: ids bind; computed keys and default values are reference position. */
  const visitPattern = (node: AstNode | null | undefined, scope: Scope): void => {
    if (node === null || node === undefined || bound.has(node)) return;
    if (node.type.startsWith("TS")) {
      visit(node, scope);
      return;
    }
    if (node.type === "Identifier") {
      bound.add(node);
      if (isNode(node.typeAnnotation)) visit(node.typeAnnotation as AstNode, scope); // `x: T` (LG3)
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
        for (const heritage of (node.implements as AstNode[] | undefined) ?? []) {
          if (isNode(heritage)) visit(heritage, scope); // `implements I` is a type position (LG3)
        }
        for (const key of ["superTypeParameters", "superTypeArguments"] as const) {
          const args = node[key];
          if (isNode(args)) visit(args, scope);
        }
        const inner = withTypeParams(node, new Set(scope));
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
      case "ArrowFunctionExpression":
      case "TSDeclareFunction": {
        const vars = new Set(scope);
        for (const param of node.params as AstNode[]) patternNames(param, vars);
        if (node.type === "FunctionExpression") patternNames(node.id as AstNode | null, vars); // named expression (6.3)
        if (node.type !== "ArrowFunctionExpression") vars.add("arguments"); // 6.3
        const typed = withTypeParams(node, vars); // `<T>` binds T; its constraints are references
        const body = node.body as AstNode | null | undefined;
        if (isNode(body) && body.type === "BlockStatement") {
          const fnScope = varScopeOf(body.body as AstNode[], typed);
          for (const statement of body.body as AstNode[]) visit(statement, fnScope);
        } else if (isNode(body)) {
          visit(body, typed); // an arrow's expression body
        }
        for (const param of node.params as AstNode[]) visitPatternTypes(param, typed); // `x: T` (LG3)
        if (isNode(node.returnType)) visit(node.returnType as AstNode, typed);
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
        const inner = withTypeParams(node, scope);
        if (node.computed === true && isNode(node.key)) visit(node.key as AstNode, inner);
        if (isNode(node.typeAnnotation)) visit(node.typeAnnotation as AstNode, inner); // `field: T`
        if (isNode(node.value)) visit(node.value as AstNode, inner);
        return;
      }
      // The member signatures of an interface or a type literal, a `declare`d method, and the
      // function types `(x: T) => R`: names and parameter names bind; keys are members unless
      // computed; annotations and heritage are references (LG3).
      case "TSPropertySignature":
      case "TSMethodSignature":
      case "TSIndexSignature":
      case "TSCallSignatureDeclaration":
      case "TSConstructSignatureDeclaration":
      case "TSFunctionType":
      case "TSConstructorType":
      case "TSDeclareMethod": {
        const inner = withTypeParams(node, scope);
        for (const [key, value] of Object.entries(node)) {
          if (SKIP_KEYS.has(key) || key === "typeParameters") continue;
          if (key === "key") {
            if (node.computed === true && isNode(value)) visit(value, inner);
            continue;
          }
          if (key === "params" || key === "parameters") {
            for (const param of (value as Array<AstNode | null>) ?? []) {
              if (isNode(param)) visitPattern(param, inner);
            }
            continue;
          }
          if (Array.isArray(value)) {
            for (const item of value) if (isNode(item)) visit(item, inner);
            continue;
          }
          if (isNode(value)) visit(value, inner);
        }
        return;
      }
      // The TypeScript declaration rows of LG2 inside an entity: the name binds; everything
      // else (heritage, members, initializers, module bodies) is searched (6.3).
      case "TSTypeAliasDeclaration":
      case "TSInterfaceDeclaration":
      case "TSEnumDeclaration":
      case "TSModuleDeclaration": {
        const inner = withTypeParams(node, new Set(scope));
        const id = node.id as AstNode | null | undefined;
        if (isNode(id)) {
          bound.add(id);
          const declared = nameOf(id);
          if (declared !== "") inner.add(declared);
        }
        for (const [key, value] of Object.entries(node)) {
          if (SKIP_KEYS.has(key) || key === "id" || key === "typeParameters") continue;
          if (Array.isArray(value)) {
            for (const item of value) if (isNode(item)) visit(item, inner);
            continue;
          }
          if (isNode(value)) visit(value, inner);
        }
        return;
      }
      case "TSEnumMember": {
        if (node.computed === true && isNode(node.id)) visit(node.id as AstNode, scope);
        if (isNode(node.initializer)) visit(node.initializer as AstNode, scope);
        return;
      }
      // `ns.Type` in a type position resolves like `ns.prop`: the leftmost name is the
      // reference and the segment after it is the member read on it (LG3, 6.3).
      case "TSQualifiedName": {
        let member: string | null = nameOf(node.right as AstNode);
        let inner = node.left as AstNode;
        while (inner.type === "TSQualifiedName") {
          member = nameOf(inner.right as AstNode);
          inner = inner.left as AstNode;
        }
        if (inner.type === "Identifier") {
          bound.add(inner);
          if (!scope.has(inner.name as string)) add(inner, member);
        } else {
          visit(inner, scope);
        }
        return;
      }
      // `import("./x.ts")` is a whole-module reference, like a dynamic import;
      // `import("./x.ts").T` reads T from that module (6.2, LG3).
      case "TSImportType": {
        const argument = node.argument as AstNode | undefined;
        if (isNode(argument) && argument.type === "Literal" && typeof argument.value === "string") {
          let qualifier = node.qualifier as AstNode | undefined;
          let imported: string | null = null;
          if (isNode(qualifier)) {
            while (isNode(qualifier) && qualifier.type === "TSQualifiedName") {
              qualifier = qualifier.left as AstNode;
            }
            imported = isNode(qualifier) && qualifier.type === "Identifier" ? nameOf(qualifier) : null;
          }
          typeImports.push({ specifier: argument.value, imported });
        }
        for (const [key, value] of Object.entries(node)) {
          if (SKIP_KEYS.has(key) || key === "argument" || key === "qualifier") continue;
          if (Array.isArray(value)) {
            for (const item of value) if (isNode(item)) visit(item, scope);
            continue;
          }
          if (isNode(value)) visit(value, scope);
        }
        return;
      }
      case "ParenthesizedExpression":
        visit(node.expression as AstNode, scope);
        return;
      // JSX (LG3): a capitalized element name or a member name is a name read like any other;
      // a lowercase or namespaced name is a tag, not a binding. The closing tag repeats the
      // same name and is skipped.
      case "JSXElement": {
        visit(node.openingElement as AstNode, scope);
        for (const child of (node.children as AstNode[]) ?? []) {
          if (isNode(child)) visit(child, scope);
        }
        return;
      }
      case "JSXFragment": {
        for (const child of (node.children as AstNode[]) ?? []) {
          if (isNode(child)) visit(child, scope);
        }
        return;
      }
      case "JSXOpeningElement": {
        const nameNode = node.name as AstNode;
        if (isNode(nameNode) && nameNode.type === "JSXMemberExpression") {
          let member: string | null = nameOf(nameNode.property as AstNode);
          let inner = nameNode.object as AstNode;
          while (inner.type === "JSXMemberExpression") {
            member = nameOf(inner.property as AstNode);
            inner = inner.object as AstNode;
          }
          if (inner.type === "JSXIdentifier") {
            bound.add(inner);
            if (!scope.has(inner.name as string)) add(inner, member);
          } else {
            visit(inner, scope);
          }
        } else if (isNode(nameNode) && nameNode.type === "JSXIdentifier" && /^[A-Z]/u.test(nameOf(nameNode))) {
          bound.add(nameNode);
          if (!scope.has(nameOf(nameNode))) add(nameNode, null);
        }
        for (const attribute of (node.attributes as AstNode[]) ?? []) {
          if (isNode(attribute)) visit(attribute, scope);
        }
        return;
      }
      case "JSXAttribute": {
        if (isNode(node.value)) visit(node.value as AstNode, scope); // the name is a prop name, not a binding
        return;
      }
      case "JSXSpreadAttribute": {
        visit(node.argument as AstNode, scope);
        return;
      }
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
  return { names, importSpecifiers, typeImports };
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
  languages: LanguageSet,
  files: ReadonlySet<string>,
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
      const T2 = resolveSpecifier(T, String(node.source), languages, files);
      if (T2 === null) return null;
      if (node.imported === "*") return T2; // `export * as ns`: the whole module
      return resolveExport(T2, String(node.imported), modules, languages, files, depth + 1, seen, out);
    }
    return key;
  }
  if (x !== "default") {
    for (const entity of info.entities) {
      if (entity.kind !== "reexport-all") continue;
      const T2 = resolveSpecifier(T, String(entity.nodes[0]!.source), languages, files);
      if (T2 === null) continue;
      const found = resolveExport(T2, x, modules, languages, files, depth + 1, seen, out);
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

const TOP_LEVEL = new Set([
  "function",
  "class",
  "const",
  "let",
  "var",
  "value",
  "type", // LG2: a type alias is a module-level name too (LG3)
  "interface",
  "enum",
  "namespace",
]);

/**
 * The reference tables of 6.2 for `files` (path -> content): R(E), G(E), the unresolved and
 * banned lists, and the negative lookups. Only files that are modules and parse take part.
 */
export function analyse(files: ReadonlyMap<string, string>, languages: LanguageSet = TIDEPOOL_LANGUAGES): Analysis {
  const modules = new Map<string, ModuleInfo>();
  for (const [path, content] of files) {
    const language = languageOfPath(path, languages);
    if (language === null) continue;
    try {
      modules.set(path, parseModule(content, language));
    } catch {
      // a module that does not parse is opaque (2.1): it has no entities and exports nothing
    }
  }
  const existing = new Set(files.keys());
  const refs = new Map<string, Set<string>>();
  const globals = new Map<string, Set<string>>();
  const negatives = new Map<string, Set<string>>();
  const unresolved: Array<{ from: string; to: string }> = [];
  const banned: Array<{ from: string; specifier: string }> = [];

  for (const [path, info] of modules) {
    if (info.syntax !== undefined) {
      // LG4: a Python or Go module's references are by name, added below for every module at once.
      for (const entity of info.entities) {
        const from = `${path}#${entity.name}`;
        refs.set(from, new Set());
        globals.set(from, new Set());
        negatives.set(from, new Set());
      }
      continue;
    }
    const topLevel = new Set(info.entities.filter((entity) => TOP_LEVEL.has(entity.kind)).map((e) => e.name));
    const addNamed = (from: string, specifier: string, imported: string): void => {
      const T = resolveSpecifier(path, specifier, languages, existing);
      if (T === null) {
        // LG3: under the imported set an external specifier is just external — nothing banned.
        if (isExternalSpecifier(specifier)) {
          if (languages.externalSpecifiersBanned) banned.push({ from, specifier });
        } else unresolved.push({ from, to: `${specifier}#${imported}` });
        return;
      }
      const out: ResolveOut = { hops: new Set(), negatives: new Set() };
      const found = resolveExport(T, imported, modules, languages, existing, 0, new Set(), out);
      for (const hop of out.hops) refs.get(from)!.add(hop);
      for (const negative of out.negatives) negatives.get(from)!.add(negative);
      if (found === null) unresolved.push({ from, to: `${T}#${imported}` });
      else refs.get(from)!.add(found);
    };
    const addModule = (from: string, specifier: string): void => {
      const T = resolveSpecifier(path, specifier, languages, existing);
      if (T === null) {
        if (isExternalSpecifier(specifier)) {
          if (languages.externalSpecifiersBanned) banned.push({ from, specifier });
        } else unresolved.push({ from, to: specifier });
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
        const { names, importSpecifiers, typeImports } = referencesIn(entity.nodes);
        for (const specifier of importSpecifiers) addModule(from, specifier);
        for (const { specifier, imported } of typeImports) {
          if (imported === null) addModule(from, specifier);
          else addNamed(from, specifier, imported);
        }
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
  addByNameRefs(modules, files, existing, (from, to) => refs.get(from)!.add(to));
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
