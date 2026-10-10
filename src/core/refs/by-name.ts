// References by name for Python and Go (06-repos.md LG4, LG9). Each entity's uses (collected in
// `src/core/entities/tree-modules.ts`) are matched against definitions: of the same module (Python)
// or package (Go), of what a Python import binds, and of a Go import's package. Every match is a
// reference, and no match gives none: a by-name reference never adds to `unresolved` or `banned`.

import type { ModuleInfo } from "../entities/entities.ts";
import type { ImportBinding } from "../entities/tree-modules.ts";

/** The kinds that are top-level definitions a name can refer to (LG4). */
const DEFINITION_KINDS = new Set(["function", "class", "const", "var", "type"]);

/** The directory of a path, "" for the root. */
function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function join(directory: string, rest: string): string {
  return directory === "" ? rest : rest === "" ? directory : `${directory}/${rest}`;
}

// ---- Python (LG9) ----

/**
 * The pool directory a Python module name points at, without the file: `a.b` -> `a/b`, and a
 * relative `..m` from `p/q/x.py` -> `p/m`. Null when a relative name climbs above the root.
 */
function pythonModuleBase(fromPath: string, module: string): string | null {
  const dots = /^\.*/.exec(module)![0].length;
  const rest = module
    .slice(dots)
    .split(".")
    .filter((part) => part !== "");
  if (dots === 0) return rest.join("/");
  let directory = directoryOf(fromPath);
  for (let up = 1; up < dots; up += 1) {
    if (directory === "") return null;
    directory = directoryOf(directory);
  }
  return join(directory, rest.join("/"));
}

/** LG9: `a/b.py`, then `a/b/__init__.py`; null when neither is a pool file (the module is external). */
function pythonModulePath(fromPath: string, module: string, files: ReadonlySet<string>): string | null {
  const base = pythonModuleBase(fromPath, module);
  if (base === null) return null;
  if (base !== "" && files.has(`${base}.py`)) return `${base}.py`;
  const init = join(base, "__init__.py");
  return files.has(init) ? init : null;
}

/** The keys one Python import binding refers to: `m#n`, or the whole module of a submodule `p/n`. */
function pythonBindingTargets(
  fromPath: string,
  binding: ImportBinding,
  modules: ReadonlyMap<string, ModuleInfo>,
  files: ReadonlySet<string>,
): string[] {
  if (binding.imported === null) {
    const path = pythonModulePath(fromPath, binding.module, files);
    return path === null ? [] : [path];
  }
  const path = pythonModulePath(fromPath, binding.module, files);
  if (path !== null && definesName(modules.get(path), binding.imported)) return [`${path}#${binding.imported}`];
  // LG9: when the package defines no `n` but the file `p/n.py` exists, `n` is that whole module.
  const submodule = pythonModulePath(
    fromPath,
    `${binding.module}${binding.module.endsWith(".") ? "" : "."}${binding.imported}`,
    files,
  );
  return submodule === null ? [] : [submodule];
}

function definesName(info: ModuleInfo | undefined, name: string): boolean {
  return (
    info !== undefined && info.entities.some((entity) => entity.name === name && DEFINITION_KINDS.has(entity.kind))
  );
}

function pythonRefs(
  path: string,
  info: ModuleInfo,
  modules: ReadonlyMap<string, ModuleInfo>,
  files: ReadonlySet<string>,
  add: (from: string, to: string) => void,
): void {
  const syntax = info.syntax!;
  const definitions = new Set(info.entities.filter((e) => DEFINITION_KINDS.has(e.kind)).map((e) => e.name));
  for (const entity of info.entities) {
    const from = `${path}#${entity.name}`;
    if (entity.kind === "import") {
      // An import statement refers to what it imports, as a JavaScript import does (6.2).
      for (const target of syntax.importTargets.get(entity.name) ?? []) {
        for (const key of pythonBindingTargets(path, target, modules, files)) add(from, key);
      }
      continue;
    }
    const uses = syntax.uses.get(entity.name);
    if (uses === undefined) continue;
    // A module used as `a.x` is referred to through `x` (below), not as a whole.
    const objects = new Set(uses.attributes.map(([object]) => object));
    for (const name of new Set(uses.names)) {
      if (definitions.has(name)) {
        if (name !== entity.name) add(from, `${path}#${name}`); // never refers to itself (6.3)
        continue;
      }
      const binding = syntax.bindings.get(name);
      if (binding !== undefined && binding.imported !== null) {
        for (const key of pythonBindingTargets(path, binding, modules, files)) {
          if (!key.includes("#") && objects.has(name)) continue;
          add(from, key);
        }
      }
    }
    for (const [object, attribute] of uses.attributes) {
      const binding = syntax.bindings.get(object);
      if (binding === undefined) continue;
      // `a` is a module: bound by `import m [as a]`, or by `from p import a` where `a` is a submodule.
      const targets = pythonBindingTargets(path, binding, modules, files).filter((key) => !key.includes("#"));
      for (const modulePath of targets) {
        if (definesName(modules.get(modulePath), attribute)) add(from, `${modulePath}#${attribute}`);
      }
    }
  }
}

