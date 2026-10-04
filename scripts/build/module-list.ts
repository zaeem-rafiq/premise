// Records which modules a Vite build put into a bundle, for `npm run check:licenses` (BP5).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import type { Plugin } from "vite";

/** Where the bundlers write their module lists. Outside `dist/client`, so the lists are never deployed. */
export const META_DIR = "dist/meta";

/**
 * A Vite plugin that writes the repository-relative paths of every module of the bundle to `outFile`
 * as a JSON array.
 */
export function moduleList(repoRoot: string, outFile: string): Plugin {
  return {
    name: "premise-module-list",
    apply: "build",
    generateBundle(_options, bundle) {
      const modules = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const id of Object.keys(output.modules)) {
          // Ids that start with a NUL byte are modules a plugin made up; they are no file.
          if (id.startsWith("\0")) continue;
          const file = id.split("?")[0] ?? id;
          modules.add(relative(repoRoot, file).split("\\").join("/"));
        }
      }
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, JSON.stringify([...modules].sort(), null, 2) + "\n");
    },
  };
}
