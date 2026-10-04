// The early measurement's own Acorn pass over top-level declarations (ME3, plan 2.2a): the pool
// uses this until `src/core/entities` exists. Entity model of 01-core 2.3: one entity per bound
// name, `(import <spec>)` shared by specifier, `(top)` shared by every other statement (EN4), and
// regions that run statement-end to statement-end so comments fold into what follows them (EN6).

import { parse } from "acorn";
import { H } from "../../../src/core/sync/h.ts";

export type EntityKind =
  "function" | "class" | "const" | "let" | "var" | "value" | "import" | "reexport" | "reexport-all" | "top";

export type Entity = {
  name: string; // `foo`, `(import ./x.js)`, `(top)`, `default`, `*<spec>`
  kind: EntityKind;
  hash: string; // the normalized entity hash of 01-core 2.4 (H of the canonical form)
  exports: string[]; // sorted export names this entity adds
  signature: string; // the declaration head: `export const X`, `export function f(a, b)`, ...
  lines: [number, number]; // 1-based first/last line over the entity's regions
  start: number; // first region's start
  end: number; // last region's end
  regions: Array<[number, number]>; // every statement region of this entity (EN6)
  source: string; // the region texts (EN7), each with leading blank lines removed, joined by "\n"
};

export type ParsedModule =
  | { ok: true; entities: Entity[]; exports: string[] }
  | { ok: false; error: { message: string; line: number; column: number } };

type NodeLike = {
  type: string;
  start: number;
  end: number;
  body?: NodeLike[];
  [key: string]: unknown;
};

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
}

function nameOfId(id: unknown): string | null {
  const node = id as NodeLike | null | undefined;
  return node?.type === "Identifier" ? (node.name as string) : null;
}

/** Every identifier bound by a `const {p, q}` / `const [a, b]` / plain declarator. */
function boundNames(pattern: unknown, out: string[]): void {
  const node = pattern as NodeLike | null | undefined;
  if (node === null || node === undefined) return;
  switch (node.type) {
    case "Identifier":
      out.push(node.name as string);
      return;
    case "ObjectPattern":
      for (const p of (node.properties ?? []) as NodeLike[]) {
        boundNames(p.type === "RestElement" ? p.argument : p.value, out);
      }
      return;
    case "ArrayPattern":
      for (const el of (node.elements ?? []) as Array<NodeLike | null>) boundNames(el, out);
      return;
    case "RestElement":
      boundNames(node.argument, out);
      return;
    case "AssignmentPattern":
      boundNames(node.left, out);
      return;
    default:
      return;
  }
}

function functionSignature(source: string, node: NodeLike, prefix: string, name: string | null): string {
  const params = ((node.params ?? []) as NodeLike[]).map((p) => source.slice(p.start, p.end)).join(", ");
  const gen = node.generator === true ? "*" : "";
  const asyncPrefix = node.async === true ? "async " : "";
  return `${prefix}${asyncPrefix}function${gen}${name === null ? "" : ` ${name}`}(${params})`;
}

function classSignature(source: string, node: NodeLike, prefix: string, name: string | null): string {
  const sup = node.superClass as NodeLike | null | undefined;
  const ext = sup ? ` extends ${source.slice(sup.start, sup.end)}` : "";
  return `${prefix}class ${name ?? ""}${ext}`.trimEnd();
}

/**
 * Parse `source` as an ES module (acorn, `ecmaVersion: 2025`, `sourceType: "module"`).
 * Opaque/unparseable files come back `{ ok: false }`; the pool answers `not_a_module`.
 */
