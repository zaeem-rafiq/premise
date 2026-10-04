// The scoring functions of 05-agent 6.5 and ME8: pure functions over a run's resulting tree and its
// hand-written final files. "Completed" for the early variant, the `energy numbers of a file`,
// whether a creature references `ENERGY_MAX`, and the hero classes. Expected values come from the
// specification, never from a run.

import { parse } from "acorn";
import { importsOf, parseModule, resolveSpecifier } from "./entities.ts";

export type TreeCheck = {
  ok: boolean;
  parse_errors: string[];
  import_errors: string[];
};

/** Every `.js` file of the tree parses as a module; every relative import resolves to a file and an export. */
export function checkTree(files: Map<string, string>): TreeCheck {
  const parseErrors: string[] = [];
  const importErrors: string[] = [];
  for (const [path, content] of files) {
    if (!path.endsWith(".js")) continue;
    const mod = parseModule(path, content);
    if (!mod.ok) {
      parseErrors.push(`${path}: ${mod.error.message}`);
      continue;
    }
    for (const imp of importsOf(path, content)) {
      const target = resolveSpecifier(path, imp.specifier);
      if (target === null) continue; // non-relative imports are banned_import elsewhere; scoring counts them below
      const targetContent = files.get(target);
      if (targetContent === undefined) {
        importErrors.push(`${path}: ${imp.specifier} names no file`);
        continue;
      }
      const targetMod = parseModule(target, targetContent);
      if (!targetMod.ok) continue;
      for (const name of imp.names) {
        if (name === "*") continue;
        if (!targetMod.exports.includes(name)) importErrors.push(`${path}: ${imp.specifier} has no export ${name}`);
      }
    }
  }
  return {
    ok: parseErrors.length === 0 && importErrors.length === 0,
    parse_errors: parseErrors,
    import_errors: importErrors,
  };
}

const REQUIRED_EXPORTS = ["spawn", "update", "draw"];

function exportsFunctions(source: string): boolean {
  const mod = parseModule("creature.js", source);
  if (!mod.ok) return false;
  return REQUIRED_EXPORTS.every((name) =>
    mod.entities.some((e) => e.kind === "function" && e.name === name && e.exports.includes(name)),
  );
}

export type Completion = "completed" | "other_name" | "not_completed";

/**
 * The "completed (early)" tree conditions of 6.5: every `.js` parses, every relative import resolves
 * to a file and an export, and the file of the intent's "Writes" column exists and exports `spawn`,
 * `update` and `draw` as functions. `other_name` when only the Writes file is missing but exactly
 * one added `creatures/*.js` carries the three exports.
 */
export function scoreCompleted(opts: {
  files: Map<string, string>;
  seedPaths: ReadonlySet<string>;
  writes: string;
  passedSubmit: boolean;
}): Completion {
  if (!opts.passedSubmit) return "not_completed";
  const tree = checkTree(opts.files);
  if (!tree.ok) return "not_completed";
  const target = opts.files.get(opts.writes);
  if (target !== undefined && exportsFunctions(target)) return "completed";
  // `other_name`: the run's creature file has another valid kind name.
  const added = [...opts.files.keys()].filter(
    (path) => path.startsWith("creatures/") && path.endsWith(".js") && !opts.seedPaths.has(path),
  );
  const candidates = added.filter((path) => exportsFunctions(opts.files.get(path) as string));
  if (candidates.length === 1) return "other_name";
  return "not_completed";
}

/**
 * `references ENERGY_MAX` (6.5): the written module imports `ENERGY_MAX` from `world/energy.js`
 * and has at least one reference to it outside the import.
 */
export function referencesEnergyMax(path: string, source: string): boolean {
  const imports = importsOf(path, source);
  const brings = imports.some(
    (imp) => imp.names.includes("ENERGY_MAX") && resolveSpecifier(path, imp.specifier) === "world/energy.js",
  );
  if (!brings) return false;
  const needle = /\bENERGY_MAX\b/;
  return source.split("\n").some((line) => {
    const trimmed = line.trimStart();
    return !trimmed.startsWith("import") && needle.test(line);
  });
}

type AstNode = {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
};

function walk(node: unknown, visit: (n: AstNode) => void): void {
  if (typeof node !== "object" || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  const n = node as AstNode;
  if (typeof n.type !== "string") return;
  visit(n);
  for (const key of Object.keys(n)) {
    if (key === "loc" || key === "start" || key === "end" || key === "range") continue;
    walk(n[key], visit);
  }
}

function numericLiterals(node: unknown, out: number[], negative: boolean): void {
  if (typeof node !== "object" || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) numericLiterals(item, out, negative);
    return;
  }
  const n = node as AstNode;
  if (typeof n.type !== "string") return;
  if (n.type === "Literal" && typeof n.value === "number") {
    out.push(negative ? -(n.value as number) : (n.value as number));
    return;
  }
  if (n.type === "UnaryExpression" && n.operator === "-") {
    numericLiterals(n.argument, out, !negative);
    return;
  }
  if (n.type === "UnaryExpression" && n.operator === "+") {
    numericLiterals(n.argument, out, negative);
    return;
  }
  for (const key of Object.keys(n)) {
    if (key === "loc" || key === "start" || key === "end" || key === "range") continue;
    numericLiterals(n[key], out, negative);
  }
}

