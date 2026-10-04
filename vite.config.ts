// Vite builds the Floor (this file) and the pool host (vite.host.config.ts). Nothing else.
// Wrangler bundles the Worker. Vitest reads vitest.config.ts, never this file.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { META_DIR, moduleList } from "./scripts/build/module-list.ts";

const repoRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: join(repoRoot, "src/floor"),
  publicDir: join(repoRoot, "public"),
  plugins: [react(), moduleList(repoRoot, join(repoRoot, META_DIR, "floor.json"))],
  build: {
    outDir: join(repoRoot, "dist/client"),
    // `npm run build` cleans `dist/` first, then the host and the Floor both write into `dist/client`.
    emptyOutDir: false,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
