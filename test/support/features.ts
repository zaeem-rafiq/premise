// A test's own flags (FJ1): the built Worker's source with the values a test names in its one
// `FEATURES` object, whatever `src/config/features.ts` ships. A test of a feature's on or off
// behavior starts the Worker from this text, so switching a flag in the build (BP4 says when)
// changes the test of no feature.

import type { Features } from "../../src/protocol/floor-json.ts";

/** `source` (the text of `dist/worker/index.js`) with each key of `features` set in the bundle's
 * one `FEATURES` object. Throws when the bundle holds no such object, or more than one, or the
 * object lacks a key: a test must never run with flags it did not ask for. */
export function withFeatures(source: string, features: Partial<Features>): string {
  const blocks = source.match(/var FEATURES = \{[\s\S]*?\n\};/g) ?? [];
  if (blocks.length !== 1) throw new Error("the built bundle must hold exactly one FEATURES object");
  const original = blocks[0]!;
  let block = original;
  for (const [key, value] of Object.entries(features)) {
    const property = new RegExp(`(\\n  ${key}: )(?:true|false|"[a-z_]+")(,?\\n)`);
    if (!property.test(block)) throw new Error(`the built FEATURES object has no ${key} property`);
    block = block.replace(property, `$1${JSON.stringify(value)}$2`);
  }
  return source.replace(original, () => block);
}
