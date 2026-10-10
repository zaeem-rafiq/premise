// Pool repository paths and directory keys (01-core.md 2.1), and the pool's
// language set (06-repos.md LG1): which extensions are modules and which
// language parses them.

import { MAX_PATH_LEN } from "../../protocol/constants.ts";
import { PATH_PATTERN } from "../../protocol/premise.ts";

const FORBIDDEN_SEGMENTS = new Set([".", "..", ".git"]);

/**
 * A path of the pool repository (2.1): relative to the repo root, segments of
 * `[A-Za-z0-9._-]`, never `.`, `..` or `.git`, at most `MAX_PATH_LEN` characters.
 */
export function isPath(path: string): boolean {
  return (
    path.length <= MAX_PATH_LEN &&
    PATH_PATTERN.test(path) &&
    !path.split("/").some((segment) => FORBIDDEN_SEGMENTS.has(segment))
  );
}

/** The directory key of a directory: its path followed by `/`. The repo root is `/` (2.1). */
export function directoryKey(directory: string): string {
  if (directory === "/" || directory === "") return "/";
  return directory.endsWith("/") ? directory : `${directory}/`;
}

/**
 * The directory key of the directory that holds `path`:
 * `creatures/fish.js` -> `creatures/`, `main.js` -> `/`.
 */
export function parentKey(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "/" : path.slice(0, slash + 1);
}

// ---- LG1: a pool's language set ----

/** The module languages of LG1. `"jsx"` is JavaScript with JSX, `"tsx"` TypeScript with JSX;
 * `"python"` and `"go"` parse through tree-sitter (LG4). */
export type Language = "javascript" | "jsx" | "typescript" | "tsx" | "python" | "go";

/**
 * A pool's language set: which extensions are modules (LG1) and how a relative specifier
 * resolves under them (LG3). The resolution fields are empty in the tide-pool set, where 6.1's
 * "no extension is added" holds unchanged.
 */
export type LanguageSet = {
  /** extension, with the dot, -> the language that parses it. */
  readonly languages: Readonly<Record<string, Language>>;
  /** extensions appended to a specifier that matched no exact path, in order (LG3). */
  readonly resolveAppend: readonly string[];
  /** specifier endings replaced by these, in order (LG3). */
  readonly resolveReplace: Readonly<Record<string, readonly string[]>>;
  /** index files tried for a specifier that names a directory, in order (LG3). */
  readonly resolveIndex: readonly string[];
  /** `true` when a specifier that is not relative is a `banned_import` (CK5); under the
   * imported set it is simply external — no reference, no premise, no check failure (LG3). */
  readonly externalSpecifiersBanned: boolean;
};

/** The tide-pool set (LG1): only `.js` and `.mjs` are modules, resolved as in 6.1. */
export const TIDEPOOL_LANGUAGES: LanguageSet = {
  languages: { ".js": "javascript", ".mjs": "javascript" },
  resolveAppend: [],
  resolveReplace: {},
  resolveIndex: [],
  externalSpecifiersBanned: true,
};

/** The imported-pool set (LG1): JavaScript, TypeScript, Python and Go. */
export const IMPORT_LANGUAGES: LanguageSet = {
  languages: {
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".jsx": "jsx",
    ".ts": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".tsx": "tsx",
    ".py": "python",
    ".go": "go",
  },
  resolveAppend: [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs"],
  resolveReplace: {
    ".js": [".ts", ".mts", ".cts"],
    ".mjs": [".ts", ".mts", ".cts"],
    ".cjs": [".ts", ".mts", ".cts"],
  },
  resolveIndex: ["index.ts", "index.tsx", "index.js"],
  externalSpecifiersBanned: false,
};

/**
 * The language of `path` under `languages`, or null when its extension is not a module
 * language of the set (the file is opaque, 2.1).
 */
export function languageOfPath(path: string, languages: LanguageSet = TIDEPOOL_LANGUAGES): Language | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1 || dot < path.lastIndexOf("/")) return null;
  return languages.languages[path.slice(dot)] ?? null;
}

/**
 * A module is a file whose extension is in the pool's language set (2.1, LG1). The default is
 * the tide-pool set, so a caller without a set keeps the `.js`/`.mjs` behaviour of 2.1.
 */
export function isModulePath(path: string, languages: LanguageSet = TIDEPOOL_LANGUAGES): boolean {
  return languageOfPath(path, languages) !== null;
}
