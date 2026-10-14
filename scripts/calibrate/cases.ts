// The labelled set of `calibrate:clef` (04-build-plan 2.16 item 2; 01-core S6, RR7): the file
// `clef-cases.json` turned into one `TriageInput` per case, in the shape `ClefTriage` sends (7.3).
// A case names its texts by reference (the seed, the pool of the case vectors, or a module a real
// agent wrote on 2026-10-06), so the set carries no copy that could drift from its source. Every
// reference must resolve, and every `replace` must match, or loading fails.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { entitySource, parseModule } from "../../src/core/entities/index.ts";
import type { TriageInput } from "../../src/protocol/ports.ts";
import type { PremiseKind } from "../../src/protocol/premise.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CASES_FILE = join(ROOT, "scripts", "calibrate", "clef-cases.json");

export const LABELS = ["dependent", "independent"] as const;
export type Label = (typeof LABELS)[number];
/** The triage rows of 01-core 7.3. */
export const TRIAGE_ROWS = ["E3", "F4", "F6", "QT2", "QR4"] as const;
const KINDS: readonly PremiseKind[] = ["entity", "file", "listing", "query"];

export type TextRef = string | { from: string; path: string; entity?: string; replace?: Array<[string, string]> };
type PatchRef = { path: string; after: TextRef; before?: TextRef };

type RawCase = {
  id: string;
  source: { kind: "vector" | "spec" | "real"; ref: string; attempt?: string };
  row: string;
  zone: "triage" | "rule";
  intent: string;
  patch: PatchRef[];
  premise: {
    kind: PremiseKind;
    key: string;
    read_then: TextRef | null;
    is_now: TextRef | null;
    changed_by_intent: string | null;
    added?: Array<{ key: string; source: string | null }>;
    changed?: string[];
  };
  label: Label;
  why: string;
};

export type CalibrationCase = {
  id: string;
  source: RawCase["source"];
  row: string;
  zone: "triage" | "rule";
  label: Label;
  why: string;
  /** The question id of the one premise in `input.premises`. */
  qid: string;
  input: TriageInput;
};

/** Where references read their text from. A test passes its own. */
export type Sources = {
  seed(path: string): string | undefined;
  vector(path: string): string | undefined;
  run(model: string, intent: string, run: number, path: string): string | undefined;
};

/** The repository's sources: `seeds/tidepool`, the vector pool, the 2026-10-06 measurement files. */
export function repoSources(root: string = ROOT): Sources {
  const vectors = JSON.parse(readFileSync(join(root, "docs", "spec", "premise-cases.json"), "utf8")) as {
    pools: { tidepool: { files: Record<string, string> } };
  };
  const runs = new Map<string, Array<{ intent: string; run: number; files: Record<string, string> }>>();
  return {
    seed(path) {
      try {
        return readFileSync(join(root, "seeds", "tidepool", path), "utf8");
      } catch {
        return undefined;
      }
    },
    vector: (path) => vectors.pools.tidepool.files[path],
    run(model, intent, n, path) {
      let list = runs.get(model);
      if (list === undefined) {
        const file = join(root, "docs", "measurements", "models", `2026-10-06-engine-${model}.json`);
        try {
          list = (JSON.parse(readFileSync(file, "utf8")) as { runs: typeof list }).runs ?? [];
        } catch {
          list = [];
        }
        runs.set(model, list);
      }
      return list.find((r) => r.intent === intent && r.run === n)?.files[path];
    },
  };
}

function fail(id: string, message: string): never {
  throw new Error(`clef-cases.json: case ${id}: ${message}`);
}

/** The whole text a reference names, after its `replace` edits; `entity` is applied by the caller. */
function fileText(id: string, ref: Exclude<TextRef, string>, sources: Sources): string {
  let text: string | undefined;
  if (ref.from === "seed") text = sources.seed(ref.path);
  else if (ref.from === "vector") text = sources.vector(ref.path);
  else if (ref.from.startsWith("run:")) {
    const [, model, intent, n] = ref.from.split(":");
    if (model === undefined || intent === undefined || n === undefined) fail(id, `bad origin ${ref.from}`);
    text = sources.run(model, intent, Number(n), ref.path);
  } else fail(id, `unknown origin ${ref.from}`);
  if (text === undefined) fail(id, `no text for ${ref.from} ${ref.path}`);
  for (const [old, now] of ref.replace ?? []) {
    if (!text.includes(old)) fail(id, `replace: ${JSON.stringify(old)} is not in ${ref.from} ${ref.path}`);
    text = text.replace(old, now);
  }
  return text;
}

