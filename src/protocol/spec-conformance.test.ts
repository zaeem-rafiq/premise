// Type-shape conformance of the protocol module against the specification, decided by the compiler.
//
// For every `type`/`interface` declared in a ```ts block of docs/spec/, this test writes one module
// per specification file under `.tmp-test/spec-conformance/` that exports the declarations verbatim,
// then a `check.ts` that asserts mutual assignability between each specification type and the
// protocol type of the same name, and runs the repository's own `tsc` over them. A difference fails
// the test with the compiler's own message. `PoolEvent` is additionally asserted member by member,
// so that a failure names the event shape that differs.
//
// The specification files are the four the lane brief names — 01-core, 02-tidepool, 03-floor and
// 05-agent — plus 04-build-plan, because plan 2.1 assigns `Sql` and `Driver` to `ports.ts` and its
// section 1.3 is the only ```ts block that declares them.
//
// Every name both sides declare is compared. REQUIRED below fixes the names that must exist on both
// sides: the fourteen names of the lane brief and every type the table of plan 2.1 assigns to a
// protocol file. A required name missing on either side fails the test before the compiler runs.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../test/support/source.ts";

const COMPILER = join(REPO_ROOT, "node_modules/typescript/bin/tsc");
const OUT_DIR = join(REPO_ROOT, ".tmp-test/spec-conformance");

/** The specification files read, in precedence order (0.1: 01-core.md wins a repetition). */
const SPEC_FILES = [
  { file: "01-core", path: "docs/spec/01-core.md" },
  { file: "02-tidepool", path: "docs/spec/02-tidepool.md" },
  { file: "03-floor", path: "docs/spec/03-floor.md" },
  { file: "05-agent", path: "docs/spec/05-agent.md" },
  { file: "04-build-plan", path: "docs/spec/04-build-plan.md" },
] as const;

type SpecFileName = (typeof SPEC_FILES)[number]["file"];

const specFile = (name: SpecFileName) => `spec-${name}.ts`;
const specNs = (name: SpecFileName) => `Spec_${name.replace(/-/g, "_")}`;

/**
 * Declarations the specification names but never writes as `type`/`interface` declarations, added
 * to the generated modules so that every name a specification type references resolves. `RiskInput`
 * is the `state` object of 01-core 10.4 (per the `RiskJudge` row of 1.7, S6a), `MetricsEvent` is the
 * `metrics` member of `PoolEvent` (03-floor FloorState), and `EntryHandler` is named by the
 * `EngineTable` example of 04-build-plan 2.1 without a declaration.
 */
const SYNTHETIC: Readonly<Partial<Record<SpecFileName, { name: string; text: string; note: string }[]>>> = {
  "01-core": [
    {
      name: "RiskInput",
      note: "named by 1.7's RiskJudge row and 10.4's S6a; the specification writes its shape only as the example `state` object of 10.4",
      text: `export type RiskInput = {
  intent: string;
  summary: string;
  held_paths: string[];
  files: Array<{ path: string; tier: "auto" | "held"; entities: Array<{ key: string; before: string; after: string }> }>;
};`,
    },
  ],
  "03-floor": [
    {
      name: "MetricsEvent",
      note: "FloorState.metrics is 'the metrics member of PoolEvent' by the comment of 03-floor's FloorState block",
      text: `export type MetricsEvent = Extract<PoolEvent, { type: "metrics" }>;`,
    },
  ],
  "04-build-plan": [
    {
      name: "EntryHandler",
      note: "named by the EngineTable row of plan 2.1's example but never declared",
      text: `export type EntryHandler = unknown;`,
    },
  ],
};

/**
 * The names that must exist on both sides: the fourteen of the brief, and every type the table of
 * plan 2.1 assigns to a protocol file (`proto` names that file).
 */
