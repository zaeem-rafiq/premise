// Scratch reference for docs/spec/01-core.md sections 2 and 6.
// Used only to check worked examples and test vectors by hand. Not product code.
import * as acorn from "acorn";
import { createHash } from "node:crypto";

export const PARSE = { ecmaVersion: 2025, sourceType: "module" };

export function sha256hex(s) {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
}
export function blobOid(s) {
  const b = Buffer.from(s, "utf8");
  return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest("hex");
}

const DROP = new Set(["start", "end", "loc", "range"]);
export function clean(v) {
  if (Array.isArray(v)) return v.map(clean);
  if (v === null || typeof v !== "object") return typeof v === "bigint" ? undefined : v;
  if (v instanceof RegExp) return undefined;
  const out = {};
  const isLiteral = v.type === "Literal";
  for (const k of Object.keys(v)) {
    if (DROP.has(k)) continue;
    if (isLiteral && k === "raw") continue;
    if (isLiteral && k === "value" && (v.regex || v.bigint)) continue;
    if (isLiteral && k === "value" && typeof v[k] === "number" && !Number.isFinite(v[k])) { out.number = "Infinity"; continue; }
    const c = clean(v[k]);
    if (c !== undefined) out[k] = c;
  }
  return out;
}
export function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
}

function patternNames(p, out) {
  if (!p) return;
  switch (p.type) {
    case "Identifier": out.push(p.name); break;
    case "ObjectPattern": for (const q of p.properties) patternNames(q.type === "RestElement" ? q.argument : q.value, out); break;
    case "ArrayPattern": for (const q of p.elements) patternNames(q, out); break;
    case "RestElement": patternNames(p.argument, out); break;
    case "AssignmentPattern": patternNames(p.left, out); break;
  }
}