export function parseModule(path: string, source: string): ParsedModule {
  void path;
  let program: NodeLike;
  try {
    program = parse(source, { ecmaVersion: 2025, sourceType: "module", locations: false }) as unknown as NodeLike;
  } catch (error) {
    const e = error as { message?: string; loc?: { line: number; column: number } };
    return {
      ok: false,
      error: { message: e.message ?? "parse error", line: e.loc?.line ?? 1, column: e.loc?.column ?? 0 },
    };
  }

  const body = (program.body ?? []) as NodeLike[];
  const moduleExports = new Set<string>();
  const importBindings = new Map<string, { source: string; imported: string }>();

  // EN6 regions: statement i owns (end of statement i-1, end of statement i]; the last runs to EOF.
  const regions: Array<[number, number]> = body.map((n, i) => [i === 0 ? 0 : (body[i - 1]?.end ?? 0), n.end]);
  if (regions.length > 0) regions[regions.length - 1]![1] = source.length;

  // Pass 1: contributions. A `kind === null` contribution adds exports/a region to an existing
  // entity (`export { a, b as c }`) and creates nothing on its own. `node` is the 2.4 step-1 hash
  // node: `null` for `export { a }` without source, which contributes only an export name.
  type Contrib = {
    name: string;
    kind: EntityKind | null;
    exports: string[];
    signature: string | null;
    index: number;
    node: Record<string, unknown> | null;
  };
  const contribs: Contrib[] = [];

  for (let i = 0; i < body.length; i++) {
    const node = body[i]!;
    const regionText = () => source.slice(regions[i]![0], regions[i]![1]).replace(/^\s+/, "").split("\n")[0]!.trimEnd();
    switch (node.type) {
      case "ImportDeclaration": {
        const spec = String((node.source as { value?: unknown })?.value ?? "");
        for (const s of (node.specifiers ?? []) as NodeLike[]) {
          const local = nameOfId(s.local);
          if (local === null) continue;
          const imported =
            s.type === "ImportDefaultSpecifier"
              ? "default"
              : s.type === "ImportNamespaceSpecifier"
                ? "*"
                : (nameOfId(s.imported) ?? local);
          importBindings.set(local, { source: spec, imported });
        }
        contribs.push({
          name: `(import ${spec})`,
          kind: "import",
          exports: [],
          signature: regionText(),
          index: i,
          node,
        });
        break;
      }
      case "ExportNamedDeclaration": {
        const decl = node.declaration as NodeLike | null | undefined;
        if (decl) {
          if (decl.type === "VariableDeclaration") {
            for (const d of (decl.declarations ?? []) as NodeLike[]) {
              const bound: string[] = [];
              boundNames(d.id, bound);
              for (const n of bound) {
                moduleExports.add(n);
                contribs.push({
                  name: n,
                  kind: decl.kind as EntityKind,
                  exports: [n],
                  signature: `export ${decl.kind as string} ${n}`,
                  index: i,
                  node: { type: "VariableDeclarator", kind: decl.kind, id: d.id, init: d.init ?? null },
                });
              }
            }
          } else {
            const kind: EntityKind =
              decl.type === "FunctionDeclaration" ? "function" : decl.type === "ClassDeclaration" ? "class" : "top";
            const name = nameOfId(decl.id) ?? "(anonymous)";
            const sig =
              kind === "function"
                ? functionSignature(source, decl, "export ", nameOfId(decl.id))
                : kind === "class"
                  ? classSignature(source, decl, "export ", nameOfId(decl.id))
                  : regionText();
            if (kind !== "top") moduleExports.add(name);
            contribs.push({ name, kind, exports: kind === "top" ? [] : [name], signature: sig, index: i, node: decl });
          }
        } else {
          const spec = node.source ? String((node.source as { value?: unknown }).value ?? "") : null;
          for (const s of (node.specifiers ?? []) as NodeLike[]) {
            const local = nameOfId(s.local) ?? "";
            const exported = nameOfId(s.exported) ?? local;
            if (exported === "") continue;
            moduleExports.add(exported);
            if (spec !== null) {
              // export { a as b } from "./m.js" -> entity `b`, kind `reexport`
              contribs.push({
                name: exported,
                kind: "reexport",
                exports: [exported],
                signature: regionText(),
                index: i,
                node: { type: "ReExport", source: spec, imported: local },
              });
            } else {
              const viaImport = importBindings.get(local);
              if (viaImport !== undefined) {
                // `export { a as c }` over an import binding is the re-export `export { imported as c } from spec`
                contribs.push({
                  name: exported,
                  kind: "reexport",
                  exports: [exported],
                  signature: regionText(),
                  index: i,
                  node: { type: "ReExport", source: viaImport.source, imported: viaImport.imported },
                });
              } else {
                // export { a, b as c }: contributes to entities `a` and `b`, adds export `a`/`c`
                contribs.push({ name: local, kind: null, exports: [exported], signature: null, index: i, node: null });
              }
            }
          }
        }
        break;
      }
      case "ExportDefaultDeclaration": {
        moduleExports.add("default");
        const decl = node.declaration as NodeLike | undefined;
        if (decl?.type === "FunctionDeclaration") {
          const name = nameOfId(decl.id);
          contribs.push({
            name: name ?? "default",
            kind: "function",
            exports: ["default"],
            signature: functionSignature(source, decl, "export default ", name),
            index: i,
            node: decl,
          });
        } else if (decl?.type === "ClassDeclaration") {
          const name = nameOfId(decl.id);
          contribs.push({
            name: name ?? "default",
            kind: "class",
            exports: ["default"],
            signature: classSignature(source, decl, "export default ", name),
            index: i,
            node: decl,
          });
        } else {
          contribs.push({
            name: "default",
            kind: "value",
            exports: ["default"],
            signature: "export default",
            index: i,
            node: decl ?? node,
          });
        }
        break;
      }
      case "ExportAllDeclaration": {
        const spec = String((node.source as { value?: unknown })?.value ?? "");
        const exported = nameOfId(node.exported);
        if (exported !== null) {
          moduleExports.add(exported);
          contribs.push({
            name: exported,
            kind: "reexport",
            exports: [exported],
            signature: regionText(),
            index: i,
            node: { type: "ReExport", source: spec, imported: "*" },
          });
        } else {
          moduleExports.add("*");
          contribs.push({
            name: `*${spec}`,
            kind: "reexport-all",
            exports: ["*"],
            signature: regionText(),
            index: i,
            node: { type: "ReExportAll", source: spec },
          });
        }
        break;
      }
      case "FunctionDeclaration":
      case "ClassDeclaration": {
        const kind: EntityKind = node.type === "FunctionDeclaration" ? "function" : "class";
        const name = nameOfId(node.id) ?? "(anonymous)";
        const sig =
          kind === "function"
            ? functionSignature(source, node, "", nameOfId(node.id))
            : classSignature(source, node, "", nameOfId(node.id));
        contribs.push({ name, kind, exports: [], signature: sig, index: i, node });
        break;
      }
      case "VariableDeclaration": {
        for (const d of (node.declarations ?? []) as NodeLike[]) {
          const bound: string[] = [];
          boundNames(d.id, bound);
          for (const n of bound)
            contribs.push({
              name: n,
              kind: node.kind as EntityKind,
              exports: [],
              signature: `${node.kind as string} ${n}`,
              index: i,
              node: { type: "VariableDeclarator", kind: node.kind, id: d.id, init: d.init ?? null },
            });
        }
        break;
      }
      default: {
        contribs.push({ name: "(top)", kind: "top", exports: [], signature: regionText(), index: i, node });
        break;
      }
    }
  }

  // Pass 2: merge contributions into entities (EN4), first-contribution order.
  const order: string[] = [];
  const byName = new Map<
    string,
    {
      kind: EntityKind | null;
      exports: Set<string>;
      signature: string | null;
      idxs: number[];
      nodes: Array<Record<string, unknown>>;
    }
  >();
  const entry = (name: string) => {
    let e = byName.get(name);
    if (e === undefined) {
      e = { kind: null, exports: new Set(), signature: null, idxs: [], nodes: [] as Array<Record<string, unknown>> };
      byName.set(name, e);
      order.push(name);
    }
    return e;
  };
  for (const c of contribs) {
    const e = entry(c.name);
    if (c.kind !== null && e.kind === null) {
      e.kind = c.kind;
      e.signature = c.signature;
    }
    for (const x of c.exports) e.exports.add(x);
    if (!e.idxs.includes(c.index)) e.idxs.push(c.index);
    if (c.node !== null) e.nodes.push(c.node);
  }

  const entities: Entity[] = [];
  for (const name of order) {
    const e = byName.get(name)!;
    if (e.kind === null) continue; // `export { x }` of a name never declared: no entity
    const regs = e.idxs.map((i) => regions[i]!);
    const texts = regs.map(([s, en]) => source.slice(s, en).replace(/^\s+/, ""));
    // `lines` bounds the region's visible text: from its first non-blank line to its last.
    const lead = /^\s*/.exec(source.slice(regs[0]![0], regs[0]![1]))![0].length;
    const lastReg = regs[regs.length - 1]!;
    const trail = /\s*$/.exec(source.slice(lastReg[0], lastReg[1]))![0].length;
    entities.push({
      name,
      kind: e.kind,
      exports: [...e.exports].sort(),
      hash: entityHashOf([...e.exports].sort(), e.nodes),
      signature: e.signature ?? name,
      lines: [lineOf(source, regs[0]![0] + lead), lineOf(source, lastReg[1] - trail - 1)],
      start: regs[0]![0],
      end: regs[regs.length - 1]![1],
      regions: regs,
      source: texts.join("\n"),
    });
  }

  if (entities.length === 0) {
    // EN5: a module with no statements has exactly one entity, `(top)`, with no nodes.
    entities.push({
      name: "(top)",
      kind: "top",
      exports: [],
      hash: entityHashOf([], []),
      signature: "(top)",
      lines: [1, 1],
      start: 0,
      end: 0,
      regions: [],
      source: "",
    });
  }

  return { ok: true, entities, exports: [...moduleExports].sort() };
}