const REQUIRED: ReadonlyArray<{ name: string; proto: string }> = [
  // plan 2.1, premise.ts
  { name: "PremiseKind", proto: "premise" },
  { name: "PremiseRef", proto: "premise" },
  // plan 2.1, attempt.ts
  { name: "AttemptState", proto: "attempt" },
  { name: "AgentStopReason", proto: "attempt" },
  // plan 2.1, cards.ts
  { name: "Card", proto: "cards" },
  { name: "CardOption", proto: "cards" },
  { name: "BlastRadius", proto: "cards" },
  { name: "FrameAddress", proto: "cards" },
  { name: "RiskAnswers", proto: "cards" },
  // plan 2.1, undo.ts
  { name: "UndoRefusal", proto: "undo" },
  { name: "UndoPlan", proto: "undo" },
  { name: "UndoPlanResponse", proto: "undo" },
  { name: "UndoResponse", proto: "undo" },
  // plan 2.1, note.ts
  { name: "Note", proto: "note" },
  // plan 2.1, green.ts
  { name: "VerifyResult", proto: "green" },
  // plan 2.1, events.ts
  { name: "EventBase", proto: "events" },
  { name: "ErrCode", proto: "events" },
  { name: "PoolEvent", proto: "events" },
  // plan 2.1, operations.ts
  { name: "Operation", proto: "operations" },
  // plan 2.1, headsup.ts
  { name: "HeadsUp", proto: "headsup" },
  { name: "HeadsUpItem", proto: "headsup" },
  { name: "Diff", proto: "headsup" },
  // plan 2.1, tools.ts (envelopes, results, the four calls that are not tools, model-facing types, gate calls)
  { name: "ToolRequest", proto: "tools" },
  { name: "ToolResponse", proto: "tools" },
  { name: "ErrorCode", proto: "tools" },
  { name: "Check", proto: "tools" },
  { name: "SubmitError", proto: "tools" },
  { name: "SubmitResult", proto: "tools" },
  { name: "SyncRequest", proto: "tools" },
  { name: "SyncResponse", proto: "tools" },
  { name: "RegisterRequest", proto: "tools" },
  { name: "RegisterResponse", proto: "tools" },
  { name: "StopRequest", proto: "tools" },
  { name: "StopResponse", proto: "tools" },
  { name: "ResumeRequest", proto: "tools" },
  { name: "ResumeResponse", proto: "tools" },
  { name: "ModelToolMessage", proto: "tools" },
  { name: "HeadsUpForModel", proto: "tools" },
  { name: "GateReserveRequest", proto: "tools" },
  { name: "GateReserveResponse", proto: "tools" },
  { name: "GateSettleRequest", proto: "tools" },
  { name: "GateReleaseRequest", proto: "tools" },
  // plan 2.1, ports.ts (the interfaces of 1.7 and the 1.3 seam types)
  { name: "Sql", proto: "ports" },
  { name: "Driver", proto: "ports" },
  { name: "RefUpdate", proto: "ports" },
  { name: "PushResult", proto: "ports" },
  { name: "Pusher", proto: "ports" },
  { name: "NotesReader", proto: "ports" },
  { name: "TokenSource", proto: "ports" },
  { name: "AttemptRepoProvisioner", proto: "ports" },
  { name: "ModelPlan", proto: "ports" },
  { name: "TriageInput", proto: "ports" },
  { name: "TriageAnswers", proto: "ports" },
  { name: "Triage", proto: "ports" },
  { name: "SyncTriage", proto: "ports" },
  { name: "RiskJudge", proto: "ports" },
  { name: "Verifier", proto: "ports" },
  { name: "Version", proto: "ports" },
  { name: "PoolSource", proto: "ports" },
  // plan 2.1, swarm.ts and routes.ts
  { name: "SwarmConfig", proto: "swarm" },
  { name: "SwarmRequest", proto: "swarm" },
  // plan 2.1, channel.ts
  { name: "FloorToPool", proto: "channel" },
  { name: "PoolToFloor", proto: "channel" },
  // plan 2.1, floor-json.ts
  { name: "Features", proto: "floor-json" },
  { name: "FloorJson", proto: "floor-json" },
];

type Decl = {
  name: string;
  kind: "type" | "interface";
  /** The declaration text, dedented to column zero. */
  text: string;
  file: SpecFileName;
  /** 1-based line in the markdown file the declaration came from (0 for a synthetic declaration). */
  line: number;
};