export function extract(src) {
  const ast = acorn.parse(src, PARSE);
  const ents = new Map(); // name -> {name, kind, exports:Set, nodes:[], raw:[]}
  const order = [];
  const regions = [];
  const imports = new Map(); // local -> {source, imported} ; imported "*" = namespace
  const get = (name, kind) => {
    if (!ents.has(name)) { ents.set(name, { name, kind, exports: new Set(), nodes: [], raw: [] }); order.push(name); }
    return ents.get(name);
  };
  const exportLists = [];
  let prevEnd = 0;
  const body = ast.body;
  body.forEach((st, i) => {
    const names = [];
    const declare = (d, exported, isDefault) => {
      if (d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") {
        const name = d.id ? d.id.name : "default";
        const e = get(name, d.type === "FunctionDeclaration" ? "function" : "class");
        e.nodes.push(clean(d)); e.raw.push(d);
        if (exported) e.exports.add(isDefault ? "default" : name);
        names.push(name);
      } else if (d.type === "VariableDeclaration") {
        for (const dec of d.declarations) {
          const bound = []; patternNames(dec.id, bound);
          for (const name of bound) {
            const e = get(name, d.kind);
            e.nodes.push({ type: "VariableDeclarator", kind: d.kind, id: clean(dec.id), init: clean(dec.init) });
            e.raw.push(dec);
            if (exported) e.exports.add(name);
            names.push(name);
          }
        }
      }
    };
    switch (st.type) {
      case "ImportDeclaration": {
        const e = get(`(import ${st.source.value})`, "import");
        e.nodes.push(clean(st)); e.raw.push(st); names.push(e.name);
        for (const sp of st.specifiers) {
          if (sp.type === "ImportSpecifier") imports.set(sp.local.name, { source: st.source.value, imported: sp.imported.name ?? sp.imported.value });
          else if (sp.type === "ImportDefaultSpecifier") imports.set(sp.local.name, { source: st.source.value, imported: "default" });
          else imports.set(sp.local.name, { source: st.source.value, imported: "*" });
        }
        break;
      }
      case "ExportNamedDeclaration":
        if (st.declaration) declare(st.declaration, true, false);
        else if (st.source) {
          if (st.specifiers.length === 0) { const e = get("(top)", "top"); e.nodes.push(clean(st)); e.raw.push(st); names.push("(top)"); }
          for (const sp of st.specifiers) {
            const ex = sp.exported.name ?? sp.exported.value;
            const e = get(ex, "reexport");
            e.exports.add(ex);
            e.nodes.push({ type: "ReExport", source: st.source.value, imported: sp.local.name ?? sp.local.value });
            names.push(ex);
          }
        } else exportLists.push({ st, i, names });
        break;
      case "ExportDefaultDeclaration": {
        const d = st.declaration;
        if (d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") declare(d, true, true);
        else { const e = get("default", "value"); e.nodes.push(clean(d)); e.raw.push(d); e.exports.add("default"); names.push("default"); }
        break;
      }
      case "ExportAllDeclaration":
        if (st.exported) {
          const ex = st.exported.name ?? st.exported.value;
          const e = get(ex, "reexport"); e.exports.add(ex);
          e.nodes.push({ type: "ReExport", source: st.source.value, imported: "*" }); names.push(ex);
        } else {
          const e = get(`*${st.source.value}`, "reexport-all"); e.exports.add("*");
          e.nodes.push({ type: "ReExportAll", source: st.source.value }); names.push(e.name);
        }
        break;
      case "FunctionDeclaration": case "ClassDeclaration": case "VariableDeclaration":
        declare(st, false, false); break;
      default: { const e = get("(top)", "top"); e.nodes.push(clean(st)); e.raw.push(st); names.push("(top)"); }
    }
    regions.push({ start: prevEnd, end: i === body.length - 1 ? src.length : st.end, names });
    prevEnd = st.end;
  });
  for (const { st, names } of exportLists) {
    for (const sp of st.specifiers) {
      const local = sp.local.name, ex = sp.exported.name ?? sp.exported.value;
      if (ents.has(local) && ents.get(local).kind !== "reexport") { ents.get(local).exports.add(ex); names.push(local); }
      else if (imports.has(local)) {
        const im = imports.get(local);
        const e = get(ex, "reexport"); e.exports.add(ex);
        e.nodes.push({ type: "ReExport", source: im.source, imported: im.imported }); names.push(ex);
      }
    }
  }
  if (body.length === 0) { get("(top)", "top"); regions.push({ start: 0, end: src.length, names: ["(top)"] }); }
  const out = [];
  for (const name of order) {
    const e = ents.get(name);
    const obj = { exports: [...e.exports].sort(), nodes: e.nodes };
    const c = canon(obj);
    let arity = null;
    if (e.kind === "function" && e.raw[0]) arity = e.raw[0].params.length;
    out.push({ name, kind: e.kind, exports: obj.exports, canonical: c, hash: sha256hex(c).slice(0, 32), arity, raw: e.raw });
  }
  return { entities: out, regions, imports, ast };
}

export function resolveSpecifier(fromPath, spec) {
  if (!(spec.startsWith("./") || spec.startsWith("../"))) return null;
  const parts = fromPath.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === ".") continue;
    if (seg === "..") { if (parts.length === 0) return null; parts.pop(); }
    else parts.push(seg);
  }
  return parts.join("/");
}

// ---- references (section 6) ----
function varNames(node, out) {
  // hoisted `var` names and nothing else; does not enter nested functions
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach((n) => varNames(n, out)); return; }
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") return;
  if (node.type === "VariableDeclaration" && node.kind === "var") for (const d of node.declarations) patternNames(d.id, out);
  for (const k of Object.keys(node)) if (k !== "type" && node[k] && typeof node[k] === "object") varNames(node[k], out);
}
function lexicals(stmts, out) {
  for (const s of stmts) {
    if (!s) continue;
    if (s.type === "VariableDeclaration" && s.kind !== "var") for (const d of s.declarations) patternNames(d.id, out);
    else if ((s.type === "FunctionDeclaration" || s.type === "ClassDeclaration") && s.id) out.push(s.id.name);
  }
}

