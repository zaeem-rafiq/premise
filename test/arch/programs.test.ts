// docs/spec/04-build-plan.md 1.3, mechanism 1 (separate compile), and 1.5 (`npm run typecheck`).
//
// `npm run typecheck` compiles several programs, each with the libraries of the code in it. What a program
// holds is read from the compiler itself (`tsc --showConfig`), never from the text of a tsconfig file.
// Expected values come from the plan (BP1).

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codeFilesUnder, isTestFile, REPO_ROOT } from "../support/source.ts";
import { CHECKED_DIRECTORIES, FIXTURES } from "./import-rules.ts";

/** Plan 1.5, the row "Typecheck": the programs in the order they are compiled. */
const PLAN_PROGRAMS = [
  "tsconfig.core.json",
  "tsconfig.worker.json",
  "tsconfig.floor.json",
  "tsconfig.host.json",
  "tsconfig.test.json",
  "tsconfig.test-browser.json",
];

/** Options that every program takes over. It is no program itself. */
const SHARED_OPTIONS = "tsconfig.base.json";

/** Plan 1.3: the pure paths. */
const PURE_PATHS = ["src/protocol/", "src/copy/", "src/config/", "src/core/", "src/swarm/"];

const COMPILER = join(REPO_ROOT, "node_modules/typescript/bin/tsc");

type Program = {
  /** The files the program names, as paths from the repository root. Files they import come on top. */
  files: string[];
  /** Lower case, as the compiler prints them. */
  lib: string[];
  types: string[];
};

function programOf(config: string): Program {
  const output = execFileSync(process.execPath, [COMPILER, "--showConfig", "--project", config], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const shown = JSON.parse(output) as { files?: string[]; compilerOptions?: { lib?: string[]; types?: string[] } };
  return {
    files: (shown.files ?? []).map((file) => file.replace(/^\.\//, "")),
    lib: (shown.compilerOptions?.lib ?? []).map((name) => name.toLowerCase()),
    types: shown.compilerOptions?.types ?? [],
  };
}

const programs = new Map(PLAN_PROGRAMS.map((config) => [config, programOf(config)]));

function program(config: string): Program {
  const found = programs.get(config);
  if (found === undefined) throw new Error(`${config} is not a program of plan 1.5.`);
  return found;
}

function isTypeScript(path: string): boolean {
  return /\.[cm]?tsx?$/.test(path);
}

describe("npm run typecheck", () => {
  it("compiles the programs of plan 1.5, in the plan's order", () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const compiled = [...(manifest.scripts.typecheck ?? "").matchAll(/tsc --noEmit -p (\S+)/g)].map(
      ([, config]) => config,
    );
    expect(compiled).toEqual(PLAN_PROGRAMS);
  });

  it("leaves out no tsconfig file of the repository root", () => {
    const present = readdirSync(REPO_ROOT)
      .filter((name) => /^tsconfig\..*json$/.test(name) && name !== SHARED_OPTIONS)
      .sort();
    expect(present).toEqual([...PLAN_PROGRAMS].sort());
  });

  it("compiles every TypeScript file under src/, test/ and scripts/ in at least one program", () => {
    const compiled = new Set([...programs.values()].flatMap((entry) => entry.files));
    const files = CHECKED_DIRECTORIES.flatMap((directory) => codeFilesUnder(REPO_ROOT, directory)).filter(
      (file) => isTypeScript(file) && !file.startsWith(FIXTURES),
    );
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => !compiled.has(file))).toEqual([]);
  });
});

describe("separate compile (plan 1.3, mechanism 1)", () => {
  it("tsconfig.core.json holds only the pure paths, and none of their test files", () => {
    const { files } = program("tsconfig.core.json");
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => !PURE_PATHS.some((path) => file.startsWith(path)))).toEqual([]);
    expect(files.filter(isTestFile)).toEqual([]);
  });

  it("tsconfig.core.json has the library ES2023 and the types of Node, and nothing else", () => {
    const core = program("tsconfig.core.json");
    expect(core.lib).toEqual(["es2023"]);
    expect(core.types).toEqual(["node"]);
  });

  it("the Worker's types are in the Worker's program only", () => {
    for (const [config, entry] of programs) {
      expect(entry.files.includes("worker-configuration.d.ts"), config).toBe(config === "tsconfig.worker.json");
    }
  });

  it.each(["tsconfig.floor.json", "tsconfig.host.json"])(
    "%s is browser code: no types of Node, and no test file, because a test needs them",
    (config) => {
      const browser = program(config);
      expect(browser.files.length).toBeGreaterThan(0);
      expect(browser.types).not.toContain("node");
      expect(browser.files.filter(isTestFile)).toEqual([]);
    },
  );

  it("only the programs for browser code have the DOM library", () => {
    const withDom = [...programs]
      .filter(([, entry]) => entry.lib.some((name) => name.startsWith("dom")))
      .map(([config]) => config);
    expect(withDom).toEqual(["tsconfig.floor.json", "tsconfig.host.json", "tsconfig.test-browser.json"]);
  });
});