/** The `<path>#<name>` key of an entity. */
export function entityKey(path: string, name: string): string {
  return `${path}#${name}`;
}

/** Look up one entity by name; `null` when the module has none of that name. */
export function entityByName(module: ParsedModule, name: string): Entity | null {
  if (!module.ok) return null;
  return module.entities.find((e) => e.name === name) ?? null;
}

/** The imports of a module: `{ specifier, names }` per import/re-export-from declaration (CK5). */
export function importsOf(path: string, source: string): Array<{ specifier: string; names: string[] }> {
  void path;
  let program: NodeLike;
  try {
    program = parse(source, { ecmaVersion: 2025, sourceType: "module", locations: false }) as unknown as NodeLike;
  } catch {
    return [];
  }
  const out: Array<{ specifier: string; names: string[] }> = [];
  for (const node of (program.body ?? []) as NodeLike[]) {
    const spec = node.source ? String((node.source as { value?: unknown }).value ?? "") : null;
    if (spec === null) continue;
    if (node.type === "ImportDeclaration") {
      const names = ((node.specifiers ?? []) as NodeLike[]).map((s) => {
        if (s.type === "ImportDefaultSpecifier") return "default";
        if (s.type === "ImportNamespaceSpecifier") return "*";
        return nameOfId(s.imported) ?? "";
      });
      out.push({ specifier: spec, names });
    } else if (node.type === "ExportNamedDeclaration") {
      // CK5 checks the LOCAL name against the target module (`export { a as b } from m` needs `a` on m)
      const names = ((node.specifiers ?? []) as NodeLike[]).map((s) => nameOfId(s.local) ?? "");
      out.push({ specifier: spec, names });
    } else if (node.type === "ExportAllDeclaration") {
      out.push({ specifier: spec, names: ["*"] });
    }
  }
  return out;
}