/** The fenced ```ts blocks of a markdown document, in order. */
function tsBlocks(markdown: string): Array<{ line: number; code: string }> {
  const blocks: Array<{ line: number; code: string }> = [];
  const lines = markdown.split("\n");
  let open: number | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    if (open === null && trimmed === "```ts") {
      open = i;
    } else if (open !== null && trimmed === "```") {
      blocks.push({ line: open + 2, code: lines.slice(open + 1, i).join("\n") });
      open = null;
    }
  }
  return blocks;
}

/** Index one past the end of the string literal opened at `i` (a quote or backtick), or -1. */
function skipString(code: string, i: number, quote: string): number {
  for (let j = i + 1; j < code.length; j += 1) {
    if (code[j] === "\\") {
      j += 1;
    } else if (code[j] === quote) {
      return j + 1;
    } else if (quote !== "`" && code[j] === "\n") {
      return -1;
    }
  }
  return -1;
}

/**
 * Index of the character that ends the declaration that starts at `start`: the `;` of a `type` at
 * bracket depth zero, or the `}` that closes an `interface`. -1 when the code ends first.
 */
function declEnd(code: string, start: number, kind: "type" | "interface"): number {
  let depth = 0;
  let braces = 0;
  for (let i = start; i < code.length; i += 1) {
    const c = code[i]!;
    if (c === "/" && code[i + 1] === "/") {
      const j = code.indexOf("\n", i);
      if (j < 0) return -1;
      i = j;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const j = code.indexOf("*/", i + 2);
      if (j < 0) return -1;
      i = j + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const j = skipString(code, i, c);
      if (j < 0) return -1;
      i = j - 1;
      continue;
    }
    if (c === "{" || c === "(" || c === "[" || c === "<") depth += 1;
    if (c === "{") braces += 1;
    if (c === "}" || c === ")" || c === "]" || c === ">") depth -= 1;
    if (c === "}") {
      braces -= 1;
      if (kind === "interface" && braces === 0) return i;
    }
    if (kind === "type" && c === ";" && depth === 0) return i;
  }
  return -1;
}

/** The `type`/`interface` declarations of one ```ts block, in order. */
function declsOf(code: string, file: SpecFileName, firstLine: number): Decl[] {
  const decls: Decl[] = [];
  const head = /(^|\n)([ \t]*)(?:export[ \t]+)?(type|interface)[ \t]+([A-Za-z_]\w*)/g;
  let match;
  while ((match = head.exec(code)) !== null) {
    const [, newline, indent, kind, name] = match;
    const start = match.index + newline!.length;
    const end = declEnd(code, start, kind as "type" | "interface");
    if (end < 0) continue;
    const line = firstLine + code.slice(0, start).split("\n").length - 1;
    const text = code
      .slice(start, end + 1)
      .split("\n")
      .map((l) => (l.startsWith(indent!) ? l.slice(indent!.length) : l))
      .join("\n")
      .replace(/^export\s+/, "");
    decls.push({ name: name!, kind: kind as "type" | "interface", text, file, line });
    head.lastIndex = end + 1;
  }
  return decls;
}

/** Comments and whitespace removed: the text two declarations are equal by. */
function normalized(text: string): string {
  return text
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, "");
}

/** Exported type names of one protocol file: definitions and re-exports. */
function exportedTypes(code: string): { defined: Set<string>; reexported: Set<string> } {
  const defined = new Set<string>();
  const reexported = new Set<string>();
  for (const match of code.matchAll(/export\s+(?:type|interface)\s+([A-Za-z_]\w*)/g)) defined.add(match[1]!);
  for (const match of code.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of match[1]!.split(",")) {
      const item = part.trim().replace(/^type\s+/, "");
      const alias = /\bas\s+([A-Za-z_]\w*)$/.exec(item);
      const name = alias ? alias[1]! : item;
      if (/^[A-Za-z_]\w*$/.test(name)) reexported.add(name);
    }
  }
  return { defined, reexported };
}

