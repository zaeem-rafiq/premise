// The import allow list of docs/spec/04-build-plan.md 1.3, mechanism 2, as data.
//
// To change who may import what, change the table in the plan first, then ZONES below.
//
// A comment can bring types in as well: `/// <reference … />` adds a file, a type package or a library to every
// file of its program, and `// @ts-nocheck` switches the compiler off for its file. Either one would undo
// mechanism 1 (the separate compile) unseen, so both are refused in every file under `src/`.

import { statSync } from "node:fs";
import { join, posix } from "node:path";
import {
  codeFilesUnder,
  isTestFile,
  lineOf,
  memberName,
  parseSource,
  readText,
  stringValue,
  walk,
} from "../support/source.ts";
import type { Comment, Node } from "../support/source.ts";

type Allow = {
  /** Repository paths a relative import may reach. A directory ends with "/". */
  readonly paths: readonly string[];
  /** Repository paths under `paths` that are still closed. */
  readonly notPaths?: readonly string[];
  /** Repository paths reachable only by `import type` and `export type`. */
  readonly typeOnlyPaths?: readonly string[];
  /** Packages a bare import may name. An entry that ends with ":" allows every module of that scheme. */
  readonly packages: readonly string[];
};

/** `files` is a directory (it ends with "/") or one file. */
type Zone = { readonly files: string; readonly allow: Allow };

/** One row of the plan's table per zone. The first zone that holds the file decides. */
export const ZONES: readonly Zone[] = [
  // The row of src/host/** says that this file "itself imports nothing": the host takes values from it, so
  // whatever it imported would travel into the pool frame with them.
  { files: "src/protocol/constants.ts", allow: { paths: [], packages: [] } },
  { files: "src/protocol/", allow: { paths: ["src/protocol/"], packages: [] } },
  { files: "src/copy/", allow: { paths: ["src/copy/", "src/protocol/"], packages: [] } },
  { files: "src/config/", allow: { paths: ["src/config/", "src/protocol/"], packages: [] } },
  { files: "src/core/sync/", allow: { paths: ["src/core/sync/"], packages: ["node:crypto", "node:zlib"] } },
  { files: "src/core/", allow: { paths: ["src/core/", "src/protocol/", "src/copy/"], packages: ["acorn"] } },
  { files: "src/swarm/", allow: { paths: ["src/swarm/", "src/core/sync/", "src/protocol/"], packages: [] } },
  {
    files: "src/host/",
    allow: {
      paths: ["src/host/", "src/protocol/constants.ts"],
      typeOnlyPaths: ["src/protocol/channel.ts"],
      packages: [],
    },
  },
  {
    files: "src/floor/",
    allow: { paths: ["src/floor/", "src/protocol/", "src/copy/"], packages: ["react", "react-dom"] },
  },
  {
    files: "src/worker/",
    allow: { paths: ["src/"], notPaths: ["src/floor/", "src/host/"], packages: ["cloudflare:workers", "node:"] },
  },
];

/** What a test file (`*.test.ts`) may import on top of its zone. */
const TEST_FILE_EXTRA: Allow = { paths: ["test/support/"], packages: ["vitest", "node:"] };

/** Directories whose files are checked. Files outside `src/` have no zone: only the rules for all files apply. */
export const CHECKED_DIRECTORIES = ["src", "test", "scripts"] as const;

/** Working material from before the build. No checked file imports from it (BP6). */
const REFERENCE = "reference/";

/** Files that break the rules on purpose, for this test's own negative cases. Never part of the real scan. */
export const FIXTURES = "test/arch/fixtures/";

export type Violation = { file: string; line: number; specifier: string; reason: string };

type Import = { specifier: string | null; typeOnly: boolean; offset: number; what: string };

function under(path: string, entry: string): boolean {
  return entry.endsWith("/") ? path.startsWith(entry) : path === entry;
}

function packageAllowed(specifier: string, packages: readonly string[]): boolean {
  return packages.some((entry) =>
    entry.endsWith(":") ? specifier.startsWith(entry) : specifier === entry || specifier.startsWith(`${entry}/`),
  );
}

