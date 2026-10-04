// Scratch simulator of the pure core in docs/spec/01-core.md (revision 2), written from the spec text,
// used only to cross-check premise-cases.json. Not product code.
import { analyse, extract, blobOid, sha256hex, occurrences } from "./ref.mjs";

const H = (s) => sha256hex(s).slice(0, 32);
const HM = (members) => H(JSON.stringify([...members].sort()));
const isModule = (p) => /\.m?js$/.test(p);
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "/");
const pathOf = (k) => k.split("#")[0];
const cache = new Map();
function an(files) {
  const k = JSON.stringify(Object.entries(files).sort());
  if (!cache.has(k)) cache.set(k, analyse(files));
  return cache.get(k);
}
function entity(files, key) {
  const [path, name] = [key.slice(0, key.indexOf("#")), key.slice(key.indexOf("#") + 1)];
  const m = an(files).mods[path];
  if (!m || m.error) return null;
  return m.entities.find((e) => e.name === name) || null;
}
function entityKeys(files, path) {
  const m = an(files).mods[path];
  if (!m || m.error) return null;
  return m.entities.map((e) => `${path}#${e.name}`);
}
function listing(files, dir) {
  const prefix = dir === "/" ? "" : dir;
  const names = new Set();
  for (const p of Object.keys(files)) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    names.add(rest.includes("/") ? rest.slice(0, rest.indexOf("/") + 1) : rest);
  }
  return [...names].sort();
}
function targetsOf(files, path, start, end) {
  const m = an(files).mods[path];
  if (!m || m.error) return [path];
  const names = [];
  for (const r of m.regions) if (start < r.end && end > r.start) for (const n of r.names) if (!names.includes(n)) names.push(n);
  return names.map((n) => `${path}#${n}`);
}
// 2.6: container -> number of matches. A directory scope is recursive.
function textCounts(files, scope, needle) {
  const out = new Map();
  for (const [p, src] of Object.entries(files)) {
    const inScope = scope === "/" || (scope.endsWith("/") ? p.startsWith(scope) : p === scope);
    if (!inScope) continue;
    for (const o of occurrences(src, needle)) for (const t of targetsOf(files, p, o, o + needle.length)) out.set(t, (out.get(t) || 0) + 1);
  }
  return out;
}
const textMembers = (files, scope, needle) => [...textCounts(files, scope, needle)].map(([c, n]) => `${c}*${n}`).sort();
const memberContainer = (m) => m.slice(0, m.lastIndexOf("*"));
const memberCount = (m) => Number(m.slice(m.lastIndexOf("*") + 1));
// 6.2: referrers of E include whole-module referrers of E's module.
function referrers(files, key) {
  const out = []; const path = pathOf(key);
  for (const [from, set] of an(files).refs) if (from !== key && (set.has(key) || set.has(path))) out.push(from);
  return out.sort();
}
function moduleHash(files, path) {
  const m = an(files).mods[path];
  return H(JSON.stringify(m.entities.map((e) => `${e.name} ${e.hash}`).sort()));
}
function refsMembers(files, key) {
  const r = referrers(files, key);
  const mods = [...new Set(r.map(pathOf))].map((p) => `${p}@${moduleHash(files, p)}`);
  return [...r, ...mods].sort();
}
function outlineLines(files, path) {
  const m = an(files).mods[path];
  return m.entities.map((e) => `${e.name}|${e.kind}|${e.exports.join(",")}|${e.arity ?? ""}`).sort();
}
export function keyHash(files, kind, key) {
  if (kind === "entity") { const e = entity(files, key); return { hash: e ? e.hash : "absent", members: null }; }
  if (kind === "file") return { hash: key in files ? blobOid(files[key]) : "absent", members: null };
  if (kind === "listing") { const m = listing(files, key); return { hash: HM(m), members: m }; }
  let m;
  if (key.startsWith("text:")) { const rest = key.slice(5); const i = rest.indexOf(":"); m = textMembers(files, rest.slice(0, i), rest.slice(i + 1)); }
  else if (key.startsWith("refs:")) m = refsMembers(files, key.slice(5));
  else { const p = key.slice(8); if (!(p in files)) return { hash: "absent", members: [] }; m = outlineLines(files, p); }
  return { hash: HM(m), members: m };
}
// Agent inbox rule HU6a: show only a contiguous run; a gap asks for a sync.
export function inboxNext(shown_hn, inbox) {
  const have = new Set(inbox); const show = []; let n = shown_hn + 1;
  while (have.has(n)) { show.push(n); n += 1; }
  return { show, sync: inbox.some((h) => h >= n) };
}