export function freeNames(nodes) {
  // returns [{name, member|null, node}] for identifiers that resolve to module scope
  const found = [];
  const visit = (node, scopes) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach((n) => visit(n, scopes)); return; }
    switch (node.type) {
      case "Identifier":
        for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(node.name)) return;
        found.push({ name: node.name, member: null, node }); return;
      case "MemberExpression":
        if (!node.computed && node.object.type === "Identifier") {
          for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(node.object.name)) return;
          found.push({ name: node.object.name, member: node.property.type === "Identifier" ? node.property.name : null, node: node.object });
          return;
        }
        visit(node.object, scopes); if (node.computed) visit(node.property, scopes); return;
      case "Property":
        if (node.computed) visit(node.key, scopes); visit(node.value, scopes); return;
      case "MethodDefinition": case "PropertyDefinition":
        if (node.computed) visit(node.key, scopes); visit(node.value, scopes); return;
      case "FunctionDeclaration": case "FunctionExpression": case "ArrowFunctionExpression": {
        const names = [];
        for (const p of node.params) patternNames(p, names);
        if (node.type === "FunctionExpression" && node.id) names.push(node.id.name);
        if (node.type !== "ArrowFunctionExpression") names.push("arguments");
        if (node.body.type === "BlockStatement") { varNames(node.body, names); lexicals(node.body.body, names); }
        const s = [...scopes, new Set(names)];
        for (const p of node.params) visitPattern(p, s, true);
        if (node.body.type === "BlockStatement") visit(node.body.body, s); else visit(node.body, s);
        return;
      }
      case "ClassDeclaration": case "ClassExpression": {
        const s = node.id ? [...scopes, new Set([node.id.name])] : scopes;
        visit(node.superClass, scopes); visit(node.body.body, s); return;
      }
      case "StaticBlock": case "BlockStatement": {
        const names = []; lexicals(node.body, names); visit(node.body, [...scopes, new Set(names)]); return;
      }
      case "SwitchStatement": {
        const names = []; for (const c of node.cases) lexicals(c.consequent, names);
        visit(node.discriminant, scopes); const s = [...scopes, new Set(names)];
        for (const c of node.cases) { visit(c.test, s); visit(c.consequent, s); } return;
      }
      case "ForStatement": case "ForInStatement": case "ForOfStatement": {
        const names = []; const head = node.type === "ForStatement" ? node.init : node.left;
        if (head && head.type === "VariableDeclaration" && head.kind !== "var") for (const d of head.declarations) patternNames(d.id, names);
        const s = [...scopes, new Set(names)];
        for (const k of ["init", "left", "test", "update", "right", "body"]) if (node[k]) (node[k].type && /Pattern$|^Identifier$/.test(node[k].type) && k === "left") ? visitPattern(node[k], s, false) : visit(node[k], s);
        return;
      }
      case "CatchClause": {
        const names = []; patternNames(node.param, names); const s = [...scopes, new Set(names)];
        if (node.param) visitPattern(node.param, s, true); visit(node.body, s); return;
      }
      case "VariableDeclaration":
        for (const d of node.declarations) { visitPattern(d.id, scopes, true); visit(d.init, scopes); } return;
      case "VariableDeclarator": // synthetic entity node shape is handled by caller
        visitPattern(node.id, scopes, true); visit(node.init, scopes); return;
      case "AssignmentExpression":
        visitPattern(node.left, scopes, false); visit(node.right, scopes); return;
      case "LabeledStatement": visit(node.body, scopes); return;
      case "BreakStatement": case "ContinueStatement": case "MetaProperty": return;
      default:
        for (const k of Object.keys(node)) if (k !== "type" && node[k] && typeof node[k] === "object") visit(node[k], scopes);
    }
  };
  const visitPattern = (p, scopes, declaring) => {
    if (!p) return;
    switch (p.type) {
      case "Identifier": if (!declaring) visit(p, scopes); return;
      case "ObjectPattern":
        for (const q of p.properties) {
          if (q.type === "RestElement") visitPattern(q.argument, scopes, declaring);
          else { if (q.computed) visit(q.key, scopes); visitPattern(q.value, scopes, declaring); }
        } return;
      case "ArrayPattern": for (const q of p.elements) visitPattern(q, scopes, declaring); return;
      case "RestElement": visitPattern(p.argument, scopes, declaring); return;
      case "AssignmentPattern": visitPattern(p.left, scopes, declaring); visit(p.right, scopes); return;
      default: visit(p, scopes); // MemberExpression targets
    }
  };
  for (const n of nodes) {
    const hoisted = []; varNames(n, hoisted);
    visit(n, [new Set(hoisted)]);
  }
  return found;
}

