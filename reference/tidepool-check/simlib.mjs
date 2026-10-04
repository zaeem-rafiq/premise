import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Core, keyHash } from "../specwork/sim.mjs";
export function loadFiles(dir) {
  const out = {};
  const walk = (d, rel) => { for (const n of readdirSync(d).sort()) { const p = join(d, n); const r = rel ? rel + "/" + n : n; if (statSync(p).isDirectory()) walk(p, r); else out[r] = readFileSync(p, "utf8"); } };
  walk(dir, ""); return out;
}
export function run(title, files, attempts, steps, opts = {}) {
  console.log("\n================ " + title);
  const core = new Core(files, { GO_AROUND_LIMIT: 3, STARVATION_AFTER: 2, MAX_BATCH: 64, T_REPAIR: 0.7, T_CONFIRM: 0.2 }, attempts);
  steps.forEach((st, i) => {
    core.begin(); let resp = null, extra = {};
    if (["outline", "read", "list", "search", "write", "replace", "submit"].includes(st.do)) resp = core.tool(st.by, st);
    else if (st.do === "tick") core.tick();
    else if (st.do === "push_ok") core.pushOk();
    else if (st.do === "triage") core.triage(st.args);
    else if (st.do === "owner") extra = core.owner(st.args) || {};
    const o = core.out;
    let line = `${String(i).padStart(2)} ${st.by || "-"} ${st.do} ${st.note || (st.args && (st.args.path || st.args.query || st.args.summary || st.args.action)) || ""}`;
    if (resp) {
      if (!resp.ok) line += `  ERROR ${JSON.stringify(resp.error)}`;
      else if (st.do === "submit") line += `  -> ${resp.result.status} ${resp.result.tier || ""} ${JSON.stringify(resp.result.unresolved || "")}`;
      else if (st.do === "replace" || st.do === "write") line += `  targets=${JSON.stringify(resp.result.targets || resp.result.added)} altered=${JSON.stringify(resp.result.altered)} relied_on_by=${JSON.stringify(resp.result.relied_on_by)}`;
      else if (st.do === "list") line += `  entries=${JSON.stringify(resp.result.entries.map((e) => e.name))}`;
      else if (st.do === "search") line += `  containers=${JSON.stringify(resp.result.containers)}`;
      if (opts.premises || st.showPremises) line += `\n      premises: ${resp.premises.map((p) => `${p.kind}:${p.key}[${p.read ? "r" : ""}${p.edit ? "e" : ""}${p.derived ? "d" : ""}]`).join(", ")}`;
    }
    console.log(line);
    for (const j of o.judgments) console.log(`      judgment ${j.attempt} ${j.kind}:${j.key} rule=${j.rule} class=${j.class} result=${j.result}`);
    for (const h of o.heads_ups) console.log(`      HEADS-UP to ${h.to} #${h.hn} ${h.result} cause=${h.cause}: ` + h.items.map((it) => `${it.kind}:${it.key} ${it.rule}/${it.result}${it.added ? " added=" + JSON.stringify(it.added) : ""}`).join(" | ") + (h.dropped_ops.length ? ` dropped=${JSON.stringify(h.dropped_ops)}` : ""));
    for (const c of o.cards) console.log(`      CARD ${JSON.stringify(c)}`);
    if (o.accepted.length) console.log(`      accepted ${JSON.stringify(o.accepted)} skipped ${JSON.stringify(o.skipped)}`);
    if (st.do !== "push_ok" && (o.heads_ups.length || o.accepted.length || st.do === "submit" || st.do === "owner")) console.log("      states " + [...core.attempts.values()].map((a) => `${a.name}:${a.state}(ga${a.go_arounds})`).join(" "));
  });
  return core;
}