function zoneOf(file: string): Zone | null {
  return ZONES.find((zone) => under(file, zone.files)) ?? null;
}

/** The zone as the plan's table writes it: `src/core/**` for a directory, the path for one file. */
function nameOf(zone: Zone): string {
  return zone.files.endsWith("/") ? `${zone.files}**` : zone.files;
}

/** The sentence that ends a refusal: what the zone may import. */
function mayImport(allow: Allow, testFile: boolean): string {
  const parts = [
    ...allow.paths.map((path) => (allow.notPaths === undefined ? path : `${path} (not ${allow.notPaths.join(", ")})`)),
    ...(allow.typeOnlyPaths ?? []).map((path) => `types only from ${path}`),
    ...allow.packages.map((entry) => (entry.endsWith(":") ? `${entry}*` : entry)),
    ...(testFile ? ["and, as a test file: vitest, node:*, test/support/"] : []),
  ];
  return parts.length === 0 ? "It may import nothing." : `It may import: ${parts.join(", ")}.`;
}

/** The text of a `///` comment that adds a file, a type package or a library to its whole program. */
const REFERENCE_DIRECTIVE = /^\/\s*<reference\s/i;

/** The text of a `//` or `///` comment that switches the compiler off for its file. */
const NO_CHECK_DIRECTIVE = /^\/?\s*@ts-nocheck(?=[\s:]|$)/i;

/**
 * Why a comment may not stand in a file under `src/`, or null. The compiler obeys these two only at the top
 * of a file, and reads their names in any letter case. They are refused wherever they stand: nothing needs one.
 */
function directiveRefusal(comment: Comment): string | null {
  if (comment.type !== "Line") return null;
  if (REFERENCE_DIRECTIVE.test(comment.value)) {
    return "A `/// <reference>` comment adds types to every file of its program, past the import allow list. Remove it: each tsconfig file names its own libraries and types (plan 1.3).";
  }
  if (NO_CHECK_DIRECTIVE.test(comment.value)) {
    return "A `@ts-nocheck` comment switches the compiler off for this file. Remove it (plan 1.3).";
  }
  return null;
}

/** Every import, re-export, `import()`, `require()` and `import.meta.glob()` of one parsed file. */
function importsOf(program: Node): Import[] {
  const found: Import[] = [];
  walk(program, (node) => {
    switch (node.type) {
      case "ImportDeclaration":
        found.push({
          specifier: stringValue(node.source),
          typeOnly: node.importKind === "type",
          offset: node.start,
          what: "import",
        });
        break;
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
        if (node.source !== null && node.source !== undefined) {
          found.push({
            specifier: stringValue(node.source),
            typeOnly: node.exportKind === "type",
            offset: node.start,
            what: "export … from",
          });
        }
        break;
      case "ImportExpression":
        found.push({ specifier: stringValue(node.source), typeOnly: false, offset: node.start, what: "import()" });
        break;
      case "TSImportType":
        found.push({ specifier: stringValue(node.source), typeOnly: true, offset: node.start, what: "import() type" });
        break;
      case "TSExternalModuleReference":
        found.push({
          specifier: stringValue(node.expression),
          typeOnly: false,
          offset: node.start,
          what: "import = require()",
        });
        break;
      case "CallExpression": {
        const callee = node.callee as Node;
        if (callee.type === "Identifier" && callee.name === "require") {
          const [argument] = node.arguments as unknown[];
          found.push({ specifier: stringValue(argument), typeOnly: false, offset: node.start, what: "require()" });
        } else if (
          callee.type === "MemberExpression" &&
          (callee.object as Node).type === "MetaProperty" &&
          memberName(callee) === "glob"
        ) {
          // A glob import names its modules by pattern, so this test could not see them.
          found.push({ specifier: null, typeOnly: false, offset: node.start, what: "import.meta.glob()" });
        }
        break;
      }
      default:
        break;
    }
  });
  return found;
}

function isRelative(specifier: string): boolean {
  return specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
}