function resolve(id: string, ref: TextRef | null, sources: Sources): string | null {
  if (ref === null || typeof ref === "string") return ref;
  const text = fileText(id, ref, sources);
  if (ref.entity === undefined) return text;
  const source = entitySource(text, parseModule(text), ref.entity);
  if (source === null) fail(id, `no entity ${ref.entity} in ${ref.from} ${ref.path}`);
  return source;
}

/** The added and altered entities of one file, as the attempt view lists them (S6 `patch`). */
function patchEntities(id: string, ref: PatchRef, sources: Sources): Array<{ key: string; source: string }> {
  const after = resolve(id, ref.after, sources);
  if (after === null) fail(id, `patch ${ref.path} has no text`);
  const before = ref.before === undefined ? null : resolve(id, ref.before, sources);
  const was = new Map((before === null ? [] : parseModule(before).entities).map((e) => [e.name, e.hash]));
  const info = parseModule(after);
  const out: Array<{ key: string; source: string }> = [];
  for (const entity of info.entities) {
    if (was.get(entity.name) === entity.hash) continue;
    out.push({ key: `${ref.path}#${entity.name}`, source: entitySource(after, info, entity.name) ?? "" });
  }
  if (out.length === 0) fail(id, `patch ${ref.path} adds or alters no entity`);
  return out;
}

function check(raw: RawCase, seen: Set<string>): void {
  const id = typeof raw.id === "string" ? raw.id : "?";
  if (id === "?" || id === "") fail(id, "no id");
  if (seen.has(id)) fail(id, "duplicate id");
  seen.add(id);
  if (!LABELS.includes(raw.label)) fail(id, `label must be one of ${LABELS.join(", ")}`);
  if (!(TRIAGE_ROWS as readonly string[]).includes(raw.row)) fail(id, `row ${raw.row} is not a triage row`);
  if (raw.zone !== "triage" && raw.zone !== "rule") fail(id, "zone must be triage or rule");
  if (!["vector", "spec", "real"].includes(raw.source?.kind)) fail(id, "source.kind must be vector, spec or real");
  if (typeof raw.why !== "string" || raw.why.length < 20) fail(id, "why must say why the label holds");
  if (typeof raw.intent !== "string" || raw.intent === "") fail(id, "no intent");
  if (!Array.isArray(raw.patch) || raw.patch.length === 0) fail(id, "no patch");
  if (!KINDS.includes(raw.premise?.kind)) fail(id, "premise.kind is not a premise kind");
}

/** Load and resolve the labelled set. Throws, naming the case, on anything that does not resolve. */
export function loadCases(file: string = CASES_FILE, sources: Sources = repoSources()): CalibrationCase[] {
  const doc = JSON.parse(readFileSync(file, "utf8")) as { v: number; cases: RawCase[] };
  if (doc.v !== 1 || !Array.isArray(doc.cases)) throw new Error("clef-cases.json: expected { v: 1, cases: [...] }");
  const seen = new Set<string>();
  return doc.cases.map((raw) => {
    check(raw, seen);
    const p = raw.premise;
    const qid = `${p.kind}:${p.key}`;
    const input: TriageInput = {
      attempt_id: `cal_${raw.id}`,
      intent: raw.intent,
      patch: raw.patch.flatMap((ref) => patchEntities(raw.id, ref, sources)),
      premises: {
        [qid]: {
          kind: p.kind,
          key: p.key,
          rule: raw.row,
          read_then: resolve(raw.id, p.read_then, sources),
          is_now: resolve(raw.id, p.is_now, sources),
          changed_by_intent: p.changed_by_intent,
          ...(p.added !== undefined ? { added: p.added } : {}),
          changed: p.changed ?? [],
        },
      },
      truth: null,
    };
    const premise = input.premises[qid]!;
    if (premise.read_then !== null && premise.read_then === premise.is_now) fail(raw.id, "read_then equals is_now");
    return { id: raw.id, source: raw.source, row: raw.row, zone: raw.zone, label: raw.label, why: raw.why, qid, input };
  });
}