/** The members of a `Base & ( | {...} | {...} )` union body: the verbatim member texts. */
function unionMembers(text: string): string[] {
  const open = text.indexOf("(", text.indexOf("&"));
  if (open < 0) return [];
  const members: string[] = [];
  let depth = 0;
  let memberStart = open + 1;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      continue;
    }
    if ("{[(<".includes(c)) depth += 1;
    if ("}])>".includes(c)) depth -= 1;
    if (c === "|" && depth === 1) {
      members.push(text.slice(memberStart, i));
      memberStart = i + 1;
    }
    if (depth === 0) {
      members.push(text.slice(memberStart, i));
      return members.map((m) => m.trim()).filter((m) => m.length > 0);
    }
  }
  return members;
}
/**
 * `text` with every use of a name in `refs` rewritten to `<namespace>.<name>` (comments and string
 * literals are copied unchanged). `refs` maps each name to the namespace of the file that owns it.
 */
function qualify(text: string, refs: Map<string, string>): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") {
      const j = text.indexOf("\n", i);
      const end = j < 0 ? text.length : j;
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const j = text.indexOf("*/", i + 2);
      const end = j < 0 ? text.length : j + 2;
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const j = skipString(text, i, c);
      const end = j < 0 ? text.length : j;
      out += text.slice(i, end);
      i = end;
      continue;
    }
    const id = /^[A-Za-z_]\w*/.exec(text.slice(i));
    if (id !== null) {
      const owner = refs.get(id[0]);
      out += owner === undefined ? id[0] : `${owner}.${id[0]}`;
      i += id[0].length;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

type Analysis = {
  /** Every declaration of every file, including the synthetic ones, in file order. */
  decls: Decl[];
  /** name -> declarations, after deduplication (the first in file order is the one followed). */
  byName: Map<string, Decl[]>;
  /** Names defined differently in two blocks: `name -> why skipped`. */
  contradictions: Map<string, string>;
  /** Exported type name -> protocol file that defines (preferred) or re-exports it. */
  protoTypes: Map<string, string>;
  /** The check.ts program text. */
  check: string;
  /** Specification type names compared (the Equal assertions emitted), sorted. */
  compared: string[];
  /** The generated tsconfig path. */
  config: string;
};

function analyze(): Analysis {
  const decls: Decl[] = [];
  for (const { file, path } of SPEC_FILES) {
    const markdown = readFileSync(join(REPO_ROOT, path), "utf8");
    for (const block of tsBlocks(markdown)) {
      decls.push(...declsOf(block.code, file, block.line));
    }
  }
  const byName = new Map<string, Decl[]>();
  for (const decl of decls) {
    const list = byName.get(decl.name) ?? [];
    list.push(decl);
    byName.set(decl.name, list);
  }
  const contradictions = new Map<string, string>();
  for (const [name, list] of byName) {
    if (new Set(list.map((decl) => normalized(decl.text))).size > 1) {
      const where = list.map((decl) => `${decl.file}:${decl.line}`).join(" and ");
      contradictions.set(
        name,
        `the specification declares ${name} differently in ${where}; the Equal check is skipped per the lane brief's contradiction rule`,
      );
    }
  }

  // The protocol side: every exported type name -> the file that defines it (re-exports lose to
  // definitions, and index.ts only re-exports).
  const protoTypes = new Map<string, string>();
  const reexports = new Map<string, string>();
  const protocolDir = join(REPO_ROOT, "src/protocol");
  const protoFiles = readdirSync(protocolDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();
  for (const name of protoFiles) {
    const code = readFileSync(join(protocolDir, name), "utf8");
    const { defined, reexported } = exportedTypes(code);
    const file = name.replace(/\.ts$/, "");
    for (const typeName of defined) protoTypes.set(typeName, file);
    for (const typeName of reexported) {
      if (!protoTypes.has(typeName) && !reexports.has(typeName)) reexports.set(typeName, file);
    }
  }
  for (const [typeName, file] of reexports) if (!protoTypes.has(typeName)) protoTypes.set(typeName, file);

  // One generated module per specification file: verbatim declarations plus the synthetic ones the
  // specification names without declaring, and `import type` lines for names other files define.
  const owner = new Map<string, SpecFileName>();
  for (const { file } of SPEC_FILES) {
    for (const decl of decls) {
      if (decl.file === file && !owner.has(decl.name)) owner.set(decl.name, file);
    }
    for (const synth of SYNTHETIC[file] ?? []) if (!owner.has(synth.name)) owner.set(synth.name, file);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const specModuleNames = new Map<SpecFileName, string>();
  for (const { file } of SPEC_FILES) specModuleNames.set(file, specFile(file));
  for (const { file, path } of SPEC_FILES) {
    const imports = new Map<SpecFileName, Set<string>>();
    const bodies: string[] = [];
    const own = new Set(decls.filter((d) => d.file === file).map((d) => d.name));
    for (const decl of decls.filter((d) => d.file === file)) {
      bodies.push(`// ${path}:${decl.line}\nexport ${decl.text}`);
      for (const ref of decl.text.match(/[A-Za-z_]\w*/g) ?? []) {
        const refFile = owner.get(ref);
        if (refFile !== undefined && refFile !== file && !own.has(ref)) {
          const set = imports.get(refFile) ?? new Set<string>();
          set.add(ref);
          imports.set(refFile, set);
        }
      }
    }
    for (const synth of SYNTHETIC[file] ?? []) {
      bodies.push(`// Synthesized: ${synth.note}.\n${synth.text}`);
      for (const ref of synth.text.match(/[A-Za-z_]\w*/g) ?? []) {
        const refFile = owner.get(ref);
        if (refFile !== undefined && refFile !== file) {
          const set = imports.get(refFile) ?? new Set<string>();
          set.add(ref);
          imports.set(refFile, set);
        }
      }
    }
    const head = [...imports]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([from, names]) => `import type { ${[...names].sort().join(", ")} } from "./${specModuleNames.get(from)!}";`)
      .join("\n");
    writeFileSync(
      join(OUT_DIR, specFile(file)),
      `// Generated from ${path} by src/protocol/spec-conformance.test.ts. Do not edit.\n\n${head ? `${head}\n\n` : ""}${bodies.join("\n\n")}\n`,
    );
  }

  // check.ts: a namespace import per side, Equal assertions for every name both sides declare, and
  // a member-by-member assertion for the PoolEvent union.
  const compared: string[] = [];
  const protoModules = new Set<string>();
  const checks: string[] = [];
  const contradictedNames = new Set<string>();
  const emitEqual = (name: string, file: SpecFileName, where: string): void => {
    const protoFile = protoTypes.get(name);
    if (protoFile === undefined) return;
    compared.push(name);
    protoModules.add(protoFile);
    const specRef = `${specNs(file)}.${name}`;
    const protoRef = `P_${protoFile.replace(/-/g, "_")}.${name}`;
    const tag = `${file}_${name}`.replace(/\W/g, "_");
    checks.push(
      `// ${name} (${where}) vs src/protocol/${protoFile}.ts\n` +
        `const check_${tag}: Equal<${specRef}, ${protoRef}> = true;\n` +
        `const toSpec_${tag}: ${specRef} = 0 as unknown as ${protoRef};\n` +
        `const toProto_${tag}: ${protoRef} = 0 as unknown as ${specRef};`,
    );
  };
  for (const decl of decls) {
    if (contradictions.has(decl.name)) {
      if (!contradictedNames.has(decl.name)) {
        contradictedNames.add(decl.name);
        checks.push(`// CONTRADICTION: ${contradictions.get(decl.name)}`);
      }
      continue;
    }
    emitEqual(decl.name, decl.file, `${decl.file}:${decl.line}`);
  }
  // A synthetic declaration is the specification's shape for a name it never wrote as `type`
  // (`RiskInput` is the `state` object of 10.4): when the protocol defines the name, prove it.
  for (const { file } of SPEC_FILES) {
    for (const synth of SYNTHETIC[file] ?? []) {
      emitEqual(synth.name, file, `${file}, synthesized`);
    }
  }

  // PoolEvent, member by member: Spec side is EventBase & <verbatim member>, Proto side is Extract.
  const specRefs = new Map<string, string>();
  for (const [name, file] of owner) specRefs.set(name, specNs(file));
  const poolEvent = decls.find((d) => d.name === "PoolEvent" && d.file === "01-core");
  if (poolEvent !== undefined) {
    const members = unionMembers(poolEvent.text);
    if (members.length === 0) {
      throw new Error("the specification's PoolEvent is not a `Base & (member union)`: no members found");
    }
    for (const member of members) {
      const typeMatch = /type:\s*"([^"]+)"/.exec(member);
      if (typeMatch === null) throw new Error(`a PoolEvent member has no type tag: ${member.slice(0, 80)}`);
      const tag = typeMatch[1]!.replace(/[^A-Za-z0-9_]/g, "_");
      const specType = `SpecPoolEvent__${tag}`;
      const protoType = `ProtoPoolEvent__${tag}`;
      checks.push(
        `// PoolEvent member ${typeMatch[1]}\n` +
          `type ${specType} = Spec_01_core.EventBase & (\n${qualify(member, specRefs)}\n);\n` +
          `type ${protoType} = Extract<P_events.PoolEvent, { type: "${typeMatch[1]}" }>;\n` +
          `const check_PoolEvent__${tag}: Equal<${specType}, ${protoType}> = true;\n` +
          `const toSpec_PoolEvent__${tag}: ${specType} = 0 as unknown as ${protoType};\n` +
          `const toProto_PoolEvent__${tag}: ${protoType} = 0 as unknown as ${specType};`,
      );
    }
    protoModules.add("events");
  }

  const specImports = SPEC_FILES.map(({ file }) => `import type * as ${specNs(file)} from "./${specFile(file)}";`).join(
    "\n",
  );
  const protoImports = [...protoModules]
    .sort()
    .map((file) => `import type * as P_${file.replace(/-/g, "_")} from "../../src/protocol/${file}.ts";`)
    .join("\n");
  const check = `// Generated by src/protocol/spec-conformance.test.ts. Do not edit.\n\ntype Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;\n\n${specImports}\n${protoImports}\n\n${checks.join("\n\n")}\n`;
  writeFileSync(join(OUT_DIR, "check.ts"), check);

  writeFileSync(join(OUT_DIR, "compared.txt"), `${[...new Set(compared)].sort().join("\n")}\n`);

  const config = join(OUT_DIR, "tsconfig.json");
  writeFileSync(
    config,
    `${JSON.stringify(
      {
        extends: "../../tsconfig.base.json",
        compilerOptions: { lib: ["ES2023"], types: ["node"] },
        include: ["*.ts"],
      },
      null,
      2,
    )}\n`,
  );

  return {
    decls,
    byName,
    contradictions,
    protoTypes,
    check,
    compared: [...new Set(compared)].sort(),
    config,
  };
}

