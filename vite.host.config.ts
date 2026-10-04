// Builds the pool host (src/host) as one ES module: dist/client/pool/~host.<build>.js (02-tidepool 4.2).
// `<build>` is a hash of the file's content, so the file can be cached for ever.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { META_DIR, moduleList } from "./scripts/build/module-list.ts";

const repoRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: repoRoot,
  publicDir: false,
  plugins: [moduleList(repoRoot, join(repoRoot, META_DIR, "host.json"))],
  build: {
    outDir: join(repoRoot, "dist/client/pool"),
    emptyOutDir: false,
    lib: {
      entry: join(repoRoot, "src/host/main.ts"),
      formats: ["es"],
    },
    rollupOptions: {
      output: {
        entryFileNames: "~host.[hash].js",
      },
    },
  },
});