function globMatch(pattern, path) {
  const re = "^" + pattern.split("/").map((seg) => seg === "**" ? "\u0000" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("/")
    .replace(/\u0000\//g, "(?:.*/)?").replace(/\/\u0000/g, "(?:/.*)?").replace(/\u0000/g, ".*") + "$";
  return new RegExp(re).test(path);
}
const DEFAULT_GLOBALS = ["Math", "Number", "String", "Boolean", "Array", "Object", "JSON", "Map", "Set", "Infinity", "NaN", "undefined", "isFinite", "isNaN", "parseInt", "parseFloat"];
const WAITING = ["submitted", "validated", "held"];

export class Core {
  constructor(files, constants, attempts) {
    this.K = constants;
    this.head = { seq: 0, files: { ...files } };
    this.history = [{ ...files }];
    this.attempts = new Map();
    this.order = 0;
    for (const [name, a] of Object.entries(attempts)) {
      this.attempts.set(name, { name, intent: a.intent, intent_id: a.intent_id ?? "i:" + name, state: "opened", stop_reason: null, go_arounds: 0, pull_backs: 0, row: null, revision: 1,
        premises: new Map(), ops: [], opCount: 0, heads: [], lastCall: null, submit_id: null, validated_order: null,
        resolved: new Set(), e1: new Set(), tier: null, approved: false, bypass: false, landed_seq: null });
    }
    this.landings = []; this.outbox = null; this.pool_state = "ready"; this.undoQueue = []; this.cards = [];
    this.pendingTriage = []; this.batchId = 0; this.clock = 0;
    this.out = null;
  }
  begin() { this.out = { judgments: [], heads_ups: [], cards: [], events: [], accepted: [], skipped: {}, landings: [], landed: [], reasked: [] }; }
  ev(t) { this.out.events.push(t); }

  // ---------- attempt view and sets ----------
  curOps(a) { return a.ops.filter((o) => !o.dropped); }
  replay(ops, tree, opts = {}) {
    const files = { ...tree }; const failed = [];
    const badPaths = new Set();
    for (const o of ops) {
      if (badPaths.has(o.path)) continue;
      let rule = null;
      if (o.op === "write") {
        // OP5 applies to every write, against the tree the replay started from.
        if (!opts.noOP5) { const cur = o.path in tree ? blobOid(tree[o.path]) : "absent"; if (cur !== o.base_oid) rule = "OP5"; }
        if (!rule) { if (o.content === null) delete files[o.path]; else files[o.path] = o.content; }
      } else {
        if (!(o.path in files)) rule = "OP4";
        else {
          const occ = occurrences(files[o.path], o.old);
          if (occ.length === 0) rule = "OP1"; else if (occ.length > 1) rule = "OP2";
          else {
            const t = targetsOf(files, o.path, occ[0], occ[0] + o.old.length);
            if (!opts.noOP3 && JSON.stringify(t) !== JSON.stringify(o.targets)) rule = "OP3";
            else files[o.path] = files[o.path].slice(0, occ[0]) + o.new + files[o.path].slice(occ[0] + o.old.length);
          }
        }
      }
      if (rule) { failed.push({ op_seq: o.op_seq, path: o.path, rule }); badPaths.add(o.path); }
    }
    if (failed.length) for (const p of badPaths) { if (p in tree) files[p] = tree[p]; else delete files[p]; }
    return { files, failed };
  }
  view(a, tree = this.head.files) { return this.replay(this.curOps(a), tree).files; }
  // 6.3: Added, Altered, NewRefs, ModuleRefs, AddedRefs, Edited
  sets(a, tree = this.head.files) {
    const v = this.view(a, tree); const A = an(v), Hd = an(tree);
    const added = [], altered = [], removed = [];
    const paths = new Set(this.curOps(a).map((o) => o.path));
    for (const p of paths) {
      const hk = entityKeys(tree, p) || [], vk = entityKeys(v, p) || [];
      for (const k of vk) { if (!hk.includes(k)) added.push(k); else if (entity(v, k).hash !== entity(tree, k).hash) altered.push(k); }
      for (const k of hk) if (!vk.includes(k)) removed.push(k);
    }
    const Altered = [...altered, ...removed];
    const newRefs = new Set(), moduleRefs = new Set(), addedRefs = new Set(), negatives = new Set();
    for (const k of [...added, ...altered]) { for (const r of A.refs.get(k) || []) if (!added.includes(r)) newRefs.add(r); for (const n of A.negatives.get(k) || []) { newRefs.add(n); negatives.add(n); } }
    for (const k of added) for (const r of A.refs.get(k) || []) if (!added.includes(r)) addedRefs.add(r);
    for (const k of altered) { const before = Hd.refs.get(k) || new Set(); for (const r of A.refs.get(k) || []) if (!added.includes(r) && !before.has(r)) addedRefs.add(r); }
    for (const p of paths) for (const k of entityKeys(v, p) || []) {
      for (const r of A.refs.get(k) || []) if (!added.includes(r) && !newRefs.has(r)) moduleRefs.add(r);
      for (const n of A.negatives.get(k) || []) { if (!newRefs.has(n)) moduleRefs.add(n); negatives.add(n); }
    }
    const edited = new Set(Altered);
    for (const p of a.premises.values()) if (p.edit) edited.add(p.key);
    return { view: v, Added: added, Altered, NewRefs: newRefs, ModuleRefs: moduleRefs, AddedRefs: addedRefs, Negatives: negatives, Edited: edited, A, Hd, paths };
  }
  literalNames(a, s) {
    const names = new Set();
    const walk = (n) => { if (!n || typeof n !== "object") return; if (Array.isArray(n)) return n.forEach(walk);
      if (n.type === "Literal" && typeof n.value === "string") names.add(n.value);
      if (n.type === "TemplateElement") names.add(n.value.cooked);
      for (const k of Object.keys(n)) if (k !== "type" && n[k] && typeof n[k] === "object") walk(n[k]); };
    for (const k of [...s.Added, ...s.Altered]) { const e = entity(s.view, k); if (e) e.raw.forEach(walk); }
    return names;
  }
  // "sweeping D" (7.2): operations on at least min(2, n) distinct paths directly in D that exist in `tree`
  sweeping(a, dir, tree) {
    const n = listing(tree, dir).filter((x) => !x.endsWith("/")).length;
    if (n === 0) return false;
    const touched = new Set(this.curOps(a).filter((o) => dirOf(o.path) === dir && o.path in tree).map((o) => o.path));
    return touched.size >= Math.min(2, n);
  }
  created(a, tree) { return new Set(this.curOps(a).filter((o) => !(o.path in tree)).map((o) => o.path)); }

  // ---------- premises ----------
  pin(a, kind, key, flags, files = this.head.files, seq = this.head.seq) {
    const id = kind + "|" + key; const h = keyHash(files, kind, key);
    let p = a.premises.get(id);
    if (!p) { p = { kind, key, hash: h.hash, seq, members: h.members, read: false, edit: false, derived: false, status: "holds", shown: null }; a.premises.set(id, p); }
    else if (flags.repin) { p.hash = h.hash; p.seq = seq; p.members = h.members; }
    for (const f of ["read", "edit", "derived"]) if (flags[f]) p[f] = true;
    if (flags.read) p.shown = kind === "listing" ? [...h.members] : h.hash;   // what the agent was shown by this tool call
    return p;
  }
  ref(p) { return { kind: p.kind, key: p.key, hash: p.hash, seq: p.seq, read: p.read, edit: p.edit, derived: p.derived }; }
  // R4, W4, D1, D1b, D2 after every change of the operations. Returns the premises created or whose flags changed (TA7).
  syncPremises(a) {
    const head = this.head.files; const s = this.sets(a); const changed = new Set();
    const flag = (kind, key, f) => { const had = a.premises.get(kind + "|" + key); const p = this.pin(a, kind, key, {}); if (!had || !p[f]) { p[f] = true; changed.add(p); } return p; };
    // edit flags
    const wantEdit = new Set();
    for (const o of this.curOps(a)) {
      if (o.op === "write") wantEdit.add("file|" + o.path);
      else for (const t of o.targets) { if (t.includes("#")) { if (entity(head, t)) wantEdit.add("entity|" + t); } else if (t in head) wantEdit.add("file|" + t); }
    }
    for (const k of s.Added) if (pathOf(k) in head) wantEdit.add("entity|" + k);          // absence pinned (R4a)
    // derived flags
    const wantDerived = new Set();
    for (const K of [...s.NewRefs, ...s.ModuleRefs]) {
      if (K.includes("#")) { if (entity(head, K) || s.Negatives.has(K)) wantDerived.add("entity|" + K); } else if (K in head) wantDerived.add("file|" + K);   // D1b: a negative lookup is pinned at absent
    }
    for (const K of s.Altered) wantDerived.add("query|refs:" + K);                       // D2
    for (const id of wantEdit) { const i = id.indexOf("|"); flag(id.slice(0, i), id.slice(i + 1), "edit"); }
    for (const id of wantDerived) { const i = id.indexOf("|"); flag(id.slice(0, i), id.slice(i + 1), "derived"); }
    for (const [id, p] of [...a.premises]) {
      if (p.kind === "query" && !p.key.startsWith("refs:")) continue;
      if (p.kind === "listing") continue;
      if (p.edit && !wantEdit.has(id)) p.edit = false;
      if (p.derived && !wantDerived.has(id)) p.derived = false;
      if (!p.read && !p.edit && !p.derived) { a.premises.delete(id); changed.delete(p); this.ev("premise.removed"); this.pendingTriage = this.pendingTriage.filter((t) => t.p !== p); }
    }
    return [...changed];
  }

  // ---------- classification (section 7) ----------
  rowFor(a, p, it, s, before, after) {
    const hasOps = this.curOps(a).length > 0;
    const readCovered = p.read || (p.kind === "entity" && a.premises.get("file|" + pathOf(p.key))?.read);
    let row;
    if (p.kind === "entity") {
      if (p.edit || s.Edited.has(p.key)) row = ["E1", "repair", "edited_entity_changed"];
      else if (s.NewRefs.has(p.key)) row = ["E2", "repair", "referenced_entity_changed"];
      else if (s.ModuleRefs.has(p.key)) row = ["E2m", "confirm", "module_reference_changed"];
      else if (readCovered) row = ["E3", "triage", "read_not_referenced"];
      else row = ["E4", "delete", "reference_gone"];
    } else if (p.kind === "file") {
      const P = p.key; const mb = isModule(P) && entityKeys(before, P), ma = isModule(P) && entityKeys(after, P);
      const writes = this.curOps(a).some((o) => o.path === P && (o.op === "write" || !(mb)));
      if (p.edit && writes) row = ["F1", "repair", "write_base_changed"];
      else if (mb && ma) {
        const D = it.changed;
        if (D.length === 0) row = ["F2", "holds", "cosmetic"];
        else if (D.some((k) => s.NewRefs.has(k) || s.Edited.has(k)) || s.NewRefs.has(P)) row = ["F3", "repair", s.NewRefs.has(P) ? "referenced_file_changed" : "referenced_entity_changed"];
        else if (D.some((k) => s.ModuleRefs.has(k)) || s.ModuleRefs.has(P)) row = ["F3m", "confirm", "module_reference_changed"];
        else if (p.read) row = ["F4", "triage", "read_not_referenced"];
        else row = ["F7", "delete", "reference_gone"];
      } else {
        const all = [...s.NewRefs, ...s.ModuleRefs];
        const referenced = all.includes(P) || all.some((k) => k.startsWith(P + "#"));
        if (referenced) row = ["F5", "repair", "referenced_file_changed"];
        else if (p.read) row = ["F6", "triage", "read_not_referenced"];
        else row = ["F7", "delete", "reference_gone"];
      }
    } else if (p.kind === "listing") {
      const created = this.created(a, before); const prefix = p.key === "/" ? "" : p.key;
      const unshown = it.members.filter((n) => !(p.shown || []).includes(n) && !created.has(prefix + n));
      const lit = this.literalNames(a, s);
      const named = [...it.added, ...it.removed].some((n) => !created.has(prefix + n) && (lit.has(n) || lit.has(n.replace(/\.[^.]*$/, ""))));
      if (unshown.length && this.sweeping(a, p.key, before)) { row = ["L1", "repair", "sweep_incomplete"]; it.added = unshown; }
      else if (named) row = ["L2", "confirm", "listing_named"];
      else row = ["L3", "holds", "listing_unused"];
    } else if (p.key.startsWith("text:")) {
      const pinned = it.oldMembers.map(memberContainer);
      const swept = pinned.filter((c) => (c.includes("#") ? s.Altered.includes(c) : this.curOps(a).some((o) => o.path === c))).length;
      if (it.added.length && pinned.length && swept >= Math.min(2, pinned.length)) row = ["QT1", "repair", "sweep_incomplete"];
      else if (it.added.length) row = ["QT2", "triage", "search_gained_match"];
      else row = ["QT3", "holds", "match_lost"];
    } else if (p.key.startsWith("refs:")) {
      if (!s.Altered.includes(p.key.slice(5))) row = ["QR3", "delete", "n/a"];
      else if (it.added.length) row = ["QR1", "repair", "new_reference_to_altered_entity"];
      else if (it.context.length) row = ["QR1m", "confirm", "referrer_module_changed"];
      else row = ["QR2", "holds", "match_lost"];
    } else {
      const path = p.key.slice(8);
      const changedNames = [...it.oldMembers.filter((l) => !it.members.includes(l)), ...it.members.filter((l) => !it.oldMembers.includes(l))].map((l) => path + "#" + l.split("|")[0]);
      if (changedNames.some((k) => s.NewRefs.has(k) || s.Edited.has(k))) row = ["QO1", "repair", "outlined_entity_changed"];
      else row = ["QO2", "holds", "outline_unused"];
    }
    if (row[1] === "triage" && !hasOps) row = ["X0", "info", "no_patch_yet"];
    return row;
  }
  // landers: the landing changes being classified against (for row QR4): [{ premises }]
  classify(a, before, after, setsOverride, landers = []) {
    const s = setsOverride || this.sets(a, before);
    const items = [];
    for (const p of a.premises.values()) {
      const cur = keyHash(after, p.kind, p.key);
      if (cur.hash === p.hash) continue;
      const it = { p, kind: p.kind, key: p.key, old_hash: p.hash, new_hash: cur.hash, members: cur.members, oldMembers: p.members, before, after };
      if (p.kind === "entity") { it.after_src = entity(after, p.key) ? this.source(after, p.key) : null; }
      else if (p.kind === "file") {
        const P = p.key; const mb = isModule(P) && entityKeys(before, P), ma = isModule(P) && entityKeys(after, P);
        it.changed = [];
        if (mb && ma) for (const k of new Set([...mb, ...ma])) { const b = entity(before, k), c = entity(after, k); if (!b || !c || b.hash !== c.hash) it.changed.push(k); }
      } else if (p.kind === "listing") {
        it.added = cur.members.filter((n) => !p.members.includes(n)); it.removed = p.members.filter((n) => !cur.members.includes(n));
      } else if (p.key.startsWith("text:")) {
        const oldC = new Map(p.members.map((m) => [memberContainer(m), memberCount(m)])), newC = new Map(cur.members.map((m) => [memberContainer(m), memberCount(m)]));
        it.added = [...newC].filter(([c, n]) => n > (oldC.get(c) || 0)).map(([c]) => c).sort();
        it.removed = [...oldC].filter(([c, n]) => n > (newC.get(c) || 0)).map(([c]) => c).sort();
      } else if (p.key.startsWith("refs:")) {
        const isRef = (m) => m.includes("#");
        it.added = cur.members.filter((m) => isRef(m) && !p.members.includes(m)); it.removed = p.members.filter((m) => isRef(m) && !cur.members.includes(m));
        // context: entities added or altered between before and after in the modules that hold a referrer now
        it.context = [];
        const mods = new Set(cur.members.filter(isRef).map(pathOf));
        for (const m of mods) for (const k of entityKeys(after, m) || []) { const b = (m in before) ? entity(before, k) : null; if ((!b || b.hash !== entity(after, k).hash) && !it.added.includes(k)) it.context.push(k); }
        it.context.sort();
      }
      const row = this.rowFor(a, p, it, s, before, after);
      it.rule = row[0]; it.result = row[1]; it.reason = row[2];
      // HU2a: a file item is folded when entity items of the same classification carry every relevant changed entity
      items.push(it);
    }
    for (const it of items) if (it.kind === "file" && (it.rule === "F3" || it.rule === "F3m") && !s.NewRefs.has(it.key) && !s.ModuleRefs.has(it.key)) {
      const rel = it.changed.filter((k) => s.NewRefs.has(k) || s.Edited.has(k) || s.ModuleRefs.has(k));
      if (rel.length && rel.every((k) => items.some((x) => x.kind === "entity" && x.key === k && (x.result === "repair" || x.result === "confirm")))) it.folded = true;
    }
    // QR4: a landing that only read K, while this attempt alters K
    const rep = this.replay(this.curOps(a), after);
    for (const K of s.Altered) {
      if (!entity(before, K) || rep.failed.some((f) => f.path === pathOf(K))) continue;
      const reader = landers.some((l) => l.premises.some((q) => q.read && !q.edit && !q.derived &&
        ((q.kind === "entity" && q.key === K) || (q.kind === "file" && q.key === pathOf(K) && !l.premises.some((r) => r.kind === "entity" && r.key === K && (r.edit || r.derived))))));
      if (!reader) continue;
      const p = a.premises.get("query|refs:" + K); if (!p) continue;
      let it = items.find((x) => x.p === p);
      if (it && (it.result === "repair" || it.result === "confirm")) continue;
      if (!it) { it = { p, kind: p.kind, key: p.key, old_hash: p.hash, new_hash: p.hash, members: p.members, oldMembers: p.members, added: [], removed: [], context: [], before, after }; items.push(it); }
      it.rule = "QR4"; it.result = "triage"; it.reason = "reader_landed";
    }
    return { items, failed: rep.failed, sets: s };
  }
  source(files, key) { const e = entity(files, key); if (!e) return null; const path = pathOf(key); const m = an(files).mods[path];
    return m.regions.filter((r) => r.names.includes(e.name)).map((r) => files[path].slice(r.start, r.end)).join("").replace(/^\n+/, ""); }
  hItem(it, result) { const p = it.p;
    if (p.kind === "entity") p.shown = p.hash; else if (p.kind === "listing") p.shown = [...p.members];
    return { kind: p.kind, key: p.key, rule: it.rule, result, added: it.added, removed: it.removed, context: it.context, after: it.after_src }; }

  // apply a classification to an in-flight (or parked) attempt
  applyClassification(a, c, after, seq, cause, causeAttempt) {
    const hItems = []; let strongest = null; const e1keys = [];
    for (const it of c.items) {
      const p = it.p;
      if (it.result === "delete") { a.premises.delete(p.kind + "|" + p.key); this.ev("premise.removed"); continue; }
      const cur = keyHash(after, p.kind, p.key); p.hash = cur.hash; p.seq = seq; p.members = cur.members;
      const j = { attempt: a.name, kind: p.kind, key: p.key, rule: it.rule, class: it.result === "triage" ? "triage" : "rule" };
      if (it.result !== "triage") j.result = it.result === "info" ? "holds" : it.result;
      this.out.judgments.push(j); this.ev("premise.judged");
      if (it.folded) { p.status = "holds"; continue; }
      if (it.result === "triage") {
        p.status = "pending_triage"; this.pendingTriage.push({ a, p, it, cause, stamp: a.opCount });
        hItems.push(this.hItem(it, "pending")); if (!strongest) strongest = "info"; continue;
      }
      if (it.result === "repair") { p.status = "pending_repair"; strongest = "repair"; if (it.rule === "E1") e1keys.push(p.key); }
      else if (it.result === "confirm") { p.status = "pending_confirm"; if (strongest !== "repair") strongest = "confirm"; }
      else if (it.result === "info") { if (!strongest) strongest = "info"; }
      if (it.result !== "holds") hItems.push(this.hItem(it, it.result === "info" ? "holds" : it.result));
    }
    const dropped = this.dropFailed(a, c.failed);
    if (dropped.length) strongest = "repair";
    if (!strongest) return;
    this.sendHeadsUp(a, strongest, hItems, dropped, cause, e1keys, causeAttempt);
  }
  dropFailed(a, failed) {
    const dropped = [];
    for (const f of failed) for (const o of a.ops) if (!o.dropped && o.path === f.path) { o.dropped = true; dropped.push({ op_seq: o.op_seq, rule: f.rule }); }
    if (dropped.length) { this.syncPremises(a); this.ev("op.dropped"); }
    return dropped;
  }
  sentBack(a) { return a.go_arounds + a.pull_backs; }
  sendHeadsUp(a, result, items, dropped, cause, e1keys = [], causeAttempt = null) {
    const hn = a.heads.length + 1;
    const wake = result !== "info" && a.state !== "stopped";
    const h = { hn, result, items, dropped_ops: dropped, cause, resolved: result === "info", delivered: false };
    a.heads.push(h);
    this.out.heads_ups.push({ to: a.name, hn, result, cause, wake, items: items.map((i) => ({ ...i })), dropped_ops: dropped });
    this.ev("headsup.sent");
    if (result === "repair") this.enterRepair(a, h, e1keys, causeAttempt);
    else if (result === "confirm" && WAITING.includes(a.state)) {       // T11: a pull-back
      this.closeCard(a, "stale");
      if (this.sentBack(a) >= this.K.GO_AROUND_LIMIT) { this.setState(a, "stopped", "go_around_limit"); this.openCard("choice", "go_around_limit", [a.name]); return; }
      this.setState(a, "needs_confirm"); a.pull_backs += 1; this.unvalidate(a);
      if (this.sentBack(a) === this.K.STARVATION_AFTER) a.row = ++this.clock;
    }
  }
  unvalidate(a) { a.submit_id = null; a.validated_order = null; a.approved = false; a.bypass = false; }
  setState(a, st, reason = null) { if (a.state !== st) { a.state = st; this.ev("attempt.state"); } if (reason) a.stop_reason = reason; }
  closeCard(a, why) { for (const c of this.cards) if (c.open && c.attempts.includes(a.name) && c.kind !== "choice") { c.open = false; this.ev("card.closed"); } a.approved = false; }
  enterRepair(a, h, e1keys, causeAttempt) {
    if (a.state === "stopped") { e1keys.forEach((k) => a.e1.add(k)); return; }           // parked: the heads-up waits (GL3a)
    if (a.state === "going_around") {
      // GA1: joins unless every earlier unresolved repair heads-up was already delivered
      const earlier = a.heads.filter((x) => x !== h && x.result === "repair" && !x.resolved);
      if (earlier.some((x) => !x.delivered)) { e1keys.forEach((k) => a.e1.add(k)); return; }
    }
    const contradiction = e1keys.some((k) => a.e1.has(k)) && causeAttempt && causeAttempt.intent_id !== a.intent_id;
    e1keys.forEach((k) => a.e1.add(k));
    this.closeCard(a, "stale");
    if (contradiction) { this.setState(a, "stopped", "contradiction"); this.openCard("choice", "contradiction", [a.name, causeAttempt.name]); return; }
    if (this.sentBack(a) >= this.K.GO_AROUND_LIMIT) { this.setState(a, "stopped", "go_around_limit"); this.openCard("choice", "go_around_limit", [a.name]); return; }
    if (a.state === "going_around") this.ev("attempt.state"); else this.setState(a, "going_around");
    a.go_arounds += 1; this.unvalidate(a);
    if (this.sentBack(a) === this.K.STARVATION_AFTER) a.row = ++this.clock;
  }
  openCard(kind, reason, attempts, extra = {}) { const c = { kind, reason, attempts, open: true, ...extra }; this.cards.push(c); this.out.cards.push({ kind, reason, attempts, ...extra }); this.ev("card.opened"); return c; }

  // ---------- tools ----------
  tool(name, step) {
    const a = this.attempts.get(name); const callId = step.call_id;
    if (a.lastCall && callId && a.lastCall.id === callId) return a.lastCall.resp;
    const ack = step.ack ?? a.heads.length;
    for (const h of a.heads) if (h.hn <= ack) h.delivered = true;                         // HU8
    const resp = this.toolInner(a, step.do, step.args || {}, ack);
    resp.heads_ups = a.heads.filter((h) => h.hn > ack).map((h) => h.hn);
    resp.attempt = { state: a.state, go_arounds: a.go_arounds };
    a.lastCall = { id: callId, resp };
    return resp;
  }
  err(code, premises = []) { return { ok: false, error: { code }, premises }; }
  // V7: operations changed while a triage is pending
  reevaluate(a) {
    const s = this.sets(a);
    const items = []; let strongest = null; const e1keys = [];
    for (const t of this.pendingTriage.filter((x) => x.a === a)) {
      const row = t.it.rule === "QR4" ? ["QR4", "triage"] : this.rowFor(a, t.p, t.it, s, t.it.before, t.it.after);
      if (row[1] === "triage") { t.stamp = a.opCount; this.out.reasked.push({ attempt: a.name, kind: t.p.kind, key: t.p.key }); continue; }
      if (row[1] !== "repair" && row[1] !== "confirm") { t.stamp = a.opCount; continue; }
      this.pendingTriage.splice(this.pendingTriage.indexOf(t), 1);
      t.it.rule = row[0]; t.it.result = row[1];
      this.out.judgments.push({ attempt: a.name, kind: t.p.kind, key: t.p.key, rule: row[0], class: "rule", result: row[1] }); this.ev("premise.judged");
      t.p.status = row[1] === "repair" ? "pending_repair" : "pending_confirm";
      if (row[1] === "repair") { strongest = "repair"; if (row[0] === "E1") e1keys.push(t.p.key); } else if (!strongest) strongest = "confirm";
      items.push(this.hItem(t.it, row[1]));
    }
    if (strongest) this.sendHeadsUp(a, strongest, items, [], "landing", e1keys, null);
  }
  // late L1: the attempt became a sweep of a directory that gained names it was never shown
  lateSweep(a) {
    const head = this.head.files; const items = [];
    for (const p of a.premises.values()) {
      if (p.kind !== "listing" || p.status !== "holds") continue;
      const created = this.created(a, head); const prefix = p.key === "/" ? "" : p.key;
      const unshown = p.members.filter((n) => !(p.shown || []).includes(n) && !created.has(prefix + n));
      if (!unshown.length || !this.sweeping(a, p.key, head)) continue;
      this.out.judgments.push({ attempt: a.name, kind: p.kind, key: p.key, rule: "L1", class: "rule", result: "repair" }); this.ev("premise.judged");
      p.status = "pending_repair"; p.shown = [...p.members];
      items.push({ kind: p.kind, key: p.key, rule: "L1", result: "repair", added: unshown, removed: [] });
    }
    if (items.length) this.sendHeadsUp(a, "repair", items, [], "landing");
  }
  afterOp(a) {
    // T22: an operation after a passing submit takes the attempt out of the landing queue
    if (WAITING.includes(a.state)) { this.closeCard(a, "stale"); this.unvalidate(a); a.tier = null; this.setState(a, "working"); }
    const premises = this.syncPremises(a);
    this.ev("op.recorded");
    this.reevaluate(a);
    this.lateSweep(a);
    return premises;
  }
  toolInner(a, tool, args, ack) {
    const isWrite = ["write", "replace", "submit"].includes(tool);
    if (isWrite && a.heads.some((h) => h.hn > ack)) return this.err("heads_up_first");
    if (isWrite && tool !== "submit" && this.pool_state !== "ready") return this.err("pool_not_ready");
    if (tool === "submit" && this.pool_state !== "ready" && !["accepted", "landed", "stopped"].includes(a.state)) return this.err("pool_not_ready");
    if (["accepted", "landed", "stopped"].includes(a.state) && tool !== "submit") return this.err("attempt_closed");
    if (a.state === "opened") this.setState(a, "working");
    const head = this.head.files; const v = this.view(a);
    if (tool === "outline") {
      if (!(args.path in head)) return this.err("not_found", [this.ref(this.pin(a, "file", args.path, { read: true, repin: true }))]);
      const p = this.pin(a, "query", "outline:" + args.path, { read: true, repin: true });
      return { ok: true, result: { path: args.path }, premises: [this.ref(p)] };
    }
    if (tool === "read") {
      if (!args.entity) {
        const p = this.pin(a, "file", args.path, { read: true, repin: true });
        if (!(args.path in v)) return this.err("not_found", [this.ref(p)]);
        return { ok: true, result: { path: args.path, content: v[args.path] }, premises: [this.ref(p)] };
      }
      const key = args.path + "#" + args.entity;
      if (!(args.path in head)) { const p = this.pin(a, "file", args.path, { read: true, repin: true }); return entity(v, key) ? { ok: true, result: { key, source: this.source(v, key) }, premises: [this.ref(p)] } : this.err("not_found", [this.ref(p)]); }
      const p = this.pin(a, "entity", key, { read: true, repin: true });
      if (!entity(v, key)) return this.err("not_found", [this.ref(p)]);
      return { ok: true, result: { key, source: this.source(v, key) }, premises: [this.ref(p)] };
    }
    if (tool === "list") {
      const dir = args.path.endsWith("/") ? args.path : args.path + "/";
      const p = this.pin(a, "listing", dir, { read: true, repin: true });
      return { ok: true, result: { path: dir, entries: listing(v, dir).map((n) => ({ name: n, type: n.endsWith("/") ? "dir" : "file" })) }, premises: [this.ref(p)] };
    }
    if (tool === "search") {
      const scope = args.path || "/";
      const p = this.pin(a, "query", `text:${scope}:${args.query}`, { read: true, repin: true });
      return { ok: true, result: { query: args.query, in: scope, containers: [...textCounts(v, scope, args.query).keys()].sort() }, premises: [this.ref(p)] };
    }
    if (tool === "write") {
      const P = args.path; const content = args.delete ? null : args.content;
      // W1: the agent must have been shown the bytes that are at head now
      if (P in head) { const fp = a.premises.get("file|" + P); if (!(fp && fp.read && fp.shown === blobOid(head[P]))) return this.err("read_first"); }
      if (content !== null && isModule(P)) { try { extract(content); } catch (e) { return this.err("parse_error"); } }
      if ((content === null && !(P in v)) || v[P] === content) return this.err("no_change");
      const op = { op_seq: ++a.opCount, op: "write", path: P, content, base_oid: P in head ? blobOid(head[P]) : "absent" };
      a.ops.push(op);
      const premises = this.afterOp(a);
      const s = this.sets(a);
      const relied = {}; for (const k of s.Altered) relied[k] = referrers(head, k);
      const hk = entityKeys(head, P) || [];
      return { ok: true, result: { path: P, op_seq: op.op_seq, created: !(P in head), added: s.Added.filter((k) => k.startsWith(P + "#")), altered: s.Altered.filter((k) => k.startsWith(P + "#") && entity(s.view, k)), removed: hk.filter((k) => !entity(s.view, k)), relied_on_by: relied }, premises: premises.map((p) => this.ref(p)) };
    }
    if (tool === "replace") {
      const P = args.path;
      if (!(P in v)) return this.err("not_found");
      if (!args.old || args.old === args.new) return this.err("no_change");
      const occ = occurrences(v[P], args.old);
      if (occ.length === 0) return this.err("no_match");
      if (occ.length > 1) return this.err("ambiguous");
      const next = v[P].slice(0, occ[0]) + args.new + v[P].slice(occ[0] + args.old.length);
      if (isModule(P)) { try { extract(next); } catch (e) { return this.err("parse_error"); } }
      const targets = targetsOf(v, P, occ[0], occ[0] + args.old.length);
      const op = { op_seq: ++a.opCount, op: "replace", path: P, old: args.old, new: args.new, targets };
      a.ops.push(op);
      const premises = this.afterOp(a);
      const s = this.sets(a);
      const relied = {}; for (const k of s.Altered) relied[k] = referrers(head, k);
      const hk = entityKeys(head, P) || [];
      return { ok: true, result: { path: P, op_seq: op.op_seq, targets, altered: s.Altered.filter((k) => k.startsWith(P + "#") && entity(s.view, k)), added: s.Added.filter((k) => k.startsWith(P + "#")), removed: hk.filter((k) => !entity(s.view, k)), relied_on_by: relied }, premises: premises.map((p) => this.ref(p)) };
    }
    return this.submit(a, args, ack);
  }

  submitId(a) { return "s_" + H([a.name, a.revision, a.opCount, [...a.resolved].sort((x, y) => x - y).join(",")].join("|")).slice(0, 16); }
  policyTier(files, paths) {
    let pol; try { pol = JSON.parse(files[".premise/policy.json"]); } catch { return "held"; }
    let tier = "auto";
    for (const p of paths) {
      let t = pol.default;
      if (p.startsWith(".premise/")) t = "held";
      else for (const r of pol.tiers) if (r.paths.some((g) => globMatch(g, p))) { t = r.tier; break; }
      if (t === "held") tier = "held";
    }
    return tier;
  }
  changedPaths(before, after) { return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((p) => before[p] !== after[p]); }
  submit(a, args, ack) {
    const fin = (result, premises = []) => { this.ev("submit.result"); return { ok: true, result, premises }; };
    // CK0
    if (a.state === "accepted") return fin({ status: "accepted", seq: a.landed_seq });
    if (a.state === "landed") return fin({ status: "landed", seq: a.landed_seq, commit: "commit-" + a.landed_seq });
    if (a.state === "stopped") return fin({ status: "stopped", reason: a.stop_reason });
    const newAcks = (args.acknowledge || []).filter((n) => !a.resolved.has(n));
    if (WAITING.includes(a.state) && newAcks.length === 0 && this.submitId(a) === a.submit_id)
      return fin({ status: a.state, submit_id: a.submit_id, tier: a.tier, duplicate: true });
    // CK1
    for (const n of args.acknowledge || []) {
      const h = a.heads.find((x) => x.hn === n); if (!h || n > ack) return this.err("invalid_args");
      h.resolved = true; a.resolved.add(n);
      for (const it of h.items) { const p = a.premises.get(it.kind + "|" + it.key); if (p && p.status !== "pending_triage") p.status = "holds"; }
    }
    const head = this.head.files;
    // CK2
    const rep = this.replay(this.curOps(a), head);
    if (rep.failed.length) { const dropped = this.dropFailed(a, rep.failed); this.sendHeadsUp(a, "repair", [], dropped, "submit"); return fin({ status: "go_around", unresolved: a.heads.filter((h) => !h.resolved).map((h) => h.hn) }); }
    // CK3
    const changed = this.changedPaths(head, rep.files);
    if (changed.length === 0) return fin({ status: "rejected", errors: [{ code: "empty_change" }] });
    const s = this.sets(a);
    // CK5
    const touched = new Set(changed);
    const unresolved = s.A.unresolved.filter((u) => touched.has(pathOf(u.from)) || touched.has(pathOf(u.to)));
    if (unresolved.length) return fin({ status: "rejected", errors: [{ code: "import_unresolved", detail: unresolved }] });
    // CK6
    let allow = DEFAULT_GLOBALS; try { const pol = JSON.parse(head[".premise/policy.json"]); if (pol.globals) allow = pol.globals; } catch {}
    for (const k of [...s.Added, ...s.Altered]) for (const g of s.A.globals.get(k) || []) if (!allow.includes(g)) return fin({ status: "rejected", errors: [{ code: "banned_global", detail: { entity: k, name: g } }] });
    // CK7: derived premises again, late sweep, blind spots among the references the attempt added
    const premises = this.syncPremises(a);
    this.lateSweep(a);
    const blind = [];
    for (const K of s.AddedRefs) {
      const isEntity = K.includes("#"); const p = a.premises.get((isEntity ? "entity|" : "file|") + K);
      if (!p || p.read || p.edit || p.shown !== null) continue;
      if (isEntity && a.premises.get("file|" + pathOf(K))?.read) continue;
      blind.push(p);
    }
    if (blind.length) {
      for (const p of blind) { p.status = "pending_confirm"; p.shown = p.hash; this.out.judgments.push({ attempt: a.name, kind: p.kind, key: p.key, rule: "B1", class: "rule", result: "confirm" }); }
      this.sendHeadsUp(a, "confirm", blind.map((p) => ({ kind: p.kind, key: p.key, rule: "B1", result: "confirm", after: p.kind === "entity" ? this.source(head, p.key) : null })), [], "submit");
    }
    // CK8
    const open = a.heads.filter((h) => !h.resolved);
    if (open.length || [...a.premises.values()].some((p) => p.status === "pending_confirm" || p.status === "pending_repair")) {
      const repair = open.some((h) => h.result === "repair");
      if (!repair) this.setState(a, "needs_confirm");
      return fin({ status: repair ? "go_around" : "needs_confirm", unresolved: open.map((h) => h.hn) }, premises.map((p) => this.ref(p)));
    }
    // CK9
    a.tier = this.policyTier(head, changed); a.submit_id = this.submitId(a); a.summary = args.summary;
    const waiting = [...a.premises.values()].some((p) => p.status === "pending_triage");
    if (a.tier === "held") {
      this.setState(a, "held"); a.approved = false;
      this.openCard("held", "held_path", [a.name], { blast_radius: this.blast(a) });
      return fin({ status: "held", submit_id: a.submit_id, tier: "held" }, premises.map((p) => this.ref(p)));
    }
    if (waiting) { this.setState(a, "submitted"); return fin({ status: "submitted", submit_id: a.submit_id, waiting_for: ["triage"] }, premises.map((p) => this.ref(p))); }
    this.setState(a, "validated"); a.validated_order = ++this.order;
    return fin({ status: "validated", submit_id: a.submit_id, tier: "auto" }, premises.map((p) => this.ref(p)));
  }
  inflight() { return [...this.attempts.values()].filter((a) => ["working", "going_around", "needs_confirm", "submitted", "validated", "held"].includes(a.state)); }
  parked() { return [...this.attempts.values()].filter((a) => a.state === "stopped" && this.cards.some((c) => c.open && c.kind === "choice" && c.attempts[0] === a.name)); }
  frozen(a) { return { premises: [...a.premises.values()].map((p) => ({ ...p })) }; }
  worst(c) { return c.failed.length || c.items.some((i) => i.result === "repair") ? "repair" : c.items.some((i) => i.result === "confirm" && !i.folded) ? "confirm" : c.items.some((i) => i.result === "triage") ? "triage" : null; }
  blast(a) {
    const after = this.replay(this.curOps(a), this.head.files).files; const out = { repair: [], confirm: [], triage: [] };
    for (const o of this.inflight()) { if (o === a) continue; const res = this.worst(this.classify(o, this.head.files, after, null, [this.frozen(a)])); if (res) out[res].push(o.name); }
    return out;
  }

  // ---------- landing (section 9) ----------
  writeSet(before, after) {
    const w = [];
    const paths = this.changedPaths(before, after);
    for (const p of paths) {
      w.push({ kind: "file", key: p });
      const kb = entityKeys(before, p) || [], ka = entityKeys(after, p) || [];
      for (const k of new Set([...kb, ...ka])) { const b = entity(before, k), c = entity(after, k); if (!b || !c || b.hash !== c.hash) w.push({ kind: "entity", key: k }); }
    }
    return { w, paths };
  }
  tick() {
    if (this.pool_state !== "ready" || this.outbox) return;
    const pre = this.head.files; let running = { ...pre }; let seq = this.head.seq; const batch = [];
    const reopened = [];
    // undo requests
    for (const u of this.undoQueue.splice(0)) {
      const plan = this.planUndo(u.seq, running);
      const before = running; running = plan.files; seq += 1;
      const l = { seq, kind: "undo", attempt: null, before, after: running, ...this.writeSet(before, running), premises: [], ops: [], undoes: plan.reverted, pushed: false };
      batch.push(l); this.out.accepted.push("undo:" + u.seq); this.out.landings.push({ seq, kind: "undo", undoes: plan.reverted });
      for (const s of plan.reverted) {
        const x = this.landings.find((y) => y.seq === s); x.undone_by = seq; const a = this.attempts.get(x.attempt);
        if (s === u.seq) this.setState(a, "stopped", "undone");
        else {
          // T19
          a.state = "going_around"; this.ev("attempt.state"); this.ev("attempt.reopened"); a.revision += 1; a.go_arounds += 1; a.row = null; this.unvalidate(a);
          a.ops = x.ops.map((o) => ({ ...o, dropped: false, ...(o.op === "write" ? { base_oid: o.path in running ? blobOid(running[o.path]) : "absent" } : {}) }));
          a.opCount = Math.max(...a.ops.map((o) => o.op_seq));
          a.premises = new Map(x.premises.map((p) => [p.kind + "|" + p.key, { ...p, status: "holds", shown: null }])); reopened.push({ a, plan, x });
        }
      }
    }
    // candidates (9.3)
    const cands = this.inflight().filter((a) => a.state === "validated" && [...a.premises.values()].every((p) => p.status === "holds") && a.heads.every((h) => h.resolved) && a.submit_id === this.submitId(a))
      .sort((x, y) => (x.row ?? Infinity) - (y.row ?? Infinity) || x.validated_order - y.validated_order);
    const inBatch = new Set(); const members = [];
    for (const c of cands) {
      if (batch.length >= this.K.MAX_BATCH) break;
      const after = this.replay(this.curOps(c), running);
      // 3a right of way
      let blocked = null;
      if (!after.failed.length && !c.bypass) for (const P of this.inflight()) {
        if (P === c || inBatch.has(P) || P.row == null) continue;
        if (c.row != null && c.row < P.row) continue;
        const w = this.worst(this.classify(P, running, after.files, null, [this.frozen(c)]));
        if (w === "repair" || w === "confirm") { blocked = P; break; }
      }
      if (blocked) { this.out.skipped[c.name] = "right_of_way"; this.ev("tick.skipped"); continue; }
      // 3b disjoint: a dry run; nothing is committed for a skipped candidate
      const cl = this.classify(c, pre, running, this.sets(c, pre), members);
      if (cl.failed.length || cl.items.some((i) => i.result !== "holds" && i.result !== "delete")) { this.out.skipped[c.name] = "not_disjoint"; this.ev("tick.skipped"); continue; }
      // 3c checks against running: non_empty and the tier under the running policy
      const changed = this.changedPaths(running, after.files);
      if (changed.length === 0) {
        this.out.skipped[c.name] = "checks_failed"; this.ev("tick.skipped");
        this.out.judgments.push({ attempt: c.name, kind: "check", key: "non_empty", rule: "CKL", class: "rule", result: "repair" });
        this.sendHeadsUp(c, "repair", [{ kind: "check", key: "non_empty", rule: "CKL", result: "repair" }], [], "landing"); continue;
      }
      if (this.policyTier(running, changed) === "held" && !c.approved) {
        this.out.skipped[c.name] = "held"; this.ev("tick.skipped"); c.tier = "held"; this.setState(c, "held");
        this.openCard("held", "held_path", [c.name], { blast_radius: this.blast(c) }); continue;
      }
      for (const it of cl.items) { if (it.result === "delete") { c.premises.delete(it.p.kind + "|" + it.p.key); continue; }
        const cur = keyHash(running, it.p.kind, it.p.key); it.p.hash = cur.hash; it.p.members = cur.members; it.p.seq = seq;
        this.out.judgments.push({ attempt: c.name, kind: it.kind, key: it.key, rule: it.rule, class: "rule", result: "holds" }); }
      const before = running; running = after.files; seq += 1;
      const l = { seq, kind: "change", attempt: c.name, before, after: running, ...this.writeSet(before, running), premises: [...c.premises.values()].map((p) => ({ ...p })), ops: this.curOps(c).map((o) => ({ ...o })), pushed: false };
      batch.push(l); members.push(l); inBatch.add(c); this.out.accepted.push(c.name); this.out.landings.push({ seq, attempt: c.name, kind: "change" });
    }
    if (!batch.length) { this.waiting = cands.filter((c) => this.out.skipped[c.name] === "right_of_way").length; return; }
    // step 5
    for (const l of batch) { this.landings.push(l); this.history[l.seq] = l.after; this.ev("landing.accepted"); if (l.attempt) { const a = this.attempts.get(l.attempt); a.state = "accepted"; a.landed_seq = l.seq; this.ev("attempt.state"); } }
    this.head = { seq, files: running };
    this.outbox = { id: ++this.batchId, seqs: batch.map((l) => l.seq), main: false, notes: false };
    for (const r of reopened) {
      const items = [];
      for (const p of r.a.premises.values()) {
        const cur = keyHash(running, p.kind, p.key); const dep = r.plan.depKeys.get(r.x.seq)?.has(p.kind + "|" + p.key);
        if (dep && cur.hash !== p.hash) { const rule = p.kind === "file" ? "F1" : p.edit ? "E1" : "E2"; p.status = "pending_repair"; if (p.kind === "entity") p.shown = cur.hash; items.push({ kind: p.kind, key: p.key, rule, result: "repair", after: p.kind === "entity" ? this.source(running, p.key) : null }); }
        p.hash = cur.hash; p.members = cur.members; p.seq = seq;
      }
      const hn = r.a.heads.length + 1; r.a.heads.push({ hn, result: "repair", items, dropped_ops: [], cause: "undo", resolved: false, delivered: false });
      this.out.heads_ups.push({ to: r.a.name, hn, result: "repair", cause: "undo", wake: true, items, dropped_ops: [] }); this.ev("headsup.sent");
    }
    for (const a of [...this.inflight(), ...this.parked()]) {
      if (inBatch.has(a) || reopened.some((r) => r.a === a)) continue;
      const cl = this.classify(a, pre, running, null, members);
      // cause attempt: first batch member whose write set touches an E1 key
      let causeAttempt = null;
      for (const it of cl.items) if (it.rule === "E1") { const l = batch.find((b) => b.w.some((w) => w.kind === it.kind && w.key === it.key)); if (l && l.attempt) causeAttempt = this.attempts.get(l.attempt); }
      this.applyClassification(a, cl, running, seq, "landing", causeAttempt);
    }
    this.waiting = this.inflight().filter((c) => c.state === "validated" && this.out.skipped[c.name] === "right_of_way").length;
  }
  markLanded() {
    for (const s of this.outbox.seqs) { const l = this.landings.find((x) => x.seq === s); if (l.pushed) continue; l.pushed = true; this.out.landed.push(s); this.ev("landing.landed"); if (l.attempt) { const a = this.attempts.get(l.attempt); if (a.state === "accepted") this.setState(a, "landed"); a.row = null; } }
  }
  pushOk() {
    if (!this.outbox) return;
    this.markLanded(); this.ev("batch.pushed"); this.outbox = null;
  }
  // LP5/LP7: decide by the values of both remote refs
  reconcile(main, notes) {
    if (!this.outbox) return "none";
    if (main === "other" || (main === "old" && notes === "other")) { this.pool_state = "paused"; this.ev("pool.paused"); return "pause"; }
    if (main === "old") return notes === "new" ? "retry_main" : "repush";
    // main === "new": the landings are on main
    if (notes === "new") { this.pushOk(); return "mark_pushed"; }
    this.markLanded();
    if (notes === "old") { this.outbox.main = true; return "retry_notes"; }
    this.pool_state = "paused"; this.ev("pool.paused"); return "pause";
  }
  restart(args) {
    // TR6: judgments still pending are asked again once
    for (const t of this.pendingTriage) this.out.reasked.push({ attempt: t.a.name, kind: t.p.kind, key: t.p.key });
    return this.reconcile(args.remote_main, args.remote_notes ?? args.remote_main);
  }
  triage(args) {
    const i = this.pendingTriage.findIndex((t) => t.a.name === args.attempt && t.p.kind === args.kind && t.p.key === args.key);
    if (i < 0) return;                                           // already decided by rule (V7): the answer is discarded
    const t = this.pendingTriage[i]; const { a, p, it } = t;
    if ("asked_at_op" in args && args.asked_at_op !== t.stamp) return;        // stale answer (V7): discarded, the question was asked again
    this.pendingTriage.splice(i, 1);
    let result;
    if (args.p == null) result = "confirm"; else if (args.p >= this.K.T_REPAIR) result = "repair"; else if (args.p >= this.K.T_CONFIRM) result = "confirm"; else result = "holds";
    p.status = result === "repair" ? "pending_repair" : result === "confirm" ? "pending_confirm" : "holds";
    this.out.judgments.push({ attempt: a.name, kind: p.kind, key: p.key, rule: it.rule, class: "triage", result }); this.ev("premise.judged");
    if (result !== "holds") this.sendHeadsUp(a, result, [{ kind: p.kind, key: p.key, rule: it.rule, result, added: it.added, removed: it.removed, after: it.after_src }], [], "landing");
    if (a.state === "submitted" && [...a.premises.values()].every((q) => q.status === "holds")) { this.setState(a, "validated"); a.validated_order = ++this.order; }
  }
  owner(args) {
    if (args.action === "land" || args.action === "land_now") { const a = this.attempts.get(args.attempt); if (a.state === "held" && [...a.premises.values()].every((p) => p.status === "holds") && a.submit_id === this.submitId(a)) { this.closeCard(a, "land"); a.approved = true; a.bypass = args.action === "land_now"; this.setState(a, "validated"); a.validated_order = ++this.order; } return {}; }
    if (args.action === "decline") { const a = this.attempts.get(args.attempt); this.closeCard(a, "decline"); this.setState(a, "stopped", "declined"); return {}; }
    if (args.action === "undo") {
      const target = this.landings.find((l) => l.seq === args.seq);
      if (!target || target.kind !== "change") return { refused: "not_a_change" };
      if (target.undone_by) return { refused: "already_undone" };
      const plan = this.planUndo(args.seq, this.head.files);
      if (args.expect_reverted && JSON.stringify(args.expect_reverted) !== JSON.stringify(plan.reverted)) return { refused: "plan_changed", undo: { reverted: plan.reverted, reopened: plan.reverted.filter((s) => s !== args.seq).map((s) => this.landings.find((l) => l.seq === s).attempt), kept_readers: plan.kept } };
      this.undoQueue.push({ seq: args.seq }); this.ev("undo.planned");
      return { undo: { reverted: plan.reverted, reopened: plan.reverted.filter((s) => s !== args.seq).map((s) => this.landings.find((l) => l.seq === s).attempt), kept_readers: plan.kept } }; }
    if (args.action === "retry") {
      // T21
      const a = this.attempts.get(args.attempt); for (const c of this.cards) if (c.open && c.kind === "choice" && c.attempts[0] === a.name) { c.open = false; this.ev("card.closed"); }
      a.go_arounds = 0; a.pull_backs = 0; a.row = ++this.clock; a.stop_reason = null;
      const open = a.heads.filter((h) => !h.resolved);
      if (open.some((h) => h.result === "repair")) { this.setState(a, "going_around"); a.go_arounds = 1; }
      else if (open.length) this.setState(a, "needs_confirm"); else this.setState(a, "working");
      return {}; }
    if (args.action === "stop") { const a = this.attempts.get(args.attempt); for (const c of this.cards) if (c.open && c.kind === "choice" && c.attempts[0] === a.name) { c.open = false; this.ev("card.closed"); } return {}; }
  }
  planUndo(u, running) {
    const live = this.landings.filter((l) => !l.undone_by && l.kind === "change");
    const R = new Set([u]); const depKeys = new Map();
    for (;;) {
      let grew = false;
      for (const L of live) {
        if (R.has(L.seq)) continue;
        for (const xs of R) { if (xs >= L.seq) continue; const X = this.landings.find((l) => l.seq === xs);
          for (const p of L.premises) if (p.seq >= xs && (p.kind === "entity" || p.kind === "file") && (p.edit || p.derived) && X.w.some((w) => w.kind === p.kind && w.key === p.key)) {
            if (!depKeys.has(L.seq)) depKeys.set(L.seq, new Set()); depKeys.get(L.seq).add(p.kind + "|" + p.key); if (!R.has(L.seq)) { R.add(L.seq); grew = true; } } }
      }
      // UN3
      const files = { ...running }; const P = new Set(); for (const s of R) for (const p of this.landings.find((l) => l.seq === s).paths) P.add(p);
      let failedLanding = null;
      for (const p of P) {
        const first = live.filter((l) => R.has(l.seq) && l.paths.includes(p)).sort((a, b) => a.seq - b.seq)[0];
        let tree = {}; if (p in first.before) tree[p] = first.before[p];
        for (const L of live) { if (R.has(L.seq) || L.seq < first.seq) continue; const ops = L.ops.filter((o) => o.path === p); if (!ops.length) continue;
          const r = this.replay(ops, tree, { noOP5: true }); if (r.failed.length) { failedLanding = L.seq; break; } tree = r.files; }
        if (failedLanding) break;
        if (p in tree) files[p] = tree[p]; else delete files[p];
      }
      if (failedLanding) { R.add(failedLanding); continue; }
      if (!grew) {
        const kept = [];
        for (const L of live) { if (R.has(L.seq)) continue; for (const xs of R) { if (xs >= L.seq) continue; const X = this.landings.find((l) => l.seq === xs);
          if (L.premises.some((p) => p.seq >= xs && p.read && !p.edit && !p.derived && X.w.some((w) => w.kind === p.kind && w.key === p.key))) { if (!kept.includes(L.seq)) kept.push(L.seq); } } }
        return { reverted: [...R].sort((a, b) => a - b), files, depKeys, kept };
      }
    }
  }
}
