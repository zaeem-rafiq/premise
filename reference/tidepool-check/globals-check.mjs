import { analyse } from "../specwork/ref.mjs";
import { loadFiles } from "./simlib.mjs";
import { readFileSync, readdirSync } from "node:fs";
const files = loadFiles("pool");
for (const f of readdirSync("hero")) files["creatures/" + f] = readFileSync("hero/" + f, "utf8");
const allow = new Set(JSON.parse(files[".premise/policy.json"]).globals);
const A = analyse(files);
const used = new Map();
for (const [from, set] of A.globals) for (const g of set) { if (!used.has(g)) used.set(g, new Set()); used.get(g).add(from); }
for (const [g, where] of [...used].sort()) console.log((allow.has(g) ? "ok     " : "BANNED ") + g.padEnd(12), allow.has(g) ? where.size : [...where].join(", "));
console.log("unresolved:", JSON.stringify(A.unresolved));
for (const [p, m] of Object.entries(A.mods)) if (m.error) console.log("PARSE ERROR", p, m.error);
