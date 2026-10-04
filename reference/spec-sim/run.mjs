import { readFileSync } from "node:fs";
import { Core, keyHash, inboxNext } from "./sim.mjs";
import { extract, sha256hex, blobOid } from "./ref.mjs";
const doc = JSON.parse(readFileSync(process.argv[2], "utf8"));
const only = process.argv[3];
let fails = 0;
const fail = (id, i, msg) => { fails++; console.log(`FAIL ${id} step ${i}: ${msg}`); };
const subset = (exp, act) => {
  if (exp === null || typeof exp !== "object") return exp === act;
  if (Array.isArray(exp)) return Array.isArray(act) && exp.length === act.length && exp.every((e, i) => subset(e, act[i]));
  return act && typeof act === "object" && Object.keys(exp).every((k) => subset(exp[k], act[k]));
};
const sortJ = (a) => JSON.stringify([...a].sort());
for (const h of doc.hash_cases) {
  if (h.kind === "canonical") { const e = extract(h.source).entities.find((x) => x.name === h.entity); if (e.canonical !== h.canonical || e.hash !== h.hash) fail(h.id, "-", `canonical/hash mismatch ${e.canonical} ${e.hash}`); }
  else if (h.kind === "entity") { const a = extract(h.a).entities.find((x) => x.name === h.entity), b = extract(h.b).entities.find((x) => x.name === h.entity); if ((a.hash === b.hash) !== h.equal) fail(h.id, "-", `equal expected ${h.equal}`); }
  else if (h.kind === "blob") { if (blobOid(h.content) !== h.hash) fail(h.id, "-", "blob id"); }
  else { const got = sha256hex(JSON.stringify([...h.members].sort())).slice(0, 32); if (got !== h.hash) fail(h.id, "-", `members hash ${got}`); }
}
for (const ic of doc.inbox_cases || []) {
  const got = inboxNext(ic.shown_hn, ic.inbox);
  if (JSON.stringify(got.show) !== JSON.stringify(ic.expect.show) || got.sync !== ic.expect.sync) fail(ic.id, "-", `inbox ${JSON.stringify(got)}`);
}
for (const c of doc.cases) {
  if (only && !c.id.startsWith(only)) continue;
  const files = { ...doc.pools[c.pool].files };
  for (const [p, v] of Object.entries(c.files || {})) { if (v === null) delete files[p]; else files[p] = v; }
  const core = new Core(files, { ...doc.constants, ...(c.constants || {}) }, c.attempts);
  const responses = [];
  c.steps.forEach((st, i) => {
    core.begin(); let resp = null, extra = {};
    try {
      if (["outline", "read", "list", "search", "write", "replace", "submit"].includes(st.do)) resp = core.tool(st.by, st);
      else if (st.do === "tick") core.tick();
      else if (st.do === "push_ok") core.pushOk();
      else if (st.do === "restart") extra.action = core.restart(st.args);
      else if (st.do === "push_result") extra.action = core.reconcile(st.args.remote_main, st.args.remote_notes);
      else if (st.do === "triage") core.triage(st.args);
      else if (st.do === "owner") extra = core.owner(st.args) || {};
    } catch (e) { fail(c.id, i, "exception " + e.stack); return; }
    responses.push(resp);
    const e = st.expect || {}; const o = core.out;
    const chk = (cond, msg) => { if (!cond) fail(c.id, i, msg); };
    if ("ok" in e) chk(resp.ok === e.ok, `ok ${resp.ok} error ${JSON.stringify(resp.error)}`);
    if ("error" in e) chk(resp.error?.code === e.error, `error ${JSON.stringify(resp.error)}`);
    if ("status" in e) chk(resp.result?.status === e.status, `status ${JSON.stringify(resp.result || resp.error)}`);
    if ("duplicate" in e) chk(!!resp.result?.duplicate === e.duplicate, `duplicate`);
    if ("result" in e) chk(subset(e.result, resp.result), `result ${JSON.stringify(resp.result)}`);
    if ("same_response_as" in e) chk(JSON.stringify(resp) === JSON.stringify(responses[e.same_response_as]), "same_response_as");
    if ("same_submit_id_as" in e) chk(resp.result.submit_id === responses[e.same_submit_id_as].result.submit_id, "same_submit_id_as");
    if ("premises" in e) {
      const norm = (p) => JSON.stringify([p.kind, p.key, p.hash, p.read, p.edit, p.derived]);
      const exp = e.premises.map((p) => norm({ ...p, hash: p.hash || keyHash(core.history[p.at], p.kind, p.key).hash }));
      chk(sortJ(exp) === sortJ(resp.premises.map(norm)), `premises\n   exp ${sortJ(exp)}\n   got ${sortJ(resp.premises.map(norm))}`);
    }
    if ("judgments" in e) {
      const n = (j, withRes) => JSON.stringify([j.attempt, j.kind, j.key, j.rule, j.class, withRes ? j.result : undefined]);
      const exp = e.judgments.map((j) => n(j, "result" in j));
      const got = o.judgments.map((j, k) => n(j, e.judgments.some((x) => x.attempt === j.attempt && x.key === j.key && "result" in x)));
      chk(sortJ(exp) === sortJ(got), `judgments\n   exp ${sortJ(exp)}\n   got ${sortJ(got)}`);
    }
    if ("heads_ups" in e) {
      chk(e.heads_ups.length === o.heads_ups.length, `heads_ups count exp ${e.heads_ups.length} got ${JSON.stringify(o.heads_ups)}`);
      for (const x of e.heads_ups) {
        const g = o.heads_ups.find((h) => h.to === x.to && h.hn === x.hn);
        if (!g) { fail(c.id, i, `heads-up ${x.to}#${x.hn} missing; got ${JSON.stringify(o.heads_ups)}`); continue; }
        chk(g.result === x.result, `heads-up result ${g.result}`);
        if (x.cause) chk(g.cause === x.cause, `heads-up cause ${g.cause}`);
        if ("wake" in x) chk(g.wake === x.wake, `heads-up wake ${g.wake}`);
        chk(x.items.length === g.items.length, `heads-up items ${JSON.stringify(g.items)}`);
        for (const it of x.items) {
          const gi = g.items.find((y) => y.kind === it.kind && y.key === it.key);
          if (!gi) { fail(c.id, i, `item ${it.key} missing`); continue; }
          chk(gi.rule === it.rule && gi.result === it.result, `item rule/result ${gi.rule}/${gi.result}`);
          if (it.added) chk(sortJ(it.added) === sortJ(gi.added || []), `item added ${JSON.stringify(gi.added)}`);
          if (it.removed) chk(sortJ(it.removed) === sortJ(gi.removed || []), `item removed`);
          if (it.context) chk(sortJ(it.context) === sortJ(gi.context || []), `item context ${JSON.stringify(gi.context)}`);
          if (it.after_contains) chk((gi.after || "").includes(it.after_contains), `after_contains: ${gi.after}`);
        }
        if (x.dropped_ops) chk(JSON.stringify(x.dropped_ops) === JSON.stringify(g.dropped_ops), `dropped_ops ${JSON.stringify(g.dropped_ops)}`);
      }
    }
    if ("accepted" in e) chk(JSON.stringify(e.accepted) === JSON.stringify(o.accepted), `accepted ${JSON.stringify(o.accepted)}`);
    if ("skipped" in e) chk(subset(e.skipped, o.skipped) && Object.keys(e.skipped).length === Object.keys(o.skipped).length, `skipped ${JSON.stringify(o.skipped)}`);
    if ("landings" in e) chk(subset(e.landings, o.landings), `landings ${JSON.stringify(o.landings)}`);
    if ("landed" in e) chk(JSON.stringify(e.landed) === JSON.stringify(o.landed), `landed ${JSON.stringify(o.landed)}`);
    if ("action" in e) chk(extra.action === e.action, `action ${extra.action}`);
    if ("pool_state" in e) chk(core.pool_state === e.pool_state, `pool_state ${core.pool_state}`);
    if ("undo" in e) chk(JSON.stringify(e.undo) === JSON.stringify(extra.undo), `undo ${JSON.stringify(extra.undo)}`);
    if ("refused" in e) chk(extra.refused === e.refused, `refused ${extra.refused}`);
    if ("reasked" in e) { const n = (j) => JSON.stringify([j.attempt, j.kind, j.key]); chk(sortJ(e.reasked.map(n)) === sortJ(o.reasked.map(n)), `reasked ${JSON.stringify(o.reasked)}`); }
    for (const [n, s] of Object.entries(e.pull_backs || {})) chk(core.attempts.get(n).pull_backs === s, `pull_backs ${n} = ${core.attempts.get(n).pull_backs}`);
    if ("cards" in e) chk(subset(e.cards, o.cards), `cards ${JSON.stringify(o.cards)}`);
    for (const [n, s] of Object.entries(e.states || {})) chk(core.attempts.get(n).state === s, `state ${n} = ${core.attempts.get(n).state}, expected ${s}`);
    for (const [n, s] of Object.entries(e.stop_reasons || {})) chk(core.attempts.get(n).stop_reason === s, `stop_reason ${n} = ${core.attempts.get(n).stop_reason}`);
    for (const [n, s] of Object.entries(e.go_arounds || {})) chk(core.attempts.get(n).go_arounds === s, `go_arounds ${n} = ${core.attempts.get(n).go_arounds}`);
    for (const [n, s] of Object.entries(e.right_of_way || {})) chk((core.attempts.get(n).row != null) === s, `right_of_way ${n}`);
    if ("waiting_behind" in e) chk(core.waiting === e.waiting_behind, `waiting_behind ${core.waiting}`);
    for (const t of e.events_include || []) chk(o.events.includes(t), `event ${t} missing: ${o.events}`);
    for (const t of e.events_exclude || []) chk(!o.events.includes(t), `event ${t} present`);
  });
  const f = c.final; const chk = (cond, msg) => { if (!cond) fail(c.id, "final", msg); };
  chk(core.head.seq === f.head_seq, `head_seq ${core.head.seq}`);
  for (const [p, v] of Object.entries(f.files)) chk((core.head.files[p] ?? null) === v, `file ${p}:\n${core.head.files[p]}`);
  for (const [n, s] of Object.entries(f.states)) chk(core.attempts.get(n).state === s, `state ${n} = ${core.attempts.get(n).state}`);
  for (const [n, s] of Object.entries(f.go_arounds || {})) chk(core.attempts.get(n).go_arounds === s, `go_arounds ${n} = ${core.attempts.get(n).go_arounds}`);
  const got = core.landings.map((l) => (l.attempt ? { seq: l.seq, attempt: l.attempt, kind: l.kind } : { seq: l.seq, kind: l.kind }));
  chk(JSON.stringify(got) === JSON.stringify(f.landings), `landings ${JSON.stringify(got)}`);
}
console.log(fails ? `${fails} failures` : "all vectors agree with the scratch simulator");
