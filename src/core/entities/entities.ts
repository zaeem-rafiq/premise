// Entities, regions, the normalized entity hash, outline lines and the module hash
// (01-core.md 2.3, 2.4, 2.7 and KH1; the TypeScript rows of 06-repos.md LG2). The parser is
// acorn, pinned in package.json; for JavaScript the parse options are exactly
// `{ ecmaVersion: 2025, sourceType: "module" }` (2.3). TypeScript parses through
// `@sveltejs/acorn-typescript` (LG1), with JSX for `.tsx` and for the `.jsx` language.

import * as acorn from "acorn";
import { tsPlugin } from "@sveltejs/acorn-typescript";
import { H } from "../sync/h.ts";
import type { Language } from "../keys/paths.ts";
import type { EntityKind } from "../../protocol/premise.ts";

export const PARSE_OPTIONS = { ecmaVersion: 2025, sourceType: "module" } as const;

// The plugin asks for `locations` (its README); `loc` is dropped by the cleaning of 2.4.
const TS_PARSE_OPTIONS = { ...PARSE_OPTIONS, locations: true } as const;

const TS_PARSER = acorn.Parser.extend(tsPlugin());
const TSX_PARSER = acorn.Parser.extend(tsPlugin({ jsx: true }));

/**
 * The TypeScript-only entity kinds of LG2. `EntityKind` lives in `src/protocol`, the lead's
 * file, and is widened when the engine wires the pool's languages into the tools; until then
 * the four are asserted into it here. Under the tide-pool set no entity can hold one, because
 * TypeScript files are opaque there.
 */
type TsEntityKind = "type" | "interface" | "enum" | "namespace";

const TS_DECLARATION_KINDS: Readonly<Record<string, TsEntityKind>> = {
  TSTypeAliasDeclaration: "type",
  TSInterfaceDeclaration: "interface",
  TSEnumDeclaration: "enum",
  TSModuleDeclaration: "namespace",
};

/** A syntax node or a cleaned syntax node. `[key]` holds child nodes, arrays of them, or values. */
export type AstNode = { type: string; start?: number; end?: number; [key: string]: unknown };

/** One entity of a module (2.3), with the canonical form and hash of 2.4. */
export type Entity = {
  name: string; // the entity name: a binding name, `(import <spec>)`, `*<spec>`, `(top)` or `default`
  kind: EntityKind;
  exports: string[]; // the entity's export names, sorted
  nodes: AstNode[]; // the cleaned nodes of 2.4 step 1, in source order
  canonical: string; // the canonical form of 2.4 step 4
  hash: string; // H(canonical)
  arity: number | null; // parameter count for kind `function` (2.7), null otherwise
};

/** A region (EN6): every character of a module belongs to exactly one. */
export type Region = { start: number; end: number; names: string[] };

/** The local bindings an import declares: local name -> (source specifier text, imported name). */
export type ImportTable = Map<string, { source: string; imported: string }>;

export type ModuleInfo = {
  entities: Entity[]; // in the order their first contributing statement appears
  regions: Region[];
  imports: ImportTable;
};

// ---- 2.4 step 2: cleaning a node ----

const DROPPED_KEYS = new Set(["start", "end", "loc", "range"]);