let cached: Analysis | undefined;
const analyzed = (): Analysis => (cached ??= analyze());

describe("protocol conformance to the specification", () => {
  it("has every required name on both the specification and the protocol side", () => {
    const { byName, protoTypes } = analyzed();
    const missingSpec = REQUIRED.filter(({ name }) => !byName.has(name)).map(({ name }) => name);
    const missingProto = REQUIRED.filter(({ name }) => !protoTypes.has(name)).map(({ name }) => name);
    const wrongFile = REQUIRED.filter(({ name, proto }) => protoTypes.has(name) && protoTypes.get(name) !== proto).map(
      ({ name, proto }) => `${name} is in src/protocol/${protoTypes.get(name)}.ts, plan 2.1 assigns it to ${proto}.ts`,
    );
    expect(missingSpec, "required names the specification does not declare").toEqual([]);
    expect(missingProto, "required names the protocol module does not export").toEqual([]);
    expect(wrongFile, "required names not in the file plan 2.1 assigns them to").toEqual([]);
  });

  it("typechecks the generated mutual-assignability assertions with the repository's tsc", () => {
    const { config, compared, contradictions } = analyzed();
    console.log(`compared ${compared.length} specification type names:\n${compared.join(", ")}`);
    for (const warning of contradictions.values()) console.log(`CONTRADICTION: ${warning}`);
    let output = "";
    try {
      execFileSync(process.execPath, [COMPILER, "--noEmit", "--pretty", "false", "-p", config], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; status?: number };
      output = `${failed.stdout ?? ""}${failed.stderr ?? ""}`;
      if (output === "") output = String(error);
    }
    expect(
      output,
      `compared ${compared.length} specification type names:\n${compared.join(", ")}\n\ncompiler output:`,
    ).toBe("");
  });
});