// ---- Go (LG9) ----

type GoPackage = { directory: string; name: string; files: string[] };

/** The pool's module path: the `module` line of the root `go.mod`, or null. */
function goModulePath(contents: ReadonlyMap<string, string>): string | null {
  const goMod = contents.get("go.mod");
  if (goMod === undefined) return null;
  const match = /^\s*module\s+("?)([^\s"]+)\1\s*$/m.exec(goMod);
  return match === null ? null : match[2]!;
}

/** The pool directory an import path names (LG9), or null when the path is external. */
function goImportDirectory(importPath: string, modulePath: string | null): string | null {
  if (modulePath === null) return null;
  if (importPath === modulePath) return "";
  return importPath.startsWith(`${modulePath}/`) ? importPath.slice(modulePath.length + 1) : null;
}

function goPackages(modules: ReadonlyMap<string, ModuleInfo>): Map<string, GoPackage> {
  const packages = new Map<string, GoPackage>();
  for (const [path, info] of modules) {
    if (info.syntax?.language !== "go" || info.syntax.packageName === null) continue;
    const directory = directoryOf(path);
    const key = `${directory}\0${info.syntax.packageName}`;
    let found = packages.get(key);
    if (found === undefined) {
      found = { directory, name: info.syntax.packageName, files: [] };
      packages.set(key, found);
    }
    found.files.push(path);
  }
  return packages;
}

/** The package an imported directory holds: its files that are not `_test.go` decide its name. */
function importedPackage(directory: string, packages: ReadonlyMap<string, GoPackage>): GoPackage | null {
  const candidates = [...packages.values()].filter((pkg) => pkg.directory === directory);
  return candidates.find((pkg) => pkg.files.some((file) => !file.endsWith("_test.go"))) ?? candidates[0] ?? null;
}

function goRefs(
  modules: ReadonlyMap<string, ModuleInfo>,
  contents: ReadonlyMap<string, string>,
  add: (from: string, to: string) => void,
): void {
  const packages = goPackages(modules);
  const modulePath = goModulePath(contents);
  // name -> the keys of the definitions and methods of one package with that name.
  const definitionsOf = (pkg: GoPackage) => {
    const byName = new Map<string, string[]>();
    const methods = new Map<string, string[]>();
    for (const file of pkg.files) {
      for (const entity of modules.get(file)!.entities) {
        const key = `${file}#${entity.name}`;
        if (DEFINITION_KINDS.has(entity.kind)) byName.set(entity.name, [...(byName.get(entity.name) ?? []), key]);
        if ((entity.kind as string) === "method") {
          const method = entity.name.slice(entity.name.indexOf(".") + 1);
          methods.set(method, [...(methods.get(method) ?? []), key]);
        }
      }
    }
    return { byName, methods };
  };
  const tables = new Map<GoPackage, ReturnType<typeof definitionsOf>>();
  const tableOf = (pkg: GoPackage) => {
    let table = tables.get(pkg);
    if (table === undefined) {
      table = definitionsOf(pkg);
      tables.set(pkg, table);
    }
    return table;
  };

  for (const pkg of packages.values()) {
    const own = tableOf(pkg);
    for (const path of pkg.files) {
      const info = modules.get(path)!;
      const syntax = info.syntax!;
      // The package names this file's imports bind: the alias, or the imported package's own name.
      const imported = new Map<string, GoPackage>();
      for (const { path: importPath, alias } of syntax.goImports) {
        if (alias === "_" || alias === ".") continue;
        const directory = goImportDirectory(importPath, modulePath);
        if (directory === null) continue;
        const target = importedPackage(directory, packages);
        if (target !== null) imported.set(alias ?? target.name, target);
      }
      for (const entity of info.entities) {
        const from = `${path}#${entity.name}`;
        const uses = syntax.uses.get(entity.name);
        if (uses === undefined || entity.kind === "import") continue;
        for (const name of new Set(uses.names)) {
          for (const key of own.byName.get(name) ?? []) if (key !== from) add(from, key);
        }
        for (const [object, attribute] of uses.attributes) {
          const target = imported.get(object);
          if (target === undefined) continue;
          const table = tableOf(target);
          for (const key of [...(table.byName.get(attribute) ?? []), ...(table.methods.get(attribute) ?? [])]) {
            if (key !== from) add(from, key);
          }
        }
      }
    }
  }
}

/**
 * Adds the LG4 references of every Python and Go module in `modules` through `add`. `contents` is
 * the file map (for the root `go.mod`), `files` the paths that exist.
 */
export function addByNameRefs(
  modules: ReadonlyMap<string, ModuleInfo>,
  contents: ReadonlyMap<string, string>,
  files: ReadonlySet<string>,
  add: (from: string, to: string) => void,
): void {
  for (const [path, info] of modules) {
    if (info.syntax?.language === "python") pythonRefs(path, info, modules, files, add);
  }
  goRefs(modules, contents, add);
}
