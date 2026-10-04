// The text query match set of 01-core.md 2.6: a literal, case-sensitive substring search.

import { isModulePath } from "./paths.ts";
import { parseModule, regionTargets } from "../entities/entities.ts";

/** Every offset at which `haystack` starts with `needle`; overlapping matches count (2.6). */
export function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (needle === "") return found;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    found.push(index);
    index = haystack.indexOf(needle, index + 1);
  }
  return found;
}

/**
 * The containers of the matches of `needle` in `path`/`content` (2.6): for a module, one
 * `path#<name>` per target (EN6) of each matched span; for an opaque file, `path`. The result maps
 * each container to the number of matches whose targets include it.
 */
export function matchContainers(path: string, content: string, needle: string): Map<string, number> {
  const counts = new Map<string, number>();
  const offsets = occurrences(content, needle);
  if (offsets.length === 0) return counts;
  let targetsOf: ((start: number, end: number) => string[]) | null = null;
  if (isModulePath(path)) {
    try {
      const info = parseModule(content);
      targetsOf = (start, end) => regionTargets(info, start, end).map((name) => `${path}#${name}`);
    } catch {
      targetsOf = null; // a module that does not parse is opaque (2.1)
    }
  }
  for (const offset of offsets) {
    const containers = targetsOf === null ? [path] : targetsOf(offset, offset + needle.length);
    for (const container of containers) {
      counts.set(container, (counts.get(container) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * The members of a `text:` query premise (2.6): one `<container>*<count>` per container, sorted.
 * `scope` is a directory key (recursive) or a file path; `/` covers the whole pool.
 */
export function textMembers(tree: ReadonlyMap<string, string>, scope: string, needle: string): string[] {
  const total = new Map<string, number>();
  for (const [path, content] of tree) {
    const covered = scope === "/" || path === scope || (scope.endsWith("/") && path.startsWith(scope));
    if (!covered) continue;
    for (const [container, count] of matchContainers(path, content, needle)) {
      total.set(container, (total.get(container) ?? 0) + count);
    }
  }
  return [...total.entries()].map(([container, count]) => `${container}*${count}`).sort();
}
