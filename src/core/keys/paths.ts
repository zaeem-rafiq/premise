// Pool repository paths and directory keys (01-core.md 2.1).

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

/** A module is a file whose path ends in `.js` or `.mjs` (2.1). It is opaque when it does not parse. */
export function isModulePath(path: string): boolean {
  return path.endsWith(".js") || path.endsWith(".mjs");
}
