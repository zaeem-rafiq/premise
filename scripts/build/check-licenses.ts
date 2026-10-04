// npm run check:licenses
//
// BP5: reads the bundlers' module lists and fails on any package whose licence is not allowed.
// The lists are written by `npm run build`: dist/meta/floor.json and dist/meta/host.json (Vite, through
// scripts/build/module-list.ts) and dist/meta/worker.json (the esbuild metafile that wrangler writes).
// It also checks every direct dependency of package.json.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { licenseAllowed, packageDirectoryOf } from "./licenses.ts";
import { META_DIR } from "./module-list.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

type PackageJson = {
  name?: string;
  version?: string;
  license?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
}

/** The module paths of one bundle, relative to the repository root. */
function modulesOf(bundle: "floor" | "host" | "worker"): string[] {
  const file = `${META_DIR}/${bundle}.json`;
  if (!existsSync(join(repoRoot, file))) {
    throw new Error(`${file} is missing. Run \`npm run build\` first.`);
  }
  const data = readJson(file);
  if (Array.isArray(data)) return data as string[];
  const inputs = (data as { inputs?: Record<string, unknown> }).inputs;
  if (inputs === undefined) {
    throw new Error(`${file} is neither a module list nor an esbuild metafile.`);
  }
  return Object.keys(inputs);
}

function main(): number {
  // Package directory -> where it was found.
  const packages = new Map<string, string>();
  for (const bundle of ["floor", "host", "worker"] as const) {
    for (const modulePath of modulesOf(bundle)) {
      const directory = packageDirectoryOf(modulePath.split("\\").join("/"));
      if (directory !== null && !packages.has(directory)) packages.set(directory, `the ${bundle} bundle`);
    }
  }
  const bundled = packages.size;

  const own = readJson("package.json") as PackageJson;
  const direct = [...Object.keys(own.dependencies ?? {}), ...Object.keys(own.devDependencies ?? {})];
  for (const name of direct) {
    const directory = `node_modules/${name}`;
    if (!packages.has(directory)) packages.set(directory, "package.json");
  }

  const refused: string[] = [];
  for (const [directory, where] of [...packages].sort()) {
    const manifest = `${directory}/package.json`;
    if (!existsSync(join(repoRoot, manifest))) {
      refused.push(`${directory} (from ${where}): no package.json. Run \`npm ci\`.`);
      continue;
    }
    const { name, version, license } = readJson(manifest) as PackageJson;
    const expression = typeof license === "string" ? license : "";
    if (!licenseAllowed(expression)) {
      refused.push(`${name}@${version} (from ${where}): licence "${expression}" is not allowed.`);
    }
  }

  if (refused.length > 0) {
    console.error("check:licenses: BP5 allows MIT, Apache-2.0, BSD and Unlicense only.");
    for (const line of refused) console.error(`  ${line}`);
    return 1;
  }
  console.log(
    `check:licenses: ${bundled} bundled package(s) and ${direct.length} direct dependencies, every licence allowed.`,
  );
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`check:licenses: ${(error as Error).message}`);
  process.exitCode = 2;
}
