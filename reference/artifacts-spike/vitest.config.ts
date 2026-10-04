import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // The Workers-only module is replaced by a small stub so tests can import the built bundle.
      "cloudflare:workers": join(root, "test/helpers/cloudflare-workers-stub.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