function containsEnergyMember(node: unknown): boolean {
  let found = false;
  walk(node, (n) => {
    if (n.type === "MemberExpression") {
      const prop = n.property as AstNode | undefined;
      if (prop && prop.type === "Identifier" && prop.name === "energy") found = true;
    }
  });
  return found;
}

const COMPARISONS = new Set(["<", "<=", ">", ">=", "==", "===", "!=", "!=="]);

/**
 * The "energy numbers of a file" (6.5): values of numeric literals in these places, outside the
 * entity `draw`: (a) an argument of a call to `drain` or `feed`; (b) either side of a comparison
 * whose other side holds `.energy`; (c) the initializer of a top-level `const` other than `count`.
 * A literal inside arithmetic counts; a leading minus is part of the value.
 */
export function energyNumbers(source: string): number[] {
  let program: AstNode;
  try {
    program = parse(source, { ecmaVersion: 2025, sourceType: "module" }) as unknown as AstNode;
  } catch {
    return [];
  }
  const out: number[] = [];
  const drawRanges: Array<[number, number]> = [];
  // Regions of the entity `draw` are skipped wholesale.
  const mod = parseModule("creature.js", source);
  if (mod.ok) {
    for (const e of mod.entities) {
      if (e.name === "draw") for (const r of e.regions) drawRanges.push(r);
    }
  }
  const inDraw = (n: AstNode) => drawRanges.some(([s, e]) => n.start >= s && n.end <= e);

  walk(program, (n) => {
    if (inDraw(n)) return;
    if (n.type === "CallExpression") {
      const callee = n.callee as AstNode | undefined;
      if (callee && callee.type === "Identifier" && (callee.name === "drain" || callee.name === "feed")) {
        for (const arg of (n.arguments ?? []) as unknown[]) numericLiterals(arg, out, false);
      }
    }
    if (n.type === "BinaryExpression" && COMPARISONS.has(String(n.operator))) {
      const left = n.left as unknown;
      const right = n.right as unknown;
      if (containsEnergyMember(right)) numericLiterals(left, out, false);
      if (containsEnergyMember(left)) numericLiterals(right, out, false);
    }
    if (n.type === "VariableDeclaration" && n.kind === "const") {
      // top-level only: the declaration's parent chain is not tracked, so check it is a program body member
      const body = (program.body ?? []) as AstNode[];
      const isTop = body.some((b) => b === n) || body.some((b) => (b as AstNode).declaration === n);
      if (!isTop) return;
      for (const decl of (n.declarations ?? []) as AstNode[]) {
        const id = decl.id as AstNode | undefined;
        const name = id && id.type === "Identifier" ? String(id.name) : "";
        if (name === "count") continue;
        numericLiterals(decl.init, out, false);
      }
    }
  });
  return out;
}

function hasNumber(list: number[], value: number): boolean {
  return list.some((n) => Math.abs(n - value) < 1e-9);
}

function sameNumbers(a: number[], b: number[]): boolean {
  const xs = [...a].sort((x, y) => x - y);
  const ys = [...b].sort((x, y) => x - y);
  return xs.length === ys.length && xs.every((v, i) => Math.abs(v - (ys[i] ?? NaN)) < 1e-9);
}

export type HeroClass =
  "not_completed" | "no_reference" | "relative" | "not_answered" | "repaired" | "not_repaired" | "unclear";

const OLD_NUMBER: Record<string, number> = { P1a: 30, P1b: 5 };
const NEW_NUMBER: Record<string, number> = { P1a: 0.3, P1b: 0.05 };

/** ME8: the class of a hero run. The first row that applies decides. */
export function classifyHero(opts: {
  intent: "P1a" | "P1b";
  creaturePath: string;
  firstSubmitPassed: boolean;
  before: string | null; // the creature file kept after the first passing submit
  finalSource: string | null; // the creature file at the run's end
  secondSubmitPassed: boolean;
}): HeroClass {
  if (!opts.firstSubmitPassed || opts.before === null) return "not_completed";
  const oldN = OLD_NUMBER[opts.intent] as number;
  const newN = NEW_NUMBER[opts.intent] as number;
  if (!referencesEnergyMax(opts.creaturePath, opts.before)) {
    return "no_reference";
  }
  const beforeNumbers = energyNumbers(opts.before);
  if (!hasNumber(beforeNumbers, oldN)) return "relative";
  if (!opts.secondSubmitPassed || opts.finalSource === null) return "not_answered";
  const finalNumbers = energyNumbers(opts.finalSource);
  if (hasNumber(finalNumbers, newN) && !hasNumber(finalNumbers, oldN)) return "repaired";
  if (sameNumbers(finalNumbers, beforeNumbers)) return "not_repaired";
  return "unclear";
}