/**
 * Checks one file's source text: its imports and, under `src/`, its comments. `file` is its path from the
 * repository root.
 * With `isFile`, a relative import must also name a file that exists: `./x.ts`, never `./x.js` or `./x`.
 * Node runs the files under `scripts/` as they are, so the name in the import is the name on disk.
 */
export function violationsIn(file: string, text: string, isFile?: (path: string) => boolean): Violation[] {
  const violations: Violation[] = [];
  const zone = zoneOf(file);
  const testFile = isTestFile(file);

  if (zone === null && file.startsWith("src/")) {
    violations.push({
      file,
      line: 1,
      specifier: "",
      reason: `${file} is in no zone of the import allow list. Add its directory to plan 1.3 and to ZONES.`,
    });
    return violations;
  }

  const { program, comments } = parseSource(file, text);

  if (file.startsWith("src/")) {
    for (const comment of comments) {
      const reason = directiveRefusal(comment);
      if (reason !== null) {
        violations.push({ file, line: lineOf(text, comment.start), specifier: `//${comment.value}`.trim(), reason });
      }
    }
  }

  for (const found of importsOf(program)) {
    const line = lineOf(text, found.offset);
    const fail = (reason: string): void => {
      violations.push({ file, line, specifier: found.specifier ?? "", reason });
    };

    if (found.specifier === null) {
      fail(`${found.what} without a fixed string cannot be checked. Name the module in a string.`);
      continue;
    }
    const specifier = found.specifier;

    if (!isRelative(specifier)) {
      if (specifier.startsWith("/") || /^[a-z][a-z0-9+.-]*:\/\//i.test(specifier)) {
        fail(`"${specifier}" is an absolute address. Import by relative path or by package name.`);
        continue;
      }
      if (zone === null) continue;
      const allowed =
        packageAllowed(specifier, zone.allow.packages) ||
        (testFile && packageAllowed(specifier, TEST_FILE_EXTRA.packages));
      if (!allowed) {
        fail(`${nameOf(zone)} may not import "${specifier}". ${mayImport(zone.allow, testFile)}`);
      }
      continue;
    }

    const target = posix.normalize(posix.join(posix.dirname(file), specifier));
    if (target.startsWith("../")) {
      fail(`"${specifier}" leaves the repository.`);
      continue;
    }
    if (under(target, REFERENCE)) {
      fail(`"${specifier}" reaches ${REFERENCE}, which is not product code (BP6).`);
      continue;
    }
    if (zone !== null) {
      const open =
        zone.allow.paths.some((entry) => under(target, entry)) &&
        !(zone.allow.notPaths ?? []).some((entry) => under(target, entry));
      const openForTypes = (zone.allow.typeOnlyPaths ?? []).some((entry) => under(target, entry));
      const openForTests = testFile && TEST_FILE_EXTRA.paths.some((entry) => under(target, entry));
      if (!open && !openForTests && !(openForTypes && found.typeOnly)) {
        fail(
          openForTypes
            ? `${nameOf(zone)} may import ${target} with \`import type\` only.`
            : `${nameOf(zone)} may not import ${target}. ${mayImport(zone.allow, testFile)}`,
        );
        continue;
      }
    }
    if (isFile !== undefined && !isFile(target)) {
      fail(`"${specifier}" names no file. Write the name of the file that exists, with its extension ("./x.ts").`);
    }
  }
  return violations;
}

function isFileAt(root: string, path: string): boolean {
  return statSync(join(root, path), { throwIfNoEntry: false })?.isFile() === true;
}

/**
 * Checks every code file under the checked directories of `root`.
 * `skip` names directories (ending with "/") that are left out.
 */
export function violationsUnder(root: string, skip: readonly string[] = []): Violation[] {
  return CHECKED_DIRECTORIES.flatMap((directory) => codeFilesUnder(root, directory))
    .filter((file) => !skip.some((entry) => under(file, entry)))
    .flatMap((file) => violationsIn(file, readText(root, file), (path) => isFileAt(root, path)));
}

export function format(violations: readonly Violation[]): string {
  return violations.map((violation) => `${violation.file}:${violation.line}  ${violation.reason}`).join("\n");
}