export function analyse(files) {
  // files: {path: content}; returns {mods, refs: Map fromKey -> Set toKey, globals: Map fromKey -> Set, unresolved}
  const mods = {};
  for (const [p, src] of Object.entries(files)) if (src != null && /\.m?js$/.test(p)) { try { mods[p] = extract(src); } catch (e) { mods[p] = { error: String(e) }; } }
  const resolveExport = (T, x, hops, depth = 0, seen = new Set(), neg = []) => {
    if (depth > 8 || seen.has(T + "#" + x)) return null; seen.add(T + "#" + x);
    const m = mods[T]; if (!m || m.error) return null;
    for (const e of m.entities) if (e.exports.includes(x)) {
      if (e.kind === "reexport") {
        hops.push(`${T}#${e.name}`);
        const node = JSON.parse(e.canonical).nodes[0];
        const T2 = resolveSpecifier(T, node.source); if (T2 == null) return null;
        if (node.imported === "*") return T2; // file reference
        return resolveExport(T2, node.imported, hops, depth + 1, seen, neg);
      }
      return `${T}#${e.name}`;
    }
    if (x !== "default") for (const e of m.entities) if (e.kind === "reexport-all") {
      const node = JSON.parse(e.canonical).nodes[0];
      const T2 = resolveSpecifier(T, node.source); if (T2 == null) continue;
      const h = []; const ng = []; const r = resolveExport(T2, x, h, depth + 1, seen, ng);
      if (r) { hops.push(`${T}#${e.name}`, ...h); neg.push(`${T}#${x}`, ...ng); return r; }
    }
    return null;
  };
  const refs = new Map(), globals = new Map(), unresolved = [], negatives = new Map();
  for (const [p, m] of Object.entries(mods)) {
    if (m.error) continue;
    const top = new Set(m.entities.filter((e) => !["import", "reexport", "reexport-all", "top"].includes(e.kind)).map((e) => e.name));
    for (const e of m.entities) {
      const from = `${p}#${e.name}`; const set = new Set(); refs.set(from, set); const g = new Set(); globals.set(from, g); const ngs = new Set(); negatives.set(from, ngs);
      const addImport = (source, imported) => {
        const T = resolveSpecifier(p, source); if (T == null) return;
        if (imported === "*") { set.add(T); return; }
        const hops = []; const ng = []; const r = resolveExport(T, imported, hops, 0, new Set(), ng);
        hops.forEach((h) => set.add(h)); if (r) ng.forEach((h) => ngs.add(h));
        if (r) set.add(r); else unresolved.push({ from, to: `${T}#${imported}` });
      };
      if (e.kind === "import") {
        for (const st of e.raw) for (const sp of st.specifiers) {
          if (sp.type === "ImportSpecifier") addImport(st.source.value, sp.imported.name ?? sp.imported.value);
          else if (sp.type === "ImportDefaultSpecifier") addImport(st.source.value, "default");
          else addImport(st.source.value, "*");
        }
        continue;
      }
      if (e.kind === "reexport" || e.kind === "reexport-all") {
        const node = JSON.parse(e.canonical).nodes[0]; addImport(node.source, e.kind === "reexport-all" ? "*" : node.imported); continue;
      }
      for (const f of freeNames(e.raw)) {
        if (top.has(f.name)) { if (f.name !== e.name) set.add(`${p}#${f.name}`); }
        else if (m.imports.has(f.name)) {
          const im = m.imports.get(f.name);
          if (im.imported === "*") { if (f.member) addImport(im.source, f.member); else addImport(im.source, "*"); }
          else addImport(im.source, im.imported);
        } else g.add(f.name);
      }
    }
  }
  return { mods, refs, globals, unresolved, negatives };
}

export function regionTargets(src, start, end) {
  const { regions } = extract(src);
  const names = [];
  for (const r of regions) if (start < r.end && end > r.start) for (const n of r.names) if (!names.includes(n)) names.push(n);
  return names;
}
export function occurrences(hay, needle) {
  const out = []; let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { out.push(i); i += 1; }
  return out;
}