/** `resolve` of 6.2: only `./` and `../` specifiers; `null` marks an external specifier. */
export function resolveSpecifier(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const dir = fromPath.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      if (dir.length === 0) return null;
      dir.pop();
    } else dir.push(part);
  }
  return dir.join("/");
}

// ---- The normalized entity hash of 01-core 2.4 ----

/** Step 2: drop position keys, `raw` and volatile Literal fields, then `undefined` values. */
function cleanNode(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(cleanNode);
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (value === undefined) continue;
    if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
    if (src.type === "Literal") {
      if (key === "raw") continue;
      if (key === "value" && (src.regex !== undefined || src.bigint !== undefined)) continue;
    }
    out[key] = cleanNode(value);
  }
  if (src.type === "Literal" && typeof src.value === "number" && !Number.isFinite(src.value)) {
    delete out.value;
    out.number = "Infinity";
  }
  return out;
}

/** Step 4: JSON with object keys sorted at every level (ECMAScript `JSON.stringify` rules). */
function canon(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canon((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

/** `entityHash` of 2.4: H over the canonical `{ exports, nodes }` of the entity's hash nodes. */
function entityHashOf(exports: string[], nodes: Array<Record<string, unknown>>): string {
  const form = canon({ exports, nodes: nodes.map(cleanNode) });
  return H(form);
}
