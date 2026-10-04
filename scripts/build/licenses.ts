// BP5: a package that ends up in the Worker bundle or in a browser bundle must be MIT, Apache-2.0, BSD or
// Unlicense. This file holds the two pure parts of `npm run check:licenses`.

/** SPDX identifiers that BP5 allows. "BSD" is the 2-clause and the 3-clause licence. */
export const ALLOWED_LICENSES: ReadonlySet<string> = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Unlicense",
]);

/**
 * True when an SPDX licence expression is satisfied by the allowed licences alone:
 * every part of an AND, at least one part of an OR. An exception (`WITH`), an unknown identifier or
 * anything that cannot be read is not allowed.
 */
export function licenseAllowed(expression: string): boolean {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let position = 0;

  // Each function returns null when the text cannot be read.
  const factor = (): boolean | null => {
    const token = tokens[position];
    if (token === undefined) return null;
    position += 1;
    if (token === "(") {
      const inner = either();
      if (tokens[position] !== ")") return null;
      position += 1;
      return inner;
    }
    if (token === ")" || token === "AND" || token === "OR" || token === "WITH") return null;
    if (tokens[position] === "WITH") {
      position += 2;
      return false;
    }
    return ALLOWED_LICENSES.has(token);
  };
  const all = (): boolean | null => {
    let result = factor();
    while (result !== null && tokens[position] === "AND") {
      position += 1;
      const next = factor();
      result = next === null ? null : result && next;
    }
    return result;
  };
  const either = (): boolean | null => {
    let result = all();
    while (result !== null && tokens[position] === "OR") {
      position += 1;
      const next = all();
      result = next === null ? null : result || next;
    }
    return result;
  };

  const result = either();
  return result === true && position === tokens.length;
}

/**
 * The package directory a bundled module comes from, as a path that ends with the package name
 * (`node_modules/react`, `node_modules/a/node_modules/@scope/b`). Null for a module of this repository.
 */
export function packageDirectoryOf(modulePath: string): string | null {
  const marker = "node_modules/";
  const at = modulePath.lastIndexOf(marker);
  if (at === -1) return null;
  const [first, second] = modulePath.slice(at + marker.length).split("/");
  if (first === undefined || first === "") return null;
  const name = first.startsWith("@") ? `${first}/${second ?? ""}` : first;
  return modulePath.slice(0, at + marker.length) + name;
}