function clean(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? undefined : value;
  }
  if (Array.isArray(value)) return value.map(clean);
  if (value instanceof RegExp) return undefined;
  const node = value as Record<string, unknown>;
  const isLiteral = node.type === "Literal";
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(node)) {
    if (DROPPED_KEYS.has(key)) continue;
    if (isLiteral && key === "raw") continue;
    if (isLiteral && key === "value" && (node.regex !== undefined || node.bigint !== undefined)) continue;
    if (isLiteral && key === "value" && typeof node.value === "number" && !Number.isFinite(node.value)) {
      out.number = "Infinity"; // a number that is not finite would serialize as null (2.4 step 2)
      continue;
    }
    const cleaned = clean(node[key]);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

/** The canonical form of 2.4 step 4: JSON with object keys sorted at every level. */
export function canon(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  const node = value as Record<string, unknown>;
  const entries = Object.keys(node)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canon(node[key])}`);
  return `{${entries.join(",")}}`;
}

// ---- 2.3: statements to entities ----

type WorkingEntity = {
  name: string;
  kind: EntityKind;
  exports: Set<string>;
  nodes: AstNode[];
};

/** The names a pattern binds (declaration ids, destructuring patterns). */
function patternNames(pattern: AstNode | null | undefined, out: string[]): void {
  if (pattern === null || pattern === undefined) return;
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name as string);
      return;
    case "ObjectPattern":
      for (const property of pattern.properties as AstNode[]) {
        patternNames(
          property.type === "RestElement" ? (property.argument as AstNode) : (property.value as AstNode),
          out,
        );
      }
      return;
    case "ArrayPattern":
      for (const element of pattern.elements as Array<AstNode | null>) patternNames(element, out);
      return;
    case "RestElement":
    case "AssignmentPattern":
      patternNames((pattern.argument ?? pattern.left) as AstNode, out);
      return;
    default:
      return;
  }
}

/** The text of an `Identifier` or of a module-name `Literal` (`export { "a-b" as c }`). */
function nameOf(node: AstNode | null | undefined): string {
  if (node === null || node === undefined) return "";
  if (node.type === "Identifier") return node.name as string;
  if (node.type === "Literal") return String(node.value);
  return "";
}

function declareVariable(
  statement: AstNode,
  exported: boolean,
  get: (name: string, kind: EntityKind) => WorkingEntity,
  names: string[],
): void {
  for (const declarator of statement.declarations as AstNode[]) {
    const bound: string[] = [];
    patternNames(declarator.id as AstNode, bound);
    for (const name of bound) {
      const entity = get(name, statement.kind as EntityKind);
      entity.nodes.push({
        type: "VariableDeclarator",
        kind: statement.kind,
        ...(statement.declare === true ? { declare: true } : {}),
        id: clean(declarator.id),
        init: clean(declarator.init ?? null),
      } as AstNode);
      if (exported) entity.exports.add(name);
      names.push(name);
    }
  }
}

function declareHoisted(
  declaration: AstNode,
  exported: boolean,
  isDefault: boolean,
  get: (name: string, kind: EntityKind) => WorkingEntity,
  names: string[],
): void {
  const kind: EntityKind =
    declaration.type === "ClassDeclaration" ? "class" : "function"; // TSDeclareFunction included (LG2)
  const name = isDefault ? nameOf(declaration.id as AstNode) || "default" : nameOf(declaration.id as AstNode);
  const entity = get(name, kind);
  entity.nodes.push(clean(declaration) as AstNode);
  if (exported) entity.exports.add(isDefault ? "default" : name);
  names.push(name);
}

/**
 * A `type`, `interface`, `enum`, `const enum`, `namespace` or `module` declaration (LG2):
 * entity of the declared name and the row's kind.
 */
function declareTs(
  declaration: AstNode,
  exported: boolean,
  get: (name: string, kind: EntityKind) => WorkingEntity,
  names: string[],
): void {
  const name = nameOf(declaration.id as AstNode);
  const entity = get(name, TS_DECLARATION_KINDS[declaration.type] as EntityKind);
  entity.nodes.push(clean(declaration) as AstNode);
  if (exported) entity.exports.add(name);
  names.push(name);
}

/**
 * Parses `source` into entities and regions (2.3, LG2). `language` is the path's language
 * (LG1): `javascript` is acorn with the 2.3 options, `jsx` adds JSX, `typescript` and `tsx`
 * go through `@sveltejs/acorn-typescript`. Throws the parser's `SyntaxError` when the module
 * does not parse; the caller decides whether the file is a module at all (2.1: opaque).
 */
export function parseModule(source: string, language: Language = "javascript"): ModuleInfo {
  const program = (
    language === "javascript"
      ? acorn.parse(source, PARSE_OPTIONS as { ecmaVersion: 2025; sourceType: "module" })
      : (language === "typescript" ? TS_PARSER : TSX_PARSER).parse(
          source,
          TS_PARSE_OPTIONS as { ecmaVersion: 2025; sourceType: "module"; locations: true },
        )
  ) as unknown as AstNode;
  const body = program.body as AstNode[];
  const entities = new Map<string, WorkingEntity>();
  const imports: ImportTable = new Map();
  const regions: Region[] = [];
  const get = (name: string, kind: EntityKind): WorkingEntity => {
    let entity = entities.get(name);
    if (entity === undefined) {
      entity = { name, kind, exports: new Set(), nodes: [] };
      entities.set(name, entity);
    }
    return entity;
  };

  // `export { a, b as c };` resolves after the walk: the entity it exports may be declared later.
  const exportLists: Array<{ statement: AstNode; names: string[] }> = [];

  let previousEnd = 0;
  for (let index = 0; index < body.length; index += 1) {
    const statement = body[index]!;
    const names: string[] = [];
    const top = () => {
      const entity = get("(top)", "top");
      entity.nodes.push(clean(statement) as AstNode);
      names.push("(top)");
    };
    switch (statement.type) {
      case "ImportDeclaration": {
        const specifier = nameOf(statement.source as AstNode);
        const entity = get(`(import ${specifier})`, "import");
        entity.nodes.push(clean(statement) as AstNode);
        names.push(entity.name);
        for (const specifierNode of statement.specifiers as AstNode[]) {
          if (specifierNode.type === "ImportSpecifier") {
            imports.set(nameOf(specifierNode.local as AstNode), {
              source: specifier,
              imported: nameOf(specifierNode.imported as AstNode),
            });
          } else if (specifierNode.type === "ImportDefaultSpecifier") {
            imports.set(nameOf(specifierNode.local as AstNode), { source: specifier, imported: "default" });
          } else {
            imports.set(nameOf(specifierNode.local as AstNode), { source: specifier, imported: "*" });
          }
        }
        break;
      }
      case "ExportNamedDeclaration": {
        const declaration = statement.declaration as AstNode | null;
        const source = statement.source as AstNode | null;
        if (declaration !== null && declaration !== undefined) {
          if (
            declaration.type === "FunctionDeclaration" ||
            declaration.type === "ClassDeclaration" ||
            declaration.type === "TSDeclareFunction"
          ) {
            declareHoisted(declaration, true, false, get, names);
          } else if (declaration.type === "VariableDeclaration") {
            declareVariable(declaration, true, get, names);
          } else if (declaration.type in TS_DECLARATION_KINDS) {
            declareTs(declaration, true, get, names);
          } else top();
        } else if (source !== null && source !== undefined) {
          for (const specifierNode of statement.specifiers as AstNode[]) {
            const exported = nameOf(specifierNode.exported as AstNode);
            const entity = get(exported, "reexport");
            entity.exports.add(exported);
            entity.nodes.push({
              type: "ReExport",
              source: nameOf(source),
              imported: nameOf(specifierNode.local as AstNode),
              ...(statement.exportKind === "type" ? { exportKind: "type" } : {}),
            } as AstNode);
            names.push(exported);
          }
        } else {
          exportLists.push({ statement, names });
        }
        break;
      }
      case "ExportDefaultDeclaration": {
        const declaration = statement.declaration as AstNode;
        if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") {
          declareHoisted(declaration, true, true, get, names);
        } else {
          const entity = get("default", "value");
          entity.exports.add("default");
          entity.nodes.push(clean(declaration) as AstNode);
          names.push("default");
        }
        break;
      }
      case "ExportAllDeclaration": {
        const specifier = nameOf(statement.source as AstNode);
        const exported = statement.exported as AstNode | null;
        if (exported !== null && exported !== undefined) {
          const name = nameOf(exported); // `export * as ns from "./m.js"`
          const entity = get(name, "reexport");
          entity.exports.add(name);
          entity.nodes.push({ type: "ReExport", source: specifier, imported: "*" } as AstNode);
          names.push(name);
        } else {
          const entity = get(`*${specifier}`, "reexport-all"); // `export * from "./m.js"`
          entity.exports.add("*");
          entity.nodes.push({ type: "ReExportAll", source: specifier } as AstNode);
          names.push(entity.name);
        }
        break;
      }
      case "FunctionDeclaration":
      case "ClassDeclaration":
      case "TSDeclareFunction":
        declareHoisted(statement, false, false, get, names);
        break;
      case "VariableDeclaration":
        declareVariable(statement, false, get, names);
        break;
      case "TSTypeAliasDeclaration":
      case "TSInterfaceDeclaration":
      case "TSEnumDeclaration":
      case "TSModuleDeclaration":
        declareTs(statement, false, get, names);
        break;
      default:
        top();
        break;
    }
    // A statement that contributed no entity contributes `(top)` (EN6: every character is in a region).
    if (names.length === 0) top();
    regions.push({
      start: previousEnd,
      end: index === body.length - 1 ? source.length : (statement.end as number),
      names,
    });
    previousEnd = statement.end as number;
  }

  for (const { statement, names } of exportLists) {
    for (const specifierNode of statement.specifiers as AstNode[]) {
      const local = nameOf(specifierNode.local as AstNode);
      const exported = nameOf(specifierNode.exported as AstNode);
      const entity = entities.get(local);
      if (entity !== undefined && entity.kind !== "reexport" && entity.kind !== "reexport-all") {
        entity.exports.add(exported); // adds export name `exported` to the entity `local` (2.3)
        names.push(local);
      } else {
        const binding = imports.get(local);
        if (binding !== undefined) {
          // An export of an import binding is a re-export (2.3).
          const reexport = get(exported, "reexport");
          reexport.exports.add(exported);
          reexport.nodes.push({ type: "ReExport", source: binding.source, imported: binding.imported } as AstNode);
          names.push(exported);
        }
      }
    }
    if (names.length === 0) {
      const entity = get("(top)", "top");
      entity.nodes.push(clean(statement) as AstNode);
      names.push("(top)");
    }
  }

  if (body.length === 0) {
    get("(top)", "top"); // EN5: a module with no statements has exactly `(top)`, with no nodes
    regions.push({ start: 0, end: source.length, names: ["(top)"] });
  }

  return {
    entities: [...entities.values()].map((entity) => {
      const exports = [...entity.exports].sort();
      const canonical = canon({ exports, nodes: entity.nodes });
      const firstFunction = entity.nodes.find(
        (node) =>
          (node.type === "FunctionDeclaration" || node.type === "TSDeclareFunction") &&
          Array.isArray(node.params),
      );
      return {
        name: entity.name,
        kind: entity.kind,
        exports,
        nodes: entity.nodes,
        canonical,
        hash: H(canonical),
        arity: firstFunction === undefined ? null : (firstFunction.params as AstNode[]).length,
      };
    }),
    regions,
    imports,
  };
}

// ---- regions, sources, outlines, module hash ----

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

/**
 * The entities a character span belongs to (EN6): every entity contributed by a statement whose
 * region intersects `[start, end)`, in source order, without duplicates.
 */
export function regionTargets(info: ModuleInfo, start: number, end: number): string[] {
  const names: string[] = [];
  for (const region of info.regions) {
    if (start < region.end && end > region.start) {
      for (const name of region.names) if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * The source of one entity (EN7): the text of the regions of its statements, with leading blank
 * lines removed, or null when the module has no entity of that name.
 */
export function entitySource(source: string, info: ModuleInfo, name: string): string | null {
  if (!info.entities.some((entity) => entity.name === name)) return null;
  const regions = info.regions.filter((region) => region.names.includes(name));
  return regions
    .map((region) => source.slice(region.start, region.end))
    .join("")
    .replace(/^\n+/, "");
}

/** The 1-based line span of an entity's source (the `lines` of `outline` and `read`, 4.3, 4.4). */
export function entityLines(source: string, info: ModuleInfo, name: string): [number, number] {
  const regions = info.regions.filter((region) => region.names.includes(name));
  if (regions.length === 0) return [0, 0];
  const joined = regions.map((region) => source.slice(region.start, region.end)).join("");
  const start = regions[0]!.start + (joined.length - joined.replace(/^\n+/, "").length);
  const first = lineOf(source, start);
  let end = regions[regions.length - 1]!.end;
  while (
    end > start &&
    (source[end - 1] === "\n" || source[end - 1] === "\r" || source[end - 1] === " " || source[end - 1] === "\t")
  ) {
    end -= 1;
  }
  const last = lineOf(source, Math.max(start, end - 1));
  return [first, Math.max(first, last)];
}

/** The outline lines of 2.7: `<name>|<kind>|<export names, joined by ",">|<arity or "">`. */
export function outlineLines(info: ModuleInfo): string[] {
  return info.entities.map(
    (entity) => `${entity.name}|${entity.kind}|${entity.exports.join(",")}|${entity.arity ?? ""}`,
  );
}

/** KH1: `H(JSON array of the sorted "<entity name> <entityHash>")` over every entity of the module. */
export function moduleHash(info: ModuleInfo): string {
  const members = info.entities.map((entity) => `${entity.name} ${entity.hash}`).sort();
  return H(JSON.stringify(members));
}

/**
 * The display form of one entity for the `outline` tool (4.3). The specification fixes the two
 * examples it shows (`export const ENERGY_MAX`, `export function drain(creature, amount)`); this
 * writes the same form for every kind.
 */
export function entitySignature(source: string, info: ModuleInfo, name: string): string | null {
  const entity = info.entities.find((entry) => entry.name === name);
  if (entity === undefined) return null;
  const prefix = entity.exports.length > 0 ? "export " : "";
  switch (entity.kind as string) {
    case "function": {
      const node = entity.nodes.find(
        (entry) => entry.type === "FunctionDeclaration" || entry.type === "TSDeclareFunction",
      );
      const params = node === undefined ? [] : (node.params as AstNode[]).map((param) => nameOf(param) || "…");
      return `${prefix}function ${name}(${params.join(", ")})`;
    }
    case "class":
      return `${prefix}class ${name}`;
    case "const":
    case "let":
    case "var":
      return `${prefix}${entity.kind} ${name}`;
    case "value":
      return "export default";
    case "import":
      return `import "${name.slice(8, -1)}"`;
    case "reexport": {
      const node = entity.nodes[0];
      return node === undefined
        ? `${prefix}${name}`
        : `export { ${String(node.imported)} as ${name} } from "${String(node.source)}"`;
    }
    case "reexport-all":
      return `export * from "${name.slice(1)}"`;
    case "type":
      return `${prefix}type ${name}`;
    case "interface":
      return `${prefix}interface ${name}`;
    case "enum":
      return `${prefix}enum ${name}`;
    case "namespace":
      return `${prefix}namespace ${name}`;
    case "top":
      return "(top)";
    default:
      return `${prefix}${name}`;
  }
}
